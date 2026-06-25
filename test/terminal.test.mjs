// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Terminal mode: the renderer-agnostic terminal engine (Shell) — JS builtins
// that render without spawning a child (clear/pwd) and live output streaming via
// onData. These are the terminal-rendering behaviors layered over the shell.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/boot.mjs";

let nano;
before(async () => {
  nano = await boot();
});
after(() => nano?.destroy());

test("clear builtin emits the terminal reset sequence [feat:sdk.mode.terminal]", async () => {
  const sh = nano.shell({ cwd: "/" });
  let streamed = "";
  const r = await sh.run("clear", { onData: (c) => (streamed += c) });
  assert.ok(r.output.includes("\x1b[2J"), "result carries the clear sequence");
  assert.ok(streamed.includes("\x1b[2J"), "clear sequence is streamed via onData");
});

test("pwd builtin renders the tracked cwd without spawning [feat:sdk.mode.terminal]", async () => {
  const sh = nano.shell({ cwd: "/app" });
  const r = await sh.run("pwd");
  assert.equal(r.output.trim(), "/app");
});

test("onData streams command output as it is produced [feat:sdk.mode.terminal]", async () => {
  const sh = nano.shell({ cwd: "/" });
  const chunks = [];
  await sh.run("echo termtest", { onData: (c) => chunks.push(c) });
  assert.match(chunks.join(""), /termtest/);
});
