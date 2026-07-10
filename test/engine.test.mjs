// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Unit test for the SDK's node() engine-selection policy (spec §14). Booting
// the VM needs a cross-origin-isolated context (covered by the Playwright e2e),
// so this exercises the PURE policy: resolveNodeEngine() over engine + routing,
// and the ERR_NODERT_UNWIRED guard on node() (which rejects before ever
// touching the VM). We build a Nano off its prototype with the two private
// policy fields set — the same state Nano.create() assigns from config.engines.
//
// Run after `npm run build`:  node --test test/engine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Nano } from "../dist/index.js";

function withPolicy(engine, routing) {
  const n = Object.create(Nano.prototype);
  n.nodeEngine = engine;
  n.nodeRouting = { ...routing };
  return n;
}

test("default engine is vm; resolveNodeEngine echoes it", () => {
  const n = withPolicy("vm", {});
  assert.equal(n.resolveNodeEngine(["app.js"]), "vm");
  assert.equal(n.resolveNodeEngine(["-e", "1+1"]), "vm");
});

test("routing pin resolves via the entry-bin basename", () => {
  const n = withPolicy("nodert", { jest: "vm" });
  assert.equal(n.resolveNodeEngine(["node_modules/.bin/jest", "--ci"]), "vm");
  assert.equal(n.resolveNodeEngine(["app.js"]), "nodert"); // unpinned → default
});

test("inline eval has no entry, so a pin doesn't apply", () => {
  const n = withPolicy("auto", { jest: "vm" });
  assert.equal(n.resolveNodeEngine(["-e", "require('jest')"]), "auto");
  assert.equal(n.resolveNodeEngine(["--print", "1"]), "auto");
});

test("flags are skipped when finding the entry", () => {
  const n = withPolicy("vm", { tsc: "nodert" });
  assert.equal(n.resolveNodeEngine(["--max-old-space-size=512", "node_modules/typescript/bin/tsc"]), "nodert");
});

test("node() rejects with ERR_NODERT_UNWIRED for a non-vm engine", async () => {
  const n = withPolicy("auto", {});
  await assert.rejects(() => n.node(["app.js"]), (e) => {
    assert.equal(e.code, "ERR_NODERT_UNWIRED");
    assert.match(e.message, /host-engine \(nodert\) runtime/);
    return true;
  });
});

test("node() rejects when a pin forces nodert but it is unwired", async () => {
  const n = withPolicy("vm", { tsc: "nodert" });
  await assert.rejects(() => n.node(["node_modules/.bin/tsc"]), (e) => e.code === "ERR_NODERT_UNWIRED");
});
