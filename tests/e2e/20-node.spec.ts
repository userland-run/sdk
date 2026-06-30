// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Deep Node.js coverage (@heavy): the cold ELF path and the snapshot fast path,
// running real Node v25 inside nano. V8 needs ~1.8 GB guest RAM and slow init
// under emulation — assert on STDOUT, not exitCode (a warm restore aborts 134
// after printing correct output; see node-runtime.ts).

import { test, expect } from "@playwright/test";
import { gotoHarness, minutes } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("cold node: -e, process.version/arch, and a required core module [feat:sdk.node.cold] @heavy", async ({
  page,
}) => {
  test.setTimeout(minutes(10));
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot({ node: true });
    try {
      const eval2 = await nano.node(["-e", "console.log(2 + 2)"]);
      const info = await nano.node(["-e", "console.log(process.version + ' ' + process.arch)"]);
      nano.fs.writeFile("/work/app.js", "const path = require('path');\nconsole.log(path.join('a', 'b', 'c'));\n");
      const file = await nano.node(["/work/app.js"]);
      return { eval2: eval2.stdout, info: info.stdout, file: file.stdout };
    } finally {
      nano.destroy();
    }
  });
  expect(r.eval2).toContain("4");
  expect(r.info).toMatch(/v\d+\.\d+\.\d+/);
  expect(r.info).toContain("riscv64");
  expect(r.file).toContain("a/b/c");
});

test("NodeRuntime: warm once, run repeatedly, seed per-run inputs [feat:sdk.node.fastpath] @heavy", async ({
  page,
}) => {
  test.setTimeout(minutes(12));
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot({ node: true });
    try {
      const rt = nano.nodeRuntime();
      await rt.warmup();
      const a = await rt.run("console.log(6 * 7)");
      const b = await rt.run("console.log('second-run-' + (1 + 1))");
      // The snapshot launcher runs payloads via `new Function`, so module-local
      // `require` isn't in scope — reach it through the main module (the pattern
      // the node recipe documents).
      const c = await rt.run(
        "const fs = process.mainModule.require('fs'); const s = fs.readFileSync('/tmp/in.txt', 'utf8'); console.log(s.trim().toUpperCase());",
        { extraFiles: [{ path: "/tmp/in.txt", content: "seeded-input" }] },
      );
      return { warm: rt.isWarm, a: a.stdout, b: b.stdout, c: c.stdout };
    } finally {
      nano.destroy();
    }
  });
  expect(r.warm).toBe(true);
  expect(r.a).toContain("42");
  expect(r.b).toContain("second-run-2");
  expect(r.c).toContain("SEEDED-INPUT");
});

test("a multi-file CommonJS project resolves a local require [feat:sdk.node.project] @heavy", async ({
  page,
}) => {
  test.setTimeout(minutes(10));
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot({ node: true });
    try {
      nano.fs.writeFile("/proj/package.json", JSON.stringify({ name: "p", version: "1.0.0", type: "commonjs" }) + "\n");
      nano.fs.writeFile("/proj/lib.js", "module.exports = (n) => n * 2;\n");
      nano.fs.writeFile("/proj/index.js", "const dbl = require('./lib');\nconsole.log('result=' + dbl(21));\n");
      const out = await nano.node(["/proj/index.js"]);
      return out.stdout;
    } finally {
      nano.destroy();
    }
  });
  expect(r).toContain("result=42");
});
