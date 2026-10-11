// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Regression tests that need no nano.wasm: VM-op serialization (over a fake
// NanoVM), NodeRuntime warmup memoization, CDN generation retry, catalog
// rollback protection, canonicalize/JSON.stringify parity, and the provision
// template + output-filter helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Nano,
  CdnClient,
  canonicalize,
  resolveIndex,
  publicKeyFromB64,
  openChunkCache,
  fetchVerifiedChunk,
  sha256Hex,
} from "../dist/index.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// --- a fake NanoVM: records concurrency; a "server" run parks until cancelRun ---
function fakeVm() {
  const vm = {
    active: 0,
    maxActive: 0,
    order: [],
    unlinked: [],
    snapshots: 0,
    restores: 0,
    parked: null,
    async run(cmd) {
      vm.active++;
      vm.maxActive = Math.max(vm.maxActive, vm.active);
      vm.order.push(cmd);
      try {
        if (cmd.startsWith("sh ") && vm.files.get(cmd.slice(3))?.includes("SERVE")) {
          await new Promise((r) => (vm.parked = r));
          return { exitCode: 0, stdout: "", cancelled: true };
        }
        await tick();
        return { exitCode: 0, stdout: cmd };
      } finally {
        vm.active--;
      }
    },
    files: new Map(),
    addFile(path, content) {
      vm.files.set(path, String(content));
    },
    cancelRun() {
      vm.parked?.();
      vm.parked = null;
    },
    async nodeSnapshot() {
      vm.snapshots++;
      await tick(10);
      return { snap: true };
    },
    async restoreAndRun(_snap, src) {
      vm.restores++;
      return vm.run(`restore:${src}`);
    },
    readFileString: () => null,
    listDir: () => null,
    _memfs: {
      resolve: () => null,
      unlink(path) {
        vm.unlinked.push(path);
        vm.files.delete(path);
        return 0;
      },
    },
    destroy() {},
  };
  return vm;
}

test("overlapping run/shExec/fs ops are serialized on one VM", async () => {
  const vm = fakeVm();
  const nano = new Nano(vm);
  const results = await Promise.all([
    nano.run("echo a"),
    nano.shExec("echo b"),
    nano.fs.mkdir("/x"),
    nano.exec(["echo", "c"]),
    nano.run("echo d"),
  ]);
  assert.equal(vm.maxActive, 1, "never more than one VM run at a time");
  assert.equal(results.length, 5);
  assert.equal(vm.order[0], "echo a");
  assert.equal(vm.order[4], "echo d", "FIFO order");
  // Temp scripts are removed after use.
  assert.equal(vm.unlinked.length, 3);
  assert.ok(vm.unlinked.every((p) => /^\/tmp\/\.nano-(exec|vfs)-/.test(p)));
  assert.equal([...vm.files.keys()].filter((p) => p.startsWith("/tmp/.nano-")).length, 0);
});

test("a failed op releases the lock for the next one", async () => {
  const vm = fakeVm();
  const nano = new Nano(vm);
  const realRun = vm.run;
  vm.run = async (cmd) => {
    if (cmd === "boom") throw new Error("boom");
    return realRun(cmd);
  };
  const [a, b] = await Promise.allSettled([nano.run("boom"), nano.run("echo ok")]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
});

test("while a server holds the VM, new runs reject fast; stop() releases it", async () => {
  const vm = fakeVm();
  const nano = new Nano(vm);
  const server = nano.launchServer({ command: "SERVE" });
  await tick();
  await assert.rejects(nano.run("echo x"), /busy serving/);
  await assert.rejects(nano.fs.mkdir("/y"), /busy serving/);
  nano.cancel();
  await server;
  await tick();
  const r = await nano.run("echo after");
  assert.equal(r.stdout, "echo after");
});

test("NodeRuntime: concurrent runs share one in-flight warmup", async () => {
  const vm = fakeVm();
  const nano = new Nano(vm);
  const rt = nano.nodeRuntime();
  await Promise.all([rt.run("a"), rt.run("b"), rt.warmup()]);
  assert.equal(vm.snapshots, 1, "nodeSnapshot built once");
  assert.equal(vm.restores, 2);
  assert.equal(vm.maxActive, 1);
});

// --- CDN generation resolution ---

test("CdnClient.generation retries after a failure and ignores junk versions", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        versions: [{ version: "0.0.7" }, { version: "0.0.12" }, { version: "0.0.x" }, { version: "1.0.0-beta" }, {}],
      }),
    };
  };
  const cdn = new CdnClient({ fetchFn });
  await assert.rejects(cdn.generation(), /503/);
  assert.equal(await cdn.generation(), 12, "second call refetches (rejection not memoized)");
  assert.equal(await cdn.generation(), 12);
  assert.equal(calls, 2);
});

