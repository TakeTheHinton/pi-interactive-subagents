/**
 * herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the herdr calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by herdr pane ids (e.g. `w2:p8`). Splits always target
 * the parent pi's pane (`$HERDR_PANE_ID`) so they follow the agent rather than
 * the user's focus.
 *
 * On Windows herdr panes start PowerShell, so launch scripts are run through
 * an explicitly resolved Git Bash — a bare `bash` there can resolve to WSL.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";
const HERDR_BIN = process.env.HERDR_BIN || "herdr";

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    if (IS_WINDOWS) {
      execFileSync("where.exe", [command], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    }
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a herdr pane with the herdr binary on PATH.
 * herdr injects `HERDR_ENV` and `HERDR_PANE_ID` into every pane it spawns.
 */
export function isHerdrAvailable(): boolean {
  return !!process.env.HERDR_ENV && !!process.env.HERDR_PANE_ID && hasCommand(HERDR_BIN);
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start herdr (`herdr`), then run pi inside a herdr pane.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

function herdr(args: string[]): string {
  return execFileSync(HERDR_BIN, args, { encoding: "utf8" });
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function powershellEscape(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

let cachedBash: string | undefined;

/**
 * Bash used to run launch scripts. `SUBAGENTS_BASH` overrides; on Windows we
 * prefer Git Bash next to `git.exe` so WSL's System32 bash is never picked.
 */
function resolveBash(): string {
  if (cachedBash) return cachedBash;
  if (process.env.SUBAGENTS_BASH) return (cachedBash = process.env.SUBAGENTS_BASH);
  if (!IS_WINDOWS) return (cachedBash = "bash");

  const candidates: string[] = [];
  try {
    const gitPaths = execFileSync("where.exe", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      // <Git>\cmd\git.exe or <Git>\bin\git.exe → <Git>\bin\bash.exe
      candidates.push(join(dirname(dirname(gitPath)), "bin", "bash.exe"));
    }
  } catch {}
  candidates.push("C:\\Program Files\\Git\\bin\\bash.exe");

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error("Git Bash not found. Install Git for Windows or set SUBAGENTS_BASH.");
  }
  return (cachedBash = found);
}

// ── Pane layout ──

/**
 * Subagent panes this process created, top to bottom. They form one column to
 * the right of the parent pi pane: the first splits the parent, each later one
 * splits the bottom pane of the column.
 *
 * herdr halves the target pane on every split, so without this the parent
 * (always the split target) shrinks to a sliver after a few spawns.
 */
const columnPanes: string[] = [];

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutSplit {
  direction: "right" | "down";
  ratio: number;
  rect: LayoutRect;
}

/**
 * Give every pane in the column an equal height. Best-effort: a cosmetic
 * resize must never break spawning or watching.
 *
 * The split directly below pane i divides it from the panes beneath; its
 * ratio should be 1/(panes from i down). `resize` grows the given pane toward
 * the direction by `amount` (sign ignored), so shrinking pane i means growing
 * pane i+1 upward.
 */
function rebalanceColumn(): void {
  if (columnPanes.length < 2) return;
  try {
    const layout = JSON.parse(herdr(["pane", "layout", "--pane", columnPanes[0]]))?.result?.layout;
    const rects = new Map<string, LayoutRect>(
      (layout?.panes ?? []).map((p: { pane_id: string; rect: LayoutRect }) => [p.pane_id, p.rect]),
    );
    const splits: LayoutSplit[] = layout?.splits ?? [];

    const column = columnPanes
      .filter((id) => rects.has(id))
      .sort((a, b) => rects.get(a)!.y - rects.get(b)!.y);

    for (let i = 0; i < column.length - 1; i++) {
      const rect = rects.get(column[i])!;
      const split = splits
        .filter(
          (s) =>
            s.direction === "down" &&
            s.rect.x === rect.x &&
            s.rect.y === rect.y &&
            s.rect.height > rect.height,
        )
        .sort((a, b) => a.rect.height - b.rect.height)[0];
      if (!split) continue;

      const delta = 1 / (column.length - i) - split.ratio;
      if (Math.abs(delta) < 0.01) continue;
      const [pane, direction] = delta > 0 ? [column[i], "down"] : [column[i + 1], "up"];
      herdr(["pane", "resize", "--pane", pane, "--direction", direction, "--amount", Math.abs(delta).toFixed(4)]);
    }
  } catch {
    // Pane may be gone mid-rebalance; balancing is best-effort.
  }
}

/** Drop column panes that no longer exist (e.g. closed by hand). */
function pruneColumn(): void {
  if (columnPanes.length === 0) return;
  try {
    const panes: Array<{ pane_id: string }> =
      JSON.parse(herdr(["pane", "list"]))?.result?.panes ?? [];
    const live = new Set(panes.map((p) => p.pane_id));
    for (let i = columnPanes.length - 1; i >= 0; i--) {
      if (!live.has(columnPanes[i])) columnPanes.splice(i, 1);
    }
  } catch {
    // Keep the list as-is; a failed split will surface the real error.
  }
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent in the column to the right of the parent
 * pi's pane, so new panes follow the agent rather than the user's focus and
 * the parent keeps half the width.
 *
 * Returns the new pane id (e.g. `w2:p8`).
 */
export function createSurface(name: string): string {
  pruneColumn();
  const bottom = columnPanes[columnPanes.length - 1];
  const pane = bottom
    ? createSurfaceSplit(name, "down", bottom)
    : createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID, 0.5);
  columnPanes.push(pane);
  rebalanceColumn();
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * herdr only splits right or down; left/up map onto those.
 * Returns the new pane id (e.g. `w2:p8`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  ratio?: number,
): string {
  requireHerdr();

  const args = ["pane", "split"];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }
  args.push("--direction", direction === "left" || direction === "right" ? "right" : "down");
  if (ratio !== undefined) {
    args.push("--ratio", String(ratio));
  }

  const output = herdr(args);
  let pane: string | undefined;
  try {
    pane = JSON.parse(output)?.result?.pane?.pane_id;
  } catch {}
  if (!pane) {
    throw new Error(`Unexpected herdr pane split output: ${output.trim()}`);
  }

  try {
    herdr(["pane", "rename", pane, name]);
  } catch {
    // Pane titles are cosmetic; never fail a spawn over them.
  }
  return pane;
}

/**
 * Send text to a pane and submit it with Enter.
 * Sent literally so special characters are not interpreted as keys.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  herdr(["pane", "send-text", surface, command]);
  herdr(["pane", "send-keys", surface, "enter"]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues and keeps the command out of the
 * pane's own shell (PowerShell on Windows) — only the bash invocation is typed.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  const bash = resolveBash();
  const invocation = IS_WINDOWS
    ? `& ${powershellEscape(bash)} ${powershellEscape(scriptPath)}`
    : `${shellEscape(bash)} ${shellEscape(scriptPath)}`;
  sendCommand(surface, invocation);
  return scriptPath;
}

function readArgs(surface: string, lines: number): string[] {
  return ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))];
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return herdr(readArgs(surface, lines));
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(HERDR_BIN, readArgs(surface, lines), {
    encoding: "utf8",
  });
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  const index = columnPanes.indexOf(surface);
  if (index !== -1) columnPanes.splice(index, 1);
  herdr(["pane", "close", surface]);
  rebalanceColumn();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
