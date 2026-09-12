import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { spawnSync } from "child_process";
import { decodePng, encodePng, compareImages, renderDiffImage } from "../src/visual";
import { recordVisual } from "../src/visual-cli";
import { runCheck } from "../src/runner";
import { foldRows, readEvents, rowId } from "../src/corpus";
import type { SubjectConfig } from "../src/types";
import { tmpDir } from "./tmp";

const NODE = process.execPath;
const JUDGE = path.join(__dirname, "..", "src", "visual-cli.js");

function png(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Buffer {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = fn(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return encodePng(w, h, data);
}

function crc32(d: Buffer): number {
  let c = 0xffffffff;
  for (const b of d) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
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

function craftPng(rawRows: Buffer[], colorType: number, bitDepth: number, extra: Buffer[] = [], height = rawRows.length, width = 4): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rawRows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- codec

test("codec roundtrip: odd dimensions, alpha, gradients", () => {
  const w = 37;
  const h = 23;
  const src = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    src[i * 4] = (i * 7) & 255;
    src[i * 4 + 1] = (i * 13) & 255;
    src[i * 4 + 2] = (i * 29) & 255;
    src[i * 4 + 3] = (i * 3) & 255;
  }
  const decoded = decodePng(encodePng(w, h, src));
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.ok(decoded.data.equals(src));
});

test("codec: wrong-size encode is refused", () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(3)), /size mismatch/);
});

test("codec: all four PNG filters are unfiltered", () => {
  // 2x5 RGB (bpp 3). Each row carries the same two pixels
  // P = [(64,128,192), (32,48,64)] under a different filter; the decoder must
  // restore identical content from all of them, which is what the final
  // equality asserts.
  const P = [64, 128, 192, 32, 48, 64];
  // filter 1 (sub): raw[i] = sample - left (left is the previous pixel's sample, bpp 3).
  const sub = [1, ...P.map((v, i) => (v - (i >= 3 ? P[i - 3] : 0)) & 0xff)];
  // filter 2 (up): raw[i] = sample - previous row's sample.
  const up = [2, ...P.map((v, i) => (v - P[i]) & 0xff)];
  // filter 3 (average): raw[i] = sample - floor((left + up) / 2); left is the
  // shifted (previous-pixel) sample of this row, up is the row above's sample.
  const avg = [3, ...P.map((v, i) => (v - Math.floor(((i >= 3 ? P[i - 3] : 0) + P[i]) / 2)) & 0xff)];
  // filter 4 (paeth): residual = sample - predictor, where the predictor is
  // the spec's minimum-absolute-difference among a (left), b (up), c (up-left).
  const paethPred = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  const paeth = [
    4,
    ...P.map((v, i) => (v - paethPred(i >= 3 ? P[i - 3] : 0, P[i], i >= 3 ? P[i - 3] : 0)) & 0xff),
  ];

  const img = decodePng(
    craftPng([Buffer.from([0, ...P]), Buffer.from(sub), Buffer.from(up), Buffer.from(avg), Buffer.from(paeth)], 2, 8, [], 5, 2)
  );
  assert.equal(img.width, 2);
  assert.equal(img.height, 5);
  const expected = Buffer.alloc(2 * 5 * 4);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 2; x++) {
      const o = (y * 2 + x) * 4;
      expected[o] = P[x * 3];
      expected[o + 1] = P[x * 3 + 1];
      expected[o + 2] = P[x * 3 + 2];
      expected[o + 3] = 255;
    }
  }
  assert.ok(img.data.equals(expected));
});

test("codec: palette with tRNS expands to RGBA", () => {
  const indexes = Buffer.from([
    0, 1, 0, 1,
    2, 3, 2, 3,
    0, 1, 0, 1,
    2, 3, 2, 3,
  ]);
  const full: Buffer[] = [];
  for (let y = 0; y < 4; y++) full.push(Buffer.concat([Buffer.from([0]), indexes.subarray(y * 4, y * 4 + 4)]));
  const img = decodePng(
    craftPng(full, 3, 8, [
      chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])),
      chunk("tRNS", Buffer.from([255, 128, 0, 0])),
    ], 4)
  );
  // fixture rows of indices: [0,1,0,1] / [2,3,2,3] / ... so the palette is
  // exercised at both the row level and the pixel level:
  // index 0 ->(255,0,0,255) 1 ->(0,255,0,128) 2 ->(0,0,255,0) 3 ->(255,255,255,0)
  const d = img.data;
  const p = (i: number): [number, number, number, number] => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
  assert.deepEqual(p(0), [255, 0, 0, 255]);
  assert.deepEqual(p(1), [0, 255, 0, 128]);
  assert.deepEqual(p(2), [255, 0, 0, 255]);
  assert.deepEqual(p(3), [0, 255, 0, 128]);
  assert.deepEqual(p(4), [0, 0, 255, 0]);
  assert.deepEqual(p(5), [255, 255, 255, 0]);
});

