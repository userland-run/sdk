// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The Playwright e2e harness (tests/e2e/index.html) imports the *built* SDK and
// boots a real NanoVM in the browser. NanoVM allocates a shared
// WebAssembly.Memory, which needs the page to be cross-origin isolated — so we
// send COOP/COEP on both the dev server and `vite preview` (Playwright tests
// against the preview build). `credentialless` keeps cross-origin assets simple.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  // Serve the harness, not the package. Fixtures live in tests/e2e/public and
  // are served at the site root (/nano.busybox.wasm, /node, /catalog/index.json …).
  root: fileURLToPath(new URL("./tests/e2e", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./tests/e2e/dist", import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      // Consume the SDK exactly as a published consumer would. The bundled
      // dist/index.js carries the `new Worker(new URL("./worker/worker.js", …))`
      // call, so Vite picks up and emits the worker chunk for the worker tests.
      "@userland-run/nano-sdk": fileURLToPath(new URL("./dist/index.js", import.meta.url)),
    },
  },
  server: {
    headers: coiHeaders,
    // The aliased SDK bundle + its worker chunk live in the repo root (dist/),
    // outside the tests/e2e root — let Vite serve across the workspace.
    fs: { allow: [repoRoot, workspaceRoot] },
  },
  preview: {
    headers: coiHeaders,
  },
});
