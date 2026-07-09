// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Types for the terminal DISPLAY service — `@userland-run/nano-sdk/terminal`.
// Hand-authored (the implementation is bundled from the @userland-run/terminal
// source, whose own ambient WebGPU/container types aren't threaded through the
// SDK's d.ts build). Mirrors the canonical TerminalConfig in src/types.ts.

export interface TerminalPreviewConfig {
  /** Ports offered in the preview port selector. Default [8080]. */
  ports?: number[];
  /** Port selected when the Preview tab first opens. Default ports[0]. */
  defaultPort?: number;
}

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
  /** AI assistant panel (Chrome Prompt API + optional cloud/local). Default on. */
  assistant?: boolean;
}

/** The assistant's permission mode (Claude-Code-style). Default "ask". */
export type AssistantMode = "plan" | "ask" | "acceptEdits" | "auto";

/** A request handed to a host-injected cloud `generate` callback. */
export interface CloudRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Host-injected cloud model wiring. Prefer `generate` (API keys live in the
 * host's proxy — the component ships no secrets); `endpoint` is a convenience
 * for a plain JSON HTTP proxy that returns `{ text }`.
 */
export interface CloudModelConfig {
  label?: string;
  generate?: (req: CloudRequest) => Promise<string>;
  endpoint?: string;
  headers?: Record<string, string>;
}

/** Local WebGPU model (nanoinfer engine) wiring. */
export interface LocalModelConfig {
  /** "qwen" (default, 1.5B GGUF) or "ornith" (the 9B GDN hybrid). */
  engine?: "qwen" | "ornith";
  /** Model URL: GGUF for qwen, packed Q4 safetensors for ornith. */
  ggufUrl?: string;
  /** tokenizer.json URL. */
  tokenizerUrl?: string;
  /** Base URL of the nanoinfer wasm-bindgen bundle. */
  engineBase?: string;
  /** KV capacity in tokens (bounds prompt + generation). Default 2048. */
  maxSeq?: number;
  label?: string;
}

/** Assistant wiring: enable/defaults + optional cloud & local model backends. */
export interface TerminalAssistantConfig {
  /** Enable the assistant (default on; parallels `features.assistant`). */
  enabled?: boolean;
  /** Model selected when the panel first opens. Default "nano". */
  defaultModel?: "nano" | "cloud" | "local";
  /** Permission mode the chat starts in. Default "ask". */
  defaultMode?: AssistantMode;
  /** Optional host-injected cloud model. */
  cloud?: CloudModelConfig;
  /** Local WebGPU model; `false` hides it, omit to auto-offer when available. */
  local?: LocalModelConfig | false;
}

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
  /** Feature toggles; omitted features use the defaults above. */
  features?: TerminalFeatureConfig;
  /** Assistant wiring (enable, default model/mode, optional cloud/local). */
  assistant?: TerminalAssistantConfig;
}

/** Install-progress event surfaced by {@link TerminalHandle.installApp}. */
export interface InstallProgress {
  phase: "index" | "manifest" | "chunk" | "write" | "done";
  file?: string;
  chunk?: string;
  fetched?: number;
  total?: number;
}

/** Options for {@link TerminalHandle.installApp}. */
export interface InstallAppOptions {
  /** Receives the installer's phase/chunk events (e.g. to drive a progress bar). */
  onProgress?: (e: InstallProgress) => void;
  /** Suppress the in-terminal install echo — keep the shell pane clean. */
  quiet?: boolean;
}

/** Programmatic handle returned by {@link createTerminal}. */
export interface TerminalHandle {
  /** The running NanoVM instance (read/write the VFS, run commands). */
  vm: unknown;
  /**
   * Install a catalog app ("name" or "name@version") into the running guest's
   * VFS — the SDK's verified, OPFS-cached, persisted installer (the same path
   * the catalog sidebar uses). `onProgress` receives phase/chunk events; `quiet`
   * suppresses the in-terminal echo. Resolves `true` on success; rejects if the
   * catalog feature is disabled. Use it to provision a toolchain (e.g. node +
   * tsc) on boot without leaving the SDK.
   */
  installApp: (ref: string, opts?: InstallAppOptions) => Promise<boolean>;
  /** Open a guest file in the Editor tab (no-op if the editor is disabled). */
  openFile: (path: string) => void;
  /** Reveal the Preview tab on a port (no-op if preview is disabled). */
  showPreview: (port?: number) => void;
  /** Re-list the Files panel tree (after external FS changes). */
  refreshFiles: () => void;
}

/**
 * Mount a composable terminal into `target` (a selector, element, or shadow
 * root). It injects its own scaffold + scoped stylesheet, boots a NanoVM, and
 * resolves once the interactive session is live. Prefer {@link defineNanoTerminal}
 * + the `<nano-terminal>` element for declarative use.
 */
export function createTerminal(
  target?: string | HTMLElement | ShadowRoot,
  config?: TerminalConfig,
): Promise<TerminalHandle>;

/** The `<nano-terminal>` custom element (Shadow DOM; fully CSS-encapsulated). */
export declare class NanoTerminalElement extends HTMLElement {
  /** Programmatic config; merged over (and overriding) attribute-derived config. */
  config: TerminalConfig;
  /** Resolves to the running {@link TerminalHandle} once booted (null before connect). */
  get ready(): Promise<TerminalHandle> | null;
  connectedCallback(): void;
}

/** Register the `<nano-terminal>` custom element (idempotent). */
export function defineNanoTerminal(tag?: string): void;
