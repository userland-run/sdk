// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { contentHash } from "./hash";
import { joinVfs, normDir, toFolderVfs, walkVfs } from "./target";
import { zipFolder, type ZipFolderOptions } from "./zip";
import type {
  DiffOptions,
  FileLike,
  FolderDiff,
  FolderInclude,
  FolderProgressFn,
  FolderTarget,
  FolderVfs,
  FsDirHandleLike,
  FsFileHandleLike,
  FsPermissionMode,
  MountOptions,
  SnapshotEntry,
  WriteBackOptions,
  WriteBackReport,
} from "./types";

/** Default {@link MountOptions.maxBytes}: 256 MiB. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Thrown before anything is copied when the selection exceeds `maxBytes`. */
export class FolderTooLargeError extends Error {
  override readonly name = "FolderTooLargeError";
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
    readonly files: number,
  ) {
    super(
      `nano-sdk/folder: the selected folder holds ${fmtBytes(bytes)} in ${files} files, ` +
        `over the ${fmtBytes(maxBytes)} limit. Pick a smaller folder or raise maxBytes.`,
    );
  }
}

/** Thrown when the user does not grant (readwrite) access to the folder. */
export class FolderPermissionError extends Error {
  override readonly name = "FolderPermissionError";
  constructor(readonly mode: FsPermissionMode) {
    super(`nano-sdk/folder: ${mode} permission for the folder was not granted`);
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** Whether the File System Access directory picker is available (Chromium). */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}

/**
 * Make sure `handle` has `mode` permission, prompting when needed (a prompt
 * needs a user gesture in browsers). Handles without the permission API (OPFS,
 * fakes) are treated as granted.
 */
export async function ensurePermission(
  handle: { queryPermission?: FsDirHandleLike["queryPermission"]; requestPermission?: FsDirHandleLike["requestPermission"] },
  mode: FsPermissionMode,
): Promise<boolean> {
  if (!handle.queryPermission) return true;
  let state = await handle.queryPermission({ mode });
  if (state !== "granted" && handle.requestPermission) {
    state = await handle.requestPermission({ mode });
  }
  return state === "granted";
}

interface PendingFile {
  rel: string;
  file: FileLike;
}

async function copyIn(
  vfs: FolderVfs,
  at: string,
  dirs: string[],
  files: PendingFile[],
  maxBytes: number,
  onProgress?: FolderProgressFn,
): Promise<Map<string, SnapshotEntry>> {
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
  if (totalBytes > maxBytes) throw new FolderTooLargeError(totalBytes, maxBytes, files.length);
  await vfs.mkdir(at);
  for (const d of dirs) await vfs.mkdir(joinVfs(at, d));
  const snapshot = new Map<string, SnapshotEntry>();
  let bytes = 0;
  let done = 0;
  for (const { rel, file } of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    await vfs.writeFile(joinVfs(at, rel), data);
    snapshot.set(rel, { size: data.length, hash: contentHash(data) });
    bytes += data.length;
    onProgress?.({ phase: "copy", done: ++done, total: files.length, bytes, totalBytes, path: rel });
  }
  return snapshot;
}

/**
 * A local folder copied into the VM. Keeps the directory handle (when there is
 * one) and a content snapshot taken at mount time / after the last write-back,
 * so {@link diff} and {@link writeBack} only touch what changed in the VM.
 */
export class MountedFolder {
  private snap: Map<string, SnapshotEntry>;

  constructor(
    private readonly vfs: FolderVfs,
    /** VFS directory holding the folder's contents. */
    readonly at: string,
    /** Folder name (the picked directory's name). */
    readonly name: string,
    /** The picked directory handle; null when mounted from a FileList. */
    readonly handle: FsDirHandleLike | null,
    snapshot: Map<string, SnapshotEntry>,
    private readonly include?: FolderInclude,
  ) {
    this.snap = snapshot;
  }

  /** Whether {@link writeBack} can write to disk (false for {@link mountFiles}). */
  get writable(): boolean {
    return this.handle !== null;
  }

  /** The current snapshot (relative path → size + hash). */
  get snapshot(): ReadonlyMap<string, SnapshotEntry> {
    return this.snap;
  }

  /** Whether a VFS path lies inside this mount. */
  contains(path: string): boolean {
    return path === this.at || path.startsWith(this.at === "/" ? "/" : this.at + "/");
  }

