// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Code mode in a real browser VM: run() / exec() / shExec() and the synchronous
// fs round-trip. Mirrors test/code.test.mjs, but on the SharedArrayBuffer path.

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("run() executes a BusyBox command and captures stdout [feat:sdk.code.run]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      return await nano.run("echo hello-e2e");
    } finally {
      nano.destroy();
    }
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("hello-e2e");
});

test("shExec() runs a real sh pipeline [feat:sdk.code.exec]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      nano.fs.writeFile("/app/data.txt", "3\n1\n2\n");
      return await nano.shExec("sort -rn /app/data.txt | head -1");
    } finally {
      nano.destroy();
    }
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe("3");
});

test("exec() quotes argv and runs it through sh [feat:sdk.code.exec]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      return await nano.exec(["echo", "a b", "c"]);
    } finally {
      nano.destroy();
    }
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe("a b c");
});

test("fs write → guest read round-trips through MemFS [feat:sdk.fs.write]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      nano.fs.writeFile("/work/greeting.txt", "from-the-host\n");
      const viaGuest = await nano.run("cat /work/greeting.txt");
      const viaHost = nano.fs.readText("/work/greeting.txt");
      return { guest: viaGuest.stdout, host: viaHost, exists: nano.fs.exists("/work/greeting.txt") };
    } finally {
      nano.destroy();
    }
  });
  expect(r.guest).toContain("from-the-host");
  expect(r.host).toBe("from-the-host\n");
  expect(r.exists).toBe(true);
});
