// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Browser test harness. Imports the built SDK (the `@userland-run/nano-sdk`
 * alias → ../../dist/index.js, see vite.config.ts) and publishes a handful of
 * boot helpers on `window`. Specs call them through `page.evaluate(...)`, so the
 * NanoVM instance never has to cross the Playwright boundary — only plain JSON
 * results do.
 */
import * as NanoSDK from "@userland-run/nano-sdk";

/** Fixtures staged at the site root by scripts/sync-fixtures.mjs. */
const FIX = {
  /** Slim build, no bundled ELF — required when supplying the Node ELF via image.node. */
  slim: "/nano.wasm",
  /** BusyBox bundled in-wasm — gives `sh` for shExec / overlay dev tools. */
  busybox: "/nano.busybox.wasm",
  boa: "/boa.wasm",
  node: "/node",
  /** node + tsc/eslint/prettier (built from the catalog recipe trees). */
  devtools: "/devtools.overlay",
  sw: "/nano-sw.js",
} as const;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fixture ${url} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

interface BootOpts {
  /** "busybox" (default) or any fixture key / explicit URL. */
  wasm?: keyof typeof FIX | string;
  /** Stage the Node.js ELF as image.node and let RAM auto-size for V8. */
  node?: boolean;
  /** Apply a tar.gz overlay at boot (e.g. "devenv" → node + tsc/eslint/prettier). */
  overlay?: keyof typeof FIX | string;
  /** Wire boa.wasm for scripting mode. */
  scripting?: boolean;
  /** Override guest RAM (MB). */
  ramMB?: number;
}

function resolveFixture(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  return (FIX as Record<string, string>)[key] ?? key;
}

/** Boot a main-thread Nano against a fixture, auto-sizing RAM for Node paths. */
async function boot(opts: BootOpts = {}) {
  // image.node only takes effect on the slim build (the busybox-bundled wasm
  // already assigns its single bundled ELF to _nodeElf). Overlay/dev-tool boots
  // keep busybox for `sh` and run Node from the overlay's PATH instead.
  const defaultWasm = opts.node ? FIX.slim : FIX.busybox;
  const image: { wasm: Uint8Array; node?: Uint8Array; overlays?: Uint8Array[] } = {
    wasm: await fetchBytes(resolveFixture(opts.wasm, defaultWasm)),
  };
  if (opts.node) image.node = await fetchBytes(FIX.node);
  if (opts.overlay) image.overlays = [await fetchBytes(resolveFixture(opts.overlay, opts.overlay))];

  const config: Record<string, unknown> = { image };
  // BusyBox-only boots cap RAM low; Node (direct ELF or via an overlay) needs the
  // SDK's ~1.8 GB auto-size, so we leave ramMB unset there unless overridden.
  if (opts.ramMB != null) config.ramMB = opts.ramMB;
  else if (!opts.node && !opts.overlay) config.ramMB = 512;
  if (opts.scripting) config.scripting = { wasm: await fetchBytes(FIX.boa) };

  return NanoSDK.createNano(config as Parameters<typeof NanoSDK.createNano>[0]);
}

/** Boot a worker-hosted Nano (default transport: new Worker(new URL(...))). */
async function bootWorker(opts: BootOpts = {}) {
  const image: { wasm: Uint8Array; node?: Uint8Array } = {
    wasm: await fetchBytes(resolveFixture(opts.wasm, FIX.busybox)),
  };
  if (opts.node) image.node = await fetchBytes(FIX.node);
  const config: Record<string, unknown> = { image };
  if (opts.ramMB != null) config.ramMB = opts.ramMB;
  else if (!opts.node) config.ramMB = 512;
  return NanoSDK.createNanoWorker(config as Parameters<typeof NanoSDK.createNanoWorker>[0]);
}

const w = window as unknown as Record<string, unknown>;
w.NanoSDK = NanoSDK;
w.fetchBytes = fetchBytes;
w.FIX = FIX;
w.boot = boot;
w.bootWorker = bootWorker;

// Diagnostics surfaced in the page so failed boots are legible in traces.
const set = (id: string, v: unknown): void => {
  const el = document.getElementById(id);
  if (el) el.textContent = String(v);
};
set("coi", (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false);
set("sab", typeof SharedArrayBuffer !== "undefined");
set("status", "ready");
w.__harnessReady = true;
