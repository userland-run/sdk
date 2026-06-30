// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Serve mode (browser-only, @heavy): the service-worker bridge proxies an
// iframe's HTTP request into an in-VM Node HTTP server and returns the response.
// This whole path (SW + cross-origin isolation + a guest server) cannot run in
// the Node test suite.

import { test, expect } from "@playwright/test";
import { gotoHarness, minutes } from "./_harness";

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("an iframe reaches an in-VM Node HTTP server through the SW bridge [feat:sdk.serve.bridge] @heavy", async ({
  page,
}) => {
  test.setTimeout(minutes(8));
  const body = await page.evaluate(async () => {
    const w = window as Record<string, any>;
    const { ServeBridge, startServer } = w.NanoSDK;
    const nano = await w.boot({ node: true });
    try {
      const bridge = await ServeBridge.register({ injector: nano.virtualServer, swUrl: "/nano-sw.js" });
      nano.fs.writeFile(
        "/srv/server.js",
        "require('http').createServer((q, s) => { s.setHeader('content-type', 'text/plain'); s.end('hello-serve'); })" +
          ".listen(8080, () => console.log('listening on 8080'));\n",
      );
      const server = await startServer(nano, { node: ["/srv/server.js"] }, { readyPattern: /listening/i });

      // A fresh same-origin iframe under the SW scope is controlled by the SW,
      // so its request is proxied into the guest server.
      const iframe = document.createElement("iframe");
      iframe.src = bridge.previewUrl(8080, "/");
      document.body.appendChild(iframe);
      await new Promise<void>((resolve, reject) => {
        iframe.onload = () => resolve();
        iframe.onerror = () => reject(new Error("iframe load error"));
      });
      const text = iframe.contentDocument?.body?.textContent ?? "";

      server.stop();
      await bridge.unregister();
      iframe.remove();
      return text;
    } finally {
      nano.destroy();
    }
  });
  expect(body).toContain("hello-serve");
});
