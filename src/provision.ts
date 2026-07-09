// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Generic, recipe-driven app provisioning over the Web Worker transport. Reads an
// app's recipe (from its signed catalog manifest) and provisions it — install
// deps, warm a snapshot, run, and serve — with NO per-app code here. node,
// python, … are all just data: their recipe. The only runtime-specific knowledge
// in this file is "none".

import { createNanoWorker, type NanoWorkerClient } from "./worker/client";
import type { Catalog } from "./catalog/catalog";
import type { AppRecipe } from "./catalog/types";
import { registerNanoServiceWorker } from "./serve/register-sw";
import { ServeBridge } from "./serve/bridge";
import type { ExecResult } from "./types";

export interface ProvisionOptions {
  /** The slim nano.wasm bytes. */
  wasm: ArrayBuffer;
  /** Service-worker URL (cross-origin isolation + the HTTP preview bridge). */
  swUrl: string;
  /** Spawns the SDK worker; required so it resolves in the consumer's bundler,
   *  e.g. `() => new Worker(new URL("@userland-run/nano-sdk/worker", import.meta.url), { type: "module" })`. */
  workerFactory: () => Worker;
  ramMB?: number;
  /** Supply/override the recipe when the published manifest doesn't carry one yet. */
  recipe?: AppRecipe;
  /** Extra catalog apps to install alongside (e.g. ["busybox@1.36.1"] for a shell). */
  extraApps?: string[];
  /**
   * Fetch a prebuilt warm-snapshot artifact by name (e.g. "opencode.snapshot.gz")
   * → its gzipped bytes. When the recipe declares `warmup.snapshot` and this is
   * supplied, provision loads that snapshot (gunzip → deserialize → restore) and
   * SKIPS the ~minute-long runtime warmup build. Consumers wire this to wherever
   * the artifact is hosted (catalog CDN, bundled asset, …). Absent → live build.
   */
  snapshotFetcher?: (name: string) => Promise<ArrayBuffer>;
  onProgress?: (msg: string) => void;
}

export interface RunOptions {
  onStdout?: (c: string) => void;
  extraFiles?: Array<{ path: string; content: string | Uint8Array }>;
  maxSteps?: number;
}

export interface ServeOptions extends RunOptions {
  port: number;
  readyPattern?: RegExp;
  onListening?: () => void;
}

export interface ServiceHandle {
  /** Preview URL for a bound port (through the service-worker bridge). */
  url: (path?: string) => Promise<string>;
  stop: () => void;
  done: Promise<unknown>;
}

export interface ProvisionedApp {
  /** The underlying worker client (escape hatch). */
  readonly client: NanoWorkerClient;
  /** Run the app entrypoint on a file (recipe.run.fileScript). */
  run(file: string, opts?: RunOptions): Promise<ExecResult>;
  /** Run inline source (recipe.run.evalScript). */
  evalCode(code: string, opts?: RunOptions): Promise<ExecResult>;
  /** Start a long-running server file; resolves once it reports readiness. */
  serve(file: string, opts: ServeOptions): Promise<ServiceHandle>;
  /** Raw busybox/shell exec (not the provisioned app). */
  sh(line: string, opts?: RunOptions): Promise<ExecResult>;
}

function envToArray(env?: Record<string, string>): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
}

/**
 * Wrap a streaming sink so the recipe's output filters apply live: forward whole
 * lines, but stop at the first line matching a filter (the trailing trace, e.g.
 * node's shutdown assertion, is always last — so cutting from there is safe).
 */
function filteredSink(onStdout: ((c: string) => void) | undefined, filters: string[]): ((c: string) => void) | undefined {
  if (!onStdout || !filters.length) return onStdout;
  const res = filters.map((f) => new RegExp(f));
  let pending = "";
  let stopped = false;
  return (chunk: string) => {
    if (stopped) return;
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (res.some((r) => r.test(line))) {
        stopped = true;
        return;
      }
      onStdout(line + "\n");
    }
  };
}

/** Apply the recipe's output filters + benign exit codes (e.g. strip node's
 *  shutdown-crash trace; treat its benign exit 134 as success). */
