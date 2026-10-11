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

test("overlapping run/shExec/fs calls are serialized, not clobbered [feat:sdk.code.exec]", async () => {
  // Fired without awaiting: before the VM mutex, each run reset the shared VM
  // and the earlier ones returned the later one's (or truncated) output.
  const [a, b, , c] = await Promise.all([
    nano.run("echo first-run"),
    nano.shExec("echo second | tr a-z A-Z"),
    nano.fs.mkdir("/tmp/overlap-dir"),
    nano.exec(["echo", "third"]),
  ]);
  assert.match(a.stdout, /first-run/);
  assert.equal(b.stdout.trim(), "SECOND");
  assert.equal(c.stdout.trim(), "third");
  assert.ok(nano.fs.exists("/tmp/overlap-dir"));
  // One-shot scripts are cleaned up after use.
  const leftovers = (nano.fs.list("/tmp") ?? []).filter((e) => /^\.nano-(exec|vfs)-/.test(e.name));
  assert.deepEqual(leftovers, []);
});
