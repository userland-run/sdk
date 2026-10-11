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
   * Guest RAM in MB. When omitted, auto-sized for Node (V8 OOMs below ~1.8GB):
   * `floor(2000 - wasmMB - 20)`, where `wasmMB` is the size of `image.wasm`
   * (assumed ~138MB — the bundled build — when it is a URL), keeping guest RAM
   * + the wasm's embedded binaries under the 2GB linear-memory ceiling.
   * BusyBox-only callers can pass a smaller value (e.g. 256–512).
   */
  ramMB?: number;
  /** Pre-JIT the interpreter with a no-op run. Default true. */
  warmup?: boolean;
  /** Guard against missing cross-origin isolation. Default "assert". */
  crossOriginIsolation?: "assert" | "ignore";
  /**
   * Which engine backs `nano.node()` (spec §14). Two tiers share one Kernel:
   * the RISC-V emulator (`"vm"` — fidelity oracle, native addons) and the
   * host-engine `nodert` tier (`"host"` — JIT speed). `"auto"` runs on nodert
   * and falls back to the VM on a documented `ERR_NODE_HOST_UNSUPPORTED`.
   *
   * `routing` pins specific programs to a tier regardless of the mode
   * (e.g. `{ jest: "vm" }`) — contextify/addon-heavy tools stay on the emulator.
   *
   * Default `{ node: "vm" }`. The nodert runtime is a vendored worker tree
   * loaded at runtime (`dist/vendor/runners/node`, or served at the site root
   * `/vendor/runners/node`). When it can't be loaded (missing tree, or a CSP
   * without `'unsafe-eval'`), `"host"` rejects with an error whose `code` is
   * `ERR_NODE_HOST_RUNTIME_UNAVAILABLE` and `"auto"` silently falls back to the
   * VM. A program nodert can't run (e.g. native addons) fails with
   * `ERR_NODE_HOST_UNSUPPORTED` on `"host"`; `"auto"` falls back to the VM.
   */
  engines?: EngineConfig;
}

/** Engine selection for `nano.node()` (spec §14). */
export interface EngineConfig {
  /** Engine backing `nano.node()`. Default `"vm"`. */
  node?: "vm" | "host" | "auto";
  /**
   * Per-program tier pins (S4), e.g. `{ jest: "vm", "node-gyp": "vm" }`. Keyed
   * by the entry script/bin basename; a pin beats `node`. Inline `-e`/`-p` code
   * has no entry and always uses the default.
   */
  routing?: Record<string, "vm" | "host">;
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
  /**
   * Working directory. Only `node()` honors it (`run`/`exec`/`shExec` start at
   * "/" — `cd` inside the line instead). On the host engine it is passed
   * through; on the VM it is applied via an sh wrapper that needs
   * `/usr/bin/node` in the VFS (with only an embedded node ELF it is ignored).
   */
  cwd?: string;
  /** Extra environment variables. Same rules as {@link ExecOptions.cwd}: `node()` only. */
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  /** Combined stdout+stderr as the guest wrote it. */
  stdout: string;
  cancelled?: boolean;
  snapshotReady?: boolean;
}

/** Options for {@link Nano.execWasmApp} (a registered wasm-app run directly on the wasm tier). */
export interface WasmAppExecOptions {
  /** Working directory (default "/"). Relative paths resolve against it; absolute paths work too. */
  cwd?: string;
  /** Environment variables for the app (`PWD` is always set to `cwd`). */
  env?: Record<string, string>;
  /** Bytes (or UTF-8 text) fed to the app's stdin, then EOF. Without it stdin is EOF immediately. */
  stdin?: Uint8Array | string;
  /** Wall-clock limit in ms (default 15 minutes — sized for batch image/PDF jobs). Exit code 124 on timeout. */
  timeoutMs?: number;
}

/** Result of {@link Nano.execWasmApp}: decoded text plus the raw (binary-safe) bytes. */
export interface WasmAppExecResult {
  exitCode: number;
  /** stdout decoded as UTF-8. */
  stdout: string;
  /** stderr decoded as UTF-8. */
  stderr: string;
  /** stdout exactly as written (e.g. an image an app streamed to stdout). */
  stdoutBytes: Uint8Array;
  /** stderr exactly as written. */
  stderrBytes: Uint8Array;
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
  /** Inject one raw HTTP/1.1 request (string, or bytes for binary bodies). */
  injectConnection(port: number, httpRequest: string | Uint8Array): Promise<Uint8Array>;
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

export interface NodeRunOptions extends Omit<ExecOptions, "cwd" | "env"> {
  extraFiles?: Array<{ path: string; content: string | Uint8Array }>;
}

// --- terminal (Console front-end) ---

/**
 * Per-feature toggles for the composable terminal. Each feature is `true`/`false`
 * (shorthand) or, where it carries settings, an options object. Omitting a key
 * falls back to the terminal's {@link TerminalConfig} defaults.
 */
export interface TerminalFeatureConfig {
  /** Catalog sidebar (searchable, installable app list). Default on. */
  catalog?: boolean;
  /** ⌘K command palette. Default on. */
  palette?: boolean;
  /** Files sidebar panel with CRUD on files/folders. Default on. */
  files?: boolean;
  /** CodeMirror file editor (opens in the Editor tab). Default on. */
  editor?: boolean;
  /** Server-app preview (iframe over the in-VM HTTP server). Default on. */
  preview?: boolean | TerminalPreviewConfig;
  /** AI assistant sidebar panel (Chrome Prompt API + optional cloud model). */
  assistant?: boolean;
}

/** Settings for the server-app preview feature. */
export interface TerminalPreviewConfig {
  /** Ports offered in the preview port selector. Default [8080]. */
  ports?: number[];
  /** Port selected when the Preview tab first opens. Default ports[0]. */
  defaultPort?: number;
}

/** One conversational turn passed to a cloud model. */
export interface AssistantChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A request handed to a host-injected cloud `generate` callback. */
export interface CloudRequest {
  system: string;
  messages: AssistantChatTurn[];
  /** When set, the model must return JSON conforming to this schema. */
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Host-injected cloud model for the assistant. Prefer `generate` (keys live in
 * the host's proxy, so nothing ships in the client); `endpoint` is a convenience
 * for a plain JSON HTTP proxy returning `{ text }`.
 */
export interface CloudModelConfig {
  label?: string;
  generate?: (req: CloudRequest) => Promise<string>;
  endpoint?: string;
  headers?: Record<string, string>;
}

/** Assistant wiring (e.g. an optional cloud model alongside on-device Nano). */
export interface TerminalAssistantConfig {
  cloud?: CloudModelConfig;
}

/**
 * Configuration for {@link createTerminal} (the terminal package's factory). The
 * terminal deep-merges this over its built-in defaults, so every field is
 * optional; pass only what you want to override.
 */
export interface TerminalConfig {
  /** nano.wasm URL. Default "/nano.wasm". */
  wasmUrl?: string;
  /** Guest RAM in MB. Default 1800 (V8/Node OOMs below ~1.8 GB). */
  ramMB?: number;
  /** Command booted as the interactive session. Default "sh -i". */
  shellCommand?: string;
  /** Initial terminal font size in px. Default 12. */
  fontPx?: number;
  /** Service-worker URL backing the preview bridge. Default "/nano-sw.js". */
  serviceWorkerUrl?: string;
  /** Feature toggles; omitted features default to on (set `false` to disable). */
  features?: TerminalFeatureConfig;
  /** Assistant wiring (e.g. an optional cloud model). */
  assistant?: TerminalAssistantConfig;
}
