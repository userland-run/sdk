// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { ExecOptions } from "../types";
import type { RuntimeRunOptions } from "../vendor/nanovm.mjs";

/**
 * Adapter from the SDK's public {@link ExecOptions} (`onData`) to the vendored
 * runtime's options (`onStdout`). Single source of truth — used everywhere a
 * public exec option crosses into the runtime.
 */
export function toRuntimeOpts(opts?: ExecOptions): RuntimeRunOptions {
  const out: RuntimeRunOptions = {};
  if (opts?.onData) out.onStdout = opts.onData;
  if (opts?.maxSteps !== undefined) out.maxSteps = opts.maxSteps;
  return out;
}
