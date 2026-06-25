// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "worker/worker": "src/worker/worker.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  bundle: true,
  // Each entry is self-contained (no shared chunks) so the worker entry can be
  // loaded standalone via `new Worker(new URL(".../worker", import.meta.url))`.
  splitting: false,
  sourcemap: true,
  clean: true,
  // The vendored .mjs runtime is bundled in; it has no external deps.
  noExternal: [/.*/],
});
