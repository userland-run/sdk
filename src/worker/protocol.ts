// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { NanoConfig } from "../types";

export type WorkerTarget = "nano" | "fs" | "node" | "server" | "script" | "vm";

/**
 * main → worker.
 *
 * `callbackResult` is the reply half of the reverse-RPC used by scripting
 * `registerFunction`: when a worker-hosted script calls a function whose
 * implementation lives on the main thread, the worker emits a `callback`
 * response (below) and parks until the main thread answers with this message.
 */
export type Req =
  | { id: number; kind: "create"; config: NanoConfig }
  | {
      id: number;
      kind: "call";
      target: WorkerTarget;
      method: string;
      args: unknown[];
      /** When true, the worker injects an onData that streams `data` messages. */
      stream: boolean;
    }
  | { id: number; kind: "callbackResult"; ok: boolean; value?: unknown; error?: string };

/**
 * worker → main.
 *
 * `callback` is the request half of the scripting reverse-RPC: invoke the
 * main-thread function registered under `callbackId` with `args`, then reply
 * with a `callbackResult` carrying the same `id`.
 */
export type Res =
  | { id: number; type: "data"; chunk: string }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; error: string }
  | { id: number; type: "callback"; callbackId: number; args: unknown[] };
