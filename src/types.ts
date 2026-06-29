// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/** Public types for @userland-run/nano-sdk. */

import type { VMSnapshot } from "./vendor/nanovm.mjs";

export type { VMSnapshot };

export type BinarySource = string | ArrayBuffer | Uint8Array;

// --- configuration ---

export interface ImageConfig {
  /** nano.wasm — required. URL, ArrayBuffer, or Uint8Array. */
  wasm: BinarySource;
  /** BusyBox ELF — only for the small (non-bundled) wasm build. */
  busybox?: BinarySource;
  /** Node.js ELF — only for the small (non-bundled) wasm build. */
  node?: BinarySource;
  /** .tar.gz archives unpacked at boot, in array order. */
  overlays?: BinarySource[];
}

export interface NanoConfig {
  image: ImageConfig;
  /** Scripting engine (Boa / boa.wasm). Omit to leave scripting unavailable. */
  scripting?: ScriptingConfig;
  /**
   * Guest RAM in MB. When omitted, auto-sized for Node (~1.8GB; V8 OOMs below
   * that), keeping guest RAM + the wasm's embedded binaries under the 2GB
   * linear-memory ceiling. BusyBox-only callers can pass a smaller value.
   */
  ramMB?: number;
  /** Pre-JIT the interpreter with a no-op run. Default true. */
  warmup?: boolean;
  /** Guard against missing cross-origin isolation. Default "assert". */
  crossOriginIsolation?: "assert" | "ignore";
}

// --- scripting (Boa) ---

/** Scripting engine configuration (spec §6.1). */
export interface ScriptingConfig {
  /** URL or bytes for boa.wasm. If omitted, scripting is unavailable. */
  wasm: BinarySource;
}

/**
 * Capability grant for a script (spec §4.2). A fresh engine has NO powers; this
 * is the single place that decides what the script can touch.
 */
export interface ExposeConfig {
  /** Filesystem access. Default "none". */
  fs?: "none" | "readonly" | "readwrite";
  /** Allow busybox/sh via `nano.run`/`nano.sh`/`nano.exec`. Default false. */
  run?: boolean;
  /** Allow the in-VM node ELF via `nano.node`. Default false. */
  node?: boolean;
  /** Which boa_runtime WebAPI globals to enable. Default ["console"]. */
  webapis?: Array<"console" | "encoding" | "url" | "timers">;
}

/** Loop-iteration and recursion caps that bound runaway scripts (spec §7). */
export interface RuntimeLimits {
  loopIterations?: number;
  recursion?: number;
}

/** Options for {@link Nano.scripting} / {@link Nano.script} (spec §6.2). */
export interface ScriptEngineOptions {
  expose?: ExposeConfig;
  /** Bridge global name. Default "nano". */
  globalName?: string;
  /** Read-only key/value bag injected as `<global>.env`. */
  env?: Record<string, unknown>;
  limits?: RuntimeLimits;
  /** Host watchdog (ms). On expiry the engine is disposed and the call rejects. */
  timeoutMs?: number;
  /** Expose only synchronous bridge members (skip the async job pump). */
  syncOnly?: boolean;
  /** Route console.log/info output (stdout). */
  onStdout?: (chunk: string) => void;
  /** Route console.warn/error output (stderr). Combined with stdout in worker mode. */
  onStderr?: (chunk: string) => void;
}

/**
 * A sandboxed Boa scripting engine that can drive the VM (spec §6.2). Both the
 * main-thread and worker transports expose this surface.
 */
export interface ScriptEngine {
  /** Parse and evaluate `source`; resolves with the (JSON-marshalled) result. */
  eval(source: string): Promise<unknown>;
  /** Evaluate `source` as an ES module. */
  evalModule(source: string, specifier?: string): Promise<unknown>;
  /** Register a host function callable from scripts (async by default). */
  registerFunction(
    name: string,
    fn: (...args: any[]) => unknown | Promise<unknown>,
  ): void;
  /** Define a plain-data global from a JSON-able value. */
  defineGlobal(name: string, value: unknown): void;
  /** Dispose the engine's context and free its heap. */
  dispose(): void;
}

// --- execution ---

export interface ExecOptions {
  /** Streamed output chunks (combined stdout+stderr). */
  onData?: (chunk: string) => void;
  /** Instruction budget. Default 2_000_000 (raised to 2e9 for node). */
  maxSteps?: number;
}