  /** Relative path of a VFS path inside the mount (null when outside). */
  relative(path: string): string | null {
    if (!this.contains(path) || path === this.at) return null;
    return path.slice(this.at === "/" ? 1 : this.at.length + 1);
  }

  private async scan(opts: DiffOptions): Promise<{ diff: FolderDiff; current: Map<string, SnapshotEntry>; data: Map<string, Uint8Array> }> {
    const skip = new Set((opts.skip ?? []).map(normDir));
    const { files } = await walkVfs(this.vfs, this.at, { include: this.include, skip });
    const current = new Map<string, SnapshotEntry>();
    const data = new Map<string, Uint8Array>();
    const diff: FolderDiff = { added: [], changed: [], removed: [] };
    for (const rel of files) {
      const bytes = await this.vfs.readFile(joinVfs(this.at, rel));
      if (!bytes) continue;
      const entry = { size: bytes.length, hash: contentHash(bytes) };
      current.set(rel, entry);
      data.set(rel, bytes);
      const old = this.snap.get(rel);
      if (!old) diff.added.push(rel);
      else if (old.size !== entry.size || old.hash !== entry.hash) diff.changed.push(rel);
    }
    for (const rel of this.snap.keys()) if (!current.has(rel)) diff.removed.push(rel);
    diff.removed.sort();
    return { diff, current, data };
  }

  /** Compare the VM's copy against the snapshot. */
  async diff(opts: DiffOptions = {}): Promise<FolderDiff> {
    return (await this.scan(opts)).diff;
  }

  /** Re-take the snapshot from the VM's current contents (marks everything clean). */
  async resetSnapshot(opts: DiffOptions = {}): Promise<void> {
    this.snap = (await this.scan(opts)).current;
  }

  /**
   * Write VM changes back to the local folder. By default only added/changed
   * files are written and nothing is deleted; `deleteRemoved` also removes
   * files deleted in the VM. Requests readwrite permission when needed.
   */
  async writeBack(opts: WriteBackOptions = {}): Promise<WriteBackReport> {
    const handle = this.handle;
    if (!handle) {
      throw new Error(
        "nano-sdk/folder: this folder was mounted from a file list and has no directory handle; use zipFolder() to download it",
      );
    }
    const { onlyChanged = true, deleteRemoved = false, onProgress } = opts;
    const { diff, current, data } = await this.scan(opts);
    const only = opts.paths ? new Set(opts.paths) : null;
    const pick = (list: string[]): string[] => (only ? list.filter((p) => only.has(p)) : list);
    const toWrite = pick(onlyChanged ? [...diff.added, ...diff.changed].sort() : [...current.keys()]);
    const toDelete = deleteRemoved ? pick(diff.removed) : [];
    const report: WriteBackReport = { written: [], deleted: [], failed: [], bytes: 0 };
    if (!toWrite.length && !toDelete.length) return report;
    if (!(await ensurePermission(handle, "readwrite"))) throw new FolderPermissionError("readwrite");

    const totalBytes = toWrite.reduce((n, p) => n + (data.get(p)?.length ?? 0), 0);
    let done = 0;
    for (const rel of toWrite) {
      const bytes = data.get(rel)!;
      try {
        const segs = rel.split("/");
        const name = segs.pop()!;
        let dir = handle;
        for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
        const fh: FsFileHandleLike = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        try {
          await w.write(bytes);
          await w.close();
        } catch (err) {
          await w.abort?.().catch(() => {});
          throw err;
        }
        report.written.push(rel);
        report.bytes += bytes.length;
        this.snap.set(rel, current.get(rel)!);
      } catch (err) {
        report.failed.push({ path: rel, error: String((err as Error)?.message ?? err) });
      }
      onProgress?.({ phase: "write", done: ++done, total: toWrite.length, bytes: report.bytes, totalBytes, path: rel });
    }
    for (const rel of toDelete) {
      try {
        const segs = rel.split("/");
        const name = segs.pop()!;
        let dir = handle;
        for (const s of segs) dir = await dir.getDirectoryHandle(s);
        if (!dir.removeEntry) throw new Error("removeEntry unsupported");
        await dir.removeEntry(name);
        report.deleted.push(rel);
        this.snap.delete(rel);
      } catch (err) {
        if ((err as { name?: string })?.name === "NotFoundError") {
          report.deleted.push(rel);
          this.snap.delete(rel);
        } else report.failed.push({ path: rel, error: String((err as Error)?.message ?? err) });
      }
    }
    return report;
  }

