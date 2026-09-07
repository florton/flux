/**
 * Wiring the gate into git, so nobody has to remember it.
 *
 * `ratchet guard` is only self-enforcing once something runs it without being
 * asked. Two places do that: a pre-commit hook (fast, local, catches the
 * regression before it is even a commit) and CI (authoritative, catches what
 * a bypassed hook let through). Both matter — a hook alone is advisory,
 * because `--no-verify` exists and because a fresh clone has no hooks at all.
 *
 * The installer is deliberately conservative. It never overwrites a hook it
 * did not write: an existing pre-commit hook is a colleague's work, and
 * clobbering it to install a quality gate would be its own small regression.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const MARKER = "# >>> ratchet guard >>>";
const END_MARKER = "# <<< ratchet guard <<<";

export interface HookResult {
  action: "installed" | "updated" | "removed" | "unchanged" | "refused";
  path: string;
  detail: string;
}

/** The hooks directory git is actually using, honoring core.hooksPath. */
export function hooksDir(cwd: string): string | null {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (common.status !== 0) return null;
  const gitDir = path.resolve(cwd, (common.stdout ?? "").trim());

  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd, encoding: "utf8" });
  if (configured.status === 0 && (configured.stdout ?? "").trim() !== "") {
    return path.resolve(cwd, (configured.stdout ?? "").trim());
  }
  return path.join(gitDir, "hooks");
}

function block(command: string): string {
  return [
    MARKER,
    "# Installed by `ratchet hooks install`. Remove with `ratchet hooks uninstall`,",
    "# or delete the lines between the markers.",
    "if ! " + command + "; then",
    '  echo "ratchet: commit blocked. Fix the failures above, or record the decision:" >&2',
    '  echo "  ratchet accept <id> --reason \\"...\\"   (the behavior changed on purpose)" >&2',
    '  echo "  ratchet reaffirm <id> --reason \\"...\\" (the heuristic moved, the expectation stands)" >&2',
    "  exit 1",
    "fi",
    END_MARKER,
  ].join("\n");
}

function stripBlock(text: string): string {
  const start = text.indexOf(MARKER);
  if (start === -1) return text;
  const end = text.indexOf(END_MARKER, start);
  if (end === -1) return text;
  return (text.slice(0, start) + text.slice(end + END_MARKER.length)).replace(/\n{3,}/g, "\n\n");
}

export interface InstallOptions {
  /** The command the hook runs. Defaults to whatever invokes this build. */
  command?: string;
  hook?: "pre-commit" | "pre-push";
}

/**
 * How the hook should call the ratchet.
 *
 * A bare `ratchet` is what a reader expects to see in a hook, but it only
 * works when the tool is on PATH — and a hook that dies with "command not
 * found" blocks the commit for a reason that has nothing to do with the code,
 * which is the fastest way to get the hook deleted. So: use the bare name
 * when a shell can actually resolve it, and otherwise pin the interpreter and
 * entry point that are running right now.
 */
export function defaultCommand(): { command: string; pinned: boolean } {
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["ratchet"], { encoding: "utf8" });
  if (onPath.status === 0 && (onPath.stdout ?? "").trim() !== "") {
    return { command: "ratchet guard --quiet", pinned: false };
  }
  // Git runs hooks under sh even on Windows, so forward slashes and quotes.
  const q = String.fromCharCode(34);
  const sh = (p: string): string => q + p.split(String.fromCharCode(92)).join("/") + q;
  return { command: `${sh(process.execPath)} ${sh(process.argv[1])} guard --quiet`, pinned: true };
}

export function installHook(cwd: string, opts: InstallOptions = {}): HookResult {
  const dir = hooksDir(cwd);
  if (!dir) {
    return { action: "refused", path: "", detail: "not a git repository, so there is nowhere to install a hook" };
  }
  const hook = opts.hook ?? "pre-commit";
  const file = path.join(dir, hook);
  const command = opts.command ?? defaultCommand().command;

  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(file);
  const previous = existed ? fs.readFileSync(file, "utf8") : "";

  if (previous.includes(MARKER)) {
    const updated = stripBlock(previous).trimEnd() + "\n\n" + block(command) + "\n";
    if (updated === previous) return { action: "unchanged", path: file, detail: "the hook already runs the ratchet" };
    write(file, updated);
    return { action: "updated", path: file, detail: `updated the ratchet block in ${hook}` };
  }

  if (!existed) {
    write(file, `#!/bin/sh\n\n${block(command)}\n`);
    return { action: "installed", path: file, detail: created(hook, command) };
  }

  // Somebody else's hook. Append rather than replace, and only when it looks
  // like a shell script we can safely extend.
  if (!/^#!.*\b(sh|bash|zsh)\b/m.test(previous.split("\n")[0] ?? "")) {
    return {
      action: "refused",
      path: file,
      detail:
        `${hook} already exists and is not a POSIX shell script, so appending to it is not safe.\n` +
        `Add this line to it yourself:\n  ${command}`,
    };
  }
  write(file, previous.trimEnd() + "\n\n" + block(command) + "\n");
  return { action: "installed", path: file, detail: `appended to your existing ${hook}. ` + created(hook, command) };
}

function created(hook: string, command: string): string {
  const pinned = command.includes("index.js")
    ? [
        "",
        "  It pins this checkout of the ratchet, because `ratchet` is not on PATH.",
        "  Install the CLI globally and re-run `ratchet hooks install` for a portable hook.",
      ].join("\n")
    : "";
  return `${hook} runs: ${command}${pinned}`;
}

export function uninstallHook(cwd: string, hook: "pre-commit" | "pre-push" = "pre-commit"): HookResult {
  const dir = hooksDir(cwd);
  if (!dir) return { action: "refused", path: "", detail: "not a git repository" };
  const file = path.join(dir, hook);
  if (!fs.existsSync(file)) return { action: "unchanged", path: file, detail: `no ${hook} hook installed` };
  const previous = fs.readFileSync(file, "utf8");
  if (!previous.includes(MARKER)) {
    return { action: "unchanged", path: file, detail: `${hook} exists but was not installed by the ratchet — left alone` };
  }
  const stripped = stripBlock(previous).trim();
  // A file that held nothing but our block is ours to remove entirely.
  if (stripped === "#!/bin/sh" || stripped === "") {
    fs.unlinkSync(file);
    return { action: "removed", path: file, detail: `removed ${hook}` };
  }
  write(file, stripped + "\n");
  return { action: "removed", path: file, detail: `removed the ratchet block from ${hook}, left the rest` };
}

export function hookStatus(cwd: string, hook: "pre-commit" | "pre-push" = "pre-commit"): { installed: boolean; path: string } {
  const dir = hooksDir(cwd);
  if (!dir) return { installed: false, path: "" };
  const file = path.join(dir, hook);
  if (!fs.existsSync(file)) return { installed: false, path: file };
  return { installed: fs.readFileSync(file, "utf8").includes(MARKER), path: file };
}

function write(file: string, contents: string): void {
  fs.writeFileSync(file, contents, "utf8");
  try {
    // chmod is a no-op on win32, where git uses the shebang instead.
    fs.chmodSync(file, 0o755);
  } catch {
    /* best effort */
  }
}
