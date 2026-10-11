// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Unit tests for static/nano-sw.js, evaluated in Node against a fake service-
// worker global (clients, fetch events). The real browser path is covered by
// tests/e2e/08-serve.spec.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SW_SRC = readFileSync(new URL("../static/nano-sw.js", import.meta.url), "utf8");
const ORIGIN = "https://app.example";

/**
 * Load the SW with fake window clients. Each client answers sw-request messages
 * via `reply(requestText, requestBytes)` → { status, headers, body }.
 */
function loadSw(clientSpecs) {
  const listeners = {};
  const received = [];
  const clients = clientSpecs.map((spec) => ({
    id: spec.id,
    url: spec.url ?? ORIGIN + "/nano/",
    focused: !!spec.focused,
    visibilityState: spec.visible === false ? "hidden" : "visible",
    postMessage(msg, transfer) {
      const port = transfer[0];
      const bytes = new Uint8Array(msg.httpRequestBytes);
      received.push({ client: spec.id, msg, text: new TextDecoder().decode(bytes), bytes });
      const reply = (spec.reply ?? (() => ({ status: 200, headers: {}, body: new ArrayBuffer(0) })))(bytes);
      port.postMessage(reply);
    },
  }));
  const self = {
    location: new URL(ORIGIN + "/nano/nano-sw.js"),
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    clients: { matchAll: async () => clients, claim: async () => {} },
  };
  new Function("self", SW_SRC)(self);
  const fetchEvent = (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    const body = init.body ?? null;
    const ev = {
      clientId: init.clientId ?? "",
      resultingClientId: init.resultingClientId ?? "",
      replacesClientId: "",
      request: {
        url,
        method: init.method ?? "GET",
        headers,
        referrer: init.referrer ?? "",
        mode: init.mode ?? "cors",
        destination: init.destination ?? "",
        arrayBuffer: async () => (body ? body.slice().buffer : new ArrayBuffer(0)),
      },
      responded: null,
      respondWith(p) {
        ev.responded = Promise.resolve(p);
      },
    };
    listeners.fetch(ev);
    return ev;
  };
  const message = (sourceId, data) => listeners.message({ data, source: { id: sourceId } });
  return { fetchEvent, message, received };
}

test("SW forwards pathname + query string to the guest", async () => {
  const sw = loadSw([{ id: "page" }]);
  const ev = sw.fetchEvent(ORIGIN + "/nano/sw/8080/api/items?q=1&x=%20y", { clientId: "page" });
  const res = await ev.responded;
  assert.equal(res.status, 200);
  assert.match(sw.received[0].text, /^GET \/api\/items\?q=1&x=%20y HTTP\/1\.1\r\n/);
  assert.match(sw.received[0].text, /\r\nHost: localhost:8080\r\n/);
  // Legacy string form is still sent for older bridges.
  assert.equal(typeof sw.received[0].msg.httpRequest, "string");
});

test("SW referrer-routed sub-requests keep their query string", async () => {
  const sw = loadSw([{ id: "page" }]);
  const ev = sw.fetchEvent(ORIGIN + "/app.js?v=3", { referrer: ORIGIN + "/nano/sw/3000/index.html" });
  await ev.responded;
  assert.match(sw.received[0].text, /^GET \/app\.js\?v=3 HTTP\/1\.1/);
  assert.equal(sw.received[0].msg.port, 3000);
});

test("SW builds a null-body Response for 204/304 (no constructor throw)", async () => {
  for (const status of [204, 205, 304]) {
    const sw = loadSw([
      { id: "page", reply: () => ({ status, statusText: "X", headers: { etag: "1" }, body: new TextEncoder().encode("junk").buffer }) },
    ]);
    const res = await sw.fetchEvent(ORIGIN + "/nano/sw/8080/").responded;
    assert.equal(res.status, status);
    assert.equal(res.body, null);
  }
  // 101 can't be represented by a Response → 502, not a hung/rejected fetch.
  const sw = loadSw([{ id: "page", reply: () => ({ status: 101, headers: {}, body: new ArrayBuffer(0) }) }]);
  assert.equal((await sw.fetchEvent(ORIGIN + "/nano/sw/8080/").responded).status, 502);
});

test("SW tags VM responses with CORP same-origin + COEP credentialless, drops framing headers", async () => {
  const sw = loadSw([
    {
      id: "page",
      reply: () => ({ status: 200, headers: { "transfer-encoding": "chunked", "x-app": "1" }, body: new ArrayBuffer(0) }),
    },
  ]);
  const res = await sw.fetchEvent(ORIGIN + "/nano/sw/8080/").responded;
  assert.equal(res.headers.get("cross-origin-embedder-policy"), "credentialless");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(res.headers.get("transfer-encoding"), null);
  assert.equal(res.headers.get("x-app"), "1");
});

test("SW sends request bodies as raw bytes (binary-safe)", async () => {
  const sw = loadSw([{ id: "page" }]);
  const body = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41]);
  await sw.fetchEvent(ORIGIN + "/nano/sw/8080/upload", { method: "POST", body }).responded;
  const { bytes, text } = sw.received[0];
  assert.match(text, /\r\nContent-Length: 5\r\n\r\n/);
  assert.deepEqual([...bytes.subarray(bytes.length - 5)], [...body]);
});

test("SW never intercepts cross-origin requests", () => {
  const sw = loadSw([{ id: "page" }]);
  const ev1 = sw.fetchEvent("https://evil.example/nano/sw/8080/");
  assert.equal(ev1.responded, null);
  // Cross-origin request whose referrer is a preview frame: also untouched.
  const ev2 = sw.fetchEvent("https://cdn.example/lib.js", { referrer: ORIGIN + "/nano/sw/8080/" });
  assert.equal(ev2.responded, null);
  // Same-origin request with a cross-origin "preview" referrer: not routed to the VM.
  const ev3 = sw.fetchEvent(ORIGIN + "/data.json", { referrer: "https://evil.example/nano/sw/8080/" });
  assert.equal(ev3.responded, null);
  assert.equal(sw.received.length, 0);
});

test("SW leaves same-origin non-document subresources to the network", () => {
  const sw = loadSw([{ id: "page" }]);
  const ev = sw.fetchEvent(ORIGIN + "/nano/api", { method: "POST", destination: "", mode: "cors" });
  assert.equal(ev.responded, null, "POST not re-fetched/replayed by the SW");
});

test("SW routes to the requesting / announced bridge page, not clients[0]", async () => {
  const sw = loadSw([{ id: "other-tab" }, { id: "vm-page" }]);
  sw.message("vm-page", { type: "nano-bridge-attach" });
  // iframe navigation: no clientId, a resulting preview client.
  await sw.fetchEvent(ORIGIN + "/nano/sw/8080/", { mode: "navigate", resultingClientId: "frame-1" }).responded;
  assert.equal(sw.received[0].client, "vm-page");
  // A request issued by the app page itself goes to that page.
  const sw2 = loadSw([{ id: "a" }, { id: "b" }]);
  await sw2.fetchEvent(ORIGIN + "/nano/sw/8080/x", { clientId: "b" }).responded;
  assert.equal(sw2.received[0].client, "b");
});

test("SW answers 502 when no client is available", async () => {
  const sw = loadSw([]);
  const res = await sw.fetchEvent(ORIGIN + "/nano/sw/8080/").responded;
  assert.equal(res.status, 502);
});
