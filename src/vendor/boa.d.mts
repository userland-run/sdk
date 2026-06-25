/**
 * Hand-written type declarations for the vendored Boa scripting loader
 * (`boa.mjs`), snapshotted from github.com/userland-run/nano (`container/`).
 *
 * Only the surface the SDK relies on is typed.
 */

export type BinarySource = string | ArrayBuffer | Uint8Array;

/** Host driver the bridge calls into (filesystem is synchronous; exec is async). */
export interface BoaHost {
  fs?: {
    readText?(path: string): string | null;
    readFile?(path: string): Uint8Array | number[] | null;
    list?(path: string): unknown[] | null;
    exists?(path: string): boolean;
    writeFile?(path: string, bytes: Uint8Array): void;
  };
  run?(command: string): Promise<unknown>;
  exec?(argv: string[]): Promise<unknown>;
  sh?(line: string): Promise<unknown>;
  node?(args: string[]): Promise<unknown>;
  log?(...args: unknown[]): void;
}

export interface BoaExpose {
  fs?: "none" | "readonly" | "readwrite";
  run?: boolean;
  node?: boolean;
}

export interface BoaCreateEngineOptions {
  host?: BoaHost;
  expose?: BoaExpose;
  globalName?: string;
  env?: Record<string, unknown>;
  webapis?: Array<"console" | "encoding" | "url" | "timers">;
  limits?: { loopIterations?: number; recursion?: number };
  timeoutMs?: number;
  syncOnly?: boolean;
}

export interface BoaVersion {
  engine: string;
  wrapper: string;
  abi: number;
}

export declare class ScriptError extends Error {}

export declare class BoaEngine {
  eval(source: string): Promise<unknown>;
  evalModule(source: string, specifier?: string): Promise<unknown>;
  registerFunction(
    name: string,
    fn: (...args: unknown[]) => unknown | Promise<unknown>,
    opts?: { async?: boolean },
  ): this;
  defineGlobal(name: string, value: unknown): this;
  onStdout(fn: (chunk: string) => void): this;
  onStderr(fn: (chunk: string) => void): this;
  dispose(): void;
}

export declare class BoaRuntime {
  static load(source: BinarySource): Promise<BoaRuntime>;
  version(): BoaVersion;
  createEngine(opts?: BoaCreateEngineOptions): BoaEngine;
  script(source: string, opts?: BoaCreateEngineOptions): Promise<unknown>;
}

export default BoaRuntime;
