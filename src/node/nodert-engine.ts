// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// src/node/nodert-engine.ts — lazily load the vendored nodert runtime and bind
// it to a Kernel (spec §14, K9). This is the seam that makes
// createNano({ engines: { node: "nodert" | "auto" } }) run Node on the host JS
// engine instead of the RISC-V emulator.
//
// The nodert runtime is a tree of .mjs workers + a node-lib bundle that CANNOT
// be flattened into the single tsup dist bundle (workers need standalone entry
// files; the bundle is read at runtime). So it is NOT statically imported —
// it is loaded at runtime by URL, from either layout:
//   • source  (terminal / source tests): src/node/ → ../vendor/nodert/…
//   • dist    (published SDK):            dist/index.js → ./vendor/nodert/…
// The specifier is assembled from parts so esbuild leaves it as a native
// runtime import (it never tries to bundle node:fs / the worker graph).
//
// If neither layout resolves (a bundled build without the copied vendor tree),
// the load throws; callers decide policy: "auto" falls back to the VM, explicit
// "nodert" surfaces ERR_NODERT_RUNTIME_UNAVAILABLE.

/** Minimal shape of the vendored createNodeEngine return we consume. */
export interface NodertEngine {
  node(
    argv: string[],
    opts: Record<string, unknown>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; engine: string; fellBack?: boolean }>;
  which(argv: string[], opts?: Record<string, unknown>): { engine: string; reason: string };
}

export interface NodertLoadConfig {
  engine?: "vm" | "nodert" | "auto";
  routing?: Record<string, "vm" | "nodert">;
  vmRun?: (argv: string[], opts: Record<string, unknown>) => Promise<unknown>;
}

// Candidate module specifiers for the vendored engine, relative to THIS module's
// URL at runtime. Assembled from parts so the bundler can't statically resolve
// (and therefore can't try to bundle) them.
const NODERT_SUBPATH = ["vendor", "nodert", "src", "host"].join("/");
const CANDIDATE_PREFIXES = ["../", "./"]; // source layout, then dist layout

async function importFromCandidates<T>(file: string): Promise<T> {
  let lastErr: unknown = null;
  for (const prefix of CANDIDATE_PREFIXES) {
    try {
      const spec = new URL(prefix + NODERT_SUBPATH + "/" + file, import.meta.url).href;
      return (await import(/* @vite-ignore */ spec)) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(
    "nano-sdk: the nodert host-engine runtime is not reachable in this build. " +
      "It ships as a vendored worker tree (src/vendor/nodert); a bundled dist needs " +
      "that tree copied alongside (dist/vendor/nodert). See src/node/nodert-engine.ts.",
  );
  (err as { code?: string; cause?: unknown }).code = "ERR_NODERT_RUNTIME_UNAVAILABLE";
  (err as { cause?: unknown }).cause = lastErr;
  throw err;
}

let cachedEngineMod: Promise<{ createNodeEngine: Function }> | null = null;
let cachedDelegateMod: Promise<{ registerNodertDelegate: Function }> | null = null;

/**
 * Load the vendored nodert runtime and return an engine bound to `kernel`.
 * Also registers nodert as the Kernel router's `node` spawn delegate, so the
 * VM's own execve path (`sh -c "node …"` inside the emulator) reaches nodert
 * over the shared VFS. Idempotent per module load (imports are cached).
 */
export async function loadNodertEngine(
  kernel: unknown,
  cfg: NodertLoadConfig,
): Promise<NodertEngine> {
  cachedEngineMod ??= importFromCandidates<{ createNodeEngine: Function }>("engine.mjs");
  cachedDelegateMod ??= importFromCandidates<{ registerNodertDelegate: Function }>("delegate.mjs");
  const [{ createNodeEngine }, { registerNodertDelegate }] = await Promise.all([
    cachedEngineMod,
    cachedDelegateMod,
  ]);
  // Register the router delegate once per kernel so cross-tier execve works.
  const k = kernel as { __nodertDelegateRegistered?: boolean };
  if (!k.__nodertDelegateRegistered) {
    try {
      registerNodertDelegate(kernel);
      k.__nodertDelegateRegistered = true;
    } catch {
      /* a delegate may already be registered; non-fatal */
    }
  }
  return createNodeEngine(kernel, cfg) as NodertEngine;
}

/** True if the error is the documented "runtime not in this build" signal. */
export function isRuntimeUnavailable(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "ERR_NODERT_RUNTIME_UNAVAILABLE";
}
