// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/** A file inside an app manifest. `chunks` reconstruct the (gzipped) object. */
export interface ManifestFile {
  path: string;
  mode: string;
  compression?: "gzip" | "none";
  size: number; // decompressed size the guest sees
  sha256: string; // hash of the stored object = concatenation of chunks
  chunks: string[];
}

/** A signed app manifest (the `.napp`, spec §6.1). */
export interface Manifest {
  name: string;
  version: string;
  abi: string;
  entrypoint: { argv: string[]; env: Record<string, string> };
  files: ManifestFile[];
  /** Topic facets for bottling + marketplace browse (e.g. ["Data","Text"]). */
  topics?: string[];
  /** Caveat flags from the spec: "net" | "mp" | "big" | "tty". */
  caveats?: string[];
  conformance: {
    nano_min_version: string;
    syscalls_used: number[];
    golden_sha256: string;
    instructions: number;
    tested: boolean;
  };
  size: number;
  sha256: string;
  signature: string;
}

/** The signed catalog index (spec §7.2). */
export interface SignedIndex {
  generation: number;
  nano_min_version: string;
  apps: Record<string, string>; // "name@version" -> manifest sha256 (a cas blob)
  sha256: string;
  signature: string;
}

/** Where to write installed files (satisfied by {@link Vfs}). */
export interface InstallTarget {
  writeFile(path: string, content: Uint8Array, mode?: number): void;
  /** Optional: register a file for lazy demand-fetch instead of eager write. */
  registerLazyFile?(path: string, meta: LazyFileMeta): void;
}

export interface LazyFileMeta {
  size: number;
  mode: string;
  /** Materialize the file's bytes on first access (fetch + verify + decompress). */
  resolve(): Promise<Uint8Array>;
}

export interface InstallOptions {
  /** Defer fetching a file's chunks until the guest first opens it. Default false. */
  lazy?: boolean;
  /** Progress callback. */
  onProgress?: (e: InstallProgress) => void;
}

export interface InstallProgress {
  phase: "index" | "manifest" | "chunk" | "write" | "done";
  file?: string;
  chunk?: string;
  fetched?: number;
  total?: number;
}
