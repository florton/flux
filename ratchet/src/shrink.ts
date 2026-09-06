export function ddmin<T>(
  candidate: T[],
  test: (c: T[]) => boolean,
  maxIterations = 100
): T[] {
  let current = candidate.slice();
  let granularity = 2;
  let iterations = 0;
  while (current.length >= 2 && iterations < maxIterations) {
    iterations++;
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let i = 0; i < granularity; i++) {
      const start = i * chunkSize;
      const trial = current.slice(0, start).concat(current.slice(start + chunkSize));
      if (test(trial)) {
        current = trial;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return current;
}

export function shrinkNumber(value: number, test: (n: number) => boolean): number {
  let best = value;
  const candidates: number[] = [0];
  const magnitude = Math.abs(value);
  if (Number.isInteger(value)) {
    for (let step = 2 ** Math.floor(Math.log2(Math.max(1, magnitude))); step >= 1; step = Math.floor(step / 2)) {
      for (const dir of [1, -1]) {
        const next = best - dir * step;
        if (Math.sign(next) === Math.sign(best) || next === 0) {
          if (test(next) && Math.abs(next) < Math.abs(best)) best = next;
        }
      }
    }
  } else {
    for (const c of [0.5, 0.1, 0.01]) {
      const next = best * c;
      if (test(next) && Math.abs(next) < Math.abs(best)) best = next;
    }
  }
  for (const c of candidates) {
    if (test(c) && Math.abs(c) < Math.abs(best)) best = c;
  }
  return best;
}

export function minimize(input: unknown, test: (candidate: unknown) => boolean): unknown {
  if (Array.isArray(input)) {
    return ddmin(input, (trial) => test(trial));
  }
  if (typeof input === "string" && input.length >= 2) {
    return ddmin(input.split(""), (chars) => test(chars.join(""))).join("");
  }
  if (typeof input === "number") {
    return shrinkNumber(input, (n) => test(n));
  }
  return input;
}
