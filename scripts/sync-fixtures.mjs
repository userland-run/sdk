// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Stage the runtime fixtures the Playwright e2e harness serves, into
 * tests/e2e/public/ (gitignored). Two kinds:
 *
 *  1. Binary artifacts copied from the sibling nano repo:
 *       nano.busybox.wasm, boa.wasm, the Node.js ELF, and the devenv overlay
 *       (node + tsc/eslint/prettier). Override the source with $NANO_DIR, or
 *       point individual files at $NANO_WASM / $NANO_BOA / $NANO_NODE /
 *       $NANO_DEVENV (CI downloads them from a nano release).
 *
 *  2. A self-contained, offline **signed catalog** (no jsDelivr): the real
 *     BusyBox ELF, gzipped + content-addressed + Ed25519-signed with a throwaway
 *     key — exactly the trust chain the SDK's catalog client verifies. Plus a
 *     tampered copy (one flipped chunk byte) so the install path can prove it
 *     rejects corrupted bytes.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { canonicalize } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const nanoDir = process.env.NANO_DIR ?? join(here, "../../nano");
const publicDir = join(here, "../tests/e2e/public");
const casFor = (name) => join(publicDir, name);

const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.log("[sync-fixtures]", ...a);

mkdirSync(publicDir, { recursive: true });

// --- 1. copy binary artifacts (skip if an identical-size copy is already there) ---
const artifacts = [
  // Slim build (no bundled ELF) — the node ELF passed via image.node populates
  // _nodeElf only here; the busybox-bundled wasm would clobber it (nanovm.mjs).
  { dst: "nano.wasm", env: "NANO_SLIM_WASM", src: join(nanoDir, "wasm/nano.wasm") },
  { dst: "nano.busybox.wasm", env: "NANO_WASM", src: join(nanoDir, "wasm/nano.busybox.wasm") },
  { dst: "boa.wasm", env: "NANO_BOA", src: join(nanoDir, "wasm/boa.wasm") },
  { dst: "node", env: "NANO_NODE", src: join(nanoDir, "images/node") },
  { dst: "nano-sw.js", env: "NANO_SW", src: join(here, "../static/nano-sw.js") },
];

let missing = 0;
for (const a of artifacts) {
  const src = process.env[a.env] ?? a.src;
  const dst = casFor(a.dst);
  if (!existsSync(src)) {
    console.warn(`[sync-fixtures] MISSING ${a.dst}: ${src} (set $${a.env}). Specs needing it will fail.`);
    missing++;
    continue;
  }
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) {
    log(`ok   ${a.dst} (cached)`);
    continue;
  }
  copyFileSync(src, dst);
  log(`copy ${a.dst} ← ${src}`);
}

// --- 1b. stage the vendored nodert + kernel worker trees at the SITE ROOT ---
// The e2e is a vite BUILD (flattened chunks), so the nodert worker tree can't
// sit next to the bundle; nodert-engine.ts resolves it from the origin root
// (/vendor/...) as its last candidate. Copy dist/vendor/{nodert,kernel} →
// public/vendor so `engines.node:"nodert"` boots in the browser (K9-browser).
{
  const distVendor = join(here, "../dist/vendor");
  const outVendor = join(publicDir, "vendor");
  if (existsSync(distVendor)) {
    cpSync(distVendor, outVendor, { recursive: true });
    log("copy vendor/{nodert,kernel} ← dist/vendor (site-root worker tree for nodert)");
  } else {
    console.warn("[sync-fixtures] dist/vendor missing — run `npm run build` first; nodert e2e will skip");
  }
}

// --- 2. build the offline signed catalog (busybox as the demo app) ---
const busyboxSrc = process.env.NANO_BUSYBOX_ELF ?? join(nanoDir, "images/busybox");
if (!existsSync(busyboxSrc)) {
  console.warn(`[sync-fixtures] MISSING busybox ELF for the catalog fixture: ${busyboxSrc}`);
  missing++;
} else {
  buildCatalog(new Uint8Array(readFileSync(busyboxSrc)));
}

// --- 3. dev-tools overlay: node + tsc/eslint/prettier from the catalog out trees ---
// (The devenv tarball's bin entries are Docker shell-wrappers node can't parse;
// the catalog recipe trees carry the real lib JS, so we assemble from those.)
buildDevtoolsOverlay();

