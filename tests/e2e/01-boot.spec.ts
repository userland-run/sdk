// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Boot + cross-origin isolation: the real SharedArrayBuffer path the Node suite
// can't reach (it boots with crossOriginIsolation:"ignore").

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("the page is cross-origin isolated with SharedArrayBuffer [feat:sdk.browser.isolation]", async ({ page }) => {
  const env = await page.evaluate(() => ({
    coi: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer !== "undefined",
  }));
  expect(env.coi).toBe(true);
  expect(env.sab).toBe(true);
});

test("createNano boots a BusyBox VM and runs a command [feat:sdk.browser.boot]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as Record<string, any>;
    const nano = await w.boot();
    try {
      const out = await nano.run("echo boot-ok");
      return { exitCode: out.exitCode, stdout: out.stdout };
    } finally {
      nano.destroy();
    }
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("boot-ok");
});
