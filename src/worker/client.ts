// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type {
  ConnectionInjector,
  DirEntry,
  ExecOptions,
  ExecResult,
  NanoConfig,
  NodeRunOptions,
  ScriptEngine,
  ScriptEngineOptions,
  ShellHost,
  ShellOptions,
  WasmAppExecOptions,
  WasmAppExecResult,
} from "../types";
import type { InstallOptions, Manifest } from "../catalog/types";
import type { BundleInstallResult } from "../catalog/catalog";
import type { Req, Res, WorkerTarget } from "./protocol";
import { Shell } from "../shell/shell";

type DataCb = (chunk: string) => void;
type HostCallback = (...args: unknown[]) => unknown | Promise<unknown>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stripOnData<T extends { onData?: unknown }>(opts?: T): Omit<T, "onData"> | undefined {
  if (!opts) return undefined;
  const copy = { ...opts } as { onData?: unknown };
  delete copy.onData;
  return copy as Omit<T, "onData">;
}

/**
 * The config's ArrayBuffers, deduped (transferring the same buffer twice throws
 * a DataCloneError). Only used when the caller opts in via
 * {@link NanoWorkerOptions.transferBuffers}, since transfer detaches them.
 */
function collectTransfers(config: NanoConfig): Transferable[] {
  const t = new Set<ArrayBuffer>();
  const add = (s: unknown): void => {
    if (s instanceof ArrayBuffer) t.add(s);
  };
  add(config.image.wasm);
  add(config.image.busybox);
  add(config.image.node);
  for (const o of config.image.overlays ?? []) add(o);
  add(config.scripting?.wasm);
  return [...t];
}

/** Options for {@link createNanoWorker} / {@link NanoWorkerClient.create}. */
export interface NanoWorkerOptions {
  /**
   * Transfer (zero-copy) the config's ArrayBuffers (wasm, overlays, …) to the
   * worker instead of copying them. Saves memory for large images, but DETACHES
   * the caller's buffers — they are unusable afterwards. Default false (copy).
   */
  transferBuffers?: boolean;
}

/**
 * Main-thread proxy for a worker-hosted {@link ScriptEngine}. eval/evalModule
 * are RPC round-trips; registerFunction/defineGlobal are queued so they land
 * before the next eval (the {@link ScriptEngine} surface returns void for them).
 */
class WorkerScriptEngine implements ScriptEngine {
  /** Serializes registerFunction/defineGlobal ahead of the next eval. Never rejects. */
  private ready: Promise<void> = Promise.resolve();
  /** First failure of a queued registerFunction/defineGlobal, surfaced by the next eval. */
  private queuedError: unknown = null;
  /** Main-thread callback ids owned by this engine (freed on dispose). */
  private readonly callbackIds: number[] = [];
  private disposed = false;

  constructor(
    private readonly client: NanoWorkerClient,
    private readonly engineId: number,
    /** Combined console sink (worker mode merges stdout+stderr). */
    private readonly onData?: DataCb,
  ) {}

  async eval(source: string): Promise<unknown> {
    await this.flushQueue();
    return this.client.call("script", "eval", [this.engineId, source], this.onData);
  }
  async evalModule(source: string, specifier?: string): Promise<unknown> {
    await this.flushQueue();
    return this.client.call("script", "evalModule", [this.engineId, source, specifier], this.onData);
  }
  registerFunction(name: string, fn: (...args: any[]) => unknown | Promise<unknown>): void {
    const callbackId = this.client.registerCallback(fn as HostCallback);
    this.callbackIds.push(callbackId);
    this.enqueue(["registerFunction", [this.engineId, name, callbackId]]);
  }
  defineGlobal(name: string, value: unknown): void {
    this.enqueue(["defineGlobal", [this.engineId, name, value]]);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Ordered after any queued registerFunction/defineGlobal, then free the
    // main-thread callbacks this engine registered.
    const ids = this.callbackIds.splice(0);
    void this.ready
      .then(() => this.client.call("script", "disposeEngine", [this.engineId]))
      .catch(() => undefined)
      .then(() => {
        for (const id of ids) this.client.unregisterCallback(id);
      });
  }

  /** Wait for queued ops; throw (once) the first queued failure. */
  private async flushQueue(): Promise<void> {
    if (this.disposed) throw new Error("nano-sdk: script engine is disposed");
    await this.ready;
    if (this.queuedError) {
      const e = this.queuedError;
      this.queuedError = null;
      throw e;
    }
  }

