// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Folder bridge (@userland-run/nano-sdk/folder): mount / diff / writeBack / zip.
// Most tests drive a fake FileSystemDirectoryHandle and an in-memory VFS (no
// wasm); one suite boots a real VM when nano.wasm exists.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  mountFolder,
  mountFiles,
  zipFolder,
  createZip,
  crc32,
  FolderTooLargeError,
  FolderPermissionError,
  isFileSystemAccessSupported,
} from "../dist/folder.js";
import { boot, wasmAvailable } from "./helpers/boot.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- fake File System Access handles -------------------------------------

class FakeFileHandle {
  kind = "file";
  constructor(name, data = new Uint8Array(0)) {
    this.name = name;
    this.data = data;
  }
  async getFile() {
    const data = this.data;
    return { name: this.name, size: data.length, lastModified: 0, arrayBuffer: async () => data.slice().buffer };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (d) => void chunks.push(typeof d === "string" ? enc.encode(d) : new Uint8Array(d)),
      close: async () => {
        this.data = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        this.data = new Uint8Array(this.data);
      },
      abort: async () => {},
    };
  }
}

class FakeDirHandle {
  kind = "directory";
  children = new Map();
  constructor(name, { perm = "granted", grantOnRequest = true } = {}) {
    this.name = name;
    this.perm = { read: "granted", readwrite: perm };
    this.grantOnRequest = grantOnRequest;
    this.requests = [];
  }
  async *entries() {
    for (const e of this.children) yield e;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    let h = this.children.get(name);
    if (!h) {
      if (!create) throw new DOMException(`${name} not found`, "NotFoundError");
      h = new FakeDirHandle(name);
      this.children.set(name, h);
    }
    if (h.kind !== "directory") throw new DOMException(name, "TypeMismatchError");
    return h;
  }
  async getFileHandle(name, { create = false } = {}) {
    let h = this.children.get(name);
    if (!h) {
      if (!create) throw new DOMException(`${name} not found`, "NotFoundError");
      h = new FakeFileHandle(name);
      this.children.set(name, h);
    }
    if (h.kind !== "file") throw new DOMException(name, "TypeMismatchError");
    return h;
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new DOMException(`${name} not found`, "NotFoundError");
  }
  async queryPermission({ mode }) {
    return this.perm[mode];
  }
  async requestPermission({ mode }) {
    this.requests.push(mode);
    if (this.grantOnRequest) this.perm[mode] = "granted";
    return this.perm[mode];
  }
  /** Test helper: build a tree from { "a/b.txt": "text" }. */
  static from(name, tree, opts) {
    const root = new FakeDirHandle(name, opts);
    for (const [path, content] of Object.entries(tree)) {
      const segs = path.split("/");
      const leaf = segs.pop();
      let dir = root;
      for (const s of segs) {
        if (!dir.children.has(s)) dir.children.set(s, new FakeDirHandle(s));
        dir = dir.children.get(s);
      }
      if (path.endsWith("/")) continue;
      dir.children.set(leaf, new FakeFileHandle(leaf, typeof content === "string" ? enc.encode(content) : content));
    }
    return root;
  }
  /** Test helper: flatten to { path: text }. */
  dump(prefix = "") {
    const out = {};
    for (const [n, h] of this.children) {
      if (h.kind === "file") out[prefix + n] = dec.decode(h.data);
      else Object.assign(out, h.dump(prefix + n + "/"));
    }
    return out;
  }
}

// --- in-memory VFS (FolderVfs) --------------------------------------------

function memVfs({ async = false } = {}) {
  const files = new Map();
  const dirs = new Set(["/"]);
  const wrap = (v) => (async ? Promise.resolve(v) : v);
  const mkdirp = (p) => {
    let cur = "";
    for (const s of p.split("/").filter(Boolean)) dirs.add((cur += "/" + s));
  };
  return {
    files,
    dirs,
    writeFile(p, b) {
      mkdirp(p.slice(0, p.lastIndexOf("/")));
      files.set(p, new Uint8Array(b));
      return wrap(undefined);
    },
    readFile: (p) => wrap(files.get(p) ?? null),
    list(p) {
      if (!dirs.has(p)) return wrap(null);
      const pre = p === "/" ? "/" : p + "/";
      const out = new Map();
      for (const d of dirs) if (d.startsWith(pre) && d !== p && !d.slice(pre.length).includes("/")) out.set(d.slice(pre.length), { name: d.slice(pre.length), type: "dir", size: 0 });
      for (const [f, b] of files) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) out.set(f.slice(pre.length), { name: f.slice(pre.length), type: "file", size: b.length });
      return wrap([...out.values()]);
    },
    mkdir: (p) => wrap(mkdirp(p)),
  };
}