  /** Zip the mount's current VM contents (see {@link zipFolder}). */
  zip(opts: ZipFolderOptions = {}): Promise<Blob> {
    return zipFolder(this.vfs, this.at, { include: this.include, ...opts });
  }
}

/**
 * Copy a picked local folder (a `FileSystemDirectoryHandle`, e.g. from
 * `showDirectoryPicker({ mode: "readwrite" })`) into the VM at `at`
 * (default `/work`). The whole selection is sized first; if it exceeds
 * `maxBytes` a {@link FolderTooLargeError} is thrown before anything is copied.
 */
export async function mountFolder(
  target: FolderTarget,
  dirHandle: FsDirHandleLike,
  opts: MountOptions = {},
): Promise<MountedFolder> {
  const vfs = toFolderVfs(target);
  const at = normDir(opts.at ?? "/work");
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!(await ensurePermission(dirHandle, "read"))) throw new FolderPermissionError("read");

  const files: PendingFile[] = [];
  const dirs: string[] = [];
  let scanned = 0;
  let scannedBytes = 0;
  const visit = async (dir: FsDirHandleLike, rel: string): Promise<void> => {
    const children: [string, FsFileHandleLike | FsDirHandleLike][] = [];
    for await (const entry of dir.entries()) children.push(entry);
    children.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [name, h] of children) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (h.kind === "directory") {
        if (opts.include && !opts.include(childRel + "/")) continue;
        dirs.push(childRel);
        await visit(h, childRel);
      } else {
        if (opts.include && !opts.include(childRel)) continue;
        const file = await h.getFile();
        files.push({ rel: childRel, file });
        scannedBytes += file.size;
        opts.onProgress?.({ phase: "scan", done: ++scanned, total: 0, bytes: scannedBytes, totalBytes: 0, path: childRel });
        if (scannedBytes > maxBytes) {
          // Stop early on huge trees; the error reports what was counted so far.
          throw new FolderTooLargeError(scannedBytes, maxBytes, scanned);
        }
      }
    }
  };
  await visit(dirHandle, "");
  const snapshot = await copyIn(vfs, at, dirs, files, maxBytes, opts.onProgress);
  return new MountedFolder(vfs, at, dirHandle.name, dirHandle, snapshot, opts.include);
}

/**
 * Fallback for browsers without the directory picker (Firefox, Safari): copy a
 * `FileList` from `<input type="file" webkitdirectory>` (or any File[]) into the
 * VM. Paths come from `webkitRelativePath`; the shared top-level folder name is
 * stripped so the folder's contents land directly in `at`. The result has no
 * handle — download changes with {@link zipFolder} / {@link MountedFolder.zip}.
 */
export async function mountFiles(
  target: FolderTarget,
  fileList: ArrayLike<FileLike & { webkitRelativePath?: string }> | Iterable<FileLike & { webkitRelativePath?: string }>,
  opts: MountOptions = {},
): Promise<MountedFolder> {
  const vfs = toFolderVfs(target);
  const at = normDir(opts.at ?? "/work");
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const list = Array.from(fileList as ArrayLike<FileLike & { webkitRelativePath?: string }>);
  const paths = list.map((f) =>
    (f.webkitRelativePath || f.name).split("/").filter((s) => s && s !== "." && s !== ".."),
  );
  const first = paths[0]?.[0];
  const stripTop = !!first && paths.every((p) => p.length > 1 && p[0] === first);
  const files: PendingFile[] = [];
  const dirSet = new Set<string>();
  list.forEach((file, i) => {
    const segs = stripTop ? paths[i]!.slice(1) : paths[i]!;
    if (!segs.length) return;
    for (let k = 1; k < segs.length; k++) {
      const d = segs.slice(0, k).join("/");
      if (opts.include && !opts.include(d + "/")) return;
    }
    const rel = segs.join("/");
    if (opts.include && !opts.include(rel)) return;
    for (let k = 1; k < segs.length; k++) dirSet.add(segs.slice(0, k).join("/"));
    files.push({ rel, file });
  });
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const snapshot = await copyIn(vfs, at, [...dirSet].sort(), files, maxBytes, opts.onProgress);
  return new MountedFolder(vfs, at, stripTop ? first! : "", null, snapshot, opts.include);
}