  private enqueue([method, args]: [string, unknown[]]): void {
    // One failed op must not poison every later eval: record it, keep the chain alive.
    this.ready = this.ready
      .then(() => this.client.call("script", method, args))
      .then(
        () => undefined,
        (e: unknown) => {
          this.queuedError ??= e;
        },
      );
  }
}

/** Async filesystem proxy (every method is an RPC round-trip). */
class WorkerFs {
  constructor(private readonly client: NanoWorkerClient) {}
  writeFile(path: string, content: string | Uint8Array, mode?: number): Promise<void> {
    return this.client.call("fs", "writeFile", [path, content, mode]) as Promise<void>;
  }
  readText(path: string): Promise<string | null> {
    return this.client.call("fs", "readText", [path]) as Promise<string | null>;
  }
  readFile(path: string): Promise<Uint8Array | null> {
    return this.client.call("fs", "readFile", [path]) as Promise<Uint8Array | null>;
  }
  list(path: string): Promise<DirEntry[] | null> {
    return this.client.call("fs", "list", [path]) as Promise<DirEntry[] | null>;
  }
  exists(path: string): Promise<boolean> {
    return this.client.call("fs", "exists", [path]) as Promise<boolean>;
  }
  walk(root?: string): Promise<string[]> {
    return this.client.call("fs", "walk", [root]) as Promise<string[]>;
  }
  mkdir(path: string): Promise<void> {
    return this.client.call("fs", "mkdir", [path]) as Promise<void>;
  }
  remove(path: string): Promise<void> {
    return this.client.call("fs", "remove", [path]) as Promise<void>;
  }
  move(from: string, to: string): Promise<void> {
    return this.client.call("fs", "move", [from, to]) as Promise<void>;
  }
  copy(from: string, to: string): Promise<void> {
    return this.client.call("fs", "copy", [from, to]) as Promise<void>;
  }
  loadTarGz(buffer: ArrayBuffer | Uint8Array): Promise<void> {
    return this.client.call("fs", "loadTarGz", [buffer]) as Promise<void>;
  }
}

/** Async node-runtime proxy. */
class WorkerNodeRuntime {
  constructor(private readonly client: NanoWorkerClient) {}
  warmup(opts?: { maxSteps?: number }): Promise<void> {
    return this.client.call("node", "warmup", [opts]) as Promise<void>;
  }
  run(source: string, opts?: NodeRunOptions): Promise<ExecResult> {
    return this.client.call("node", "run", [source, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  reset(): Promise<void> {
    return this.client.call("node", "reset", []) as Promise<void>;
  }
}

/**
 * Main-thread client over a worker-hosted VM. Implements the same core surface as
 * {@link Nano} plus an async {@link WorkerFs}, and satisfies both {@link ShellHost}
 * and {@link ConnectionInjector} — so the identical `Shell` and `ServeBridge` code
 * runs in worker mode.
 */
export class NanoWorkerClient implements ShellHost, ConnectionInjector {
  readonly fs: WorkerFs;
  private seq = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; onData?: DataCb }
  >();
  /** Main-thread script callbacks invoked via worker reverse-RPC (registerFunction). */
  private callbackSeq = 1;
  private readonly callbacks = new Map<number, HostCallback>();
  /** Set by destroy() (or a fatal worker error): every pending/future call rejects. */
  private destroyed: Error | null = null;

  private constructor(private readonly worker: Worker) {
    this.fs = new WorkerFs(this);
    worker.addEventListener("message", (ev) => this.onMessage(ev.data as Res));
    worker.addEventListener("error", (ev) => this.onError(ev));
  }

  static async create(
    config: NanoConfig,
    worker: Worker,
    opts: NanoWorkerOptions = {},
  ): Promise<NanoWorkerClient> {
    const client = new NanoWorkerClient(worker);
    try {
      await client.send(
        { id: client.seq++, kind: "create", config },
        opts.transferBuffers ? collectTransfers(config) : undefined,
      );
    } catch (e) {
      // Don't leak the worker (and its half-built VM) when creation fails.
      client.shutdown(new Error("nano-sdk: worker VM creation failed"));
      throw e;
    }
    return client;
  }

  private onMessage(res: Res): void {
    if (res.type === "callback") {
      void this.handleCallback(res);
      return;
    }
    const p = this.pending.get(res.id);
    if (!p) return;
    if (res.type === "data") {
      p.onData?.(res.chunk);
      return;
    }
    this.pending.delete(res.id);
    if (res.type === "result") p.resolve(res.value);
    else p.reject(new Error(res.error));
  }

  /** Reverse-RPC: run a registered script callback and return its result to the worker. */
  private async handleCallback(res: Extract<Res, { type: "callback" }>): Promise<void> {
    const reply = (msg: Extract<Req, { kind: "callbackResult" }>): void => this.worker.postMessage(msg);
    const fn = this.callbacks.get(res.callbackId);
    if (!fn) {
      reply({ id: res.id, kind: "callbackResult", ok: false, error: `unknown callback ${res.callbackId}` });
      return;
    }
    try {
      const value = await fn(...res.args);
      reply({ id: res.id, kind: "callbackResult", ok: true, value: value === undefined ? null : value });
    } catch (e) {
      reply({ id: res.id, kind: "callbackResult", ok: false, error: errMsg(e) });
    }
  }

  /** Register a main-thread script callback; returns its reverse-RPC id. */
  registerCallback(fn: HostCallback): number {
    const id = this.callbackSeq++;
    this.callbacks.set(id, fn);
    return id;
  }

  /** Free a callback registered via {@link registerCallback}. */
  unregisterCallback(id: number): void {
    this.callbacks.delete(id);
  }

  private onError(ev: ErrorEvent): void {
    const err = new Error(`nano-sdk worker error: ${ev.message}`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** Low-level: send a request and await its result, streaming `onData` if given. */
  call(target: WorkerTarget, method: string, args: unknown[], onData?: DataCb): Promise<unknown> {
    return this.send(
      { id: this.seq++, kind: "call", target, method, args, stream: !!onData },
      undefined,
      onData,
    );
  }

  private send(req: Req, transfer?: Transferable[], onData?: DataCb): Promise<unknown> {
    if (this.destroyed) return Promise.reject(this.destroyed);
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onData });
      try {
        this.worker.postMessage(req, transfer ?? []);
      } catch (e) {
        this.pending.delete(req.id);
        reject(e);
      }
    });
  }

