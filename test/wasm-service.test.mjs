// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// W-3 SDK integration: installApp auto-registers a catalog kind:"wasm-service"
// with the Kernel service registry (via the vendored WASI service runner in
// dist/vendor/nodert), so it is reachable over the svc.* bus with no extra
// wiring. Booting the VM needs cross-origin isolation, so Nano is exercised off
// its prototype with a real Kernel + a Map-backed fs (which is both the
// InstallTarget and the reader). The wasm module comes from the sibling nano
// fixture; the test skips if that checkout is absent (as check-vendor does).
//
// Run after `npm run build`:  node --test test/wasm-service.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../src/vendor/kernel/index.mjs";
import { Nano } from "../dist/index.js";

const fixtureUrl = new URL("../../nano/nodert/test/wasm-fixtures.mjs", import.meta.url);
const skip = existsSync(fileURLToPath(fixtureUrl)) ? false : "sibling nano fixture absent";

// A Map-backed fs satisfying both InstallTarget.writeFile and Vfs.readFile.
function mapFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return { files, writeFile: (p, c) => files.set(p, c), readFile: (p) => files.get(p) ?? null };
}

async function fakeNano(fs) {
  const k = new Kernel();
  await registerBuiltinServices(k);
  const n = Object.create(Nano.prototype);
  n.raw = { _kernel: k };
  n.fs = fs;
  return { n, kernel: k };
}

const WSVC_MANIFEST = {
  name: "echosvc", version: "1.2.0", kind: "wasm-service",
  entrypoint: { argv: ["echosvc"], env: {} },
  files: [{ path: "/usr/lib/echosvc.wasm", mode: "0644", size: 0, sha256: "x", chunks: [] }],
  methods: ["run"],
};

test("registerWasmService wraps the installed .wasm as a svc.* service", { skip }, async () => {
  const { stdinEchoModule } = await import(fixtureUrl.href);
  const fs = mapFs({ "/usr/lib/echosvc.wasm": stdinEchoModule("SVC:") });
  const { n, kernel } = await fakeNano(fs);

  const unregister = await n.registerWasmService(WSVC_MANIFEST);

  const listed = kernel.services.list().find((s) => s.id === "echosvc");
  assert.ok(listed, "service registered");
  assert.equal(listed.kind, "wasm-service");
  const r = await kernel.services.invoke("echosvc", "run", "ping");
  assert.equal(r.stdout, "SVC:ping", "invocation runs the wasm filter");
  assert.equal(typeof unregister, "function", "returns an unregister fn");
  unregister();
  assert.ok(!kernel.services.list().find((s) => s.id === "echosvc"), "unregister removes it");
});

test("installApp auto-registers a wasm-service (kind branch)", { skip }, async () => {
  const { stdinEchoModule } = await import(fixtureUrl.href);
  const fs = mapFs();
  const { n, kernel } = await fakeNano(fs);
  // A distinct service identity — the module cache is keyed by id@version
  // (valid: the catalog is content-addressed, so id@version → fixed bytes).
  const autoManifest = {
    name: "autosvc", version: "1.0.0", kind: "wasm-service",
    entrypoint: { argv: ["autosvc"], env: {} },
    files: [{ path: "/usr/lib/autosvc.wasm", mode: "0644", size: 0, sha256: "x", chunks: [] }],
    methods: ["run"],
  };
  // Stub the catalog: 'install' writes the .wasm and returns the manifest, like
  // the real fetch→verify→assemble→install path (covered by catalog-install).
  n._catalog = {
    install: async (target) => {
      target.writeFile("/usr/lib/autosvc.wasm", stdinEchoModule("AUTO:"));
      return autoManifest;
    },
  };

  const manifest = await n.installApp("autosvc");
  assert.equal(manifest.kind, "wasm-service");
  const res = await kernel.services.invoke("autosvc", "run", "auto-wired");
  assert.equal(res.stdout, "AUTO:auto-wired", "installApp auto-registered + invocable");
});

test("installApp does NOT register a non-service app", { skip }, async () => {
  const fs = mapFs();
  const { n, kernel } = await fakeNano(fs);
  const before = kernel.services.list().length;
  n._catalog = {
    install: async (target) => {
      target.writeFile("/usr/bin/tool.wasm", new Uint8Array([0, 0x61, 0x73, 0x6d]));
      return { name: "tool", version: "1.0.0", kind: "wasm-app", entrypoint: { argv: ["tool.wasm"], env: {} }, files: [{ path: "/usr/bin/tool.wasm" }] };
    },
  };
  await n.installApp("tool");
  assert.equal(kernel.services.list().length, before, "wasm-app did not register a service");
});
