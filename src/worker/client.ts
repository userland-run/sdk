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
  ShellHost,
  ShellOptions,
} from "../types";
import type { Req, Res, WorkerTarget } from "./protocol";
import { Shell } from "../shell/shell";

type DataCb = (chunk: string) => void;

function stripOnData<T extends { onData?: unknown }>(opts?: T): Omit<T, "onData"> | undefined {
  if (!opts) return undefined;
  const copy = { ...opts } as { onData?: unknown };
  delete copy.onData;
  return copy as Omit<T, "onData">;
}

function collectTransfers(config: NanoConfig): Transferable[] {
  const t: Transferable[] = [];
  const add = (s: unknown): void => {
    if (s instanceof ArrayBuffer) t.push(s);
  };
  add(config.image.wasm);
  add(config.image.busybox);
  add(config.image.node);
  for (const o of config.image.overlays ?? []) add(o);
  return t;
}

/** Async filesystem proxy (every method is an RPC round-trip). */
class WorkerFs {
  constructor(private readonly client: NanoWorkerClient) {}
  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.client.call("fs", "writeFile", [path, content]) as Promise<void>;
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

  private constructor(private readonly worker: Worker) {
    this.fs = new WorkerFs(this);
    worker.addEventListener("message", (ev) => this.onMessage(ev.data as Res));
    worker.addEventListener("error", (ev) => this.onError(ev));
  }

  static async create(config: NanoConfig, worker: Worker): Promise<NanoWorkerClient> {
    const client = new NanoWorkerClient(worker);
    await client.send({ id: client.seq++, kind: "create", config }, collectTransfers(config));
    return client;
  }

  private onMessage(res: Res): void {
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
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onData });
      this.worker.postMessage(req, transfer ?? []);
    });
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
  injectConnection(port: number, httpRequest: string): Promise<Uint8Array> {
    return this.call("server", "injectConnection", [port, httpRequest]) as Promise<Uint8Array>;
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
  destroy(): void {
    void this.call("nano", "destroy", []);
    this.worker.terminate();
  }

  // --- factories ---
  shell(opts?: ShellOptions): Shell {
    return new Shell(this, opts);
  }
  nodeRuntime(): WorkerNodeRuntime {
    return new WorkerNodeRuntime(this);
  }
}

/** Spawn a worker-hosted VM and return a client with the core surface. */
export async function createNanoWorker(
  config: NanoConfig,
  workerFactory?: () => Worker,
): Promise<NanoWorkerClient> {
  const worker = workerFactory
    ? workerFactory()
    : new Worker(new URL("./worker/worker.js", import.meta.url), { type: "module" });
  return NanoWorkerClient.create(config, worker);
}
