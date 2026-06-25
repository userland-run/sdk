// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Scripting (Boa): eval + JSON marshalling, the long-lived engine surface
// (registerFunction/defineGlobal), and the capability model (a fresh engine has
// no powers; grants are the single place that decides what a script may touch).
// Mirrors smoke.mjs block 6. Skipped when boa.wasm is unavailable.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot, boaAvailable } from "./helpers/boot.mjs";

// `skip` accepts a string reason; falsy means "run".
const gate = { skip: boaAvailable ? false : "boa.wasm not available" };

let nano;
before(async () => {
  if (boaAvailable) nano = await boot();
});
after(() => nano?.destroy());

test("script eval marshals a JSON result [feat:sdk.scripting.eval]", gate, async () => {
  const v = await nano.script("({ sum: [1,2,3].reduce((a,b)=>a+b,0) })", { expose: {} });
  assert.equal(v.sum, 6);
});

test("registerFunction + defineGlobal drive a long-lived engine [feat:sdk.scripting.eval]", gate, async () => {
  const engine = await nano.scripting({ expose: {} });
  engine.defineGlobal("VERSION", "1.4.2");
  engine.registerFunction("fetchRow", async (id) => ({ id, name: `row-${id}` }));
  const reg = await engine.eval(`(async () => VERSION + ":" + (await fetchRow(7)).name)()`);
  engine.dispose();
  assert.equal(reg, "1.4.2:row-7");
});

test("a script with no run grant cannot reach nano.run [feat:sdk.scripting.capability]", gate, async () => {
  const t = await nano.script("typeof nano.run", { expose: {} });
  assert.equal(t, "undefined");
});

test("fs:readonly + run grants let a script drive the VM [feat:sdk.scripting.capability]", gate, async () => {
  nano.fs.writeFile("/s/nums.txt", "5\n2\n9\n");
  const driven = await nano.script(
    `(async () => {
       const txt = nano.fs.readText("/s/nums.txt");
       const top = await nano.run("sort -rn /s/nums.txt");
       return { count: txt.trim().split("\\n").length, top: top.stdout.trim().split("\\n")[0] };
     })()`,
    { expose: { fs: "readonly", run: true } },
  );
  assert.equal(driven.count, 3);
  assert.equal(driven.top, "9");
});
