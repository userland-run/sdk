// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Persistent shell session: env persistence and cwd tracking across run() calls
// (the VM resets cwd per run, so the Shell holds this state). Mirrors smoke.mjs
// block 4.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/boot.mjs";

let nano;
before(async () => {
  nano = await boot();
});
after(() => nano?.destroy());

test("export persists across shell.run() calls [feat:sdk.shell.session]", async () => {
  const sh = nano.shell({ cwd: "/" });
  await sh.run("export GREETING=hi");
  const r = await sh.run("echo $GREETING");
  assert.match(r.stdout, /hi/);
});

test("cd tracks cwd across runs [feat:sdk.shell.session]", async () => {
  const sh = nano.shell({ cwd: "/" });
  await sh.run("mkdir -p /app/x && cd /app/x");
  assert.equal(sh.cwd, "/app/x");
});

test("constructor env seeds the session environment [feat:sdk.shell.session]", async () => {
  const sh = nano.shell({ cwd: "/", env: { FOO: "bar" } });
  const r = await sh.run("echo $FOO");
  assert.match(r.stdout, /bar/);
});
