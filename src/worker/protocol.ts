// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { NanoConfig } from "../types";

export type WorkerTarget = "nano" | "fs" | "node" | "server";

/** main → worker */
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
    };

/** worker → main */
export type Res =
  | { id: number; type: "data"; chunk: string }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; error: string };
