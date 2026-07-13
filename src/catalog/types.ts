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
    /**
     * Server readiness probe. When set, the runner captures the snapshot the
     * moment a host GET of `path` on `port` returns HTTP `status` (default 200) —
     * i.e. a warm, serviceable server — instead of waiting for a guest
     * `/dev/__snapshot__` sentinel. Required for servers whose readiness a guest
     * launcher can't report (the guest can't loopback to its own listener), and it
     * captures a much faster-restoring snapshot (routes + handler warm).
     */
    ready?: { port: number; path: string; status?: number };
    /**
     * Prebuilt-snapshot artifact name (e.g. "opencode.snapshot.gz"), produced
     * off-VM by serializing a `snapshotAppReady` capture and gzipping it (see the
     * recipe's build-snapshot tool). When set AND the runner is given a
     * `snapshotFetcher` (ProvisionOptions), provision loads this prebuilt snapshot
     * — gunzip → deserializeSnapshot → the worker's app snapshot — and SKIPS the
     * ~minute-long runtime warmup build. Falls back to the live build when the
     * artifact or fetcher is absent.
     */
    snapshot?: string;
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

/**
 * The artifact tier a catalog app targets (wasm-tier §9, D1). Absent ⇒
 * `"elf-app"` for back-compat with pre-`kind` manifests.
 *   "elf-app"        a RISC-V ELF run by the emulator (BusyBox, node, …).
 *   "wasm-app"       a wasm32-wasip1 module run by the wasm tier (kind:"wasm"
 *                    Kernel process); installed onto PATH, routed by `.wasm`.
 *   "wasm-service"   a wasm Kernel Service (SWC, esbuild, …) — registered with
 *                    the service registry, reached over the `svc.*` bus, NOT PATH.
 *   "wasm-component" a WASI-0.2 component (wasi-http, …) — served behind the
 *                    ServeBridge (W-3). Reserved; not yet runnable in this build.
 *   "node-app"       a JavaScript/TypeScript app run on the HOST Node engine
 *                    (engines.node:"host") — trusted, near-native. NOT the
 *                    RISC-V node ELF; distinct from an elf-app that ships node.
 *   "boa-app"        a sandboxed JavaScript app run by the Boa interpreter
 *                    (the boa runner) — capability-scoped, no ambient authority.
 */
export type ArtifactKind =
  | "elf-app"
  | "wasm-app"
  | "wasm-service"
  | "wasm-component"
  | "node-app"
  | "boa-app";

/**
 * The execution tier (runner) that actually runs an app, derived from its
 * artifact kind. The catalog + terminal browse UI group and badge apps by this:
 *   "riscv"  the RISC-V VM (emulated CPU) — elf-app.
 *   "node"   the host Node engine — node-app.
 *   "wasm"   the wasm runner (host wasm engine) — wasm-app/service/component.
 *   "boa"    the Boa sandbox (interpreted JS) — boa-app.
 */
export type Tier = "riscv" | "node" | "wasm" | "boa";

/** A signed app manifest (the `.napp`, spec §6.1). */
export interface Manifest {
  name: string;
  version: string;
  /** Artifact tier. Absent ⇒ "elf-app". See {@link ArtifactKind}. */
  kind?: ArtifactKind;
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

/** Per-app execution-tier metadata, denormalized into the index so a browse UI
 *  can group/badge apps by runner without fetching each manifest. */
export interface AppMeta {
  /** The runner that executes the app (derived from `kind`). */
  tier: Tier;
  /** The artifact kind from the manifest. */
  kind: ArtifactKind;
  /** The binary ABI/target (e.g. "riscv64gc-linux-musl", "wasm32-wasip1"). */
  abi: string;
}

/** The signed catalog index (spec §7.2). */
export interface SignedIndex {
  generation: number;
  nano_min_version: string;
  apps: Record<string, string>; // "name@version" -> manifest sha256 (a cas blob)
  /** Per-app tier/kind/abi, denormalized from the manifests (mirrors `categories`)
   *  so clients group apps by runner without N manifest fetches. Absent for legacy
   *  indexes ⇒ treat every app as the "riscv" tier (elf-app). */
  appMeta?: Record<string, AppMeta>;
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

/** The artifact tier of a manifest, defaulting to "elf-app" (wasm-tier D1). */
export function manifestKind(manifest: Pick<Manifest, "kind">): ArtifactKind {
  return manifest.kind ?? "elf-app";
}

/** True for any wasm tier (app/service/component) — routed off the emulator. */
export function isWasmKind(kind: ArtifactKind): boolean {
  return kind === "wasm-app" || kind === "wasm-service" || kind === "wasm-component";
}

/** The execution tier (runner) for an artifact kind. See {@link Tier}. */
export function kindToTier(kind: ArtifactKind): Tier {
  if (isWasmKind(kind)) return "wasm";
  if (kind === "node-app") return "node";
  if (kind === "boa-app") return "boa";
  return "riscv"; // elf-app (the default)
}

/** The execution tier of a manifest, defaulting via its kind ("elf-app" ⇒ riscv). */
export function manifestTier(manifest: Pick<Manifest, "kind">): Tier {
  return kindToTier(manifestKind(manifest));
}
