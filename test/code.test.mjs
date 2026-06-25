// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Code mode: raw `run()` (whitespace-split argv) and the `shExec()`/`exec()`
// sh-pipeline path. Mirrors smoke.mjs blocks 1 + 2.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/boot.mjs";

let nano;
before(async () => {
  nano = await boot();
});
after(() => nano?.destroy());

test("run() executes a BusyBox command and captures stdout [feat:sdk.code.run]", async () => {
  const r = await nano.run("echo hello-sdk");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello-sdk/);
});

test("shExec() runs a real sh pipeline [feat:sdk.code.exec]", async () => {
  nano.fs.writeFile("/app/data.txt", "3\n1\n2\n");
  const r = await nano.shExec("sort -rn /app/data.txt | head -1");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), "3");
});

test("exec() single-quotes argv and runs it through sh [feat:sdk.code.exec]", async () => {
  const r = await nano.exec(["echo", "a b", "c"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), "a b c");
});
