// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Worker transport: host the VM in a Web Worker (createNanoWorker spins up
// `new Worker(new URL("./worker/worker.js", import.meta.url))`, which only
// resolves under a real bundler/server — so this is browser-only).

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("a worker-hosted VM runs a command off the main thread [feat:sdk.worker.run]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const client = await (window as Record<string, any>).bootWorker();
    try {
      const out = await client.run("echo from-worker");
      return { exitCode: out.exitCode, stdout: out.stdout };
    } finally {
      client.destroy();
    }
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("from-worker");
});

test("the same Shell engine drives a worker-hosted VM [feat:sdk.worker.shell]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const client = await (window as Record<string, any>).bootWorker();
    try {
      const sh = client.shell({ cwd: "/" });
      await sh.run("mkdir -p /tmp/wk");
      await sh.run("cd /tmp/wk");
      const pwd = await sh.run("pwd");
      return { cwd: sh.cwd, pwd: pwd.stdout.trim() };
    } finally {
      client.destroy();
    }
  });
  expect(r.cwd).toBe("/tmp/wk");
  expect(r.pwd).toBe("/tmp/wk");
});
