// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Headless tool runs: install the tool's catalog apps into a Nano, expand and
 * validate the preset's command, run it with shExec in the working directory,
 * and report the folder changes.
 */

import { normDir, toFolderVfs, walkVfs } from "../folder/target";
import type { FolderDiff } from "../folder/types";
import { BUILTIN_TOOLS } from "./builtin";
import { envExports, expandCommand, matchingFiles, resolveValues, toolApps, validateCommand, validateValues } from "./template";
import type { ToolApp, ToolDefinition, ToolProgress, ToolValues } from "./types";

/** The slice of `Nano` a tool run needs (structural, so this module stays light). */
export interface ToolNano {
  fs: {
    list(path: string): unknown;
    readFile(path: string): unknown;
    writeFile(path: string, content: string | Uint8Array, mode?: number): unknown;
    mkdir(path: string): unknown;
  };
  installApp(ref: string, opts?: { onProgress?: (e: { phase: string; fetched?: number; total?: number }) => void }): Promise<{ name: string; version: string }>;
  registerWasmApp(name: string, bytes: Uint8Array): Promise<unknown>;
  shExec(line: string, opts?: { onData?: (chunk: string) => void; maxSteps?: number }): Promise<{ exitCode: number; stdout: string; cancelled?: boolean }>;
  cancel(): void;
}

/**
 * Alternative app source: bytes of a wasm-app module to register instead of
 * installing `app.ref` from the signed catalog (development builds, tests,
 * self-hosted apps). Leave unset in production.
 */
export type ToolAppSource = (app: Required<ToolApp>) => Promise<Uint8Array>;

/** Something with a `diff()` — a MountedFolder from `@userland-run/nano-sdk/folder`. */
export interface DiffableFolder {
  diff(): Promise<FolderDiff>;
}

export interface RunToolOptions {
  /** A definition, or a built-in id ("exif", "pdf", "csv-sql"). */
  tool: ToolDefinition | string;
  /** Preset id (default: the first). */
  preset?: string;
  /** Field values (defaults fill the rest). Secret (`env`) fields are exported, not templated. */
  values?: ToolValues;
  /**
   * Run this command instead of the preset's template (e.g. the user edited
   * the command box). It must invoke one of the tool's commands; the preset's
   * secret fields are still exported.
   */
  command?: string;
  /** Working directory (default "/work"). */
  cwd?: string;
  /** Files for template expansion (relative to cwd). Default: a walk of cwd. */
  files?: string[];
  /** The mounted folder; when given, `changes` is its diff after the run. */
  folder?: DiffableFolder;
  appSource?: ToolAppSource;
  onProgress?: (p: ToolProgress) => void;
  /** Streamed combined stdout+stderr. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  /**
   * Guest instruction budget for the run. Default: 2e9, or for RISC-V-tier
   * apps `stepsPerFile` × matching files (capped at 1e13) — cancel is the
   * real guard.
   */
  maxSteps?: number;
}

export interface RunToolResult {
  exitCode: number;
  /** Combined stdout+stderr. */
  output: string;
  /** The command that ran. */
  command: string;
  /** New / changed / removed files (when `folder` was given). */
  changes: FolderDiff | null;
  cancelled: boolean;
}

const installed = new WeakMap<object, Set<string>>();

/** Instruction budget for a run of `def` over `files` (see {@link ToolDefinition.stepsPerFile}). */
export function stepBudget(def: ToolDefinition, files: string[]): number {
  const base = 2_000_000_000;
  if (!toolApps(def).some((a) => a.tier === "riscv")) return base;
  const n = Math.max(1, matchingFiles({ files }, def.accepts).length);
  return Math.min(1e13, Math.max(base, (def.stepsPerFile ?? base) * n + base));
}

export function resolveTool(tool: ToolDefinition | string): ToolDefinition {
  if (typeof tool !== "string") return tool;
  const def = BUILTIN_TOOLS[tool];
  if (!def) throw new Error(`nano-sdk/tools: unknown tool "${tool}" (built-ins: ${Object.keys(BUILTIN_TOOLS).join(", ")})`);
  return def;
}

/**
 * Make a tool's apps runnable in `nano`: `installApp` from the signed catalog
 * (wasm apps are registered as shell commands), or register bytes from
 * `appSource`. Idempotent per Nano.
 */
