// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Deep dev-toolchain coverage (@heavy): TypeScript, ESLint, and Prettier running
// as real Node CLIs inside nano. The "devtools" overlay supplies node (/usr/bin)
// plus the three tools under /usr/local (built from the catalog recipe trees).
// Each tool is plain JS on the Node ELF, so every invocation pays full V8 boot —
// shExec must be given a Node-sized step budget (the default is BusyBox's 2M).

import { test, expect } from "@playwright/test";
import { gotoHarness, minutes } from "./_harness";

// V8 boot + a real tsc/eslint/prettier run needs far more than the BusyBox budget.
const NODE_STEPS = 200_000_000_000;

test.beforeEach(async ({ page }) => {
  await gotoHarness(page);
});

test("TypeScript: version, a clean compile, and a reported type error [feat:sdk.devtools.tsc] @heavy", async ({
  page,
}) => {
  test.setTimeout(minutes(14));
  const r = await page.evaluate(async (steps) => {
    const nano = await (window as Record<string, any>).boot({ overlay: "devtools" });
    const sh = (cmd: string) => nano.shExec(cmd, { maxSteps: steps });
    try {
      const ver = await sh("tsc --version");
      // --noLib skips loading the (large, slow-under-emulation) default lib.d.ts;
      // this still runs the real compiler/checker on the source, just fast.
      nano.fs.writeFile("/work/hello.ts", "const greeting: string = 'hi';\nconst combined: string = greeting + ' there';\n");
      await sh("cd /work && tsc --noLib --skipLibCheck hello.ts");
      const emitted = nano.fs.readText("/work/hello.js");
      nano.fs.writeFile("/work/bad.ts", "const n: number = 'not a number';\n");
      const typeErr = await sh("cd /work && tsc --noEmit --noLib bad.ts");
      return { ver: ver.stdout, emitted: emitted ?? "", typeErr: typeErr.stdout };
    } finally {
      nano.destroy();
    }
  }, NODE_STEPS);
  expect(r.ver).toMatch(/Version\s+5\./);
  expect(r.emitted).toContain("greeting"); // tsc emitted hello.js (types stripped)
  expect(r.typeErr).toMatch(/error TS\d+/); // type mismatch reported
});

test("ESLint: version + a flat-config rule violation is reported [feat:sdk.devtools.eslint] @heavy", async ({
  page,
}) => {
  // KNOWN GAP (perf): node + eslint load fine, but ESLint v10's startup pulls in a
  // very large module graph; parsing/loading it under RISC-V emulation is too slow
  // to finish in a practical test budget (>14 min, vs. tsc's ~1.3 min with --noLib).
  // Left as a tracked expected-failure — not a correctness bug (node & tsc pass).
  test.fixme(true, "eslint v10 startup is impractically slow under emulation");
  test.setTimeout(minutes(14));
  const r = await page.evaluate(async (steps) => {
    const nano = await (window as Record<string, any>).boot({ overlay: "devtools" });
    const sh = (cmd: string) => nano.shExec(cmd, { maxSteps: steps });
    try {
      const ver = await sh("eslint --version");
      nano.fs.writeFile(
        "/work/eslint.config.js",
        "module.exports = [{ rules: { 'no-unused-vars': 'error' } }];\n",
      );
      nano.fs.writeFile("/work/lint-me.js", "const unusedVar = 42;\n");
      const lint = await sh("cd /work && eslint lint-me.js");
      return { ver: ver.stdout, lint: lint.stdout };
    } finally {
      nano.destroy();
    }
  }, NODE_STEPS);
  expect(r.ver).toMatch(/\d+\.\d+\.\d+/);
  expect(r.lint).toMatch(/no-unused-vars/);
});

test("Prettier: version + reformats a file [feat:sdk.devtools.prettier] @heavy", async ({ page }) => {
  // KNOWN GAP (tracked): prettier's CLI evaluates a `/[\p{Lu}]/u` Unicode-property
  // regex that nano's current small-ICU Node build rejects ("Invalid property name
  // in character class"). prettier loads + runs but can't format until the node
  // build ships full ICU / the property-class regex support. Left in the suite as
  // a documented expected-failure rather than silently dropped.
  test.fixme(true, "prettier needs a full-ICU node build (\\p{} property class)");
  test.setTimeout(minutes(14));
  const r = await page.evaluate(async (steps) => {
    const nano = await (window as Record<string, any>).boot({ overlay: "devtools" });
    const sh = (cmd: string) => nano.shExec(cmd, { maxSteps: steps });
    try {
      const ver = await sh("prettier --version");
      nano.fs.writeFile("/work/ugly.js", "const   x=1   ;console.log( x )\n");
      const formatted = await sh("cd /work && prettier ugly.js");
      return { ver: ver.stdout, formatted: formatted.stdout };
    } finally {
      nano.destroy();
    }
  }, NODE_STEPS);
  expect(r.ver).toMatch(/\d+\.\d+\.\d+/);
  expect(r.formatted).toContain("const x = 1;");
});
