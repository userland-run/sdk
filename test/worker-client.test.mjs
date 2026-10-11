// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// NanoWorkerClient typed catalog/engine wrappers over a fake Worker (no
// nano.wasm): each wrapper must hit the allow-listed worker method with
// structured-cloneable args, and installApp/installBundle must proxy
// `onProgress` over the reverse-RPC callback channel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NanoWorkerClient } from "../dist/index.js";

/**
 * A fake Worker. `handler(req, worker)` returns the result value for a "call";
 * it may emit progress callbacks first via `worker.callback(...)`.
 */
function fakeWorker(handler) {
  const listeners = { message: [], error: [] };
  const calls = [];
  const callbackReplies = new Map();
  let cbSeq = 1000;
  const emit = (data) => {
    for (const l of listeners.message) l({ data });
  };
  const worker = {
    calls,
    terminated: false,
    addEventListener(type, l) {
      listeners[type].push(l);
    },
    terminate() {
      worker.terminated = true;
    },
    /** worker → main reverse-RPC; resolves with the callbackResult message. */
    callback(callbackId, args) {
      const id = cbSeq++;
      return new Promise((resolve) => {
        callbackReplies.set(id, resolve);
        emit({ id, type: "callback", callbackId, args });
      });
    },
    postMessage(req) {
      // Every request must survive structured clone (no functions).
      structuredClone(req);
      if (req.kind === "callbackResult") {
        callbackReplies.get(req.id)?.(req);
        return;
      }
      if (req.kind === "create") {
        queueMicrotask(() => emit({ id: req.id, type: "result", value: true }));
        return;
      }
      calls.push(req);
      queueMicrotask(async () => {
        try {
          const value = await handler(req, worker);
          emit({ id: req.id, type: "result", value });
        } catch (e) {
          emit({ id: req.id, type: "error", error: e.message });
        }
      });
    },
  };
  return worker;
}

const CONFIG = { image: { wasm: new Uint8Array([0]) } };

test("resolveNodeEngine → nano.resolveNodeEngine", async () => {
  const w = fakeWorker((req) => (req.args[0][0] === "jest" ? "vm" : "host"));
  const client = await NanoWorkerClient.create(CONFIG, w);
  assert.equal(await client.resolveNodeEngine(["jest"]), "vm");
  assert.equal(await client.resolveNodeEngine(["app.js"]), "host");
  assert.deepEqual(
    w.calls.map((c) => [c.target, c.method]),
    [
      ["nano", "resolveNodeEngine"],
      ["nano", "resolveNodeEngine"],
    ],
  );
  client.destroy();
});

test("execWasmApp → nano.execWasmApp with argv + opts", async () => {
  const w = fakeWorker((req) => ({ exitCode: 0, stdout: req.args[0].join(" "), stderr: "" }));
  const client = await NanoWorkerClient.create(CONFIG, w);
  const r = await client.execWasmApp(["photon", "in.png", "out.png"], { cwd: "/work" });
  assert.deepEqual(r, { exitCode: 0, stdout: "photon in.png out.png", stderr: "" });
  assert.equal(w.calls[0].method, "execWasmApp");
  assert.deepEqual(w.calls[0].args, [["photon", "in.png", "out.png"], { cwd: "/work" }]);
  client.destroy();
});

test("installApp without onProgress sends plain options", async () => {
  const w = fakeWorker((req) => ({ name: req.args[0], version: "1.0.0" }));
  const client = await NanoWorkerClient.create(CONFIG, w);
  const m = await client.installApp("ripgrep", { lazy: true });
  assert.equal(m.name, "ripgrep");
  assert.equal(w.calls[0].method, "installApp");
  assert.deepEqual(w.calls[0].args, ["ripgrep", { lazy: true }]);
  client.destroy();
});

test("installApp proxies onProgress over the reverse-RPC channel", async () => {
  const w = fakeWorker(async (req, worker) => {
    const { progressCallbackId } = req.args[1];
    assert.equal(typeof progressCallbackId, "number");
    const reply = await worker.callback(progressCallbackId, [{ phase: "chunk", fetched: 1, total: 2 }]);
    assert.equal(reply.ok, true);
    await worker.callback(progressCallbackId, [{ phase: "done" }]);
    return { name: "node", version: "22.0.0" };
  });
  const client = await NanoWorkerClient.create(CONFIG, w);
  const events = [];
  const m = await client.installApp("node", { onProgress: (e) => events.push(e) });
  assert.equal(m.name, "node");
  assert.deepEqual(events, [{ phase: "chunk", fetched: 1, total: 2 }, { phase: "done" }]);
  // The callback is freed once the install settles.
  const late = await w.callback(w.calls[0].args[1].progressCallbackId, [{ phase: "done" }]);
  assert.equal(late.ok, false);
  client.destroy();
});

test("installBundle proxies onProgress and frees it on failure", async () => {
  const w = fakeWorker(async (req, worker) => {
    await worker.callback(req.args[1].progressCallbackId, [{ phase: "index" }]);
    throw new Error("bundle not found");
  });
  const client = await NanoWorkerClient.create(CONFIG, w);
  const events = [];
  await assert.rejects(client.installBundle("nope", { onProgress: (e) => events.push(e) }), /bundle not found/);
  assert.deepEqual(events, [{ phase: "index" }]);
  assert.equal(w.calls[0].method, "installBundle");
  const late = await w.callback(w.calls[0].args[1].progressCallbackId, []);
  assert.equal(late.ok, false);
  client.destroy();
});
