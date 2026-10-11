// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Structural types for the folder bridge (`@userland-run/nano-sdk/folder`).
 * Kept free of DOM-lib and core imports: the File System Access API isn't in
 * every TS `lib.dom`, and the module stays type-only against the VM.
 */

type MaybePromise<T> = T | Promise<T>;

/** A directory listing entry, as returned by the VM's fs `list`. */
export interface FolderDirEntry {
  name: string;
  type: "dir" | "file" | "symlink" | string;
  size?: number;
}

/** Writable stream returned by `FileSystemFileHandle.createWritable()`. */
export interface FsWritableLike {
  write(data: Uint8Array | Blob | string | ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

/** Subset of `File` used for reads (`size`, `lastModified`, bytes). */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly lastModified?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FsPermissionMode = "read" | "readwrite";
export type FsPermissionState = "granted" | "denied" | "prompt";

interface FsHandleBase {
  readonly name: string;
  queryPermission?(d: { mode: FsPermissionMode }): Promise<FsPermissionState>;
  requestPermission?(d: { mode: FsPermissionMode }): Promise<FsPermissionState>;
}

/** Structural `FileSystemFileHandle`. */
export interface FsFileHandleLike extends FsHandleBase {
  readonly kind: "file";
  getFile(): Promise<FileLike>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsWritableLike>;
}

/** Structural `FileSystemDirectoryHandle`. */
export interface FsDirHandleLike extends FsHandleBase {
  readonly kind: "directory";
  entries(): AsyncIterable<[string, FsFileHandleLike | FsDirHandleLike]>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandleLike>;
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
}

/**
 * Normalized VM filesystem the folder bridge drives. You can pass one directly
 * as a {@link FolderTarget}; usually it is derived from a `Nano`,
 * `NanoWorkerClient`, or raw `NanoVM` by {@link toFolderVfs}.
 */
export interface FolderVfs {
  writeFile(path: string, bytes: Uint8Array): MaybePromise<void>;
  readFile(path: string): MaybePromise<Uint8Array | null>;
  list(path: string): MaybePromise<FolderDirEntry[] | null>;
  mkdir(path: string): MaybePromise<void>;
}

/** Raw NanoVM surface (e.g. `nano.raw`, or the terminal's `TerminalHandle.vm`). */
export interface RawVmLike {
  addFile(path: string, content: string | Uint8Array, mode?: number): void;
  listDir(path: string): FolderDirEntry[] | null;
  makeDir?(path: string): void;
  readFileString?(path: string): string | null;
  _memfs?: {
    resolve(path: string): { isFile: boolean; isDir?: boolean; data: Uint8Array | null } | null;
  };
}

/** `Nano` (sync fs) or `NanoWorkerClient` (async fs). */
export interface FsHostLike {
  fs: {
    writeFile(path: string, content: string | Uint8Array, mode?: number): MaybePromise<void>;
    readFile(path: string): MaybePromise<Uint8Array | null>;
    list(path: string): MaybePromise<FolderDirEntry[] | null>;
    mkdir(path: string): MaybePromise<void>;
  };
  /** `Nano.raw` — when present the fast synchronous MemFS path is used. */
  raw?: RawVmLike;
}

/** Anything the folder functions can copy into / out of. */
export type FolderTarget = FsHostLike | RawVmLike | FolderVfs;

/** Progress callback payload. */
export interface FolderProgress {
  phase: "scan" | "copy" | "diff" | "write" | "zip";
  /** Files processed so far in this phase. */
  done: number;
  /** Total files in this phase (0 while scanning). */
  total: number;
  /** Bytes processed so far in this phase. */
  bytes: number;
  /** Total bytes in this phase (0 while scanning). */
  totalBytes: number;
  /** Path (relative to the mount) being processed. */
  path?: string;
}

export type FolderProgressFn = (p: FolderProgress) => void;

/**
 * Path filter. Receives a POSIX path relative to the folder root (no leading
 * slash); directories end with "/". Returning false for a directory skips it
 * entirely.
 */
export type FolderInclude = (path: string) => boolean;

export interface MountOptions {
  /** VFS directory the folder's contents are copied into (default `/work`). */
  at?: string;
  /** Refuse to copy when the selected files exceed this many bytes (default 256 MiB). */
  maxBytes?: number;
  include?: FolderInclude;
  onProgress?: FolderProgressFn;
}

/** One file's fingerprint in a snapshot. */
export interface SnapshotEntry {
  size: number;
  /** Content hash (CRC-32 + FNV-1a, hex). */
  hash: string;
}

export interface FolderDiff {
  /** Relative paths present in the VM but not in the snapshot. */
  added: string[];
  /** Relative paths whose content differs from the snapshot. */
  changed: string[];
  /** Relative paths in the snapshot that no longer exist in the VM. */
  removed: string[];
}

export interface DiffOptions {
  /**
   * Absolute VFS directories below the mount to leave out (e.g. another folder
   * mounted inside this one).
   */
  skip?: string[];
}

export interface WriteBackOptions extends DiffOptions {
  /** Only write added/changed files (default true). false rewrites every file. */
  onlyChanged?: boolean;
  /** Delete files from the local folder that were removed in the VM (default false). */
  deleteRemoved?: boolean;
  /** Limit the write to these relative paths (still filtered by the diff when onlyChanged). */
  paths?: string[];
  onProgress?: FolderProgressFn;
}

export interface WriteBackReport {
  written: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
  bytes: number;
}
