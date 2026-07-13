// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Post-build: the terminal source spawns its on-device-AI worker via
// `new Worker(new URL("./local-worker.ts", import.meta.url), { type: "module" })`
// (Vite worker syntax). esbuild/tsup leaves that URL verbatim, but we emit the
// worker as its own bundle at dist/local-worker.js — so rewrite the reference in
// dist/terminal.js from ".ts" to ".js". The strings are the same length, so the
// sourcemap stays valid. Without this, webpack/Next consumers fail with
// "Can't resolve './local-worker.ts'".

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const terminalJs = join(dist, "terminal.js");
const workerJs = join(dist, "local-worker.js");

if (!existsSync(terminalJs)) {
  console.error("patch-terminal-worker: dist/terminal.js missing — skipped");
  process.exit(0);
}
if (!existsSync(workerJs)) {
  console.error("patch-terminal-worker: dist/local-worker.js missing (add the tsup entry) — skipped");
  process.exit(0);
}

const src = readFileSync(terminalJs, "utf8");
const needle = './local-worker.ts';
const count = src.split(needle).length - 1;
if (count === 0) {
  console.error("patch-terminal-worker: no './local-worker.ts' reference found (already patched?)");
  process.exit(0);
}
writeFileSync(terminalJs, src.split(needle).join('./local-worker.js'));
console.error(`patch-terminal-worker: rewrote ${count} './local-worker.ts' → './local-worker.js' in dist/terminal.js`);
