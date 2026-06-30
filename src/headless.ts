// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// The HEADLESS feature service — the same capabilities the terminal surfaces in
// its UI (files, catalog, run, serve/preview), exposed programmatically with no
// terminal rendered. It is the counterpart to the `/terminal` DISPLAY service:
//
//   import { createHeadless } from "@userland-run/nano-sdk";
//   const s = await createHeadless({ wasmUrl: "/nano/nano.wasm" });
//   await s.installApp("ripgrep");                 // catalog feature
//   s.fs.writeFile("/work/x.js", "console.log(1)"); // files feature
//   await s.run("node /work/x.js");                 // run feature
//   const srv = await s.serve({ node: ["/work/server.js"] }, { port: 3000 }); // preview feature
//
// This is a thin facade over the in-process Nano core (fs + run + catalog) plus
// the serve bridge — the same building blocks createTerminal wires into its UI.

import { createNano, type Nano } from "./core/nano";
import { ServeBridge, startServer } from "./serve/bridge";
import type { Catalog } from "./catalog/catalog";
import type { InstallOptions, Manifest } from "./catalog/types";
import type { ExecOptions, ExecResult, ServerLaunch } from "./types";

export interface HeadlessConfig {
  /** nano.wasm URL (or bytes). Default "/nano.wasm". */
  wasmUrl?: string;
  /** Guest RAM in MB. Default 1800 (V8/Node OOMs below ~1.8 GB). */
  ramMB?: number;
  /** Service-worker URL backing the preview bridge (only needed for serve()). */
  serviceWorkerUrl?: string;
}

/** A server started by {@link HeadlessSession.serve}. */
export interface HeadlessServer {
  /** Preview URL for the bound port, routed through the service worker. */
  url: (path?: string) => string;
  /** Stop the server (cancels its run). */
  stop: () => void;
}

export interface HeadlessServeOptions {
  /** Port the in-VM server binds (for the preview URL). Default 8080. */
  port?: number;
  /** Output pattern signalling readiness. Default /listening/i. */
  readyPattern?: RegExp;
  /** Stream server stdout. */
  onData?: (chunk: string) => void;
}

/**
 * The headless session: the terminal's features, no UI. Mirrors the parts of a
 * {@link TerminalHandle} that aren't about rendering.
 */
export interface HeadlessSession {
  /** The underlying in-process VM (escape hatch). */
  readonly vm: Nano;
  /** Filesystem CRUD (the "files" feature). */
  readonly fs: Nano["fs"];
  /** The catalog client (the "catalog" feature). */
  catalog(): Catalog;
  /** Install a signed catalog app into this VM. */
  installApp(ref: string, opts?: InstallOptions): Promise<Manifest>;
  /** Run a BusyBox/binary command (whitespace-split argv). */
  run(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Run a full shell line (pipes, redirects) via `sh`. */
  sh(line: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Start an in-VM HTTP server and get a preview URL (the "preview" feature). */
  serve(launch: ServerLaunch, opts?: HeadlessServeOptions): Promise<HeadlessServer>;
}

/** Boot a headless session exposing the terminal's features without any UI. */
export async function createHeadless(config: HeadlessConfig = {}): Promise<HeadlessSession> {
  const vm = await createNano({
    image: { wasm: config.wasmUrl ?? "/nano.wasm" },
    ramMB: config.ramMB ?? 1800,
  });
  let bridge: ServeBridge | null = null;

  return {
    vm,
    fs: vm.fs,
    catalog: () => vm.catalog(),
    installApp: (ref, opts) => vm.installApp(ref, opts),
    run: (command, opts) => vm.run(command, opts),
    sh: (line, opts) => vm.shExec(line, opts),
    async serve(launch, opts = {}) {
      const port = opts.port ?? 8080;
      bridge ??= await ServeBridge.register({
        swUrl: config.serviceWorkerUrl ?? "/nano-sw.js",
        injector: vm,
      });
      const { stop } = await startServer(vm, launch, {
        readyPattern: opts.readyPattern,
        onData: opts.onData,
      });
      return { url: (path?: string) => bridge!.previewUrl(port, path), stop };
    },
  };
}
