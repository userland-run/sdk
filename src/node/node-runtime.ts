// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { ExecResult, NodeRunOptions } from "../types";
import type { Nano } from "../core/nano";
import type { RestoreOptions, VMSnapshot } from "../vendor/nanovm.mjs";

/**
 * Snapshot-based fast path for repeated Node execution. `warmup()` boots V8 once
 * and captures the post-init snapshot; every `run()` restores that **same**
 * snapshot, so runs are isolated from each other's mutations (§10.2). Seed
 * per-run inputs with `extraFiles`.
 */
export class NodeRuntime {
  private snap: VMSnapshot | null = null;

  constructor(private readonly nano: Nano) {}

  get isWarm(): boolean {
    return this.snap !== null;
  }

  async warmup(opts?: { maxSteps?: number }): Promise<void> {
    if (this.snap) return;
    this.snap = await this.nano.raw.nodeSnapshot(opts);
  }

  async run(source: string, opts?: NodeRunOptions): Promise<ExecResult> {
    if (!this.snap) await this.warmup();
    const snap = this.snap;
    if (!snap) throw new Error("nano-sdk: node runtime failed to warm up");

    const ro: RestoreOptions = {};
    if (opts?.onData) ro.onStdout = opts.onData;
    if (opts?.maxSteps !== undefined) ro.maxSteps = opts.maxSteps;
    if (opts?.extraFiles) ro.extraFiles = opts.extraFiles;

    return this.nano.raw.restoreAndRun(snap, source, ro);
  }

  /** Drop the warm snapshot; the next run re-warms (optionally from new fs state). */
  reset(): void {
    this.snap = null;
  }
}
