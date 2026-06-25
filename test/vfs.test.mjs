// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Virtual filesystem: the synchronous MemFS fast path (writeFile/readText/
// exists/list/walk) and the BusyBox-backed mutation path (mkdir/copy).
// Mirrors smoke.mjs blocks 2 + 3.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/boot.mjs";

let nano;
before(async () => {
  nano = await boot();
});
after(() => nano?.destroy());

test("writeFile + readText round-trip through MemFS [feat:sdk.vfs.rw]", () => {
  nano.fs.writeFile("/app/data.txt", "3\n1\n2\n");
  assert.equal(nano.fs.readText("/app/data.txt"), "3\n1\n2\n");
});

test("exists reflects file presence [feat:sdk.vfs.rw]", () => {
  nano.fs.writeFile("/app/x.txt", "x");
  assert.ok(nano.fs.exists("/app/x.txt"));
  assert.ok(!nano.fs.exists("/nope"));
});

test("mkdir + copy + walk via BusyBox [feat:sdk.vfs.rw]", async () => {
  await nano.fs.mkdir("/app/sub");
  nano.fs.writeFile("/app/sub/a.txt", "A");
  await nano.fs.copy("/app/sub/a.txt", "/app/sub/b.txt");
  assert.equal(nano.fs.readText("/app/sub/b.txt"), "A");
  const w = nano.fs.walk("/app/sub");
  assert.ok(w.includes("/app/sub/a.txt"));
  assert.ok(w.includes("/app/sub/b.txt"));
});

test("list returns typed directory entries [feat:sdk.vfs.rw]", () => {
  nano.fs.writeFile("/app/list/one.txt", "1");
  const entries = nano.fs.list("/app/list");
  assert.ok(Array.isArray(entries));
  assert.ok(entries.some((e) => e.name === "one.txt" && e.type === "file"));
});