export async function installToolApps(
  nano: ToolNano,
  tool: ToolDefinition | string,
  opts: { appSource?: ToolAppSource; onProgress?: (p: ToolProgress) => void } = {},
): Promise<void> {
  const def = resolveTool(tool);
  const have = installed.get(nano) ?? new Set<string>();
  installed.set(nano, have);
  for (const app of toolApps(def)) {
    const key = `${opts.appSource ? "src:" : ""}${app.ref}`;
    if (have.has(key)) continue;
    if (opts.appSource) {
      opts.onProgress?.({ phase: "install", label: `loading ${app.ref}…`, fraction: null });
      const bytes = await opts.appSource(app);
      if (app.tier === "riscv") await nano.fs.writeFile(`/usr/bin/${app.command}`, bytes, 0o755);
      else await nano.registerWasmApp(app.command, bytes);
    } else {
      opts.onProgress?.({ phase: "install", label: `installing ${app.ref}…`, fraction: null });
      await nano.installApp(app.ref, {
        onProgress: (e) =>
          opts.onProgress?.({
            phase: "install",
            label: `installing ${app.ref} · ${e.phase}${e.total ? ` ${e.fetched ?? 0}/${e.total}` : ""}`,
            fraction: e.total ? (e.fetched ?? 0) / e.total : null,
          }),
      });
    }
    have.add(key);
  }
}

/** Relative file paths under `cwd` in the VM. */
export async function listToolFiles(nano: ToolNano, cwd = "/work"): Promise<string[]> {
  const vfs = toFolderVfs(nano as never);
  const { files } = await walkVfs(vfs, normDir(cwd));
  return files;
}

/**
 * Run a tool preset (or an edited command) on the files in `cwd`.
 *
 * ```ts
 * const folder = await mountFolder(nano, dirHandle, { at: "/work" });
 * const r = await runTool(nano, { tool: "pdf", preset: "merge", folder });
 * if (r.exitCode === 0) await folder.writeBack();
 * ```
 */
export async function runTool(nano: ToolNano, opts: RunToolOptions): Promise<RunToolResult> {
  const def = resolveTool(opts.tool);
  const preset = opts.preset ? def.presets.find((p) => p.id === opts.preset) : def.presets[0];
  if (!preset) throw new Error(`nano-sdk/tools: ${def.id} has no preset "${opts.preset}"`);
  const cwd = normDir(opts.cwd ?? "/work");
  const signal = opts.signal;
  if (signal?.aborted) throw new Error("nano-sdk/tools: aborted");

  await installToolApps(nano, def, { appSource: opts.appSource, onProgress: opts.onProgress });
  const files = opts.files ?? (await listToolFiles(nano, cwd));
  const ctx = { files };
  const values = resolveValues(preset, opts.values, ctx);
  const errors = validateValues(preset, values);
  if (errors.length) throw new Error(`nano-sdk/tools: ${errors.join("; ")}`);
  let command: string;
  if (opts.command !== undefined) {
    const ok = validateCommand(def, opts.command.trim());
    if (!ok) throw new Error(`nano-sdk/tools: the command must be one line that runs ${toolApps(def).map((a) => a.command).join(" or ")}`);
    command = ok;
  } else {
    command = expandCommand(preset, values, ctx);
  }

  opts.onProgress?.({ phase: "run", label: `running ${toolApps(def).map((a) => a.command).join(", ")}…`, fraction: null });
  const script = `${envExports(preset, values)}cd ${cwd} || exit 1\n${command}\n`;
  let output = "";
  const onAbort = () => nano.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  let r: { exitCode: number; stdout: string; cancelled?: boolean };
  try {
    r = await nano.shExec(script, {
      maxSteps: opts.maxSteps ?? stepBudget(def, files),
      onData: (chunk) => {
        output += chunk;
        opts.onOutput?.(chunk);
      },
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (!output && r.stdout) {
    output = r.stdout;
    opts.onOutput?.(r.stdout);
  }
  const cancelled = !!r.cancelled || !!signal?.aborted;
  let changes: FolderDiff | null = null;
  if (opts.folder) {
    opts.onProgress?.({ phase: "diff", label: "collecting results…", fraction: null });
    changes = await opts.folder.diff();
  }
  return { exitCode: r.exitCode, output, command, changes, cancelled };
}