function buildDevtoolsOverlay() {
  const overlay = casFor("devtools.overlay");
  if (existsSync(overlay)) {
    log("ok   devtools.overlay (cached)");
    return;
  }
  const catalogDir = process.env.CATALOG_DIR ?? join(here, "../../catalog");
  const nodeElf = process.env.NANO_NODE ?? join(nanoDir, "images/node");
  const tools = ["typescript", "eslint", "prettier"];
  const sources = tools.map((t) => join(catalogDir, "recipes", t, "out/usr/local"));
  const missingSrc = [nodeElf, ...sources].filter((p) => !existsSync(p));
  if (missingSrc.length) {
    console.warn(`[sync-fixtures] MISSING dev-tool sources, skipping devtools.overlay:\n  ${missingSrc.join("\n  ")}`);
    missing++;
    return;
  }
  const staging = join(publicDir, ".devtools-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "usr/bin"), { recursive: true });
  mkdirSync(join(staging, "usr/local"), { recursive: true });
  // node on PATH (/usr/bin) for the `exec node …` wrappers.
  copyFileSync(nodeElf, join(staging, "usr/bin/node"));
  execSync(`chmod 755 ${JSON.stringify(join(staging, "usr/bin/node"))}`);
  // Merge each tool's /usr/local (bin/ + lib/node_modules/).
  for (const src of sources) execSync(`cp -a ${JSON.stringify(src + "/.")} ${JSON.stringify(join(staging, "usr/local"))}`);
  execSync(`tar -czf ${JSON.stringify(overlay)} -C ${JSON.stringify(staging)} .`);
  rmSync(staging, { recursive: true, force: true });
  log(`devtools.overlay built (node + ${tools.join("/")})`);
}

/** Append sha256 + Ed25519 signature exactly like catalog/tools/package.mjs. */
function finalize(core, privateKey) {
  const base = { ...core };
  delete base.sha256;
  delete base.signature;
  const sha256 = sha(canonicalize(base));
  const withHash = { ...base, sha256 };
  const signature = edSign(null, Buffer.from(canonicalize(withHash)), privateKey).toString("base64");
  return { ...withHash, signature };
}

function buildCatalog(elf) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const goodB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const { publicKey: otherKey } = generateKeyPairSync("ed25519");
  const badB64 = Buffer.from(otherKey.export({ format: "jwk" }).x, "base64url").toString("base64");

  // Good catalog: the real BusyBox ELF, installed at /opt/bin/busybox so the
  // catalog spec can actually execute it after install.
  const good = packApp(privateKey, {
    name: "busybox-demo",
    version: "1.36.1",
    installPath: "/opt/bin/busybox",
    original: Buffer.from(elf),
  });
  writeCatalog("catalog", good);
  writeFileSync(join(publicDir, "catalog", "keys.json"), JSON.stringify({ good: goodB64, bad: badB64 }));

  // Tamper catalog: a DISTINCT app (distinct chunk hash, so the browser's OPFS
  // chunk cache from the good install can't satisfy it) whose served chunk bytes
  // are corrupted — the installer must reject it on a hash mismatch.
  const tamper = packApp(privateKey, {
    name: "tamper-demo",
    version: "1.0.0",
    installPath: "/opt/bin/tamper",
    original: Buffer.from("nano e2e tamper fixture payload\n".repeat(40)),
    corruptChunk: true,
  });
  writeCatalog("catalog-tampered", tamper);

  log(`catalog built (busybox-demo@1.36.1 + tamper-demo@1.0.0)`);
}

/** Gzip + content-address + sign one app into a single-app signed index. */
function packApp(privateKey, { name, version, installPath, original, corruptChunk = false }) {
  const gz = gzipSync(original, { level: 9 });
  const chunkSha = sha(gz);
  const fileEntry = {
    path: installPath,
    mode: "0755",
    compression: "gzip",
    size: original.length,
    sha256: chunkSha,
    chunks: [chunkSha],
  };
  const manifest = finalize(
    {
      name,
      version,
      abi: "riscv64gc-linux-musl",
      entrypoint: { argv: [name], env: {} },
      files: [fileEntry],
      conformance: {
        nano_min_version: "0.2.0",
        syscalls_used: [64, 93],
        golden_sha256: "fixture",
        instructions: 0,
        tested: true,
      },
      size: gz.length,
    },
    privateKey,
  );
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const manifestSha = sha(manifestBytes);
  const index = finalize(
    { generation: 1, nano_min_version: "0.2.0", apps: { [`${name}@${version}`]: manifestSha } },
    privateKey,
  );
  // Flip the last byte of the served chunk; its declared hash is unchanged.
  const chunk = corruptChunk
    ? Buffer.concat([gz.subarray(0, gz.length - 1), Buffer.from([gz[gz.length - 1] ^ 0xff])])
    : gz;
  return { index, manifestSha, manifestBytes, chunkSha, chunk };
}

function writeCatalog(dir, { index, manifestSha, manifestBytes, chunkSha, chunk }) {
  const root = join(publicDir, dir);
  mkdirSync(join(root, "cas"), { recursive: true });
  writeFileSync(join(root, "index.json"), JSON.stringify(index));
  writeFileSync(join(root, "cas", manifestSha), manifestBytes);
  writeFileSync(join(root, "cas", chunkSha), chunk);
}

if (missing) {
  console.warn(`[sync-fixtures] done with ${missing} missing artifact(s) — some specs will fail.`);
} else {
  log("done — all fixtures staged.");
}
