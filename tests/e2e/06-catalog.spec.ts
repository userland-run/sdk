// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Catalog mode, fully offline: install a signed app from a local static catalog
// (built by scripts/sync-fixtures.mjs), execute it, and prove the trust chain
// rejects a corrupted chunk and the wrong signing key.

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("install + run a signed catalog app, and reject tamper / wrong key [feat:sdk.catalog.install]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as Record<string, any>;
    const { Catalog } = w.NanoSDK;
    const keys = await (await fetch("/catalog/keys.json")).json();
    const nano = await w.boot();
    const out: Record<string, any> = {};
    try {
      // 1. happy path: verify → assemble → install the real busybox ELF, then run it.
      const cat = new Catalog({ cdn: { baseUrl: "/catalog" }, publicKeyB64: keys.good });
      const manifest = await cat.install(nano.fs, "busybox-demo");
      out.name = manifest.name;
      out.version = manifest.version;
      const run = await nano.shExec("/opt/bin/busybox echo catalog-install-ok");
      out.run = run.stdout;

      // 2. corrupted chunk (distinct app, distinct hash → not served from cache).
      try {
        await new Catalog({ cdn: { baseUrl: "/catalog-tampered" }, publicKeyB64: keys.good }).install(
          nano.fs,
          "tamper-demo",
        );
        out.tamper = "NO THROW";
      } catch (e: any) {
        out.tamper = e.message;
      }

      // 3. wrong key rejects the (otherwise valid) index signature.
      try {
        await new Catalog({ cdn: { baseUrl: "/catalog" }, publicKeyB64: keys.bad }).install(
          nano.fs,
          "busybox-demo",
        );
        out.wrongKey = "NO THROW";
      } catch (e: any) {
        out.wrongKey = e.message;
      }
      return out;
    } finally {
      nano.destroy();
    }
  });
  expect(r.name).toBe("busybox-demo");
  expect(r.version).toBe("1.36.1");
  expect(r.run).toContain("catalog-install-ok");
  expect(r.tamper).toMatch(/chunk hash mismatch/i);
  expect(r.wrongKey).toMatch(/index signature invalid/i);
});
