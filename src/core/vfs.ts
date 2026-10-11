// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { NanoVM, DirEntry } from "../vendor/nanovm.mjs";

/** Single-quote-escape a path for safe interpolation into a sh command (§7.3). */
function q(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/**
 * Typed view over nano's MemFS.
 *
 * - Reads and single-file writes go straight through MemFS (synchronous, no VM step).
 * - Directory mutations run BusyBox so behavior matches a real shell (recursive
 *   removal, attribute-preserving copy, rename-over). These are async.
 */
export class Vfs {
  private seq = 0;

  /**
   * @param vm   the underlying VM.
   * @param lock optional VM mutex (see {@link Nano.withVmLock}); BusyBox-backed
   *             mutations run under it so they never overlap another run.
   */
  constructor(
    private readonly vm: NanoVM,
    private readonly lock: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  ) {}

  // --- fast path: direct MemFS, no VM step ---

  /**
   * Write a file; parent directories are auto-created. An optional `mode`
   * (e.g. 0o755) sets the permission bits — used when installing executables.
   */
  writeFile(path: string, content: string | Uint8Array, mode?: number): void {
    this.vm.addFile(path, content, mode);
  }

  /**
   * Register a file for catalog lazy demand-fetch (satisfies the installer's
   * {@link InstallTarget}): the bytes are materialized on first guest access.
   */
  registerLazyFile(
    path: string,
    meta: { size: number; mode: string | number; resolve: () => Promise<Uint8Array> },
  ): void {
    this.vm.registerLazyFile(path, meta);
  }

  readText(path: string): string | null {
    return this.vm.readFileString(path);
  }

  readFile(path: string): Uint8Array | null {
    const node = this.vm._memfs.resolve(path);
    if (!node || !node.isFile) return null;
    return node.data ?? new Uint8Array(0);
  }

  list(path: string): DirEntry[] | null {
    return this.vm.listDir(path);
  }

  exists(path: string): boolean {
    const node = this.vm._memfs.resolve(path);
    return !!node && (node.isFile || node.isDir);
  }

  /** Best-effort file removal straight through MemFS (no VM step). */
  unlinkQuiet(path: string): void {
    try {
      this.vm._memfs.unlink(path, 0);
    } catch {
      /* ignore */
    }
  }

  /** Recursive file list under `root`. */
  walk(root: string = "/"): string[] {
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop() as string;
      const entries = this.vm.listDir(dir);
      if (!entries) continue;
      const prefix = dir === "/" ? "" : dir;
      for (const e of entries) {
        const full = `${prefix}/${e.name}`;
        if (e.type === "dir") stack.push(full);
        else out.push(full);
      }
    }
    return out;
  }

  // --- mutation path: via BusyBox, real semantics ---

  mkdir(path: string): Promise<void> {
    return this.shRun(`mkdir -p ${q(path)}`);
  }
  remove(path: string): Promise<void> {
    return this.shRun(`rm -rf ${q(path)}`);
  }
  move(from: string, to: string): Promise<void> {
    return this.shRun(`mv ${q(from)} ${q(to)}`);
  }
  copy(from: string, to: string): Promise<void> {
    return this.shRun(`cp -a ${q(from)} ${q(to)}`);
  }

  async loadTarGz(buffer: ArrayBuffer | Uint8Array): Promise<void> {
    await this.vm.loadTarGz(buffer);
  }

  /** Run a sh line via the file-script mechanism (§2.4), under the VM lock. */
  private async shRun(line: string): Promise<void> {
    const res = await this.lock(async () => {
      const path = `/tmp/.nano-vfs-${(this.seq++).toString(36)}.sh`;
      this.vm.addFile(path, line + "\n");
      try {
        return await this.vm.run(`sh ${path}`);
      } finally {
        this.unlinkQuiet(path);
      }
    });
    if (res.exitCode !== 0) {
      throw new Error(`nano-sdk: fs op failed (exit ${res.exitCode}): ${line}\n${res.stdout}`);
    }
  }
}
