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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = join(here, "..", "..", "nano", "container", "nanovm.mjs");
const VENDOR = join(here, "..", "src", "vendor", "nanovm.mjs");
const KERNEL_SRC = join(here, "..", "..", "nano", "kernel");
const KERNEL_VENDOR = join(here, "..", "src", "vendor", "kernel");
// nodert runtime mirror (K9): the runtime subtrees are byte-identical, like the
// kernel. Only the runtime is vendored (src/ vendor/ fixtures/) — never test/,
// tools/, or spike/.
const NODERT_SRC = join(here, "..", "..", "nano", "runners", "node");
const NODERT_VENDOR = join(here, "..", "src", "vendor", "runners", "node");
const NODERT_SUBTREES = ["src", "vendor", "fixtures"];

// Methods that are pure mechanism — they must be byte-identical (modulo comments
// + whitespace) between the container and the vendor.
const SHARED_METHODS = [
  "_fastYield",
  "_adaptiveYield",
  "snapshotApp",
  "snapshot",
  "restoreAndRun",
  // serve path — large responses truncate if the Content-Length completion drifts
  "_pollConnections",
  "_expectedResponseLength",
  "_resolveConnection",
  // net bridge seam (K6): stream logic lives in kernel/net/fetch-bridge.mjs;
  // these are the delegation wrappers + guest-read plumbing that must not drift
  "setNetwork",
  "setLlmBridge",
  "_netFetch",
  "_doNetFetch",
  "_serveNetRead",
  "_netOnClose",
  "_parkNet",
  "_httpResp",
];

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

// CI checks out only the sdk repo — without the sibling nano/ checkout the
// invariant can't be evaluated there; it is enforced in the local workspace
// (and by nano's own CI on the container side).
if (!existsSync(CONTAINER)) {
  console.log(`check-vendor: sibling container not present (${CONTAINER}); skipping`);
  process.exit(0);
}

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

// The yield invariant: the hot run-loop yield must go through the (unthrottled)
// adaptive yield. The container keeps ONE setTimeout(0) for the infrequent
// FS-pending yield, so flag only EXTRA setTimeouts vs the container (the perf
// regression was the hot-path yield falling back to setTimeout).
const cRunLoop = extractMethod(container, "_runLoop") ?? "";
const vRunLoop = extractMethod(vendor, "_runLoop") ?? "";
const countST = (s) => (s.match(/setTimeout\s*\(/g) ?? []).length;
if (!/_adaptiveYield\s*\(/.test(vRunLoop)) problems.push("vendor _runLoop() does not use _adaptiveYield — yields will be throttled");
if (countST(vRunLoop) > countST(cRunLoop))
  problems.push(`vendor _runLoop() has more setTimeout() yields (${countST(vRunLoop)}) than the container (${countST(cRunLoop)}) — a hot-path yield regressed (perf!)`);

// The kernel tree is NOT curated: sdk/src/vendor/kernel/** must be a strict
// byte-identical mirror of nano/kernel/** (specs/nano/node-host-engine.md §14).
// Any divergence means "re-copy from nano", never "patch the vendor".
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}
if (existsSync(KERNEL_SRC)) {
  // Only the RUNTIME kernel is vendored — never test/ or bench/ (those live in
  // nano/kernel/{test,bench} beside the code but are not shipped in the SDK).
  const runtimeOnly = (f) => !f.startsWith("test/") && !f.startsWith("bench/");
  const srcFiles = walkFiles(KERNEL_SRC).map((p) => relative(KERNEL_SRC, p)).filter(runtimeOnly).sort();
  const vendorFiles = existsSync(KERNEL_VENDOR)
    ? walkFiles(KERNEL_VENDOR).map((p) => relative(KERNEL_VENDOR, p)).filter(runtimeOnly).sort()
    : [];
  for (const f of srcFiles) {
    if (!vendorFiles.includes(f)) {
      problems.push(`kernel mirror is missing ${f} — cp -R nano/kernel/ src/vendor/kernel/`);
    } else if (
      readFileSync(join(KERNEL_SRC, f), "utf8") !== readFileSync(join(KERNEL_VENDOR, f), "utf8")
    ) {
      problems.push(`kernel/${f} DIFFERS from nano/kernel/${f} — re-copy (the kernel mirror is byte-identical, never curated)`);
    }
  }
  for (const f of vendorFiles) {
    if (!srcFiles.includes(f)) problems.push(`kernel mirror has stray file ${f} not present in nano/kernel`);
  }
}

// The nodert runtime mirror (K9): sdk/src/vendor/nodert/{src,vendor,fixtures}
// must be a strict byte-identical mirror of nano/runners/node/{src,vendor,fixtures}.
// The node-lib bundle is binary (brotli), so compare bytes, not text.
if (existsSync(NODERT_SRC)) {
  const bytesEqual = (a, b) => {
    const x = readFileSync(a), y = readFileSync(b);
    return x.length === y.length && x.equals(y);
  };
  for (const sub of NODERT_SUBTREES) {
    const srcRoot = join(NODERT_SRC, sub);
    const venRoot = join(NODERT_VENDOR, sub);
    if (!existsSync(srcRoot)) continue;
    const srcFiles = walkFiles(srcRoot).map((p) => relative(srcRoot, p)).sort();
    const venFiles = existsSync(venRoot) ? walkFiles(venRoot).map((p) => relative(venRoot, p)).sort() : [];
    for (const f of srcFiles) {
      if (!venFiles.includes(f)) problems.push(`nodert mirror is missing ${sub}/${f} — cp -R nano/runners/node/{src,vendor,fixtures} src/vendor/runners/node/`);
      else if (!bytesEqual(join(srcRoot, f), join(venRoot, f))) problems.push(`nodert/${sub}/${f} DIFFERS from nano/runners/node/${sub}/${f} — re-copy (the node runner mirror is byte-identical, never curated)`);
    }
    for (const f of venFiles) {
      if (!srcFiles.includes(f)) problems.push(`nodert mirror has stray file ${sub}/${f} not present in nano/runners/node`);
    }
  }
}

if (problems.length) {
  console.error("✗ vendor drift detected (sdk/src/vendor vs nano/{container,kernel}):\n");
  for (const p of problems) console.error("  • " + p);
  console.error("\nSee src/vendor/README.md for the reconcile process.");
  process.exit(1);
}
console.log(`✓ vendor in sync on shared core (${SHARED_METHODS.join(", ")} + the run-loop yield invariant + byte-identical kernel & nodert mirrors)`);
