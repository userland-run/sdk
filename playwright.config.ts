// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { defineConfig, devices } from "@playwright/test";

// Browser e2e for the SDK. The Node `node --test` suite runs the VM with
// `crossOriginIsolation: "ignore"` and can't reach the parts of the SDK that
// only exist in a real isolated browser — the service-worker Serve bridge, the
// Web Worker transport, and the actual SharedArrayBuffer path. These tests fill
// that gap, and add deep coverage for running Node.js + the dev toolchain
// (tsc / eslint / prettier) inside nano.
//
// `@heavy`-tagged specs boot Node.js in the guest (≈1.8 GB guest RAM, slow V8
// init under emulation); `npm run test:e2e:fast` skips them, `test:e2e:node`
// runs only them.
const PORT = 4174;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // Booting RISC-V + BusyBox in-browser is not instant; Node is far slower. The
  // heavy specs raise their own budget via test.setTimeout().
  timeout: 120_000,
  expect: { timeout: 90_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  // Build the SDK (tsup) → stage fixtures from the sibling nano repo → build the
  // harness (vite) → preview it with the COOP/COEP headers the VM needs.
  webServer: {
    command:
      `npm run build && npm run e2e:fixtures && npm run e2e:build && ` +
      `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // CI robustness: --no-sandbox (no user namespaces on the runner) and
        // --disable-dev-shm-usage (the VM's large SharedArrayBuffer can exhaust
        // a small /dev/shm and hang the renderer).
        launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
      },
    },
  ],
});
