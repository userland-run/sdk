// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Node runtime path: cold `node()` and the snapshot-based NodeRuntime fast path.
// Slow (boots V8 with ~1.8GB guest RAM), so it is opt-in behind $SMOKE_NODE.
// Assertions check STDOUT, not exitCode: a warm restore leaves V8's platform
// worker thread unjoinable at shutdown, so it aborts (exit 134) *after* writing
// correct output (the same contract as nano's test_snapshot). Mirrors smoke.mjs
// block 5.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/boot.mjs";

const gate = { skip: process.env.SMOKE_NODE ? false : "set SMOKE_NODE=1 to run the (slow) node path" };

let nano;
before(async () => {
  if (process.env.SMOKE_NODE) nano = await boot({ node: true });
});
after(() => nano?.destroy());

test("node() cold-runs a script and prints its output [feat:sdk.node.runtime]", gate, async () => {
  const r = await nano.node(["-e", "console.log(20 + 3)"]);
  assert.match(r.stdout, /23/);
});

test("nodeRuntime warms a snapshot and restores it [feat:sdk.node.runtime]", gate, async () => {
  const rt = nano.nodeRuntime();
  await rt.warmup();
  assert.ok(rt.isWarm);
  const r1 = await rt.run("console.log(2 + 2)");
  assert.match(r1.stdout, /4/);
});

test("nodeRuntime restores are isolated from each other [feat:sdk.node.runtime]", gate, async () => {
  const rt = nano.nodeRuntime();
  await rt.warmup();
  const r = await rt.run("console.log(7 * 6)");
  assert.match(r.stdout, /42/);
});
