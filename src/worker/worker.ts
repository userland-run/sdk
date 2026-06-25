// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Worker host entry (the `./worker` export). Loaded via
 * `new Worker(new URL("@userland-run/nano-sdk/worker", import.meta.url), { type: "module" })`.
 * Hosts one VM and answers RPC from {@link NanoWorkerClient}.
 *
 * Scripting (spec §6.5): boa.wasm is loaded HERE, in the same worker as the VM,
 * so the `nano` bridge drives the VM directly with no extra thread hop. Only
 * eval calls + results cross the boundary. A script's `registerFunction`
 * callback lives on the main thread, so when the script calls it the worker
 * emits a `callback` message and parks until the main thread answers.
 */
import type { Req, Res } from "./protocol";
import { createNano, type Nano } from "../core/nano";
import { NodeRuntime } from "../node/node-runtime";
import type { ScriptEngine, ScriptEngineOptions } from "../types";

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
}
const scope = globalThis as unknown as WorkerScope;

let nano: Nano | null = null;
let nodeRt: NodeRuntime | null = null;

/** Per-engine state: the engine plus its current console-stream poster (set per eval). */
interface EngineSlot {
  engine: ScriptEngine;
  post: ((chunk: string) => void) | null;
}
const engines = new Map<number, EngineSlot>();
let nextEngineId = 1;

/** Reverse-RPC (worker → main) for scripting registerFunction callbacks. */
let callbackSeq = 1;
const callbackPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function post(res: Res): void {
  scope.postMessage(res);
}

scope.addEventListener("message", (event) => {
  const req = event.data as Req | undefined;
  if (!req || typeof req.id !== "number") return;
  if (req.kind === "callbackResult") {
    const p = callbackPending.get(req.id);
    if (p) {
      callbackPending.delete(req.id);
      if (req.ok) p.resolve(req.value);
      else p.reject(new Error(req.error ?? "callback failed"));
    }
    return;
  }
  void handle(req);
});

/** Invoke a main-thread registerFunction callback and await its result. */
function invokeMainCallback(callbackId: number, args: unknown[]): Promise<unknown> {
  const id = callbackSeq++;
  return new Promise((resolve, reject) => {
    callbackPending.set(id, { resolve, reject });
    post({ id, type: "callback", callbackId, args });
  });
}

async function handle(req: Req): Promise<void> {
  try {
    if (req.kind === "create") {
      nano = await createNano(req.config);
      nodeRt = nano.nodeRuntime();
      post({ id: req.id, type: "result", value: true });
      return;
    }
    if (req.kind !== "call") return;
    if (!nano || !nodeRt) throw new Error("nano-sdk worker: VM not created");
    const value =
      req.target === "script"
        ? await dispatchScript(req, nano)
        : await dispatch(req, nano, nodeRt);
    post({ id: req.id, type: "result", value });
  } catch (err) {
    post({ id: req.id, type: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** Scripting RPC: engine lifecycle, eval, and registerFunction reverse-RPC. */
async function dispatchScript(req: Extract<Req, { kind: "call" }>, nanoInst: Nano): Promise<unknown> {
  const { method, args } = req;
  if (method === "createEngine") {
    const opts = (args[0] ?? {}) as ScriptEngineOptions;
    const slot: EngineSlot = { engine: null as unknown as ScriptEngine, post: null };
    // Console output is streamed (combined) to the active eval's data channel.
    const sink = (chunk: string): void => slot.post?.(chunk);
    slot.engine = await nanoInst.scripting({ ...opts, onStdout: sink, onStderr: sink });
    const id = nextEngineId++;
    engines.set(id, slot);
    return id;
  }

  const engineId = args[0] as number;
  const slot = engines.get(engineId);
  if (!slot) throw new Error(`nano-sdk worker: unknown script engine ${engineId}`);

  switch (method) {
    case "eval": {
      slot.post = req.stream ? (chunk): void => post({ id: req.id, type: "data", chunk }) : null;
      try {
        return await slot.engine.eval(args[1] as string);
      } finally {
        slot.post = null;
      }
    }
    case "evalModule": {
      slot.post = req.stream ? (chunk): void => post({ id: req.id, type: "data", chunk }) : null;
      try {
        return await slot.engine.evalModule(args[1] as string, args[2] as string | undefined);
      } finally {
        slot.post = null;
      }
    }
    case "registerFunction": {
      const name = args[1] as string;
      const callbackId = args[2] as number;
      slot.engine.registerFunction(name, (...cbArgs: unknown[]) =>
        invokeMainCallback(callbackId, cbArgs),
      );
      return true;
    }
    case "defineGlobal": {
      slot.engine.defineGlobal(args[1] as string, args[2]);
      return true;
    }
    case "disposeEngine": {
      slot.engine.dispose();
      engines.delete(engineId);
      return true;
    }
    default:
      throw new Error(`nano-sdk worker: script.${method} is not callable`);
  }
}

/** For streaming calls, splice an onData poster into the trailing options object. */
function injectStream(req: Extract<Req, { kind: "call" }>): void {
  if (!req.stream) return;
  const onData = (chunk: string): void => post({ id: req.id, type: "data", chunk });
  const last = req.args[req.args.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last)) {
    (last as Record<string, unknown>)["onData"] = onData;
  } else {
    req.args.push({ onData });
  }
}

async function dispatch(
  req: Extract<Req, { kind: "call" }>,
  nanoInst: Nano,
  nodeInst: NodeRuntime,
): Promise<unknown> {
  injectStream(req);
  const { target, method, args } = req;

  let host: object;
  switch (target) {
    case "nano":
      host = nanoInst;
      break;
    case "fs":
      host = nanoInst.fs;
      break;
    case "node":
      host = nodeInst;
      break;
    case "server":
      return nanoInst.injectConnection(args[0] as number, args[1] as string);
    default:
      throw new Error(`nano-sdk worker: unknown target ${target}`);
  }

  const fn = (host as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(`nano-sdk worker: ${target}.${method} is not callable`);
  }
  return (fn as (...a: unknown[]) => unknown).apply(host, args);
}
