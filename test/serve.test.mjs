// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Serve mode: the (binary-safe) HTTP response parser that turns a guest's raw
// HTTP/1.1 bytes into status/headers/body, and the startServer lifecycle helper
// (which resolves on readiness and rejects on early exit). The full ServeBridge
// needs a service worker + cross-origin-isolated page, so it is exercised in the
// browser/conformance pipeline, not here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseHttpResponse, startServer } from "../dist/index.js";
import { boot } from "./helpers/boot.mjs";

let nano;
before(async () => {
  nano = await boot();
});
after(() => nano?.destroy());

test("parseHttpResponse parses status line, headers, and body [feat:sdk.serve.http]", () => {
  const raw = new TextEncoder().encode(
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Foo: bar\r\n\r\nhello body",
  );
  const res = parseHttpResponse(raw);
  assert.equal(res.status, 200);
  assert.equal(res.statusText, "OK");
  assert.equal(res.headers["content-type"], "text/plain");
  assert.equal(res.headers["x-foo"], "bar");
  assert.equal(new TextDecoder().decode(res.body), "hello body");
});

test("parseHttpResponse decodes Transfer-Encoding: chunked [feat:sdk.serve.http]", () => {
  const raw = new TextEncoder().encode(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
  );
  const res = parseHttpResponse(raw);
  assert.equal(res.status, 200);
  assert.equal(new TextDecoder().decode(res.body), "hello world");
});

test("startServer rejects when the launch exits before readiness [feat:sdk.serve.http]", async () => {
  // `echo` exits immediately; with a ready pattern that never matches, the
  // lifecycle helper must reject rather than resolve a never-listening server.
  await assert.rejects(
    startServer(nano, { command: "echo not-a-server" }, { readyPattern: /NEVER_MATCHES/ }),
    /exited before ready/,
  );
});
