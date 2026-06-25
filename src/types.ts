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