const TREE = {
  "README.md": "# hi\n",
  "src/main.c": "int main(){return 0;}\n",
  "src/util/x.h": "#pragma once\n",
  "node_modules/dep/index.js": "module.exports=1\n",
  "empty/": "",
};

// --- tests ------------------------------------------------------------------

test("isFileSystemAccessSupported is false in node", () => {
  assert.equal(isFileSystemAccessSupported(), false);
});

for (const async of [false, true]) {
  test(`mount → modify → diff → writeBack round-trip (${async ? "async" : "sync"} fs)`, async () => {
    const vfs = memVfs({ async });
    const handle = FakeDirHandle.from("proj", TREE, { perm: "prompt" });
    const progress = [];
    const m = await mountFolder(vfs, handle, { at: "/work/proj", onProgress: (p) => progress.push(p.phase) });
    assert.equal(m.at, "/work/proj");
    assert.equal(m.name, "proj");
    assert.equal(m.writable, true);
    assert.equal(dec.decode(vfs.files.get("/work/proj/src/main.c")), TREE["src/main.c"]);
    assert.ok(vfs.dirs.has("/work/proj/empty"), "empty dirs are created");
    assert.equal(m.snapshot.size, 4);
    assert.ok(progress.includes("scan") && progress.includes("copy"));
    assert.deepEqual(await m.diff(), { added: [], changed: [], removed: [] });

    vfs.files.set("/work/proj/src/main.c", enc.encode("int main(){return 1;}\n")); // same size
    vfs.files.set("/work/proj/out/result.txt", enc.encode("ok\n"));
    vfs.dirs.add("/work/proj/out");
    vfs.files.delete("/work/proj/README.md");
    assert.deepEqual(await m.diff(), { added: ["out/result.txt"], changed: ["src/main.c"], removed: ["README.md"] });

    const report = await m.writeBack();
    assert.deepEqual(report.written, ["out/result.txt", "src/main.c"]);
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(report.failed, []);
    assert.equal(report.bytes, 22 + 3);
    assert.deepEqual(handle.requests, ["readwrite"], "readwrite permission is requested once");
    const disk = handle.dump();
    assert.equal(disk["src/main.c"], "int main(){return 1;}\n");
    assert.equal(disk["out/result.txt"], "ok\n");
    assert.equal(disk["README.md"], "# hi\n", "removed files are kept on disk by default");

    // Snapshot refreshed: only the removal remains.
    assert.deepEqual(await m.diff(), { added: [], changed: [], removed: ["README.md"] });
    const r2 = await m.writeBack({ deleteRemoved: true });
    assert.deepEqual(r2.deleted, ["README.md"]);
    assert.equal(handle.dump()["README.md"], undefined);
    assert.deepEqual(await m.diff(), { added: [], changed: [], removed: [] });
  });
}

test("writeBack: paths filter, onlyChanged=false, permission denied", async () => {
  const vfs = memVfs();
  const handle = FakeDirHandle.from("p", { "a.txt": "a", "b.txt": "b" }, { perm: "prompt", grantOnRequest: false });
  const m = await mountFolder(vfs, handle);
  assert.equal(m.at, "/work");
  vfs.files.set("/work/a.txt", enc.encode("A"));
  vfs.files.set("/work/b.txt", enc.encode("B"));
  await assert.rejects(m.writeBack(), FolderPermissionError);
  assert.deepEqual(handle.dump(), { "a.txt": "a", "b.txt": "b" });
  handle.grantOnRequest = true;
  const r = await m.writeBack({ paths: ["b.txt"] });
  assert.deepEqual(r.written, ["b.txt"]);
  assert.deepEqual((await m.diff()).changed, ["a.txt"]);
  const all = await m.writeBack({ onlyChanged: false });
  assert.deepEqual(all.written, ["a.txt", "b.txt"]);
  assert.deepEqual(handle.dump(), { "a.txt": "A", "b.txt": "B" });
  // Nothing to do → no permission prompt, empty report.
  handle.requests.length = 0;
  handle.perm.readwrite = "prompt";
  assert.deepEqual(await m.writeBack(), { written: [], deleted: [], failed: [], bytes: 0 });
  assert.deepEqual(handle.requests, []);
});