function applyRecipe(r: ExecResult, recipe: AppRecipe): ExecResult {
  let cut = r.stdout.length;
  for (const f of recipe.outputFilters ?? []) {
    const m = r.stdout.match(new RegExp(`[^\\n]*(?:${f})`));
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  const stdout = cut < r.stdout.length ? r.stdout.slice(0, cut).replace(/[ \t\n]+$/, "") + "\n" : r.stdout;
  const exitCode = (recipe.benignExitCodes ?? []).includes(r.exitCode) ? 0 : r.exitCode;
  return { ...r, stdout, exitCode };
}

/**
 * Provision a catalog app on a worker-hosted VM and return run/serve helpers
 * driven by the app's recipe.
 */
export async function provision(catalog: Catalog, ref: string, opts: ProvisionOptions): Promise<ProvisionedApp> {
  const log = opts.onProgress ?? (() => {});

  log("preparing cross-origin isolation…");
  const st = await registerNanoServiceWorker({ swUrl: opts.swUrl });
  if (st.reloading) await new Promise(() => {}); // page is reloading — halt

  log("starting worker VM…");
  const client = await createNanoWorker(
    { image: { wasm: opts.wasm }, warmup: false, ramMB: opts.ramMB ?? 1800, crossOriginIsolation: "ignore" },
    opts.workerFactory,
  );

  // Forward the file mode: the catalog ships busybox/node as 0755, and the guest
  // enforces the exec bit (execve → EACCES without it), so dropping mode here would
  // leave /bin/busybox non-executable and break `sh`-launched applets (pipes, etc.).
  const target = { writeFile: (p: string, b: Uint8Array, mode?: number) => client.fs.writeFile(p, b, mode) };

  log(`installing ${ref}…`);
  const manifest = await catalog.install(target as never, ref);
  // The app's signed manifest carries its recipe; `opts.recipe` only overrides.
  const recipe: AppRecipe = manifest.recipe ?? opts.recipe ?? {};

  for (const dep of [...(recipe.deps ?? []), ...(opts.extraApps ?? [])]) {
    log(`installing ${dep}…`);
    await catalog.install(target as never, dep).catch(() => {});
  }

  if (recipe.warmup) {
    const w = recipe.warmup;
    // Prefer a prebuilt, shipped snapshot (gunzip → deserialize → restore) over
    // building it live — the runtime build for a server can take ~a minute.
    let loadedPrebuilt = false;
    if (w.snapshot && opts.snapshotFetcher) {
      try {
        log(`loading prebuilt snapshot ${w.snapshot}…`);
        const gz = await opts.snapshotFetcher(w.snapshot);
        await client.loadSnapshot(gz);
        loadedPrebuilt = true;
      } catch (e) {
        log(`prebuilt snapshot unavailable (${(e as Error).message}); building live…`);
      }
    }
    if (!loadedPrebuilt) {
      log("warming up…");
      await client.setWarmup({
        elfPath: w.elfPath,
        launcher: w.launcher,
        launcherPath: w.launcherPath,
        argv: w.argv,
        env: envToArray(w.env),
        maxSteps: w.maxSteps,
        // Ready-probe capture (servers): snapshot when the host probe returns 200,
        // not at a guest sentinel. The runner picks snapshotAppReady when present.
        ready: w.ready,
      });
      // Prewarm off the main thread; the first run awaits the same in-flight snapshot.
      void client.warmup().catch(() => {});
    }
  }

  const fileScript = (file: string): string =>
    (recipe.run?.fileScript ?? "${file}").replace("${file}", file);
  const evalScript = (code: string): string => (recipe.run?.evalScript ?? "${code}").replace("${code}", code);

  let bridge: { previewUrl: (port: number, path?: string) => string } | null = null;
  const ensureBridge = async (): Promise<typeof bridge> => {
    if (!bridge) bridge = await ServeBridge.register({ swUrl: opts.swUrl, injector: client });
    return bridge;
  };

  // restoreAndRun defaults to the tiny busybox step budget; a warm app run needs
  // a real one (a warm V8 still executes billions of instructions).
  const DEFAULT_RUN_STEPS = 2_000_000_000;
  const filters = recipe.outputFilters ?? [];
  const restore = async (script: string, o?: RunOptions, maxSteps?: number): Promise<ExecResult> =>
    applyRecipe(
      await client.restoreRun(script, {
        extraFiles: o?.extraFiles,
        onData: filteredSink(o?.onStdout, filters),
        maxSteps: maxSteps ?? o?.maxSteps ?? DEFAULT_RUN_STEPS,
      }),
      recipe,
    );

  log("ready");
  return {
    client,
    run: (file, o) => restore(fileScript(file), o),
    evalCode: (code, o) => restore(evalScript(code), o),
    sh: (line, o) => client.run(line, { onData: o?.onStdout }),
    async serve(file, o) {
      await ensureBridge();
      const ready = o.readyPattern ?? /listening|running|started|ready/i;
      const sink = filteredSink(o.onStdout, filters);
      let signalled = false;
      const done = client.restoreRun(fileScript(file), {
        extraFiles: o.extraFiles,
        maxSteps: o.maxSteps ?? 200_000_000_000,
        onData: (chunk) => {
          sink?.(chunk);
          if (!signalled && ready.test(chunk)) {
            signalled = true;
            o.onListening?.();
          }
        },
      });
      done.catch(() => {});
      return {
        url: async (path) => (await ensureBridge())!.previewUrl(o.port, path),
        stop: () => client.cancel(),
        done,
      };
    },
  };
}
