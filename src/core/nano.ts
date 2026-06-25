// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { NanoVM } from "../vendor/nanovm.mjs";
import type { BoaRuntime } from "../vendor/boa.mjs";
import type {
  BinarySource,
  ConnectionInjector,
  ExecOptions,
  ExecResult,
  NanoConfig,
  ScriptEngine,
  ScriptEngineOptions,
  ShellHost,
  ShellOptions,
} from "../types";
import { toRuntimeOpts, NODE_DEFAULT_MAX_STEPS } from "./exec-opts";
import { resolveImage } from "./images";
import { Vfs } from "./vfs";
import { Shell } from "../shell/shell";
import { NodeRuntime } from "../node/node-runtime";
import { createLocalEngine, loadBoaRuntime, type ScriptVmDriver } from "../scripting/script-engine";
import { Catalog, type CatalogOptions } from "../catalog/catalog";
import type { InstallOptions, Manifest } from "../catalog/types";

/** Single-quote-escape one argv element for safe sh interpolation. */
function singleQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Pick a guest-RAM size when the caller doesn't specify one.
 *
 * Node's V8 needs ~1.8GB of guest RAM to initialize its sandbox/code range —
 * 512MB OOMs at startup (`SegmentedTable::InitializeTable`). We mirror the nano
 * CLI runner's heuristic: target ~2GB of linear memory total, subtracting the
 * wasm's own static data (bundled builds embed ~130MB of binaries) so guest RAM
 * plus that data stays under the 2GB ceiling. For a URL source (size unknown)
 * we assume the bundled build. BusyBox-only callers can pass a smaller `ramMB`.
 */
function defaultRamMB(wasm: unknown): number {
  const bytes =
    wasm instanceof Uint8Array || wasm instanceof ArrayBuffer ? wasm.byteLength : undefined;
  const wasmMB = bytes !== undefined ? bytes / (1024 * 1024) : 138; // URL: assume bundled
  return wasmMB > 1 ? Math.floor(2000 - wasmMB - 20) : 2000;
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
  /** boa.wasm source from NanoConfig.scripting (lazy-loaded on first scripting()). */
  private scriptingWasm?: BinarySource;
  private boaRuntime: BoaRuntime | null = null;

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
    const ramMB = config.ramMB ?? defaultRamMB(createOpts.wasm);
    let raw: NanoVM;
    try {
      raw = await NanoVM.create({ ...createOpts, ramMB });
      for (const ov of overlays) await raw.loadTarGz(ov);
    } finally {
      revoke();
    }

    const nano = new Nano(raw);
    nano.scriptingWasm = config.scripting?.wasm;
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
    return this.raw.node(...args, toRuntimeOpts(opts, NODE_DEFAULT_MAX_STEPS));
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

  // --- scripting (host-side Boa engine) ---

  /**
   * Create a sandboxed Boa scripting engine that can drive this VM. boa.wasm is
   * loaded lazily on first use, so callers who never script pay nothing
   * (spec §6.2). Requires `scripting.wasm` in the {@link NanoConfig}.
   */
  async scripting(opts?: ScriptEngineOptions): Promise<ScriptEngine> {
    if (!this.scriptingWasm) {
      throw new Error(
        "nano-sdk: scripting is not configured. Pass `scripting: { wasm }` to createNano().",
      );
    }
    if (!this.boaRuntime) this.boaRuntime = await loadBoaRuntime(this.scriptingWasm);
    return createLocalEngine(this.boaRuntime, this.scriptDriver(), opts);
  }

  /** One-shot: create an engine, evaluate `source`, dispose, return the value. */
  async script(source: string, opts?: ScriptEngineOptions): Promise<unknown> {
    const engine = await this.scripting(opts);
    try {
      return await engine.eval(source);
    } finally {
      engine.dispose();
    }
  }

  /** Bridge driver: synchronous MemFS + this Nano's async exec surface. */
  private scriptDriver(): ScriptVmDriver {
    return {
      fs: {
        readText: (p) => this.fs.readText(p),
        readFile: (p) => this.fs.readFile(p),
        list: (p) => this.fs.list(p),
        exists: (p) => this.fs.exists(p),
        writeFile: (p, bytes) => this.fs.writeFile(p, bytes),
      },
      run: (cmd) => this.run(cmd),
      exec: (argv) => this.exec(argv),
      sh: (line) => this.shExec(line),
      node: (args) => this.node(args),
    };
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