test("diff skip excludes a nested mount", async () => {
  const vfs = memVfs();
  const m = await mountFolder(vfs, FakeDirHandle.from("p", { "a.txt": "a" }));
  await mountFolder(vfs, FakeDirHandle.from("q", { "b.txt": "b" }), { at: "/work/q" });
  assert.deepEqual((await m.diff()).added, ["q/b.txt"]);
  assert.deepEqual((await m.diff({ skip: ["/work/q"] })).added, []);
});

test("size cap throws before copying anything", async () => {
  const vfs = memVfs();
  const handle = FakeDirHandle.from("big", { "a.bin": new Uint8Array(600), "b.bin": new Uint8Array(600) });
  await assert.rejects(mountFolder(vfs, handle, { maxBytes: 1000 }), (err) => {
    assert.ok(err instanceof FolderTooLargeError);
    assert.equal(err.maxBytes, 1000);
    assert.match(err.message, /over the 1000 B limit/);
    return true;
  });
  assert.equal(vfs.files.size, 0);
  assert.ok(!vfs.dirs.has("/work"));
  await mountFolder(vfs, handle, { maxBytes: 1200 }); // exactly at the cap is fine
  assert.equal(vfs.files.size, 2);
});

test("include filter applies to mount and diff", async () => {
  const vfs = memVfs();
  const include = (p) => !p.startsWith("node_modules/") && !p.endsWith(".h");
  const m = await mountFolder(vfs, FakeDirHandle.from("p", TREE), { include });
  assert.deepEqual([...m.snapshot.keys()].sort(), ["README.md", "src/main.c"]);
  assert.ok(!vfs.dirs.has("/work/node_modules"));
  vfs.files.set("/work/node_modules/x.js", enc.encode("x"));
  vfs.files.set("/work/src/new.h", enc.encode("x"));
  vfs.files.set("/work/src/new.c", enc.encode("x"));
  assert.deepEqual(await m.diff(), { added: ["src/new.c"], changed: [], removed: [] });
});

test("mountFiles uses webkitRelativePath and strips the top folder", async () => {
  const vfs = memVfs();
  const file = (path, text) => ({
    name: path.split("/").pop(),
    webkitRelativePath: path,
    size: enc.encode(text).length,
    arrayBuffer: async () => enc.encode(text).buffer,
  });
  const m = await mountFiles(vfs, [file("pics/a.txt", "A"), file("pics/sub/b.txt", "BB")], { at: "/work" });
  assert.equal(m.name, "pics");
  assert.equal(m.writable, false);
  assert.equal(dec.decode(vfs.files.get("/work/sub/b.txt")), "BB");
  vfs.files.set("/work/sub/b.txt", enc.encode("changed"));
  assert.deepEqual((await m.diff()).changed, ["sub/b.txt"]);
  await assert.rejects(m.writeBack(), /zipFolder/);
  // Plain File[] without relative paths land flat.
  const m2 = await mountFiles(vfs, [{ name: "x.txt", size: 1, arrayBuffer: async () => enc.encode("x").buffer }], { at: "/flat" });
  assert.equal(dec.decode(vfs.files.get("/flat/x.txt")), "x");
  assert.equal(m2.name, "");
  await assert.rejects(mountFiles(vfs, [file("p/a.txt", "123456")], { maxBytes: 5 }), FolderTooLargeError);
});

// --- zip ----------------------------------------------------------------------

/** Pure-JS zip reader: parses the central directory, inflates, checks CRCs. */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const flags = dv.getUint16(p + 8, true);
    assert.ok(flags & 0x800, "UTF-8 flag set");
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    assert.equal(dv.getUint32(off + 14, true), crc, "local/central CRC agree");
    const lnlen = dv.getUint16(off + 26, true);
    const elen = dv.getUint16(off + 28, true);
    const body = buf.subarray(off + 30 + lnlen + elen, off + 30 + lnlen + elen + csize);
    const data = method === 8 ? new Uint8Array(zlib.inflateRawSync(body)) : body;
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    assert.equal(zlib.crc32(data), crc, `crc32 matches zlib for ${name}`);
    out[name] = { data, method };
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

