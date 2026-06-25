// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Worker host entry (the `./worker` export). Loaded via
 * `new Worker(new URL("@userland-run/nano-sdk/worker", import.meta.url), { type: "module" })`.
 * Hosts one VM and answers RPC from {@link NanoWorkerClient}.
 */
import type { Req, Res } from "./protocol";
import { createNano, type Nano } from "../core/nano";
import { NodeRuntime } from "../node/node-runtime";

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
}
const scope = globalThis as unknown as WorkerScope;

let nano: Nano | null = null;
let nodeRt: NodeRuntime | null = null;

function post(res: Res): void {
  scope.postMessage(res);
}

scope.addEventListener("message", (event) => {
  const req = event.data as Req | undefined;
  if (!req || typeof req.id !== "number") return;
  void handle(req);
});

async function handle(req: Req): Promise<void> {
  try {
    if (req.kind === "create") {
      nano = await createNano(req.config);
      nodeRt = nano.nodeRuntime();
      post({ id: req.id, type: "result", value: true });
      return;
    }
    if (!nano || !nodeRt) throw new Error("nano-sdk worker: VM not created");
    const value = await dispatch(req, nano, nodeRt);
    post({ id: req.id, type: "result", value });
  } catch (err) {
    post({ id: req.id, type: "error", error: err instanceof Error ? err.message : String(err) });
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
  }

  const fn = (host as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(`nano-sdk worker: ${target}.${method} is not callable`);
  }
  return (fn as (...a: unknown[]) => unknown).apply(host, args);
}
