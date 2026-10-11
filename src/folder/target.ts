// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { FolderTarget, FolderVfs, FsHostLike, RawVmLike } from "./types";

const isFn = (v: unknown): boolean => typeof v === "function";

function isRawVm(t: unknown): t is RawVmLike {
  const o = t as RawVmLike | null;
  return !!o && isFn(o.addFile) && isFn(o.listDir);
}

function isFsHost(t: unknown): t is FsHostLike {
  const fs = (t as FsHostLike | null)?.fs;
  return !!fs && isFn(fs.writeFile) && isFn(fs.readFile) && isFn(fs.list);
}

function isFolderVfs(t: unknown): t is FolderVfs {
  const o = t as FolderVfs | null;
  return !!o && isFn(o.writeFile) && isFn(o.readFile) && isFn(o.list) && isFn(o.mkdir);
}

function rawVfs(vm: RawVmLike): FolderVfs {
  return {
    writeFile: (p, bytes) => vm.addFile(p, bytes),
    readFile: (p) => {
      if (vm._memfs) {
        const node = vm._memfs.resolve(p);
        if (!node || !node.isFile) return null;
        return node.data ?? new Uint8Array(0);
      }
      const s = vm.readFileString?.(p);
      return s == null ? null : new TextEncoder().encode(s);
    },
    list: (p) => vm.listDir(p),
    mkdir: (p) => {
      if (vm.makeDir) {
        // makeDir is not recursive in every runtime build: create each level.
        let cur = "";
        for (const seg of p.split("/").filter(Boolean)) {
          cur += "/" + seg;
          if (!vm.listDir(cur)) vm.makeDir(cur);
        }
      } else {
        // No makeDir: a placeholder write creates the parents, then drop it.
        const probe = `${p}/.nano-mkdir`;
        vm.addFile(probe, "");
        (vm._memfs as unknown as { unlink?: (x: string, f: number) => number })?.unlink?.(probe, 0);
      }
    },
  };
}

/**
 * Normalize a `Nano`, `NanoWorkerClient`, raw `NanoVM` (e.g. the terminal's
 * `TerminalHandle.vm`), or a ready {@link FolderVfs} into a {@link FolderVfs}.
 * For `Nano` the synchronous MemFS fast path (`nano.raw`) is preferred.
 */
export function toFolderVfs(target: FolderTarget): FolderVfs {
  if (isFsHost(target)) {
    if (isRawVm(target.raw)) return rawVfs(target.raw);
    const fs = target.fs;
    return {
      writeFile: (p, b) => fs.writeFile(p, b),
      readFile: (p) => fs.readFile(p),
      list: (p) => fs.list(p),
      mkdir: (p) => fs.mkdir(p),
    };
  }
  if (isRawVm(target)) return rawVfs(target);
  if (isFolderVfs(target)) return target;
  throw new TypeError(
    "nano-sdk/folder: target must be a Nano, NanoWorkerClient, NanoVM, or FolderVfs",
  );
}

/** Normalize a VFS directory path: absolute, no trailing slash, no `.`/`..`. */
export function normDir(p: string): string {
  if (!p.startsWith("/")) throw new Error(`nano-sdk/folder: path must be absolute: ${p}`);
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export const joinVfs = (dir: string, rel: string): string =>
  dir === "/" ? `/${rel}` : `${dir}/${rel}`;

/**
 * Recursive walk of a VFS directory. Yields files (relative path) and empty
 * directories (relative path with trailing "/"). Symlinks are skipped.
 */
export async function walkVfs(
  vfs: FolderVfs,
  root: string,
  opts: { include?: (rel: string) => boolean; skip?: Set<string> } = {},
): Promise<{ files: string[]; emptyDirs: string[] }> {
  const files: string[] = [];
  const emptyDirs: string[] = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    const entries = await vfs.list(dir);
    if (!entries) return;
    let kept = 0;
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name === "." || e.name === "..") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = joinVfs(dir, e.name);
      if (e.type === "dir") {
        if (opts.skip?.has(childAbs)) continue;
        if (opts.include && !opts.include(childRel + "/")) continue;
        kept++;
        await visit(childAbs, childRel);
      } else if (e.type === "file") {
        if (opts.include && !opts.include(childRel)) continue;
        kept++;
        files.push(childRel);
      }
    }
    if (rel && kept === 0) emptyDirs.push(rel + "/");
  };
  await visit(root, "");
  return { files, emptyDirs };
}
