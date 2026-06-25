// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Content-addressed chunk cache. Chunks are immutable (named by sha256), so once
 * fetched and verified a chunk is cached forever — each unique chunk is fetched
 * once, ever, across apps and reloads (spec §6). Backed by OPFS
 * (navigator.storage.getDirectory) when available, with an in-memory fallback
 * for Node / SSR / private contexts.
 */

export interface ChunkCache {
  get(sha256: string): Promise<Uint8Array | null>;
  put(sha256: string, bytes: Uint8Array): Promise<void>;
}

class MemoryCache implements ChunkCache {
  private map = new Map<string, Uint8Array>();
  async get(sha: string) { return this.map.get(sha) ?? null; }
  async put(sha: string, bytes: Uint8Array) { this.map.set(sha, bytes); }
}

class OpfsCache implements ChunkCache {
  constructor(private dir: FileSystemDirectoryHandle) {}

  async get(sha: string): Promise<Uint8Array | null> {
    try {
      const fh = await this.dir.getFileHandle(sha);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null; // not cached
    }
  }

  async put(sha: string, bytes: Uint8Array): Promise<void> {
    try {
      const fh = await this.dir.getFileHandle(sha, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes as BufferSource);
      await w.close();
    } catch {
      /* best-effort: a cache write failure is non-fatal (we just refetch) */
    }
  }
}

/** Open the chunk cache, preferring OPFS under `/<subdir>/cas`. */
export async function openChunkCache(subdir = "nano-catalog"): Promise<ChunkCache> {
  try {
    const nav = typeof navigator !== "undefined" ? (navigator as unknown as { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } }) : undefined;
    const storage = nav?.storage;
    if (storage?.getDirectory) {
      const root = await storage.getDirectory();
      const appDir = await root.getDirectoryHandle(subdir, { create: true });
      const casDir = await appDir.getDirectoryHandle("cas", { create: true });
      return new OpfsCache(casDir);
    }
  } catch {
    /* fall through to memory */
  }
  return new MemoryCache();
}
