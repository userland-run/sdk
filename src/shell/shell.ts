// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type {
  ExecOptions,
  ExecResult,
  ExposeConfig,
  ShellHost,
  ShellOptions,
  ShellResult,
} from "../types";

export type { ShellHost };

const STDERR_FILE = "/tmp/.nano-shell-stderr";
const CWD_FILE = "/tmp/.nano-shell-cwd";
const CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";

/** Shell control characters that disqualify a line from direct node-routing (§8.4). */
const CONTROL_CHARS = ["|", "&", ";", "<", ">", "(", ")", "$", "`", "\\", '"'];
function hasControlOperators(line: string): boolean {
  return CONTROL_CHARS.some((c) => line.includes(c));
}

function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Quote-aware tokenizer: splits on whitespace, respecting '…' and "…". */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Render a script's result value as a terminal line (strings verbatim, else JSON). */
function formatScriptResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.endsWith("\n") ? text : text + "\n";
}

/**
 * Stateful, renderer-agnostic terminal engine. Tracks cwd/env in JS (the VM
 * resets cwd to "/" per run, §2.6) and persists state through the filesystem
 * (§2.5). Wire it to any UI: feed lines on Enter, render the prompt from `cwd`.
 */
export class Shell {
  cwd: string;
  env: Record<string, string>;
  private readonly captureStderr: boolean;
  private readonly scriptCommand: string;
  private readonly scriptExpose: ExposeConfig;

  constructor(
    private readonly host: ShellHost,
    opts: ShellOptions = {},
  ) {
    this.cwd = opts.cwd ?? "/root";
    this.env = { ...(opts.env ?? {}) };
    this.captureStderr = opts.captureStderr ?? false;
    this.scriptCommand = opts.scriptCommand ?? "script";
    this.scriptExpose = opts.scriptExpose ?? { fs: "readwrite", run: true, node: true };
  }

  async run(line: string, opts?: ExecOptions): Promise<ShellResult> {
    const trimmed = line.trim();
    if (trimmed === "") return this.result({ exitCode: 0, stdout: "" });

    // 1. JS builtins (mutate shell state instead of a throwaway child).
    const builtin = this.tryBuiltin(trimmed, opts);
    if (builtin) return builtin;

    // 1.5 host-side scripting: `script <source>` → Boa engine, not BusyBox (§6.4).
    if (this.host.script && trimmed.startsWith(this.scriptCommand + " ")) {
      return this.runScript(trimmed.slice(this.scriptCommand.length + 1), opts);
    }

    // 2. node routing: `node …` with no shell control operators.
    if (/^node\s/.test(trimmed) && !hasControlOperators(trimmed)) {
      const args = tokenize(trimmed).slice(1);
      return this.result(await this.host.node(args, opts));
    }

    // 3. general command: per-command script via shExec, then cwd round-trip.
    const res = await this.host.shExec(this.buildScript(trimmed), opts);

    const newCwd = await this.host.readText(CWD_FILE);
    if (typeof newCwd === "string" && newCwd.trim()) this.cwd = newCwd.trim();

    let stderr: string | undefined;
    if (this.captureStderr) {
      const e = await this.host.readText(STDERR_FILE);
      stderr = typeof e === "string" ? e : "";
    }
    return this.result(res, stderr);
  }

  /** Run a `script <source>` line on the host-side engine, streaming console output. */
  private async runScript(rawSource: string, opts?: ExecOptions): Promise<ShellResult> {
    const source = unquote(rawSource);
    try {
      const value = await this.host.script!(source, {
        expose: this.scriptExpose,
        onStdout: opts?.onData,
        onStderr: opts?.onData,
      });
      const text = formatScriptResult(value);
      if (text) opts?.onData?.(text);
      return this.result({ exitCode: 0, stdout: text });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) + "\n";
      opts?.onData?.(msg);
      return this.result({ exitCode: 1, stdout: msg });
    }
  }

  private tryBuiltin(line: string, opts?: ExecOptions): ShellResult | null {
    // Only a clean, single `export KEY=value` (no operators/expansion) is handled
    // in JS so it persists to this.env; anything fancier runs in the script via sh.
    if (!hasControlOperators(line)) {
      const exp = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (exp) {
        this.env[exp[1] as string] = unquote(exp[2] as string);
        return this.result({ exitCode: 0, stdout: "" });
      }
    }
    if (line === "pwd") {
      const out = this.cwd + "\n";
      opts?.onData?.(out);
      return this.result({ exitCode: 0, stdout: out });
    }
    if (line === "clear") {
      opts?.onData?.(CLEAR_SEQUENCE);
      return this.result({ exitCode: 0, stdout: CLEAR_SEQUENCE });
    }
    return null;
  }

  /** Per-command script template (§8.2). */
  private buildScript(line: string): string {
    const exports = Object.entries(this.env).map(
      ([k, v]) => `export ${k}=${shSingleQuote(v)}`,
    );
    const body = this.captureStderr ? `( ${line} ) 2> ${STDERR_FILE}` : line;
    return [
      ...exports,
      `cd ${shSingleQuote(this.cwd)} 2>/dev/null || cd /`,
      body,
      "__nano_rc=$?",
      `pwd > ${CWD_FILE}`,
      "exit $__nano_rc",
    ].join("\n");
  }

  private result(res: ExecResult, stderr?: string): ShellResult {
    const out: ShellResult = { ...res, cwd: this.cwd, output: res.stdout };
    if (stderr !== undefined) out.stderr = stderr;
    return out;
  }
}
