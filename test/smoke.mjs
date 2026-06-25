// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Node smoke test for the built SDK. Exercises the main-thread core/vfs/shell
 * (and optionally node) paths against the bundled nano.wasm (which self-loads
 * BusyBox + Node, so no object-URL image loading is needed in Node).
 *
 * Run after `npm run build`:  node test/smoke.mjs
 * Include the (slow) node path:  SMOKE_NODE=1 node test/smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createNano } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, "../../nano/wasm/nano.wasm"); // bundled build

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
    failed++;
  }
}

const wasm = new Uint8Array(readFileSync(WASM));
console.log(`nano-sdk smoke — bundled wasm ${(wasm.length / 1e6).toFixed(0)}MB\n`);

const nano = await createNano({ image: { wasm }, crossOriginIsolation: "ignore" });

// 1. BusyBox run
{
  const r = await nano.run("echo hello-sdk");
  check("run(echo)", r.exitCode === 0 && r.stdout.includes("hello-sdk"), JSON.stringify(r.stdout));
}

// 2. vfs fast path + shExec pipeline (spec §15.1)
{
  nano.fs.writeFile("/app/data.txt", "3\n1\n2\n");
  const r = await nano.shExec("sort -rn /app/data.txt | head -1");
  check("shExec(sort | head)", r.exitCode === 0 && r.stdout.trim() === "3", JSON.stringify(r.stdout));
  check("vfs.readText", nano.fs.readText("/app/data.txt") === "3\n1\n2\n");
  check("vfs.exists", nano.fs.exists("/app/data.txt") && !nano.fs.exists("/nope"));
}

// 3. vfs mutation path (BusyBox)
{
  await nano.fs.mkdir("/app/sub");
  nano.fs.writeFile("/app/sub/a.txt", "A");
  await nano.fs.copy("/app/sub/a.txt", "/app/sub/b.txt");
  check("vfs.mkdir + copy", nano.fs.readText("/app/sub/b.txt") === "A");
  const w = nano.fs.walk("/app/sub");
  check("vfs.walk", w.includes("/app/sub/a.txt") && w.includes("/app/sub/b.txt"), w.join(","));
}

// 4. shell: env persistence + cwd tracking
{
  const sh = nano.shell({ cwd: "/" });
  await sh.run("export GREETING=hi");
  const r = await sh.run("echo $GREETING");
  check("shell export persists", r.stdout.includes("hi"), JSON.stringify(r.stdout));
  await sh.run("mkdir -p /app/x && cd /app/x");
  check("shell cwd tracking", sh.cwd === "/app/x", sh.cwd);
}

// 5. node (slow — opt-in). Runs AFTER the BusyBox/sh commands above, which
// exercises the per-run block-cache reset (stale `sh` blocks must not corrupt
// node's image). Assertions check OUTPUT, not exitCode: a warm restore leaves
// V8's platform worker thread unjoinable at shutdown, so it aborts (exit 134)
// *after* writing correct output — the same contract as nano's test_snapshot.
if (process.env.SMOKE_NODE === "1") {
  // Cold node() through _execute — exits cleanly (0) even after the sh runs.
  const cold = await nano.node(["-e", "console.log(20 + 3)"]);
  check("node() cold", cold.exitCode === 0 && cold.stdout.includes("23"), JSON.stringify(cold.stdout));

  // Warm snapshot fast path: warmup must reach the snapshot sentinel, and each
  // restore must produce correct output.
  const rt = nano.nodeRuntime();
  await rt.warmup();
  check("nodeRuntime.isWarm", rt.isWarm);
  const r1 = await rt.run("console.log(2 + 2)");
  check("nodeRuntime.run", r1.stdout.includes("4"), JSON.stringify(r1.stdout.slice(0, 60)));
  const r2 = await rt.run("console.log(7 * 6)");
  check("nodeRuntime.run isolated", r2.stdout.includes("42"), JSON.stringify(r2.stdout.slice(0, 60)));
} else {
  console.log("  SKIP  node + nodeRuntime (set SMOKE_NODE=1 to include)");
}

nano.destroy();
console.log(failed === 0 ? "\nALL SMOKE PASSED" : `\n${failed} SMOKE FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