test("codec: 16-bit grayscale samples keep their high byte", () => {
  // 4 samples: 0xFFFF -> 255, 0x8000 -> 128, 0x0000 -> 0, 0x0FFF -> 15.
  const row = Buffer.from([0, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x0f, 0xff]);
  const img = decodePng(craftPng([row], 0, 16));
  assert.equal(img.width, 4);
  assert.deepEqual([...img.data.subarray(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...img.data.subarray(4, 8)], [128, 128, 128, 255]);
  assert.deepEqual([...img.data.subarray(8, 12)], [0, 0, 0, 255]);
  assert.deepEqual([...img.data.subarray(12, 16)], [15, 15, 15, 255]);
});

test("codec: malformed input is refused, not crashed on", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /signature/);
  // The IHDR interlace byte sits at 8 (sig) + 4 (len) + 4 (type) + 12 = 28.
  const interlaced = craftPng([Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25])], 2, 8, [], 1, 8);
  interlaced[28] = 1; // IHDR.data[12] = interlace
  assert.throws(() => decodePng(interlaced), /interlaced/);
});

// ---------------------------------------------------------------- diff

test("compare: identical images are equal", () => {
  const a = decodePng(png(10, 5, (x, y) => [x * 20, y * 30, 7, 255]));
  const b = decodePng(png(10, 5, (x, y) => [x * 20, y * 30, 7, 255]));
  const s = compareImages(a, b);
  assert.ok(s.equal);
  assert.equal(s.changedPixels, 0);
  assert.equal(s.bbox, null);
  assert.equal(s.maxChannelDelta, 0);
});

test("compare: a one-pixel change is found, bbox and percent are right", () => {
  const a = decodePng(png(100, 50, (x, y) => [x, y, 60, 255]));
  const b = decodePng(
    png(100, 50, (x, y) => {
      const px: [number, number, number, number] = [x, y, 60, 255];
      if (x === 42 && y === 25) px[2] = 200;
      return px;
    })
  );
  const s = compareImages(a, b);
  assert.equal(s.equal, false);
  assert.equal(s.changedPixels, 1);
  assert.equal(s.percentChanged, 0.02);
  assert.deepEqual(s.bbox, { x: 42, y: 25, w: 1, h: 1 });
  assert.equal(s.maxChannelDelta, 140);
});

test("compare: per-pixel tolerance and maxPercent soften the verdict", () => {
  const a = decodePng(png(10, 10, (x, y) => [0, 0, 0, 255]));
  const b = decodePng(png(10, 10, (x, y) => [0, 0, 3, 255]));
  assert.equal(compareImages(a, b).equal, false, "3 is a change at tolerance 0");
  assert.equal(compareImages(a, b, { perPixel: 5 }).equal, true, "3 is noise at tolerance 5");
  const c = decodePng(png(10, 10, (x, y) => (x === 0 && y === 0 ? [5, 0, 0, 255] : [0, 0, 0, 255])));
  assert.equal(compareImages(a, c, { maxPercent: 2 }).equal, true, "1% changed, 2% allowed");
  assert.equal(compareImages(a, c, { maxPercent: 0.5 }).equal, false, "1% changed, 0.5% allowed");
});

test("compare: different dimensions always fail", () => {
  const a = decodePng(png(10, 10, () => [0, 0, 0, 255]));
  const b = decodePng(png(10, 11, () => [0, 0, 0, 255]));
  const s = compareImages(a, b);
  assert.equal(s.equal, false);
  assert.equal(s.changedPixels, 100);
});

test("renderDiff is deterministic and highlights changes", () => {
  const a = decodePng(png(8, 4, (x, y) => [200, 200, 200, 255]));
  const b = decodePng(png(8, 4, (x, y) => (x === 3 && y === 2 ? [200, 20, 20, 255] : [200, 200, 200, 255])));
  const d1 = renderDiffImage(a, b);
  const d2 = renderDiffImage(a, b);
  assert.ok(Buffer.from(encodePng(d1.width, d1.height, d1.data)).equals(encodePng(d2.width, d2.height, d2.data)));
  const i = (2 * 8 + 3) * 4;
  assert.ok(d1.data[i] > d1.data[i + 1], "changed pixel should be red-dominant");
  const ok = (0 * 8 + 0) * 4;
  assert.equal(d1.data[ok], d1.data[ok + 1], "unchanged pixels are desaturated equally");
});

// -------------------------------------------------- the check contract

function scratch(home: string, config: Record<string, SubjectConfig>): string {
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects: config }), "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "");
  return root;
}