export interface ExecResult {
  exitCode: number;
  /** Combined stdout+stderr as the guest wrote it. */
  stdout: string;
  cancelled?: boolean;
  snapshotReady?: boolean;
}

export type DirEntryType = "dir" | "file" | "symlink";

export interface DirEntry {
  name: string;
  type: DirEntryType;
  size: number;
}

// --- shell ---

export interface ShellOptions {
  /** Initial working directory. Default "/root". */
  cwd?: string;
  env?: Record<string, string>;
  /** Capture stderr separately via a redirect (loses live interleaving). Default false. */
  captureStderr?: boolean;
  /**
   * Command word that routes a line to the host-side scripting engine instead
   * of BusyBox (spec §6.4). Default "script". Only active when the host exposes
   * `script()` and scripting is configured.
   */
  scriptCommand?: string;
  /** Capability grant for `script` lines. Default { fs:"readwrite", run:true, node:true }. */
  scriptExpose?: ExposeConfig;
}

export interface ShellResult extends ExecResult {
  cwd: string;
  /** Alias of the combined stream. */
  output: string;
  /** Only present when captureStderr is enabled. */
  stderr?: string;
}

/**
 * Transport-agnostic host the Shell drives. Both `Nano` (main thread) and
 * `NanoWorkerClient` (worker) implement it, so identical shell code runs against
 * either. `readText` may be sync (main thread) or async (worker).
 */
export interface ShellHost {
  shExec(line: string, opts?: ExecOptions): Promise<ExecResult>;
  node(args: string[], opts?: ExecOptions): Promise<ExecResult>;
  readText(path: string): string | null | Promise<string | null>;
  /** Host-side scripting (spec §6.4). Present on both transports; routes `script` lines. */
  script?(source: string, opts?: ScriptEngineOptions): Promise<unknown>;
}

// --- serve ---

export interface ConnectionInjector {
  injectConnection(port: number, httpRequest: string): Promise<Uint8Array>;
}

export interface ServeBridgeOptions {
  injector: ConnectionInjector;
  /** URL of the shipped service worker (./service-worker export). */
  swUrl: string;
  /** SW scope; defaults to the SW's directory. */
  scope?: string;
}

export interface ParsedHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface StartServerOptions {
  onReady?: () => void;
  readyPattern?: RegExp;
  onData?: (chunk: string) => void;
}

export type ServerLaunch = { node: string[] } | { command: string };

// --- node runtime ---

export interface NodeRunOptions extends ExecOptions {
  extraFiles?: Array<{ path: string; content: string | Uint8Array }>;
}

// --- terminal (Console front-end) ---

/**
 * Per-feature toggles for the composable terminal. Each feature is `true`/`false`
 * (shorthand) or, where it carries settings, an options object. Omitting a key
 * falls back to the terminal's {@link TerminalConfig} defaults.
 */
export interface TerminalFeatureConfig {
  /** Catalog sidebar (searchable, installable app list). */
  catalog?: boolean;
  /** ⌘K command palette. */
  palette?: boolean;
  /** Files sidebar panel with CRUD on files/folders. */
  files?: boolean;
  /** CodeMirror file editor (opens in the Editor tab). */
  editor?: boolean;
  /** Server-app preview (iframe over the in-VM HTTP server). */
  preview?: boolean | TerminalPreviewConfig;
}

/** Settings for the server-app preview feature. */
export interface TerminalPreviewConfig {
  /** Ports offered in the preview port selector. Default [8080]. */
  ports?: number[];
  /** Port selected when the Preview tab first opens. Default ports[0]. */
  defaultPort?: number;
}

/**
 * Configuration for {@link createTerminal} (the terminal package's factory). The
 * terminal deep-merges this over its built-in defaults, so every field is
 * optional; pass only what you want to override.
 */
export interface TerminalConfig {
  /** nano.wasm URL. Default "/nano.wasm". */
  wasmUrl?: string;
  /** Guest RAM in MB. Default 256. */
  ramMB?: number;
  /** Command booted as the interactive session. Default "sh -i". */
  shellCommand?: string;
  /** Initial terminal font size in px. */
  fontPx?: number;
  /** Service-worker URL backing the preview bridge. Default "/nano-sw.js". */
  serviceWorkerUrl?: string;
  /** Feature toggles; omitted features use the terminal defaults. */
  features?: TerminalFeatureConfig;
}