// --- signing helpers (mirror catalog/tools) ---
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubRawB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");
function finalize(core) {
  const base = { ...core };
  delete base.sha256;
  delete base.signature;
  const sha256 = sha(canonicalize(base));
  const withHash = { ...base, sha256 };
  const signature = edSign(null, Buffer.from(canonicalize(withHash)), privateKey).toString("base64");
  return { ...withHash, signature };
}
const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj });

class MemStore {
  map = new Map();
  get(s) {
    return this.map.get(s) ?? null;
  }
  set(s, g) {
    this.map.set(s, Math.max(g, this.map.get(s) ?? -1));
  }
}

test("rollback: index generation must equal the requested (pinned) generation", async () => {
  const idx = finalize({ generation: 6, nano_min_version: "0.1.0", apps: {} });
  const fetchFn = async (url) =>
    url.includes("data.jsdelivr.com") ? jsonResponse({ versions: [{ version: "0.0.7" }] }) : jsonResponse(idx);
  const ctx = {
    cdn: new CdnClient({ fetchFn }),
    cache: await openChunkCache(),
    key: await publicKeyFromB64(pubRawB64),
    keyId: pubRawB64,
    generations: new MemStore(),
  };
  await assert.rejects(resolveIndex(ctx), /generation 6 does not match the requested generation 7/);
});

test("rollback: an index older than the highest seen generation is rejected", async () => {
  let current = finalize({ generation: 5, nano_min_version: "0.1.0", apps: {} });
  const fetchFn = async () => jsonResponse(current);
  const store = new MemStore();
  const ctx = {
    cdn: new CdnClient({ baseUrl: "local://rollback", fetchFn }),
    cache: await openChunkCache(),
    key: await publicKeyFromB64(pubRawB64),
    keyId: pubRawB64,
    generations: store,
  };
  assert.equal((await resolveIndex(ctx)).generation, 5);
  current = finalize({ generation: 4, nano_min_version: "0.1.0", apps: {} }); // validly signed, but older
  await assert.rejects(resolveIndex(ctx), /older than the newest already seen \(5\)/);
  current = finalize({ generation: 6, nano_min_version: "0.1.0", apps: {} });
  assert.equal((await resolveIndex(ctx)).generation, 6);
});

test("fetchVerifiedChunk re-verifies cache hits and evicts corrupt entries", async () => {
  const good = new TextEncoder().encode("chunk-bytes");
  const h = await sha256Hex(good);
  const cache = await openChunkCache();
  await cache.put(h, new TextEncoder().encode("tampered!!!"));
  let fetched = 0;
  const fetchFn = async () => {
    fetched++;
    return { ok: true, status: 200, arrayBuffer: async () => good.slice().buffer };
  };
  const ctx = { cdn: new CdnClient({ baseUrl: "local://c", fetchFn }), cache };
  const out = await fetchVerifiedChunk(ctx, h);
  assert.equal(new TextDecoder().decode(out), "chunk-bytes");
  assert.equal(fetched, 1, "corrupt cache entry was refetched");
  assert.equal(new TextDecoder().decode(await cache.get(h)), "chunk-bytes", "cache healed");
});

test("canonicalize drops undefined members exactly like JSON.stringify", () => {
  const fn = () => 1;
  const v = { b: 2, a: undefined, c: [1, undefined, fn], d: { x: undefined, y: null }, e: fn };
  assert.equal(canonicalize(v), '{"b":2,"c":[1,null,null],"d":{"y":null}}');
  // Same bytes as JSON.stringify of the key-sorted object.
  assert.equal(canonicalize(v), JSON.stringify({ b: 2, c: [1, undefined, fn], d: { y: null } }));
});

// --- provision helpers (bundled from source; not part of the public surface) ---
async function loadProvision() {
  const entry = fileURLToPath(new URL("../src/provision.ts", import.meta.url));
  const out = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  const code = out.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

test("provision: template substitution is literal ($&, $1, $$ in user code)", async () => {
  const { fillTemplate } = await loadProvision();
  const code = "const s = 'a$&b$1c$$d$`e';";
  assert.equal(fillTemplate("node -e ${code}", "code", code), "node -e " + code);
  assert.equal(fillTemplate("${file} && cat ${file}", "file", "/x$&.js"), "/x$&.js && cat /x$&.js");
});

test("provision: filteredSink flushes a trailing partial line and still filters", async () => {
  const { filteredSink } = await loadProvision();
  let out = "";
  const s = filteredSink((c) => (out += c), ["^Assertion failed"]);
  s.write("one\ntw");
  s.write("o\nlast-no-newline");
  s.flush();
  assert.equal(out, "one\ntwo\nlast-no-newline");

  out = "";
  const f = filteredSink((c) => (out += c), ["^TRACE"]);
  f.write("ok\nTRACE boom\nmore\n");
  f.flush();
  assert.equal(out, "ok\n");

  out = "";
  const g = filteredSink((c) => (out += c), ["^TRACE"]);
  g.write("ok\nTRACE partial");
  g.flush();
  assert.equal(out, "ok\n", "a filtered trailing line is dropped");
});