test("visual record pins a baseline; the check passes until the pixels change", async () => {
  const home = tmpDir();
  const root = scratch(home, { ui: { check: `"${NODE}" ${JSON.stringify(JUDGE)} ui`, owns: ["shot.js"] } });
  fs.writeFileSync(path.join(root, "shot.js"), "module.exports=1;\n");
  fs.writeFileSync(path.join(root, "shot.png"), png(20, 10, (x, y) => [x * 10, y * 20, 80, 255]));

  // The row's identity is its (subject, input) pair: every use below must
  // send the very same input that was recorded, or it resolves another row.
  const input = { file: "shot.png" };

  const prev = process.env.RATCHET_HOME;
  process.env.RATCHET_HOME = home;
  try {
    const rec = await recordVisual(root, "ui", input, "tester");
    assert.match(rec.id, /^c[0-9a-f]{12}$/);
    const rows = [...foldRows(readEvents(path.join(home, "corpus.jsonl"))).values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "visual");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].signature, undefined, "a pin has no failure witness until it goes red");

    // Pass: pixels still match the baseline.
    const pass = runCheck(`"${NODE}" ${JSON.stringify(JUDGE)} ui`, input, { cwd: root, homeDir: home });
    assert.equal(pass.pass, true, `expected pass, got: ${pass.reason}`);

    // Red: one pixel of the page moved. The witness must carry the numbers.
    fs.writeFileSync(
      path.join(root, "shot.png"),
      png(20, 10, (x, y): [number, number, number, number] => (x === 5 && y === 6 ? [x * 10, y * 20, 240, 255] : [x * 10, y * 20, 80, 255]))
    );
    const fail = runCheck(`"${NODE}" ${JSON.stringify(JUDGE)} ui`, input, { cwd: root, homeDir: home });
    assert.equal(fail.pass, false);
    assert.match(fail.reason, /visual diff: /);
    assert.match(fail.reason, /bbox 1x1 at \(5,6\)/);
    assert.ok(
      fs.existsSync(path.join(home, "visual", rowId("ui", input) + "-diff.png")),
      "diff artifact written"
    );

    // A fresh record re-pins: the same pixels pass again (the baseline file
    // is replaced in place; audit trail keeps the old hash).
    await recordVisual(root, "ui", input, "tester");
    const green = runCheck(`"${NODE}" ${JSON.stringify(JUDGE)} ui`, input, { cwd: root, homeDir: home });
    assert.equal(green.pass, true);
  } finally {
    if (prev === undefined) delete process.env.RATCHET_HOME;
    else process.env.RATCHET_HOME = prev;
  }
});

test("visual record: a missing baseline in the corpus is a hard failure, not n/a", async () => {
  const home = tmpDir();
  const root = scratch(home, { ui: { check: `"${NODE}" ${JSON.stringify(JUDGE)} ui` } });
  fs.writeFileSync(path.join(root, "shot.png"), png(2, 2, () => [1, 2, 3, 255]));
  // No record — no row exists; but a row without its baseline must fail loudly.
  const prev = process.env.RATCHET_HOME;
  process.env.RATCHET_HOME = home;
  try {
    const result = runCheck(`"${NODE}" ${JSON.stringify(JUDGE)} ui`, { file: "shot.png" }, { cwd: root, homeDir: home });
    assert.equal(result.pass, false);
    assert.match(result.reason, /no visual baseline/);
  } finally {
    if (prev === undefined) delete process.env.RATCHET_HOME;
    else process.env.RATCHET_HOME = prev;
  }
});

test("visual record refuses subjects with no configured check", async () => {
  const home = tmpDir();
  const root = scratch(home, {});
  fs.writeFileSync(path.join(root, "shot.png"), png(2, 2, () => [1, 2, 3, 255]));
  const prev = process.env.RATCHET_HOME;
  process.env.RATCHET_HOME = home;
  try {
    await assert.rejects(recordVisual(root, "ui", { file: "shot.png" }), /not configured with a check/);
  } finally {
    if (prev === undefined) delete process.env.RATCHET_HOME;
    else process.env.RATCHET_HOME = prev;
  }
});

// The CLI, exercised as shipped: `ratchet visual diff` through a subprocess.
test("visual diff exits nonzero on real differences, zero on identical pixels", () => {
  const dir = tmpDir();
  const a = path.join(dir, "a.png");
  const b = path.join(dir, "b.png");
  fs.writeFileSync(a, png(6, 4, (x, y) => [x, y, 5, 255]));
  fs.writeFileSync(b, png(6, 4, (x, y) => [x, y, 5 + (x === 2 && y === 3 ? 100 : 0), 255]));

  const cli = path.join(__dirname, "..", "src", "index.js");
  const diff = spawnSync(NODE, [cli, "visual", "diff", a, b], { encoding: "utf8" });
  assert.equal(diff.status, 1);
  assert.match(diff.stdout, /visual diff: .*bbox 1x1 at \(2,3\)/);

  const same = spawnSync(NODE, [cli, "visual", "diff", a, a], { encoding: "utf8" });
  assert.equal(same.status, 0);
  assert.match(same.stdout, /0% /);

  const out = path.join(dir, "out.png");
  const withOut = spawnSync(NODE, [cli, "visual", "diff", a, b, "--out", out], { encoding: "utf8" });
  assert.equal(withOut.status, 1);
  assert.ok(fs.existsSync(out));
  assert.equal(decodePng(fs.readFileSync(out)).width, 6);
});
