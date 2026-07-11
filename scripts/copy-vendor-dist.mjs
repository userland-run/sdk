// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Post-build step (K9): the nodert host-engine runtime is a tree of .mjs
// workers + a node-lib bundle that cannot be flattened into the single tsup
// dist bundle (workers need standalone entry files; the bundle is read at
// runtime). tsup bundles src/index.ts into dist/index.js; this copies the
// vendored worker trees next to it so the runtime resolver in
// src/node/nodert-engine.ts finds dist/vendor/{nodert,kernel} at runtime.
// The nodert worker imports the kernel bus client from ../../../kernel, which
// in the dist layout is dist/vendor/kernel — hence both trees are copied.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcVendor = join(here, "..", "src", "vendor");
const distVendor = join(here, "..", "dist", "vendor");

for (const tree of ["runners/node", "runners/wasm", "kernel"]) {
  const from = join(srcVendor, tree);
  const to = join(distVendor, tree);
  if (!existsSync(from)) {
    console.error(`copy-vendor-dist: ${from} missing — skipping ${tree}`);
    continue;
  }
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
console.error("copy-vendor-dist: dist/vendor/{runners/node,runners/wasm,kernel} refreshed");
