// Vendor drift guard.
//
// sdk/src/vendor/nanovm.mjs is a CURATED copy of nano/container/nanovm.mjs — not
// a blind mirror. The two have legitimately diverged in BOTH directions:
//   • vendor-only: lazy catalog demand-fetch (_lazyFiles/_maybeMaterializeLazy).
//   • container-only: the boa scripting engine + server-footer indicators.
// So we can't `cp` one over the other. But the *shared mechanism* — the run-loop
// yield strategy and the snapshot/restore primitive — MUST stay in lockstep, or
// it drifts silently (that's how the vendor lost the adaptive yield and ran ~9x
// slower). This script fails if that shared core regresses.
//
// Updating the vendor: port the container's changes to the SHARED methods below,
// preserve the SDK-only lazy-fetch, then run `npm run check:vendor`. See
// src/vendor/README.md.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = join(here, "..", "..", "nano", "container", "nanovm.mjs");
const VENDOR = join(here, "..", "src", "vendor", "nanovm.mjs");

// Methods that are pure mechanism — they must be byte-identical (modulo comments
// + whitespace) between the container and the vendor.
const SHARED_METHODS = ["_fastYield", "_adaptiveYield", "snapshotApp", "snapshot", "restoreAndRun"];

function extractMethod(src, name) {
  const re = new RegExp(`\\n {2}(?:async )?${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
  }
  return null;
}

const normalize = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

const container = readFileSync(CONTAINER, "utf8");
const vendor = readFileSync(VENDOR, "utf8");
const problems = [];

for (const name of SHARED_METHODS) {
  const a = extractMethod(container, name);
  const b = extractMethod(vendor, name);
  if (!a) problems.push(`container is missing ${name}() — update SHARED_METHODS / the source`);
  else if (!b) problems.push(`vendor is missing ${name}() — port it from the container`);
  else if (normalize(a) !== normalize(b)) problems.push(`${name}() DIFFERS between container and vendor — reconcile it`);
}

// The yield invariant: every run-loop yield must go through the (unthrottled)
// adaptive yield. A bare setTimeout(0) in _runLoop is the perf regression.
const runLoop = extractMethod(vendor, "_runLoop") ?? "";
if (!/_adaptiveYield\s*\(/.test(runLoop)) problems.push("vendor _runLoop() does not use _adaptiveYield — yields will be throttled");
if (/setTimeout\s*\(\s*r\s*,\s*0\s*\)/.test(runLoop)) problems.push("vendor _runLoop() still yields via setTimeout(0) — use _adaptiveYield (perf!)");

if (problems.length) {
  console.error("✗ vendor drift detected (sdk/src/vendor/nanovm.mjs vs nano/container/nanovm.mjs):\n");
  for (const p of problems) console.error("  • " + p);
  console.error("\nSee src/vendor/README.md for the reconcile process.");
  process.exit(1);
}
console.log(`✓ vendor in sync on shared core (${SHARED_METHODS.join(", ")} + the run-loop yield invariant)`);
