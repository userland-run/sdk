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
