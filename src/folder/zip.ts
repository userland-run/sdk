// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * A small zip writer (PKZIP 2.0: local headers + central directory, UTF-8
 * names, deflate via `CompressionStream("deflate-raw")` when available, else
 * stored). No zip64: archives are capped at 65535 entries / 4 GiB.
 */

import { crc32 } from "./hash";
import { normDir, joinVfs, toFolderVfs, walkVfs } from "./target";
import type { FolderInclude, FolderProgressFn, FolderTarget } from "./types";

export interface ZipEntry {
  /** POSIX path inside the archive; directories end with "/". */
  name: string;
  data?: Uint8Array;
  /** Unix permission bits (default 0o644 files, 0o755 dirs). */
  mode?: number;
  date?: Date;
}

export interface ZipOptions {
  /** Deflate entries when the platform supports it (default true). */
  compress?: boolean;
}

export interface ZipFolderOptions extends ZipOptions {
  include?: FolderInclude;
  /** Refuse to zip more than this many uncompressed bytes (default and max: 4 GiB - 1). */
  maxBytes?: number;
  onProgress?: FolderProgressFn;
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

let deflateRawOk: boolean | null = null;
function canDeflateRaw(): boolean {
  if (deflateRawOk !== null) return deflateRawOk;
  try {
    const CS = (globalThis as { CompressionStream?: new (f: string) => unknown }).CompressionStream;
    deflateRawOk = typeof CS === "function" && !!new CS("deflate-raw");
  } catch {
    deflateRawOk = false;
  }
  return deflateRawOk;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as unknown as { CompressionStream: new (f: string) => TransformStream })
    .CompressionStream;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a zip archive from in-memory entries. */
export async function createZip(entries: ZipEntry[], opts: ZipOptions = {}): Promise<Blob> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`nano-sdk/folder: zip has ${entries.length} entries (max ${MAX_ENTRIES}, no zip64)`);
  }
  const compress = (opts.compress ?? true) && canDeflateRaw();
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();

  for (const e of entries) {
    const isDir = e.name.endsWith("/");
    const name = enc.encode(e.name.replace(/^\/+/, ""));
    const raw = isDir ? new Uint8Array(0) : (e.data ?? new Uint8Array(0));
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (compress && raw.length > 0) {
      const z = await deflateRaw(raw);
      if (z.length < raw.length) {
        method = 8;
        body = z;
      }
    }
    if (raw.length > MAX_U32 || offset + 30 + name.length + body.length > MAX_U32) {
      throw new Error("nano-sdk/folder: zip exceeds 4 GiB (zip64 is not supported)");
    }
    const { time, date } = dosDateTime(e.date ?? now);
    const flags = 0x0800; // UTF-8 names

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    lh.set(name, 30);

    const mode = e.mode ?? (isDir ? 0o755 : 0o644);
    const unixMode = (isDir ? 0o040000 : 0o100000) | (mode & 0o7777);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by: Unix, 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    // extra len, comment len, disk start, internal attrs: 0
    cv.setUint32(38, ((unixMode << 16) | (isDir ? 0x10 : 0)) >>> 0, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);

    parts.push(lh, body);
    central.push(ch);
    offset += lh.length + body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  if (offset + cdSize + 22 > MAX_U32) {
    throw new Error("nano-sdk/folder: zip exceeds 4 GiB (zip64 is not supported)");
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd] as BlobPart[], { type: "application/zip" });
}

/**
 * Zip a VFS directory (e.g. `/work/out`) into a Blob for download. Entry names
 * are relative to `dir`; empty directories are kept.
 */
export async function zipFolder(
  target: FolderTarget,
  dir: string,
  opts: ZipFolderOptions = {},
): Promise<Blob> {
  const vfs = toFolderVfs(target);
  const root = normDir(dir);
  if (!(await vfs.list(root))) throw new Error(`nano-sdk/folder: not a directory: ${root}`);
  const maxBytes = Math.min(opts.maxBytes ?? MAX_U32, MAX_U32);
  const { files, emptyDirs } = await walkVfs(vfs, root, { include: opts.include });
  if (files.length + emptyDirs.length > MAX_ENTRIES) {
    throw new Error(
      `nano-sdk/folder: ${root} has ${files.length + emptyDirs.length} entries (zip max ${MAX_ENTRIES})`,
    );
  }
  const entries: ZipEntry[] = [];
  let bytes = 0;
  for (const rel of files) {
    const data = (await vfs.readFile(joinVfs(root, rel))) ?? new Uint8Array(0);
    bytes += data.length;
    if (bytes > maxBytes) {
      throw new Error(`nano-sdk/folder: ${root} exceeds the zip size cap of ${maxBytes} bytes`);
    }
    entries.push({ name: rel, data });
    opts.onProgress?.({
      phase: "zip",
      done: entries.length,
      total: files.length,
      bytes,
      totalBytes: 0,
      path: rel,
    });
  }
  for (const d of emptyDirs) entries.push({ name: d });
  return createZip(entries, opts);
}
