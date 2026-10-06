import { spawn } from "node:child_process";

/**
 * Runs a command-line tool (ffmpeg, ffprobe, yt-dlp) the safe way: binary + argument
 * array, never a shell, so nothing in an argument can be interpreted as a command.
 * `spawn` rather than `execFile` only because we need output line by line for progress;
 * the safety properties are the same (shell: false).
 *
 * Always has a timeout; an AbortSignal (the run was lost) kills the tool early.
 */

export type RunToolOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Keep full stdout (e.g. JSON output). Capped at 32 MB. Default true. */
  captureStdout?: boolean;
  /** Raw stdout bytes (e.g. decoded audio). When set, stdout isn't read as text at all. */
  onStdoutBytes?: (chunk: Buffer) => void;
  /**
   * Working directory. Lets ffmpeg filters take short relative paths: an absolute Windows
   * path (`D:\…`) inside a filter argument breaks on its `:` and `\`.
   */
  cwd?: string;
};

export type RunToolResult = { stdout: string; stderrTail: string };

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: "exit" | "timeout" | "aborted" | "spawn",
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(`${tool} ${reason}${exitCode != null ? ` (exit ${exitCode})` : ""}: ${stderrTail.slice(-500)}`);
    this.name = "ToolError";
  }
}

const MAX_STDOUT = 32 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;

function lineSplitter(onLine: (line: string) => void) {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.search(/\r?\n|\r/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === "\r" && buf[i + 1] === "\n" ? 2 : 1));
        if (line) onLine(line);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = "";
    },
  };
}

export function runTool(bin: string, args: readonly string[], opts: RunToolOptions): Promise<RunToolResult> {
  const tool = bin.split(/[\\/]/).pop() ?? bin;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ToolError(tool, "aborted", null, ""));

    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    let killedFor: "timeout" | "aborted" | null = null;

    const out = lineSplitter((l) => opts.onStdoutLine?.(l));
    const err = lineSplitter((l) => opts.onStderrLine?.(l));
    child.stderr.setEncoding("utf8");
    const onBytes = opts.onStdoutBytes;
    if (onBytes) {
      child.stdout.on("data", (chunk: Buffer) => onBytes(chunk));
    } else {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (opts.captureStdout !== false && stdout.length < MAX_STDOUT) stdout += chunk;
        if (opts.onStdoutLine) out.push(chunk);
      });
    }
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      if (opts.onStderrLine) err.push(chunk);
    });

    const kill = (why: "timeout" | "aborted") => {
      if (killedFor || settled) return;
      killedFor = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = () => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      out.flush();
      err.flush();
      fn();
    };

    child.on("error", (e) => finish(() => reject(new ToolError(tool, "spawn", null, e.message))));
    child.on("close", (code) =>
      finish(() => {
        if (killedFor) reject(new ToolError(tool, killedFor, code, stderrTail));
        else if (code !== 0) reject(new ToolError(tool, "exit", code, stderrTail));
        else resolve({ stdout, stderrTail });
      }),
    );
  });
}
