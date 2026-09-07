/**
 * The bundled seeded-RNG preload.
 *
 * A heuristic that declares `seed 20260906` needs its instrument to produce
 * the same numbers on every run, or the band it asserts is measuring noise.
 * Every field experiment that measured a simulation hand-rolled this, and it
 * is the same six lines each time, so the ratchet ships it: the probe injects
 * this module via NODE_OPTIONS=--require, which reaches the instrument *and*
 * anything it spawns.
 *
 * Honest limits, both worth knowing before trusting a band:
 *   - This seeds `Math.random` only. An instrument using `crypto` randomness,
 *     wall-clock time, or a library with its own generator stays
 *     nondeterministic; RATCHET_SEED is exported for those to read.
 *   - It reaches Node processes only. A non-Node instrument gets RATCHET_SEED
 *     in its environment and nothing more.
 *
 * mulberry32: small, fast, and good enough for reproducibility, which is the
 * only property being asked of it here.
 */
const raw = process.env.RATCHET_SEED;
const parsed = raw === undefined ? NaN : Number(raw);

if (Number.isFinite(parsed)) {
  let state = parsed >>> 0;
  Math.random = function seededRandom(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
