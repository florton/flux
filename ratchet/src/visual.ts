import * as zlib from "zlib";

/**
 * Visual regression support: a zero-dependency PNG codec plus a pixel diff.
 *
 * The ratchet's check contract is "exit 0 pass / nonzero fail, stdout is the
 * witness". Visual rows are pins: the row's input names the screen to shoot,
 * and the row's baseline is the pixels that screen had when the pin was
 * recorded. Between them sits this module — decode the PNGs (Node's zlib is
 * the only primitive, so no npm dependency), diff them into a small
 * machine-readable verdict, and render a highlight image for review.
 *
 * Supported decode: bit depths 1/2/4/8/16, color types 0/2/3/4/6, no
 * interlacing (Adam7 is not emitted by screenshot tools). Encode writes 8-bit
 * RGBA, which is what screenshot tools emit and what a diff needs.
 */

export interface PngImage {
  width: number;
  height: number;
  /** 4 bytes per pixel, RGBA order. */
  data: Buffer;
}

const CRC_TABLE = ((): number[] => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.slice(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Samples per pixel stored in the scanlines, per color type. A palette
 * (type 3) image stores one index per pixel, not three color samples.
 */
function sampleCount(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`visual: unsupported PNG color type ${colorType}`);
  }
}

/**
 * Expand a PNG into 8-bit RGBA.
 *
 * 16-bit samples keep their high byte; palette images are expanded through
 * PLTE (with tRNS alpha when present); gray/alpha images are expanded to
 * RGB. Interlaced (Adam7) PNGs are refused rather than mis-rendered — no
 * screenshot tool produces them.
 */
export function decodePng(buf: Buffer): PngImage {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error("visual: not a PNG file (bad signature)");
  }

  let offset = 8;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number } | null = null;
  let palette: Buffer | null = null;
  let tRNS: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (offset + 8 + len > buf.length) throw new Error("visual: truncated PNG chunk");
    offset += 8 + len + 4;
    switch (type) {
      case "IHDR":
        if (len !== 13) throw new Error("visual: bad IHDR length");
        ihdr = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colorType: data[9],
        };
        if (data[10] !== 0) throw new Error("visual: unsupported PNG compression method");
        if (data[11] !== 0) throw new Error("visual: unsupported PNG filter method");
        if (data[12] !== 0) throw new Error("visual: interlaced PNG is not supported");
        break;
      case "PLTE":
        palette = data;
        break;
      case "tRNS":
        tRNS = data;
        break;
      case "IDAT":
        idat.push(data);
        break;
      case "IEND":
        offset = buf.length;
        break;
      default:
        /* ancillary chunks (tEXt, gAMA, eXIf, ...) are ignored */
        break;
    }
  }

  if (!ihdr || idat.length === 0) throw new Error("visual: PNG missing IHDR or IDAT");
  const { width, height, bitDepth, colorType } = ihdr;
  if (width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error(`visual: unreasonable dimensions ${width}x${height}`);
  }
  if (colorType === 3 && !palette) throw new Error("visual: palette image without PLTE");
  if (bitDepth < 1 || bitDepth > 16 || (bitDepth > 8 && bitDepth !== 16)) {
    throw new Error(`visual: unsupported bit depth ${bitDepth}`);
  }
  const samples = sampleCount(colorType);
  const bitsPerPx = samples * bitDepth;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil((width * bitsPerPx) / 8);
  const stride = rowBytes + 1;
  const expected = stride * height;
  if (raw.length !== expected) {
    throw new Error(`visual: IDAT size mismatch (${raw.length} bytes, expected ${expected})`);
  }

  // Unfilter: bpp is bytes per pixel rounded up to 1 (PNG spec 6.6), and the
  // filter is applied to bytes, even for sub-byte bit depths.
  const bpp = Math.max(1, Math.floor((samples * bitDepth) / 8));
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const src = raw.subarray(y * stride + 1, (y + 1) * stride);
    const dst = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    if (filter < 0 || filter > 4) throw new Error(`visual: unknown filter ${filter} at row ${y}`);
    if (filter === 0) {
      src.copy(dst);
      continue;
    }
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bpp ? dst[x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * rowBytes + x] : 0;
      const ul = x >= bpp && y > 0 ? out[(y - 1) * rowBytes + x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += Math.floor((left + up) / 2);
      else v += paeth(left, up, ul);
      dst[x] = v & 0xff;
    }
  }

  return { width, height, data: expandToRgba(out, width, height, colorType, bitDepth, palette, tRNS) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function scaleSample(sample: number, bitDepth: number): number {
  if (bitDepth === 8) return sample;
  if (bitDepth === 16) return sample >> 8;
  const max = (1 << bitDepth) - 1;
  return Math.round((sample * 255) / max) & 0xff;
}

function expandToRgba(
  out: Buffer,
  width: number,
  height: number,
  colorType: number,
  bitDepth: number,
  palette: Buffer | null,
  tRNS: Buffer | null
): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  const fullMask = bitDepth >= 8 ? 0 : (1 << bitDepth) - 1;
  let bitCursor = 0;
  let readSample = (): number => {
    if (bitDepth === 8) return out[bitCursor++];
    if (bitDepth === 16) {
      const v = (out[bitCursor] << 8) | out[bitCursor + 1];
      bitCursor += 2;
      return v;
    }
    const byte = out[bitCursor >> 3];
    const shift = 8 - bitDepth - (bitCursor & 7);
    bitCursor += bitDepth;
    return (byte >> shift) & fullMask;
  };

  const palIndex = (n: number): [number, number, number, number] => {
    const i = n * 3;
    const r = palette ? palette[i] : 0;
    const g = palette ? palette[i + 1] : 0;
    const b = palette ? palette[i + 2] : 0;
    const a = tRNS && n < tRNS.length ? tRNS[n] : 255;
    return [r, g, b, a];
  };

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const s0 = readSample();
    if (colorType === 0) {
      const v = scaleSample(s0, bitDepth);
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    } else if (colorType === 2) {
      rgba[o] = scaleSample(s0, bitDepth);
      rgba[o + 1] = scaleSample(readSample(), bitDepth);
      rgba[o + 2] = scaleSample(readSample(), bitDepth);
      rgba[o + 3] = 255;
    } else if (colorType === 3) {
      const [r, g, b, a] = palIndex(s0);
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    } else if (colorType === 4) {
      const v = scaleSample(s0, bitDepth);
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = scaleSample(readSample(), bitDepth);
    } else {
      rgba[o] = scaleSample(s0, bitDepth);
      rgba[o + 1] = scaleSample(readSample(), bitDepth);
      rgba[o + 2] = scaleSample(readSample(), bitDepth);
      rgba[o + 3] = scaleSample(readSample(), bitDepth);
    }
  }
  return rgba;
}

