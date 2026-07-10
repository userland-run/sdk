// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Unit test for the SDK's node() engine-selection POLICY (spec §14): the pure
// resolveNodeEngine() over engine + routing (pin > per-call > default). The
// end-to-end run + fallback behavior of node() is covered by nodert.test.mjs
// (it needs the vendored runtime + a Kernel). We build a Nano off its prototype
// with the two private policy fields set — the state Nano.create() assigns from
// config.engines.
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

test("a routing pin to vm overrides a nodert default (keeps contextify tools on the VM)", () => {
  const n = withPolicy("nodert", { jest: "vm", "node-gyp": "vm" });
  assert.equal(n.resolveNodeEngine(["node_modules/.bin/jest"]), "vm");
  assert.equal(n.resolveNodeEngine(["node-gyp", "rebuild"]), "vm");
  assert.equal(n.resolveNodeEngine(["app.js"]), "nodert"); // unpinned → default
});
