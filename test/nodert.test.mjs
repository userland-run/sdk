// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// K9 — the vendored nodert host-engine runtime, live in the SDK. Two layers:
//   A. the vendored runtime runs Node on the host JS engine over a shared
//      Kernel (proves sdk/src/vendor/nodert resolves in the SDK layout — its
//      worker imports ../../../kernel, which is the vendored kernel — and
//      executes real programs), incl. cross-tier VFS.
//   B. the SDK Nano wiring routes node() through that runtime from the BUILT
//      dist (loadNodertEngine resolving dist/vendor/nodert), with the vm
//      default and the auto fallback.
// Booting the real emulator needs cross-origin isolation (Playwright e2e), so
// Nano is exercised off its prototype with a real shared Kernel + a stub VM
// node path — the same seams createNano wires at runtime.
//
// Run after `npm run build`:  node --test test/nodert.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel, registerBuiltinServices } from "../src/vendor/kernel/index.mjs";
import { createNodeEngine } from "../src/vendor/nodert/src/host/engine.mjs";
import { Nano } from "../dist/index.js";

async function freshKernel() {
  const k = new Kernel();
  await registerBuiltinServices(k);
  return k;
}

// ---- A. the vendored runtime, direct ----

test("vendored nodert runs a program on the host engine", async () => {
  const k = await freshKernel();
  const eng = createNodeEngine(k, { engine: "nodert" });
  const r = await eng.node(["node", "-e", 'process.stdout.write("host-engine:" + (6*7))'], { timeoutMs: 15000 });
  assert.equal(r.stdout, "host-engine:42");
  assert.equal(r.exitCode, 0);
  assert.equal(r.engine, "nodert");
});

test("vendored nodert shares the Kernel VFS (cross-tier file handoff)", async () => {
  const k = await freshKernel();
  // A file placed in the shared VFS by the host is visible to the nodert guest.
  k.vfs.rootMem.createFile("/data.txt", "SHARED-VFS-OK");
  const eng = createNodeEngine(k, { engine: "nodert" });
  const src = 'const fs=require("fs"); process.stdout.write(fs.readFileSync("/data.txt","utf8"))';
  const r = await eng.node(["node", "-e", src], { timeoutMs: 15000 });
  assert.equal(r.stdout, "SHARED-VFS-OK");
});

test("vendored nodert: a guest file written is visible back in the Kernel VFS", async () => {
  const k = await freshKernel();
  const eng = createNodeEngine(k, { engine: "nodert" });
  const src = 'require("fs").writeFileSync("/out.txt","FROM-GUEST"); process.stdout.write("wrote")';
  const r = await eng.node(["node", "-e", src], { timeoutMs: 15000 });
  assert.equal(r.stdout, "wrote");
  assert.equal(new TextDecoder().decode(k.vfs.rootMem.resolve("/out.txt").data), "FROM-GUEST");
});

test("vendored engine 'auto' falls back to a wired vmRun on ERR_NODERT_UNSUPPORTED", async () => {
  const k = await freshKernel();
  let vmCalled = 0;
  const vmRun = async (argv) => { vmCalled++; return { exitCode: 0, stdout: "VM:" + argv.slice(1).join(" "), stderr: "", signal: null }; };
  const eng = createNodeEngine(k, { engine: "auto", vmRun });
  const src = 'process.stderr.write("ERR_NODERT_UNSUPPORTED"); process.exit(1)';
  const r = await eng.node(["node", "-e", src], { timeoutMs: 15000 });
  assert.equal(r.engine, "vm");
  assert.ok(r.fellBack);
  assert.equal(vmCalled, 1);
});

// ---- B. the SDK Nano wiring, through the built dist ----

function fakeNano(engine, routing, kernel, vmNodeStub) {
  const n = Object.create(Nano.prototype);
  n.nodeEngine = engine;
  n.nodeRouting = { ...routing };
  n.nodertEngine = null;
  n.raw = { _kernel: kernel, node: vmNodeStub };
  return n;
}

test("Nano.node default 'vm' calls the VM path (unchanged)", async () => {
  const k = await freshKernel();
  let called = null;
  const n = fakeNano("vm", {}, k, async (...a) => { called = a; return { exitCode: 0, stdout: "VM-RAN" }; });
  const r = await n.node(["-e", "1"]);
  assert.equal(r.stdout, "VM-RAN");
  assert.ok(called, "VM node path invoked");
});

test("Nano.node 'nodert' runs on the host engine via dist/vendor/nodert", async () => {
  const k = await freshKernel();
  const n = fakeNano("nodert", {}, k, async () => { throw new Error("VM must not be used"); });
  const r = await n.node(["-e", 'process.stdout.write("dist-nodert:" + (2+3))']);
  assert.equal(r.stdout, "dist-nodert:5");
  assert.equal(r.exitCode, 0);
});

test("Nano.node 'auto' runs on nodert and returns combined output", async () => {
  const k = await freshKernel();
  const n = fakeNano("auto", {}, k, async () => { throw new Error("VM must not be used for a supported program"); });
  const r = await n.node(["-e", 'process.stdout.write("a"); process.stderr.write("b")']);
  // ExecResult.stdout is the combined stream.
  assert.equal(r.stdout, "ab");
});

test("Nano.node routing pin forces a program to the VM", async () => {
  const k = await freshKernel();
  let vmCalled = 0;
  const n = fakeNano("nodert", { jest: "vm" }, k, async () => { vmCalled++; return { exitCode: 0, stdout: "VM-JEST" }; });
  const r = await n.node(["node_modules/.bin/jest", "--ci"]);
  assert.equal(r.stdout, "VM-JEST");
  assert.equal(vmCalled, 1);
});
