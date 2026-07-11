// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// The nodert host-engine tier, live in a real browser (spec §14, K9). This is
// the one path the headless suite can't exercise: a genuine cross-origin
// isolated tab, a real module Web Worker, and the browser fetching + gzip-
// decompressing the node-lib bundle. Runs against the vite-built preview, whose
// vendored worker tree is served at the site root (/vendor/*, staged by
// e2e:fixtures) and found by nodert-engine.ts's site-root loader candidate.
//
// The proof is airtight: the VM is booted WITHOUT a node ELF (busybox only), so
// any `node …` output can ONLY have come from nodert running on the host JS
// engine over the shared Kernel — the emulator has nothing to run.

import { test, expect } from "@playwright/test";
import { gotoHarness, minutes } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("nodert runs node on the host JS engine — no ELF [feat:sdk.engines.nodert]", async ({ page }) => {
  test.setTimeout(minutes(3));
  const r = await page.evaluate(async () => {
    // No image.node → the emulator has no node binary; engines.node:"host"
    // runs the program on the browser's JS engine. Output PROVES nodert ran.
    const nano = await (window as Record<string, any>).boot({ engines: { node: "host" } });
    try {
      const evald = await nano.node(["-e", "process.stdout.write('nodert:' + (6 * 7))"]);
      nano.fs.writeFile("/app.js", "const dbl = (n) => n * 2;\nconsole.log('file-' + dbl(21));\n");
      const file = await nano.node(["/app.js"]);
      const info = await nano.node(["-e", "process.stdout.write(process.version + ' ' + process.platform)"]);
      // Shared VFS: nodert writes, the busybox VM reads the same file back.
      await nano.node(["-e", "require('fs').writeFileSync('/from-nodert.txt', 'CROSS-TIER')"]);
      const viaVm = await nano.run("cat /from-nodert.txt");
      return { evald: evald.stdout, file: file.stdout, info: info.stdout, viaVm: viaVm.stdout };
    } finally {
      nano.destroy();
    }
  });
  expect(r.evald).toBe("nodert:42");
  expect(r.file).toContain("file-42");
  expect(r.info).toMatch(/^v\d+\.\d+\.\d+/); // vendored Node lib version
  expect(r.viaVm).toContain("CROSS-TIER"); // nodert → shared VFS → busybox
});

test("auto routes node to nodert and honors a VM pin [feat:sdk.engines.config] @heavy", async ({ page }) => {
  test.setTimeout(minutes(10));
  const r = await page.evaluate(async () => {
    // With the node ELF present, engines.node:"auto" runs on nodert, but a
    // routing pin forces a program onto the VM (fidelity/native-addon path).
    const nano = await (window as Record<string, any>).boot({
      node: true,
      engines: { node: "auto", routing: { "vm-only.js": "vm" } },
    });
    try {
      const onNodert = await nano.node(["-e", "process.stdout.write('auto:' + (8 * 8))"]);
      nano.fs.writeFile("/vm-only.js", "console.log('ran ' + process.arch);\n");
      const pinned = await nano.node(["/vm-only.js"]);
      return { onNodert: onNodert.stdout, pinned: pinned.stdout };
    } finally {
      nano.destroy();
    }
  });
  expect(r.onNodert).toBe("auto:64");
  // The pinned program ran on the RISC-V emulator → riscv64 arch.
  expect(r.pinned).toContain("riscv64");
});
