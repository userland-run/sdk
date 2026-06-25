// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Fetch → verify → install an app from the catalog (spec §6, §7.4).
 *
 * Trust chain: the signed index and each manifest are verified against the
 * bundled catalog public key; every chunk is verified by sha256 before it is
 * used; the reassembled file is verified against the manifest's file hash. A
 * compromised or stale CDN edge can therefore only serve bytes that fail
 * verification, which are rejected — which is what makes a free public CDN safe
 * as a package origin.
 */

import type { CdnClient } from "./cdn";
import type { ChunkCache } from "./cache";
import { sha256Hex, verifySigned } from "./crypto";
import type {
  InstallOptions,
  InstallTarget,
  Manifest,
  ManifestFile,
  SignedIndex,
} from "./types";

export interface InstallContext {
  cdn: CdnClient;
  cache: ChunkCache;
  /** Override the verification key (tests / custom catalogs). Default: bundled. */
  key?: CryptoKey;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fetch the signed index and verify it against the catalog key. */
export async function resolveIndex(ctx: InstallContext): Promise<SignedIndex> {
  const index = await ctx.cdn.fetchJson<SignedIndex>(await ctx.cdn.indexUrl());
  const v = await verifySigned(index as unknown as Record<string, unknown>, ctx.key);
  if (!v.ok) throw new Error(`catalog: index signature invalid (${v.reason})`);
  return index;
}

/** Resolve `name` or `name@version` to a verified manifest. */
export async function resolveManifest(ctx: InstallContext, ref: string, index?: SignedIndex): Promise<Manifest> {
  const idx = index ?? (await resolveIndex(ctx));
  const key = ref.includes("@") ? ref : pickLatest(idx, ref);
  if (!key) throw new Error(`catalog: app not found: ${ref}`);
  const manifestSha = idx.apps[key];
  if (!manifestSha) throw new Error(`catalog: app not found: ${key}`);

  const bytes = await ctx.cdn.fetchBytes(await ctx.cdn.casUrl(manifestSha));
  if ((await sha256Hex(bytes)) !== manifestSha)
    throw new Error(`catalog: manifest hash mismatch for ${key}`);
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  const v = await verifySigned(manifest as unknown as Record<string, unknown>, ctx.key);
  if (!v.ok) throw new Error(`catalog: manifest signature invalid for ${key} (${v.reason})`);
  return manifest;
}

/** Highest version listed for `name` (numeric-dotted compare). */
function pickLatest(index: SignedIndex, name: string): string | null {
  const prefix = name + "@";
  const versions = Object.keys(index.apps).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  if (versions.length === 0) return null;
  versions.sort(cmpVersion);
  return `${name}@${versions[versions.length - 1]}`;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Fetch one chunk, verify its sha256, and cache it. Cache hit skips the network. */
export async function fetchVerifiedChunk(ctx: InstallContext, sha256: string): Promise<Uint8Array> {
  const cached = await ctx.cache.get(sha256);
  if (cached) return cached;
  const bytes = await ctx.cdn.fetchBytes(await ctx.cdn.casUrl(sha256));
  if ((await sha256Hex(bytes)) !== sha256) throw new Error(`catalog: chunk hash mismatch ${sha256}`);
  await ctx.cache.put(sha256, bytes);
  return bytes;
}

/** Reassemble a file from its chunks, verify the whole, and decompress. */
export async function assembleFile(
  ctx: InstallContext,
  file: ManifestFile,
  onChunk?: (sha: string, i: number, total: number) => void,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let len = 0;
  let i = 0;
  for (const sha of file.chunks) {
    const c = await fetchVerifiedChunk(ctx, sha);
    onChunk?.(sha, i++, file.chunks.length);
    parts.push(c);
    len += c.length;
  }
  const stored = new Uint8Array(len);
  let p = 0;
  for (const part of parts) { stored.set(part, p); p += part.length; }
  if ((await sha256Hex(stored)) !== file.sha256)
    throw new Error(`catalog: file hash mismatch for ${file.path}`);

  const out = file.compression === "gzip" ? await gunzip(stored) : stored;
  if (file.size != null && out.length !== file.size)
    throw new Error(`catalog: ${file.path} decompressed to ${out.length} bytes, expected ${file.size}`);
  return out;
}

/**
 * Install an app into `target`. Eager by default; with `{ lazy: true }` and a
 * target that supports `registerLazyFile`, each file's chunks are fetched on
 * first guest access instead of up front.
 */
export async function installApp(
  target: InstallTarget,
  ref: string,
  ctx: InstallContext,
  opts: InstallOptions = {},
): Promise<Manifest> {
  opts.onProgress?.({ phase: "index" });
  const index = await resolveIndex(ctx);
  opts.onProgress?.({ phase: "manifest" });
  const manifest = await resolveManifest(ctx, ref, index);

  const lazy = opts.lazy && typeof target.registerLazyFile === "function";
  for (const file of manifest.files) {
    if (lazy) {
      target.registerLazyFile!(file.path, {
        size: file.size,
        mode: file.mode,
        resolve: () => assembleFile(ctx, file),
      });
    } else {
      const bytes = await assembleFile(ctx, file, (chunk, fetched, total) =>
        opts.onProgress?.({ phase: "chunk", file: file.path, chunk, fetched, total }),
      );
      opts.onProgress?.({ phase: "write", file: file.path });
      target.writeFile(file.path, bytes, parseInt(file.mode, 8) || undefined);
    }
  }
  opts.onProgress?.({ phase: "done" });
  return manifest;
}
