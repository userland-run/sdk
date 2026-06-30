// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Shared helpers for the e2e specs. Named with a leading underscore so the
// Playwright runner's testMatch (**/*.spec.ts) skips it as a test file.

import { expect, type Page } from "@playwright/test";

/**
 * Navigate to the harness, wire failure diagnostics, wait for the SDK to load,
 * and assert the page is genuinely cross-origin isolated (no `"ignore"` bypass)
 * — that real SharedArrayBuffer path is the whole point of the browser suite.
 */
export async function gotoHarness(page: Page): Promise<void> {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as Record<string, unknown>).__harnessReady === true);
  const coi = await page.evaluate(() => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true);
  expect(coi, "harness page must be cross-origin isolated (COOP/COEP)").toBe(true);
}

/** Minutes → ms, for the heavy Node specs' per-test budgets. */
export const minutes = (n: number): number => n * 60_000;
