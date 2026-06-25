// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Integration test for the catalog client: signs real (gzipped, chunked,
// content-addressed, Ed25519-signed) artifacts with a throwaway key, serves them
// through a local fetch shim, and drives the SDK's fetch → verify → assemble →
// install path. Covers the trust chain (index + manifest signatures, chunk and
// file hashes), cache reuse, and rejection of tampered bytes. Booting the VM is
// out of scope here (needs a cross-origin-isolated context); that's covered by
// the nano conformance pipeline.
//
// Run after `npm run build`:  node test/catalog-install.test.mjs

import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Catalog, canonicalize } from "../dist/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  FAIL: ${m}`); } };
const sha = (b) => createHash("sha256").update(b).digest("hex");

// --- throwaway signing key (mirrors catalog/tools) ---
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubRawB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");

function finalize(core) {
  const base = { ...core }; delete base.sha256; delete base.signature;
  const sha256 = sha(canonicalize(base));
  const withHash = { ...base, sha256 };
  const signature = edSign(null, Buffer.from(canonicalize(withHash)), privateKey).toString("base64");
  return { ...withHash, signature };
}

// --- build a fake app artifact set ---
const original = Buffer.from("\x7fELF demo binary payload — not a real ELF, just bytes.\n".repeat(20));
const gz = gzipSync(original, { level: 9 });
const chunkSha = sha(gz);
const fileEntry = {
  path: "/usr/bin/demo", mode: "0755", compression: "gzip",
  size: original.length, sha256: sha(gz), chunks: [chunkSha],
};
const manifest = finalize({
  name: "demo", version: "1.0.0", abi: "riscv64gc-linux-musl",
  entrypoint: { argv: ["demo"], env: {} },
  files: [fileEntry],
  conformance: { nano_min_version: "0.1.0", syscalls_used: [64, 93], golden_sha256: "deadbeef", instructions: 123, tested: true },
  size: gz.length,
});
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
const manifestSha = sha(manifestBytes);
const index = finalize({ generation: 1, nano_min_version: "0.1.0", apps: { "demo@1.0.0": manifestSha } });

// --- local CDN over a fetch shim, with fetch accounting + a tamper toggle ---
function makeCdn({ tamperChunk = false } = {}) {
  const blobs = new Map();
  blobs.set("/index.json", Buffer.from(JSON.stringify(index)));
  blobs.set(`/cas/${manifestSha}`, manifestBytes);
  const served = tamperChunk ? Buffer.concat([gz.subarray(0, gz.length - 1), Buffer.from([gz[gz.length - 1] ^ 0xff])]) : gz;
  blobs.set(`/cas/${chunkSha}`, served);
  const counts = {};
  const fetchFn = async (url) => {
    const key = url.replace("local://catalog", "");
    counts[key] = (counts[key] || 0) + 1;
    if (!blobs.has(key)) return { ok: false, status: 404 };
    const buf = blobs.get(key);
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(buf.toString("utf8")),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  return { fetchFn, counts };
}

class FakeTarget {
  writes = [];
  writeFile(path, content, mode) { this.writes.push({ path, content, mode }); }
}

// --- 1. happy path: verify + assemble + install ---
{
  const { fetchFn, counts } = makeCdn();
  const catalog = new Catalog({ cdn: { baseUrl: "local://catalog", fetchFn }, publicKeyB64: pubRawB64 });
  const target = new FakeTarget();
  const m = await catalog.install(target, "demo");
  ok(m.name === "demo" && m.version === "1.0.0", "install: returns the verified manifest");
  ok(target.writes.length === 1, "install: wrote exactly one file");
  const w = target.writes[0];
  ok(w.path === "/usr/bin/demo", "install: correct install path");
  ok(w.mode === 0o755, "install: executable mode set");
  ok(Buffer.from(w.content).equals(original), "install: decompressed bytes equal the original");
  ok(counts[`/cas/${chunkSha}`] === 1, "install: fetched the chunk once");
}

// --- 2. cache reuse: a second install hits the cache, no refetch ---
{
  const { fetchFn, counts } = makeCdn();
  const cdn = { baseUrl: "local://catalog", fetchFn };
  const catalog = new Catalog({ cdn, publicKeyB64: pubRawB64 }); // shared cache across installs
  await catalog.install(new FakeTarget(), "demo");
  await catalog.install(new FakeTarget(), "demo");
  ok(counts[`/cas/${chunkSha}`] === 1, "cache: chunk fetched once across two installs");
}

// --- 3. tampered chunk is rejected ---
{
  const { fetchFn } = makeCdn({ tamperChunk: true });
  const catalog = new Catalog({ cdn: { baseUrl: "local://catalog", fetchFn }, publicKeyB64: pubRawB64 });
  let threw = null;
  try { await catalog.install(new FakeTarget(), "demo"); } catch (e) { threw = e; }
  ok(threw && /chunk hash mismatch/.test(threw.message), "tamper: chunk hash mismatch rejected");
}

// --- 4. wrong key rejects the index signature ---
{
  const { fetchFn } = makeCdn();
  const { publicKey: other } = generateKeyPairSync("ed25519");
  const otherB64 = Buffer.from(other.export({ format: "jwk" }).x, "base64url").toString("base64");
  const catalog = new Catalog({ cdn: { baseUrl: "local://catalog", fetchFn }, publicKeyB64: otherB64 });
  let threw = null;
  try { await catalog.install(new FakeTarget(), "demo"); } catch (e) { threw = e; }
  ok(threw && /index signature invalid/.test(threw.message), "wrong key: index signature rejected");
}

// --- 5. resolve by bare name picks the listed version ---
{
  const { fetchFn } = makeCdn();
  const catalog = new Catalog({ cdn: { baseUrl: "local://catalog", fetchFn }, publicKeyB64: pubRawB64 });
  const m = await catalog.manifest("demo");
  ok(m.version === "1.0.0", "resolve: bare name resolves to the published version");
}

console.log(`\ncatalog install tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
