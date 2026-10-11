// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// wasm-app tier through the SDK: execWasmApp's stdin / env / binary-safe
// stdout / cwd+absolute paths, and the routing that makes a registered app a
// first-class command — `nano.run("photon …")` and `nano.shExec("rg … | wc -l")`
// (the guest BusyBox shell exec()s it with real pipes, redirects and exit codes).
//
// The wasm modules come from the sibling nano checkout (fixtures + apps/core);
// the suite skips what is absent. Run after `npm run build`:
//   NANO_WASM=../nano/wasm/nano.busybox.wasm node --test test/wasm-app.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Kernel, registerBuiltinServices } from "../src/vendor/kernel/index.mjs";
import { Nano } from "../dist/index.js";
import { boot, wasmAvailable } from "./helpers/boot.mjs";

const fixtureUrl = new URL("../../nano/runners/wasm/test/wasm-fixtures.mjs", import.meta.url);
const haveFixtures = existsSync(fileURLToPath(fixtureUrl));
const appPath = (n) => fileURLToPath(new URL(`../../nano/apps/core/${n}.wasm`, import.meta.url));
const pngPath = fileURLToPath(new URL("../../nano/runners/wasm/test/fixtures/tiny.png", import.meta.url));
const haveApps = existsSync(appPath("rg")) && existsSync(appPath("photon")) && existsSync(pngPath);

/** Nano off its prototype over a real Kernel (no VM boot needed for execWasmApp). */
async function kernelNano() {
  const k = new Kernel();
  await registerBuiltinServices(k);
  const n = Object.create(Nano.prototype);
  n.raw = { _kernel: k };
  return { n, k };
}

test("execWasmApp: stdin bytes → binary-safe stdoutBytes; no stdin → EOF", { skip: haveFixtures ? false : "sibling nano fixture absent" }, async () => {
  const { stdinEchoModule } = await import(fixtureUrl.href);
  const { n } = await kernelNano();
  await n.registerWasmApp("echoin", stdinEchoModule("IN:"));

  const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x80]);
  const r = await n.execWasmApp(["echoin"], { stdin: bin });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdoutBytes instanceof Uint8Array, "stdoutBytes is bytes");
  assert.deepEqual([...r.stdoutBytes], [...new TextEncoder().encode("IN:"), ...bin], "bytes survive untouched");

  const t = await n.execWasmApp(["echoin"], { stdin: "text in" });
  assert.equal(t.stdout, "IN:text in", "string stdin is UTF-8 encoded");

  const none = await n.execWasmApp(["echoin"], { timeoutMs: 20000 });
  assert.equal(none.stdout, "IN:", "no stdin → immediate EOF (no hang)");
});

test("execWasmApp: env is passed and PWD is the cwd", { skip: haveFixtures ? false : "sibling nano fixture absent" }, async () => {
  const { envDumpModule } = await import(fixtureUrl.href);
  const { n, k } = await kernelNano();
  k.vfs.mkdir("/work", 0o755);
  await n.registerWasmApp("envdump", envDumpModule());
  const r = await n.execWasmApp(["envdump"], { cwd: "/work", env: { MODE: "batch", QUALITY: "85" } });
  const env = Object.fromEntries(r.stdout.split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  assert.deepEqual(env, { MODE: "batch", QUALITY: "85", PWD: "/work" });
});

test("execWasmApp: relative and absolute paths both work (photon)", { skip: haveApps ? false : "apps/core photon absent" }, async () => {
  const { n, k } = await kernelNano();
  k.vfs.mkdir("/work", 0o755);
  k.vfs.mkdir("/out", 0o755);
  k.vfs.rootMem.createFile("/work/in.png", new Uint8Array(readFileSync(pngPath)));
  await n.registerWasmApp("photon", new Uint8Array(readFileSync(appPath("photon"))));
  const rel = await n.execWasmApp(["photon", "in.png", "rel.png", "--filter", "sepia"], { cwd: "/work" });
  assert.equal(rel.exitCode, 0, rel.stderr);
  const abs = await n.execWasmApp(["photon", "/work/in.png", "/out/abs.png", "--filter", "invert"], { cwd: "/work" });
  assert.equal(abs.exitCode, 0, abs.stderr);
  for (const p of ["/work/rel.png", "/out/abs.png"]) {
    const b = k.vfs.rootMem.resolve(p)?.data;
    assert.ok(b && b[0] === 0x89 && b[1] === 0x50, `${p} is a PNG`);
  }
});

test("nano.run / nano.shExec route registered wasm apps (real BusyBox)", { skip: !wasmAvailable ? "nano.wasm not available" : !haveApps ? "apps/core absent" : false }, async () => {
  const nano = await boot({ ramMB: 256, scripting: false });
  try {
    await nano.registerWasmApp("rg", new Uint8Array(readFileSync(appPath("rg"))));
    await nano.registerWasmApp("photon", new Uint8Array(readFileSync(appPath("photon"))));
    nano.fs.writeFile("/work/in.png", new Uint8Array(readFileSync(pngPath)));
    nano.fs.writeFile("/work/src/a.js", "const answer = 42;\n");
    nano.fs.writeFile("/work/src/b.js", "const b = 1;\nconst c = 2;\n");

    // run(): direct routing, real exit status
    const r = await nano.run("photon /work/in.png /work/out.png --filter grayscale");
    assert.equal(r.exitCode, 0, r.stdout);
    assert.match(r.stdout, /grayscale/);
    const out = nano.fs.readFile("/work/out.png");
    assert.ok(out && out[0] === 0x89, "run() wrote the PNG");
    assert.equal((await nano.run("rg nomatchxyz /work")).exitCode, 1, "run() exit status");

    // shExec(): exec'd from the guest shell — && chains, pipes, redirects, $?
    const s = await nano.shExec("cd /work && photon in.png sh.png --filter invert >/dev/null && ls sh.png");
    assert.equal(s.exitCode, 0, s.stdout);
    assert.equal(s.stdout, "sh.png\n");
    const p = await nano.shExec("rg --files /work/src | wc -l");
    assert.equal(p.stdout.trim(), "2", "piped into wc");
    const f = await nano.shExec("cd /work && rg -c const src/b.js > /work/count.txt; cat /work/count.txt; rg zzz src; echo rc=$?");
    assert.equal(f.stdout, "2\nrc=1\n", "redirect + exit status");
  } finally {
    nano.destroy();
  }
});
