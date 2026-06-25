// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { NanoVM } from "../vendor/nanovm.mjs";
import type {
  ConnectionInjector,
  ExecOptions,
  ExecResult,
  NanoConfig,
  ShellHost,
  ShellOptions,
} from "../types";
import { toRuntimeOpts } from "./exec-opts";
import { resolveImage } from "./images";
import { Vfs } from "./vfs";
import { Shell } from "../shell/shell";
import { NodeRuntime } from "../node/node-runtime";
import { Catalog, type CatalogOptions } from "../catalog/catalog";
import type { InstallOptions, Manifest } from "../catalog/types";

/** Single-quote-escape one argv element for safe sh interpolation. */
function singleQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Main-thread host for a NanoVM instance. Adds types, ergonomics, and safe
 * defaults over the vendored runtime; the raw instance is always reachable via
 * {@link Nano.raw}. Implements {@link ShellHost} and {@link ConnectionInjector}
 * so it drops directly into `Shell` and `ServeBridge`.
 */
export class Nano implements ShellHost, ConnectionInjector {
  /** Escape hatch: the underlying NanoVM instance. */
  readonly raw: NanoVM;
  readonly fs: Vfs;

  private execSeq = 0;

  private constructor(raw: NanoVM) {
    this.raw = raw;
    this.fs = new Vfs(raw);
  }

  /** The in-VM HTTP connection injector (for serve mode). */
  get virtualServer(): ConnectionInjector {
    return this;
  }

  static async create(config: NanoConfig): Promise<Nano> {
    if (config.crossOriginIsolation !== "ignore" && !globalThis.crossOriginIsolated) {
      throw new Error(
        "nano-sdk: this context is not cross-origin isolated, so the shared WebAssembly.Memory " +
          "NanoVM requires is unavailable. Serve with `Cross-Origin-Opener-Policy: same-origin` + " +
          "`Cross-Origin-Embedder-Policy: require-corp` (or register the shipped service worker), " +
          'or pass `crossOriginIsolation: "ignore"` to bypass this check.',
      );
    }

    const { createOpts, overlays, revoke } = await resolveImage(config.image);
    let raw: NanoVM;
    try {
      raw = await NanoVM.create({ ...createOpts, ramMB: config.ramMB ?? 512 });
      for (const ov of overlays) await raw.loadTarGz(ov);
    } finally {
      revoke();
    }

    const nano = new Nano(raw);
    if (config.warmup !== false) {
      // Pre-JIT exec() with a no-op; best-effort.
      try {
        await raw.run("true");
      } catch {
        /* ignore warmup failures */
      }
    }
    return nano;
  }

  // --- execution ---

  /** Raw BusyBox run; whitespace-split argv, no shell parsing (§2.4). */
  run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.raw.run(command, toRuntimeOpts(opts));
  }

  /** Run the node ELF with an explicit argv. */
  node(args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.raw.node(...args, toRuntimeOpts(opts));
  }

  /** Exact program + args, quoted, executed via sh (no shell operators). */
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.shExec(argv.map(singleQuote).join(" "), opts);
  }

  /** Full sh line/script, one-shot: written to a file and run as `sh <file>`. */
  shExec(line: string, opts?: ExecOptions): Promise<ExecResult> {
    const path = `/tmp/.nano-exec-${(this.execSeq++).toString(36)}.sh`;
    this.raw.addFile(path, line.endsWith("\n") ? line : line + "\n");
    return this.raw.run(`sh ${path}`, toRuntimeOpts(opts));
  }

  /** {@link ShellHost} member — synchronous text read. */
  readText(path: string): string | null {
    return this.raw.readFileString(path);
  }

  /** {@link ConnectionInjector} member — used by the serve bridge. */
  injectConnection(port: number, httpRequest: string): Promise<Uint8Array> {
    return this.raw.virtualServer.injectConnection(port, httpRequest);
  }

  // --- factories ---

  shell(opts?: ShellOptions): Shell {
    return new Shell(this, opts);
  }

  nodeRuntime(): NodeRuntime {
    return new NodeRuntime(this);
  }

  // --- catalog (install signed apps from the CDN) ---

  private _catalog?: Catalog;

  /** The lazily-created default {@link Catalog} (bundled key, OPFS cache, jsDelivr). */
  catalog(opts?: CatalogOptions): Catalog {
    return (this._catalog ??= new Catalog(opts));
  }

  /**
   * Fetch, verify, and install a catalog app into this VM's filesystem. Every
   * byte is checked against the bundled catalog key before it touches MemFS
   * (spec §7.4). Returns the installed app's verified manifest.
   *
   * ```ts
   * await nano.installApp("ripgrep");                 // eager
   * await nano.installApp("ripgrep@14.1.0", { lazy: true });
   * await nano.run("rg --version");
   * ```
   */
  installApp(ref: string, opts?: InstallOptions): Promise<Manifest> {
    return this.catalog().install(this.fs, ref, opts);
  }

  // --- interactive stdin (extension beyond spec §2.3) ---

  writeStdin(data: Uint8Array | string): void {
    this.raw.writeStdin(data);
  }
  setInteractiveStdin(on: boolean = true): void {
    this.raw.setInteractiveStdin(on);
  }
  closeStdin(): void {
    this.raw.closeStdin();
  }

  // --- lifecycle ---

  cancel(): void {
    this.raw.cancelRun();
  }
  destroy(): void {
    this.raw.destroy();
  }
}

export function createNano(config: NanoConfig): Promise<Nano> {
  return Nano.create(config);
}
