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

/**
 * App-specific setup, carried as signed manifest data so a *generic* runner can
 * provision and run the app with no per-app code (spec: app recipes). Everything
 * runtime-specific about, e.g., node — its warmup launcher, the per-run script
 * shape, the benign shutdown exit code, the noisy shutdown assertion to strip —
 * lives here, not in the SDK or the consuming app.
 */
export interface AppRecipe {
  /** Other catalog apps to install first (refs like "busybox@1.36.1"). */
  deps?: string[];
  /**
   * Snapshot-warmup strategy. The runner boots the ELF with this launcher/argv/env
   * until the guest signals `/dev/__snapshot__`, then reuses the snapshot for fast
   * runs. The launcher convention: write `/dev/__snapshot__`, then read+execute the
   * payload at `/dev/__run__`. Absent → no warm snapshot (each run is cold).
   */
  warmup?: {
    /** ELF path in the guest VFS; defaults to entrypoint.path. */
    elfPath?: string;
    launcher?: string;
    launcherPath?: string;
    argv: string[];
    env?: Record<string, string>;
    maxSteps?: number;
  };
  /** How a run request becomes the script injected at `/dev/__run__`. */
  run?: {
    /** Template for "run this file"; `${file}` → absolute VFS path. */
    fileScript?: string;
    /** Template for "run this code"; `${code}` → the source. */
    evalScript?: string;
  };
  /** Exit codes to treat as success (e.g. node's benign shutdown crash, 134). */
  benignExitCodes?: number[];
  /** Regexes; matched text through end-of-output is stripped from stdout. */
  outputFilters?: string[];
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
  /** App-specific provisioning recipe (deps, warmup, run shape, output handling). */
  recipe?: AppRecipe;
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

/** A hand-curated collection: an intentional workflow set of apps, distinct from
 *  the auto-derived topic categories. Members are app names (version-resolved at
 *  install). */
export interface Collection {
  title: string;
  description: string;
  members: string[]; // app names, e.g. ["node", "typescript"]
}

/** The signed catalog index (spec §7.2). */
export interface SignedIndex {
  generation: number;
  nano_min_version: string;
  apps: Record<string, string>; // "name@version" -> manifest sha256 (a cas blob)
  bundles?: Record<string, string>; // "topic-slug" -> bundle manifest sha256
  /** Browse facets: topic-slug -> member app refs (denormalized from `bundles`,
   *  so clients can group apps by category without fetching each bundle). */
  categories?: Record<string, string[]>;
  /** Curated workflow sets: slug -> collection (distinct from topic categories). */
  collections?: Record<string, Collection>;
  sha256: string;
  signature: string;
}

/** A signed topic bundle: the set of app refs to install together (bottling). */
export interface BundleManifest {
  name: string;        // the topic slug, e.g. "data"
  kind: "bundle";
  topic: string;       // the display topic, e.g. "Data"
  generation: number;
  apps: string[];      // member "name@version" refs
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
