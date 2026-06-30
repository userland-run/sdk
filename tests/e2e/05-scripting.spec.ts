// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Scripting mode: the sandboxed Boa engine (boa.wasm) — one-shot eval with JSON
// marshalling, and a long-lived engine with host bindings.

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("script() evaluates and marshals the result [feat:sdk.scripting.eval]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot({ scripting: true });
    try {
      const num = await nano.script("6 * 7");
      const obj = await nano.script("({ ok: true, items: [1, 2, 3] })");
      return { num, obj };
    } finally {
      nano.destroy();
    }
  });
  expect(r.num).toBe(42);
  expect(r.obj).toEqual({ ok: true, items: [1, 2, 3] });
});

test("a long-lived engine takes host bindings (defineGlobal / registerFunction) [feat:sdk.scripting.bindings]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot({ scripting: true });
    try {
      const engine = await nano.scripting({});
      // defineGlobal: the injected value is readable from the script.
      engine.defineGlobal("BASE", 40);
      const viaGlobal = await engine.eval("BASE + 2");
      // registerFunction: the script calls back into the host (captured here).
      let captured: number | null = null;
      engine.registerFunction("report", (n: number) => {
        captured = n;
      });
      await engine.eval("report(BASE * 2)");
      engine.dispose();
      return { viaGlobal, captured };
    } finally {
      nano.destroy();
    }
  });
  expect(r.viaGlobal).toBe(42);
  expect(r.captured).toBe(80);
});
