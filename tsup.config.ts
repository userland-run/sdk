// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { defineConfig } from "tsup";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "worker/worker": "src/worker/worker.ts",
    // The terminal DISPLAY service (UI: <nano-terminal> + createTerminal),
    // bundled from the sibling @userland-run/terminal source.
    terminal: "src/terminal.ts",
    // The on-device-AI assistant's WebGPU model worker. The terminal source
    // spawns it via `new Worker(new URL("./local-worker.ts", import.meta.url))`
    // (Vite's worker syntax); esbuild/tsup leaves that URL verbatim, so we emit
    // the worker as its own standalone entry (dist/local-worker.js) and the
    // onSuccess step rewrites terminal.js's `.ts` reference to `.js`. Without
    // this, a webpack/Next consumer can't resolve "./local-worker.ts".
    "local-worker": "../terminal/src/assistant/local-worker.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  // Types only for the headless entries here; the terminal entry ships a
  // hand-authored types/terminal.d.ts (its source pulls @webgpu/@container
  // ambient types that needn't be threaded through this build).
  dts: { entry: { index: "src/index.ts", "worker/worker": "src/worker/worker.ts" } },
  bundle: true,
  // Each entry is self-contained (no shared chunks) so the worker entry can be
  // loaded standalone via `new Worker(new URL(".../worker", import.meta.url))`.
  splitting: false,
  sourcemap: true,
  clean: true,
  // K9: the nodert host-engine runtime can't be flattened into the bundle
  // (workers + a node-lib blob loaded at runtime). Copy the vendored worker
  // trees next to dist so nodert-engine.ts resolves dist/vendor/{nodert,kernel}.
  onSuccess: "node scripts/copy-vendor-dist.mjs && node scripts/patch-terminal-worker.mjs",
  // The vendored .mjs runtime + the terminal's UI deps (codemirror/lucide) are
  // bundled in; nothing is left external.
  noExternal: [/.*/],
  esbuildOptions(options) {
    // The terminal source addresses the runtime + core through aliases; point
    // them at the SDK's own vendored NanoVM and its public entry.
    options.alias = {
      ...(options.alias ?? {}),
      "@container/nanovm.mjs": path.resolve(here, "src/vendor/nanovm.mjs"),
      "@sdk": path.resolve(here, "src/index.ts"),
    };
  },
});
