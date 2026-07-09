/**
 * Hand-written type declarations for the vendored NanoVM browser runtime
 * (`nanovm.mjs` + `memfs.mjs`), snapshotted from
 * github.com/userland-run/nano @ v0.1.0 (`container/`).
 *
 * Only the surface the SDK relies on is typed, plus the interactive-stdin
 * methods and the `_memfs` accessor used by the Vfs for byte-level reads.
 */

export type BinarySource = string | ArrayBuffer | Uint8Array;

export interface CreateOptions {
  /** nano.wasm: URL string, ArrayBuffer, or Uint8Array. */
  wasm: BinarySource;
  /** Guest RAM in MB. Default 512. */
  ramMB?: number;
  /** BusyBox ELF URL — only needed for the small (non-bundled) wasm build. */
  busyboxUrl?: string;
  /** Node.js ELF URL — only needed for the small (non-bundled) wasm build. */
  nodeUrl?: string;
}

/** Streamed-output + budget options accepted by run/node/restoreAndRun. */
export interface RuntimeRunOptions {
  /** Called with decoded UTF-8 stdout+stderr chunks (the two streams are combined). */
  onStdout?: (chunk: string) => void;
  /** Instruction budget. Defaults: 2_000_000 (run), 2_000_000_000 (node/nodeSnapshot). */
  maxSteps?: number;
}

export interface RestoreOptions extends RuntimeRunOptions {
  /** Files seeded into the restored MemFS before the injected script runs. */
  extraFiles?: Array<{ path: string; content: string | Uint8Array }>;
}

export interface ExecResult {
  exitCode: number;
  /** Combined stdout+stderr as the guest wrote it. */
  stdout: string;
  /** True when the run was halted by cancelRun(). */
  cancelled?: boolean;
  /** True when the run hit the snapshot sentinel (nodeSnapshot path). */
  snapshotReady?: boolean;
}

export type DirEntryType = "dir" | "file" | "symlink";

export interface DirEntry {
  name: string;
  type: DirEntryType;
  size: number;
}

/** Opaque VM snapshot (VM struct + RAM regions + serialized MemFS). */
export interface VMSnapshot {
  vmStruct: Uint8Array;
  lowRAM: Uint8Array;
  lowEnd: number;
  stackRAM: Uint8Array;
  stackStart: number;
  memfs: unknown[];
  /** Persisted host-side statics restored on a warm resume (present on live-server
   *  snapshots): the socket table, event-loop statics, and decoded-block cache. */
  sockets?: Uint8Array | null;
  evloop?: Uint8Array | null;
  blocks?: Uint8Array | null;
}

/** Minimal node shape exposed by the vendored MemFS. */
export interface FSNode {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly data: Uint8Array | null;
  readonly target: string | null;
  readonly isFile: boolean;
  readonly isDir: boolean;
  readonly isSymlink: boolean;
}

/** Subset of the vendored MemFS used by the SDK's Vfs. */
export interface MemFS {
  resolve(path: string, followSymlinks?: boolean, maxDepth?: number): FSNode | null;
  createFile(path: string, content: string | Uint8Array | ArrayBuffer): FSNode;
  loadTarGz(buffer: ArrayBuffer | Uint8Array): Promise<void>;
  serialize(): unknown[];
}

/** Injects browser→guest HTTP connections into in-VM servers. */
export interface VirtualServer {
  injectConnection(port: number, httpRequest: string): Promise<Uint8Array>;
}

/** Request handed to a {@link NanoVM.setLlmBridge} handler. */
export interface LlmBridgeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Result a {@link NanoVM.setLlmBridge} handler may return. */
export type LlmBridgeResult =
  | Response
  | {
      status?: number;
      statusText?: string;
      headers?: Record<string, string> | Headers;
      body?: Uint8Array | string | ReadableStream<Uint8Array> | null;
    };

export type LlmBridgeHandler = (req: LlmBridgeRequest) => Promise<LlmBridgeResult> | LlmBridgeResult;

export declare class NanoVM {
  static create(opts: CreateOptions): Promise<NanoVM>;

  // --- execution ---
  run(command: string, opts?: RuntimeRunOptions): Promise<ExecResult>;
  node(...argsAndOpts: Array<string | RuntimeRunOptions>): Promise<ExecResult>;
  cancelRun(): void;
  destroy(): void;

  // --- snapshots (node fast path) ---
  snapshot(): VMSnapshot;
  nodeSnapshot(opts?: { maxSteps?: number }): Promise<VMSnapshot>;
  restoreAndRun(snap: VMSnapshot, script: string, opts?: RestoreOptions): Promise<ExecResult>;

  // --- filesystem (fast path) ---
  addFile(path: string, content: string | Uint8Array, mode?: number): void;
  readFileString(path: string): string | null;
  listDir(path: string): DirEntry[] | null;
  loadTarGz(buffer: ArrayBuffer | Uint8Array): Promise<void>;

  // --- catalog lazy demand-fetch ---
  registerLazyFile(
    path: string,
    meta: { size: number; mode: string | number; resolve: () => Promise<Uint8Array> },
  ): void;

  // --- network bridge (/dev/__net__) ---
  setNetwork(opts?: { corsProxyUrl?: string | null; disabled?: boolean }): void;
  /**
   * Route guest requests to the internal origin `nanoinfer.internal` to an
   * in-page handler instead of fetch(). A ReadableStream body streams to the
   * guest incrementally (SSE-friendly). Pass null to unregister.
   */
  setLlmBridge(handler: LlmBridgeHandler | null): void;

  // --- interactive stdin (present at runtime; beyond the v0.1 spec) ---
  writeStdin(bytes: Uint8Array | string): void;
  setInteractiveStdin(on?: boolean): void;
  closeStdin(): void;

  // --- accessors ---
  readonly exports: WebAssembly.Exports;
  readonly memory: WebAssembly.Memory;
  readonly virtualServer: VirtualServer;

  // --- semi-internal (used by the SDK's Vfs for byte reads) ---
  _memfs: MemFS;
  /** Raw byte tap: (fd, bytes) before UTF-8 decode. Assignable directly. */
  _onStdoutBytes: ((fd: number, bytes: Uint8Array) => void) | null;
}

/**
 * Serialize a {@link NanoVM.snapshot} to one portable Uint8Array (format "NSN1":
 * magic | u32 metaLen | meta(JSON) | region bytes | memfs data blobs) so it can be
 * gzipped, shipped in a catalog recipe, and restored on a fresh VM.
 * {@link deserializeSnapshot} is the exact inverse.
 */
export declare function serializeSnapshot(snap: VMSnapshot): Uint8Array;
export declare function deserializeSnapshot(bytes: Uint8Array): VMSnapshot;