/** Encode 8-bit RGBA data as a PNG (8-bit, color type 6). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`visual: encode size mismatch (${rgba.length} bytes for ${width}x${height})`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface DiffOptions {
  /** Per-pixel tolerance per channel: a pixel counts as changed when any RGBA channel differs by more than this. Default 0 (exact). */
  perPixel?: number;
  /** Percent of pixels that may differ before the check fails. Default 0. */
  maxPercent?: number;
}

export interface DiffStats {
  equal: boolean;
  width: number;
  height: number;
  totalPixels: number;
  changedPixels: number;
  /** Changed pixels as a percent of total, 0..100. */
  percentChanged: number;
  /** Bounding box of the changed region, or null when nothing changed. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Largest channel delta found anywhere (0 for identical images). */
  maxChannelDelta: number;
  perPixel: number;
  maxPercent: number;
}

function countChange(actual: PngImage, baseline: PngImage, perPixel: number): {
  changedPixels: number;
  bbox: { x: number; y: number; w: number; h: number } | null;
  maxChannelDelta: number;
} {
  const { data: a, width } = actual;
  const b = baseline.data;
  let changedPixels = 0;
  let maxDelta = 0;
  let minX = width;
  let minY = actual.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < actual.height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++) {
        const cd = Math.abs(a[i + c] - b[i + c]);
        if (cd > d) d = cd;
      }
      if (d > maxDelta) maxDelta = d;
      if (d > perPixel) {
        changedPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bbox =
    changedPixels > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  return { changedPixels, bbox, maxChannelDelta: maxDelta };
}

const pct = (fraction: number): number => Math.round(fraction * 10000) / 100;

/** Compare two decoded images. Different dimensions always fail. */
export function compareImages(actual: PngImage, baseline: PngImage, opts: DiffOptions = {}): DiffStats {
  const perPixel = opts.perPixel ?? 0;
  const maxPercent = opts.maxPercent ?? 0;
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      equal: false,
      width: actual.width,
      height: actual.height,
      totalPixels: actual.width * actual.height,
      changedPixels: actual.width * actual.height,
      percentChanged: 100,
      bbox: { x: 0, y: 0, w: actual.width, h: actual.height },
      maxChannelDelta: 255,
      perPixel,
      maxPercent,
    };
  }
  const { changedPixels, bbox, maxChannelDelta } = countChange(actual, baseline, perPixel);
  const totalPixels = actual.width * actual.height;
  const percentChanged = pct(changedPixels / totalPixels);
  const maxAllowed = totalPixels === 0 ? 0 : Math.floor((maxPercent / 100) * totalPixels);
  const equal = changedPixels <= maxAllowed;
  return { equal, width: actual.width, height: actual.height, totalPixels, changedPixels, percentChanged, bbox, maxChannelDelta, perPixel, maxPercent };
}

/**
 * Render a review artifact: the images blended where they agree, the changed
 * region tinted red. Deterministic — the same images produce the same bytes.
 */
export function renderDiffImage(actual: PngImage, baseline: PngImage): PngImage {
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    const w = Math.max(actual.width, baseline.width);
    const h = Math.max(actual.height, baseline.height);
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }
  const out = Buffer.alloc(actual.data.length);
  const { data: a } = actual;
  const b = baseline.data;
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
      Math.abs(a[i + 3] - b[i + 3])
    );
    const blend = (x: number, y: number): number => Math.round((x + y) / 2);
    if (d === 0) {
      const gray = Math.round(blend(a[i], b[i]) * 0.35);
      out[i] = gray;
      out[i + 1] = gray;
      out[i + 2] = gray;
      out[i + 3] = 255;
    } else {
      out[i] = Math.min(255, Math.round(blend(a[i], b[i]) * 0.4) + 160);
      out[i + 1] = Math.round(blend(a[i + 1], b[i + 1]) * 0.4);
      out[i + 2] = Math.round(blend(a[i + 2], b[i + 2]) * 0.4);
      out[i + 3] = 255;
    }
  }
  return { width: actual.width, height: actual.height, data: out };
}