  /** Terminate the worker and reject every pending (and future) call with `reason`. */
  private shutdown(reason: Error): void {
    if (this.destroyed) return;
    this.destroyed = reason;
    this.worker.terminate();
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
    this.callbacks.clear();
  }

  // --- core surface (mirrors Nano) ---
  run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.call("nano", "run", [command, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.call("nano", "exec", [argv, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  shExec(line: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.call("nano", "shExec", [line, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  node(args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.call("nano", "node", [args, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  readText(path: string): Promise<string | null> {
    return this.call("nano", "readText", [path]) as Promise<string | null>;
  }
  /**
   * Which engine serves a `node(args)` call (`routing` pin, else the configured
   * default). Pure introspection — mirrors {@link Nano.resolveNodeEngine}.
   */
  resolveNodeEngine(args: string[]): Promise<"vm" | "host" | "auto"> {
    return this.call("nano", "resolveNodeEngine", [args]) as Promise<"vm" | "host" | "auto">;
  }

  // --- catalog (installer runs in the worker, next to the VM) ---

  /**
   * Fetch, verify, and install a catalog app into the worker VM's filesystem —
   * mirrors {@link Nano.installApp} (wasm-app / wasm-service kinds are
   * auto-registered). `opts.onProgress` stays on the main thread: progress
   * events are proxied back over the scripting reverse-RPC channel.
   */
  installApp(ref: string, opts?: InstallOptions): Promise<Manifest> {
    return this.callWithProgress("installApp", ref, opts) as Promise<Manifest>;
  }

  /** Install a whole topic bundle — mirrors {@link Nano.installBundle}. */
  installBundle(slug: string, opts?: InstallOptions): Promise<BundleInstallResult> {
    return this.callWithProgress("installBundle", slug, opts) as Promise<BundleInstallResult>;
  }

  /**
   * Run a registered wasm-app command on the `wasm-app` tier (host wasm engine)
   * — mirrors {@link Nano.execWasmApp}. Paths are relative to `opts.cwd`.
   */
  execWasmApp(argv: string[], opts?: WasmAppExecOptions): Promise<WasmAppExecResult> {
    return this.call("nano", "execWasmApp", [argv, opts ?? {}]) as Promise<WasmAppExecResult>;
  }

  /**
   * installApp/installBundle with `onProgress` proxied: the function can't be
   * structured-cloned, so it is registered as a main-thread callback and the
   * worker re-creates `onProgress` as a reverse-RPC stub (`progressCallbackId`).
   */
  private async callWithProgress(
    method: "installApp" | "installBundle",
    arg: string,
    opts?: InstallOptions,
  ): Promise<unknown> {
    const { onProgress, ...rest } = opts ?? {};
    if (!onProgress) return this.call("nano", method, [arg, rest]);
    const callbackId = this.registerCallback((e) => {
      onProgress(e as Parameters<typeof onProgress>[0]);
    });
    try {
      return await this.call("nano", method, [arg, { ...rest, progressCallbackId: callbackId }]);
    } finally {
      this.unregisterCallback(callbackId);
    }
  }

  injectConnection(port: number, httpRequest: string | Uint8Array): Promise<Uint8Array> {
    return this.call("server", "injectConnection", [port, httpRequest]) as Promise<Uint8Array>;
  }
  // Generic, runtime-agnostic snapshot/restore (recipe-driven; see provision()).
  /** Configure the warmup (snapshot) params; the snapshot builds lazily. */
  setWarmup(params: Record<string, unknown>): Promise<void> {
    return this.call("vm", "setWarmup", [params]) as Promise<void>;
  }
  /** Build the warm snapshot now (off the main thread); fire-and-forget to prewarm. */
  warmup(): Promise<void> {
    return this.call("vm", "warmup", []) as Promise<void>;
  }
  /** Adopt a prebuilt, gzipped snapshot (skips the runtime warmup build). The
   *  worker gunzips + deserializes it into the app snapshot restoreRun resolves. */
  loadSnapshot(gz: ArrayBuffer): Promise<void> {
    return this.call("vm", "loadSnapshot", [gz]) as Promise<void>;
  }
  /** Restore the warm snapshot and run `script` (awaits any in-flight warmup). */
  restoreRun(script: string, opts?: NodeRunOptions): Promise<ExecResult> {
    return this.call("vm", "restoreRun", [script, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  /**
   * Like {@link restoreRun} for a long-running server: while it runs, other VM
   * calls on this client reject ("VM is busy serving") until {@link cancel}.
   */
  restoreServe(script: string, opts?: NodeRunOptions): Promise<ExecResult> {
    return this.call("vm", "restoreServe", [script, stripOnData(opts)], opts?.onData) as Promise<ExecResult>;
  }
  writeStdin(data: Uint8Array | string): void {
    void this.call("nano", "writeStdin", [data]);
  }
  setInteractiveStdin(on: boolean = true): void {
    void this.call("nano", "setInteractiveStdin", [on]);
  }
  closeStdin(): void {
    void this.call("nano", "closeStdin", []);
  }
  cancel(): void {
    void this.call("nano", "cancel", []);
  }
  /** Terminate the worker. Pending calls reject; later calls reject immediately. */
  destroy(): void {
    if (this.destroyed) return;
    // Best-effort in-worker teardown; terminate() follows regardless.
    try {
      this.worker.postMessage({ id: this.seq++, kind: "call", target: "nano", method: "destroy", args: [], stream: false });
    } catch {
      /* ignore */
    }
    this.shutdown(new Error("nano-sdk: worker client destroyed"));
  }

  // --- scripting (boa.wasm hosted in the worker; spec §6.5) ---
  async scripting(opts: ScriptEngineOptions = {}): Promise<ScriptEngine> {
    // onStdout/onStderr are functions — they can't cross the worker boundary, so
    // they stay on the main thread; console output streams back via the eval
    // data channel (combined stdout+stderr in worker mode).
    const { onStdout, onStderr, ...serializable } = opts;
    const engineId = (await this.call("script", "createEngine", [serializable])) as number;
    return new WorkerScriptEngine(this, engineId, onStdout ?? onStderr);
  }
  async script(source: string, opts?: ScriptEngineOptions): Promise<unknown> {
    const engine = await this.scripting(opts);
    try {
      return await engine.eval(source);
    } finally {
      engine.dispose();
    }
  }

  // --- factories ---
  shell(opts?: ShellOptions): Shell {
    return new Shell(this, opts);
  }
  nodeRuntime(): WorkerNodeRuntime {
    return new WorkerNodeRuntime(this);
  }
}

/**
 * Spawn a worker-hosted VM and return a client with the core surface. The
 * config's buffers are copied to the worker unless `opts.transferBuffers`.
 */
export async function createNanoWorker(
  config: NanoConfig,
  workerFactory?: () => Worker,
  opts?: NanoWorkerOptions,
): Promise<NanoWorkerClient> {
  const worker = workerFactory
    ? workerFactory()
    : new Worker(new URL("./worker/worker.js", import.meta.url), { type: "module" });
  return NanoWorkerClient.create(config, worker, opts);
}
