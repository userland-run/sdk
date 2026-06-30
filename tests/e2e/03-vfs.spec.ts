// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Vfs: the synchronous MemFS fast path + the BusyBox-backed directory mutations.

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("synchronous MemFS write/read/list/exists [feat:sdk.fs.memfs]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      nano.fs.writeFile("/proj/a.txt", "alpha");
      nano.fs.writeFile("/proj/b.txt", "beta");
      const names = (nano.fs.list("/proj") ?? []).map((e: { name: string }) => e.name).sort();
      return {
        a: nano.fs.readText("/proj/a.txt"),
        names,
        existsA: nano.fs.exists("/proj/a.txt"),
        existsMissing: nano.fs.exists("/proj/nope.txt"),
      };
    } finally {
      nano.destroy();
    }
  });
  expect(r.a).toBe("alpha");
  expect(r.names).toEqual(["a.txt", "b.txt"]);
  expect(r.existsA).toBe(true);
  expect(r.existsMissing).toBe(false);
});

test("BusyBox-backed mkdir / copy / walk [feat:sdk.fs.mutate]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      await nano.fs.mkdir("/src/nested");
      nano.fs.writeFile("/src/nested/file.txt", "data");
      await nano.fs.copy("/src", "/dst");
      const walked = nano.fs.walk("/dst").sort();
      return { copied: nano.fs.readText("/dst/nested/file.txt"), walked };
    } finally {
      nano.destroy();
    }
  });
  expect(r.copied).toBe("data");
  expect(r.walked).toContain("/dst/nested/file.txt");
});
