// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Terminal mode: the renderer-agnostic Shell engine — cwd tracking across runs,
// env persistence, JS builtins, and onData streaming.

import { test, expect } from "@playwright/test";
import { gotoHarness } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("Shell tracks cwd and persists env across runs [feat:sdk.shell.session]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      const sh = nano.shell({ cwd: "/" });
      await sh.run("mkdir -p /work/sub");
      await sh.run("cd /work/sub");
      const pwd = await sh.run("pwd"); // builtin, reflects tracked cwd
      await sh.run("export GREET=hello-shell");
      const echo = await sh.run("echo $GREET"); // export must survive into a new child
      return { cwd: sh.cwd, pwd: pwd.stdout.trim(), greet: echo.stdout.trim() };
    } finally {
      nano.destroy();
    }
  });
  expect(r.cwd).toBe("/work/sub");
  expect(r.pwd).toBe("/work/sub");
  expect(r.greet).toBe("hello-shell");
});

test("Shell streams output via onData [feat:sdk.shell.stream]", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const nano = await (window as Record<string, any>).boot();
    try {
      const sh = nano.shell({ cwd: "/" });
      let streamed = "";
      const res = await sh.run("echo streamed-line", { onData: (c: string) => (streamed += c) });
      return { streamed, output: res.output };
    } finally {
      nano.destroy();
    }
  });
  expect(r.streamed).toContain("streamed-line");
  expect(r.output).toContain("streamed-line");
});