test("crc32 matches zlib", () => {
  for (const s of ["", "a", "hello world", "x".repeat(10000)]) assert.equal(crc32(enc.encode(s)), zlib.crc32(s));
});

for (const compress of [true, false]) {
  test(`zipFolder round-trip (compress=${compress})`, async () => {
    const vfs = memVfs();
    const big = enc.encode("lorem ipsum dolor sit amet ".repeat(400));
    const rand = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
    await vfs.writeFile("/work/out/big.txt", big);
    await vfs.writeFile("/work/out/rand.bin", rand);
    await vfs.writeFile("/work/out/ünïcødé/ä.txt", enc.encode("utf8\n"));
    await vfs.writeFile("/work/out/zero.txt", new Uint8Array(0));
    await vfs.mkdir("/work/out/emptydir");
    const blob = await zipFolder(vfs, "/work/out", { compress });
    assert.equal(blob.type, "application/zip");
    const buf = new Uint8Array(await blob.arrayBuffer());
    const entries = readZip(buf);
    assert.deepEqual(Object.keys(entries).sort(), ["big.txt", "emptydir/", "rand.bin", "zero.txt", "ünïcødé/ä.txt"]);
    assert.deepEqual(entries["big.txt"].data, big);
    assert.equal(entries["big.txt"].method, compress ? 8 : 0);
    assert.deepEqual(entries["rand.bin"].data, rand);

    if (spawnSync("unzip", ["-v"]).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), "nano-zip-"));
      try {
        const zipPath = join(dir, "t.zip");
        writeFileSync(zipPath, buf);
        const t = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
        assert.match(t, /No errors detected/);
        execFileSync("unzip", ["-q", zipPath, "-d", join(dir, "x")]);
        assert.deepEqual(new Uint8Array(readFileSync(join(dir, "x/big.txt"))), big);
        assert.deepEqual(new Uint8Array(readFileSync(join(dir, "x/rand.bin"))), rand);
        assert.equal(readFileSync(join(dir, "x/ünïcødé/ä.txt"), "utf8"), "utf8\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

test("zip caps: too many entries, missing dir", async () => {
  await assert.rejects(createZip(Array.from({ length: 65536 }, (_, i) => ({ name: `${i}/` }))), /max 65535/);
  await assert.rejects(zipFolder(memVfs(), "/nope"), /not a directory/);
  const vfs = memVfs();
  await vfs.writeFile("/d/a", new Uint8Array(100));
  await assert.rejects(zipFolder(vfs, "/d", { maxBytes: 50 }), /size cap/);
});

// --- real VM ------------------------------------------------------------------

if (wasmAvailable) {
  let nano;
  after(() => nano?.destroy());

  test("real VM: mount, edit with busybox, writeBack, zip", async () => {
    nano = await boot();
    const handle = FakeDirHandle.from("proj", { "n.txt": "3\n1\n2\n", "keep.txt": "same\n", "sub/s.txt": "s\n" });
    const m = await mountFolder(nano, handle, { at: "/work/proj" });
    let r = await nano.shExec("cd /work/proj && sort -n n.txt > sorted.txt && echo X >> sub/s.txt && rm keep.txt && cat n.txt");
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "3\n1\n2\n");
    assert.deepEqual(await m.diff(), { added: ["sorted.txt"], changed: ["sub/s.txt"], removed: ["keep.txt"] });
    const rep = await m.writeBack();
    assert.deepEqual(rep.written, ["sorted.txt", "sub/s.txt"]);
    assert.deepEqual(handle.dump(), { "n.txt": "3\n1\n2\n", "keep.txt": "same\n", "sub/s.txt": "s\nX\n", "sorted.txt": "1\n2\n3\n" });

    // The raw NanoVM (TerminalHandle.vm shape) works too.
    const m2 = await mountFolder(nano.raw, FakeDirHandle.from("raw", { "a.txt": "a" }), { at: "/work/raw" });
    nano.raw.addFile("/work/raw/b.txt", "b");
    assert.deepEqual((await m2.diff()).added, ["b.txt"]);

    const entries = readZip(new Uint8Array(await (await zipFolder(nano, "/work/proj")).arrayBuffer()));
    assert.deepEqual(Object.keys(entries).sort(), ["n.txt", "sorted.txt", "sub/s.txt"]);
    assert.equal(dec.decode(entries["sorted.txt"].data), "1\n2\n3\n");
  });
}
