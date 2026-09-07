/**
 * The one place the ratchet's path tokens are named and filled in.
 *
 * `{home}` and `{ratchet}` are how a check reaches an instrument that lives
 * *outside* the tree being measured — the frozen-instrument mechanism that
 * makes readings across history comparable by construction. During replay the
 * home is copied out of the working tree, so a check written as
 * `node {home}/tools/probe.js` runs the same script at every commit instead of
 * whatever that commit happened to contain.
 *
 * This module exists because that mechanism kept being wired into some of its
 * call sites and not others, three times across three versions:
 *
 *   - v0    `--home` honored by 2 of 8 commands
 *   - v0.7  `{home}` substituted in 1 of 2 spawn modes in `runner.ts`
 *   - v0.7  `homeDir` passed to the check but not to `--setup`
 *   - v0.7  neither token substituted in `probe.ts`, so a *prose* heuristic
 *           could not reach a frozen instrument at all
 *
 * A corpus row cannot catch that class: a row is one counterexample, and
 * partial application is a completeness property over a set of call sites.
 * What catches it is a definition in one place plus a static check that every
 * spawn path delegates here — `source-uniformity` in `.ratchet/heuristics.rules`.
 *
 * `{test}` is deliberately not in this vocabulary. It is not a path the
 * ratchet computes; it comes out of a test file and can contain anything, so
 * it reaches a check through `RATCHET_TEST` and is refused in shell mode.
 */

/** The closed vocabulary. Adding a token here reaches every spawn path. */
export const SUBSTITUTION_TOKENS = ["{home}", "{ratchet}"] as const;

export type SubstitutionToken = (typeof SUBSTITUTION_TOKENS)[number];

export interface Substitutions {
  /** The ratchet home — during history commands, the carried copy. */
  home?: string;
  /** The ratchet's own install directory, which holds the bundled probe. */
  ratchet?: string;
}

function bindings(values: Substitutions): [SubstitutionToken, string | undefined][] {
  return [
    ["{home}", values.home],
    ["{ratchet}", values.ratchet],
  ];
}

/**
 * Whole-token substitution across an already-tokenized argv.
 *
 * A substituted value becomes exactly one argv element, so a path containing
 * spaces, quotes or shell syntax can never split into extra arguments.
 */
export function substituteArgv(argv: string[], values: Substitutions): string[] {
  let out = argv;
  for (const [token, value] of bindings(values)) {
    if (value === undefined) continue;
    out = out.map((t) => (t.includes(token) ? t.split(token).join(value) : t));
  }
  return out;
}

export type ShellSubstitution = { command: string } | { error: string };

/**
 * Textual substitution into a command that will be handed to a shell.
 *
 * A value that could close a quote or open a substitution would change the
 * *shape* of the command rather than filling a slot in it, so it is refused
 * with a message instead of being spliced in and hoped for.
 */
export function substituteShell(command: string, values: Substitutions): ShellSubstitution {
  let out = command;
  for (const [token, value] of bindings(values)) {
    if (value === undefined || !out.includes(token)) continue;
    if (/["`$\r\n]/.test(value)) {
      return { error: `cannot substitute ${token}: the path contains a shell metacharacter (${value})` };
    }
    out = out.split(token).join(value);
  }
  return { command: out };
}
