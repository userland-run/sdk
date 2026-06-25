// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Main-thread {@link ScriptEngine} — a typed facade over the vendored Boa
 * loader (`boa.mjs`). The engine drives the VM through a {@link ScriptVmDriver}:
 * synchronous filesystem (MemFS needs no VM step) + asynchronous command exec.
 */
import { BoaRuntime, ScriptError, type BoaEngine } from "../vendor/boa.mjs";
import type { BinarySource, DirEntry, ScriptEngine, ScriptEngineOptions } from "../types";

export { ScriptError };

/**
 * What the Boa bridge needs from a VM: synchronous fs reads/writes and async
 * command execution. `Nano` supplies this on the main thread.
 */
export interface ScriptVmDriver {
  fs: {
    readText(path: string): string | null;
    readFile(path: string): Uint8Array | null;
    list(path: string): DirEntry[] | null;
    exists(path: string): boolean;
    writeFile(path: string, content: Uint8Array): void;
  };
  run(command: string): Promise<unknown>;
  exec(argv: string[]): Promise<unknown>;
  sh(line: string): Promise<unknown>;
  node(args: string[]): Promise<unknown>;
}

/** Load (compile + instantiate) boa.wasm. Cache the result; reuse across engines. */
export function loadBoaRuntime(wasm: BinarySource): Promise<BoaRuntime> {
  return BoaRuntime.load(wasm);
}

/** Thin typed wrapper over a vendored {@link BoaEngine}. */
export class LocalScriptEngine implements ScriptEngine {
  constructor(private readonly engine: BoaEngine) {}

  eval(source: string): Promise<unknown> {
    return this.engine.eval(source);
  }
  evalModule(source: string, specifier?: string): Promise<unknown> {
    return this.engine.evalModule(source, specifier);
  }
  registerFunction(name: string, fn: (...args: any[]) => unknown | Promise<unknown>): void {
    this.engine.registerFunction(name, fn as (...a: unknown[]) => unknown | Promise<unknown>);
  }
  defineGlobal(name: string, value: unknown): void {
    this.engine.defineGlobal(name, value);
  }
  dispose(): void {
    this.engine.dispose();
  }
}

/** Create a sandboxed engine over `driver`, applying the capability grant in `opts`. */
export function createLocalEngine(
  runtime: BoaRuntime,
  driver: ScriptVmDriver,
  opts: ScriptEngineOptions = {},
): LocalScriptEngine {
  const expose = opts.expose ?? {};
  const engine = runtime.createEngine({
    host: {
      fs: {
        readText: (p: string) => driver.fs.readText(p),
        readFile: (p: string) => driver.fs.readFile(p),
        list: (p: string) => driver.fs.list(p),
        exists: (p: string) => driver.fs.exists(p),
        writeFile: (p: string, bytes: Uint8Array) => driver.fs.writeFile(p, bytes),
      },
      run: (cmd: string) => driver.run(cmd),
      exec: (argv: string[]) => driver.exec(argv),
      sh: (line: string) => driver.sh(line),
      node: (args: string[]) => driver.node(args),
    },
    expose: { fs: expose.fs, run: expose.run, node: expose.node },
    globalName: opts.globalName,
    env: opts.env,
    webapis: expose.webapis,
    limits: opts.limits,
    timeoutMs: opts.timeoutMs,
    syncOnly: opts.syncOnly,
  });
  if (opts.onStdout) engine.onStdout(opts.onStdout);
  if (opts.onStderr) engine.onStderr(opts.onStderr);
  return new LocalScriptEngine(engine);
}
