// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.
//
// @userland-run/nano-sdk/tools: definition checks, command templating, shell
// quoting (checked against a real /bin/sh), share-command validation, and
// runTool end to end on a real VM with the tool apps registered from local
// builds (sibling checkouts; skipped when absent):
//   ../nano/apps/core/exifstrip.wasm, ../catalog/recipes/{pdfcpu,sqlite3}/out/*
// Run after `npm run build`:  node --test test/tools.test.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_TOOLS,
  checkDefinition,
  envExports,
  expandCommand,
  identifierOf,
  resolveValues,
  runTool,
  shellQuote,
  validateCommand,
  validateValues,
} from "../dist/tools.js";
import { mountFiles } from "../dist/folder.js";
import { boot, wasmAvailable } from "./helpers/boot.mjs";

const sib = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const APPS = {
  exifstrip: sib("nano/apps/core/exifstrip.wasm"),
  pdfcpu: sib("catalog/recipes/pdfcpu/out/pdfcpu"),
  sqlite3: sib("catalog/recipes/sqlite3/out/sqlite3"),
};
const MAGICK = sib("catalog/recipes/imagemagick/out/magick");
const MAGICK_PHOTO = sib("catalog/recipes/imagemagick/test/fixtures/photo.jpg");
const isElf = (p) => existsSync(p) && readFileSync(p).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
const isWasm = (p) => existsSync(p) && readFileSync(p).subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]));
const haveApps = Object.values(APPS).every(isWasm);
const appSource = async (app) => new Uint8Array(readFileSync(APPS[app.ref]));

const PHOTO_JPG = sib("nano/apps/core/build/exifstrip/tests/fixtures/photo.jpg");
const PDF_A = sib("catalog/recipes/pdfcpu/test/fixtures/a.pdf");
const PDF_B = sib("catalog/recipes/pdfcpu/test/fixtures/b.pdf");
const haveFixtures = [PHOTO_JPG, PDF_A, PDF_B].every(existsSync);

/** A File-like for mountFiles (webkitRelativePath under a shared top folder). */
const fileLike = (path, bytes) => ({
  name: path.split("/").pop(),
  size: bytes.length,
  webkitRelativePath: `picked/${path}`,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
});

// Known runtime issue (not tools-specific): after magick reads an image file on
// the RISC-V VM, a MessagePort stays referenced even after nano.destroy(), so
// Node never exits on its own. Exit once the suite is done.
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref());

test("built-in definitions are valid", () => {
  assert.deepEqual(Object.keys(BUILTIN_TOOLS).sort(), ["csv-sql", "exif", "imagemagick", "pdf"]);
  for (const def of Object.values(BUILTIN_TOOLS)) assert.deepEqual(checkDefinition(def), [], def.id);
});

test("checkDefinition rejects bad templates and secret interpolation", () => {
  const bad = {
    id: "x",
    title: "x",
    apps: ["cat"],
    accepts: ["txt"],
    presets: [
      { id: "a", label: "a", description: "", command: "cat {{nope}}" },
      { id: "b", label: "b", description: "", fields: [{ id: "pw", label: "pw", type: "password", env: "PW" }], command: "cat {{pw}}" },
    ],
  };
  const errs = checkDefinition(bad);
  assert.match(errs[0], /unknown field \{\{nope\}\}/);
  assert.match(errs[1], /secret field "pw" can't be templated/);
});

test("templating: quoting, conditionals, file lists, each, first", () => {
  const preset = {
    id: "p",
    label: "p",
    description: "",
    fields: [
      { id: "out", label: "out", type: "text", default: "my dir" },
      { id: "n", label: "n", type: "number", default: 3, min: 1, max: 9 },
      { id: "flag", label: "flag", type: "checkbox", default: false },
      { id: "q", label: "q", type: "textarea", default: "SELECT * FROM {{first:csv:name}}" },
    ],
    command: "tool{{flag? --flag}} -o {{out}} -n {{n}} {{files:csv}} {{each:csv:.import <path> <name>}} {{q}}",
  };
  const ctx = { files: ["b.csv", "it's 2024.csv", "notes.txt", "sub/b.csv"] };
  const v = resolveValues(preset, { flag: true }, ctx);
  assert.equal(v.q, "SELECT * FROM b");
  const cmd = expandCommand(preset, v, ctx);
  assert.equal(
    cmd,
    `tool --flag -o 'my dir' -n 3 b.csv 'it'\\''s 2024.csv' sub/b.csv '.import b.csv b' '.import "it'\\''s 2024.csv" it_s_2024' '.import sub/b.csv b_2' 'SELECT * FROM b'`,
  );
  assert.equal(expandCommand(preset, { ...v, flag: false }, ctx).startsWith("tool -o"), true);
  assert.equal(identifierOf("2024 sales-EU.csv"), "t2024_sales_EU");
  assert.deepEqual(validateValues(preset, { ...v, n: 12 }), ["n: at most 9"]);
});

test("shellQuote survives a real shell", () => {
  const nasty = ["plain", "with space", "it's", 'dq " $HOME `id` $(id) ; rm -rf /', "", "tab\tnew", "ünïcode ✓"];
  const line = `printf '%s\\n' ${nasty.map(shellQuote).join(" ")}`;
  const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" });
  assert.deepEqual(out.split("\n").slice(0, -1), nasty);
});

test("secrets are exported, never templated; shared commands are validated", () => {
  const pdf = BUILTIN_TOOLS.pdf;
  const enc = pdf.presets.find((p) => p.id === "encrypt");
  const v = resolveValues(enc, { password: "s3cr#t!" }, { files: [] });
  assert.ok(!expandCommand(enc, v, { files: [] }).includes("s3cr#t!"));
  assert.equal(envExports(enc, v), "export PDF_PASSWORD='s3cr#t!'\n");
  assert.deepEqual(validateValues(enc, { password: "has space" }), ["Password: invalid value"]);
  assert.equal(validateCommand(pdf, "pdfcpu info -c disable *.pdf"), "pdfcpu info -c disable *.pdf");
  assert.equal(validateCommand(pdf, "rm -rf /work"), null);
  assert.equal(validateCommand(pdf, "pdfcpu info x.pdf\nrm -rf /"), null);
});

test(
  "runTool on a real VM: exif strip, pdf merge + info, csv export (local app builds)",
  { skip: !wasmAvailable ? "nano.wasm not available" : !haveApps ? "local app builds absent" : !haveFixtures ? "fixtures absent" : false },
  async () => {
    const nano = await boot({ ramMB: 256, scripting: false });
    try {
      // exif: copies in cleaned/, no camera string left, diff lists them
      let folder = await mountFiles(nano, [fileLike("photo.jpg", new Uint8Array(readFileSync(PHOTO_JPG)))], { at: "/work" });
      let r = await runTool(nano, { tool: "exif", preset: "strip-copy", folder, appSource });
      assert.equal(r.exitCode, 0, r.output);
      assert.match(r.output, /1 stripped/);
      assert.deepEqual(r.changes, { added: ["cleaned/photo.jpg"], changed: [], removed: [] });
      r = await runTool(nano, { tool: "exif", preset: "show", appSource });
      assert.match(r.output, /cleaned\/photo\.jpg: JPEG[^\n]*\n(\s+(exif|orientation|icc)[^\n]*\n)*\s+gps: no\n/);
      assert.ok(!/cleaned\/photo\.jpg[^.]*camera/.test(r.output), "no camera in the clean copy");

      // pdf: merge → 5 pages; an edited command runs too, a foreign one is refused
      await nano.shExec("rm -rf /work");
      folder = await mountFiles(
        nano,
        [fileLike("a.pdf", new Uint8Array(readFileSync(PDF_A))), fileLike("b.pdf", new Uint8Array(readFileSync(PDF_B)))],
        { at: "/work" },
      );
      r = await runTool(nano, { tool: "pdf", preset: "merge", values: { name: "all.pdf" }, folder, appSource });
      assert.equal(r.exitCode, 0, r.output);
      assert.equal(r.command, "mkdir -p out && pdfcpu merge -c disable out/all.pdf *.pdf");
      assert.deepEqual(r.changes.added, ["out/all.pdf"]);
      r = await runTool(nano, { tool: "pdf", command: "pdfcpu info -c disable out/all.pdf", appSource });
      assert.match(r.output, /Page count: 5/);
      await assert.rejects(runTool(nano, { tool: "pdf", command: "rm -rf /work", appSource }), /must be one line that runs pdfcpu/);
      // encrypt via an exported secret, then info with the password
      r = await runTool(nano, { tool: "pdf", preset: "encrypt", values: { password: "s3cr#t!" }, appSource });
      assert.equal(r.exitCode, 0, r.output);
      r = await runTool(nano, { tool: "pdf", command: "pdfcpu info -c disable --upw 's3cr#t!' out/a-locked.pdf", appSource });
      assert.match(r.output, /Encrypted: Yes/);

      // csv: export a grouped query
      await nano.shExec("rm -rf /work");
      const csv = "region,qty\nnorth,3\nsouth,5\nnorth,2\n";
      folder = await mountFiles(nano, [fileLike("sales data.csv", new TextEncoder().encode(csv))], { at: "/work" });
      r = await runTool(nano, {
        tool: "csv-sql",
        preset: "export",
        values: { sql: "SELECT region, sum(qty) AS qty FROM sales_data GROUP BY 1 ORDER BY 1;" },
        folder,
        appSource,
      });
      assert.equal(r.exitCode, 0, r.output);
      assert.deepEqual(r.changes.added, ["out/result.csv"]);
      assert.equal(new TextDecoder().decode(nano.fs.readFile("/work/out/result.csv")), "region,qty\r\nnorth,5\r\nsouth,5\r\n");
    } finally {
      nano.destroy();
    }
  },
);

test(
  "runTool on a real VM: imagemagick (RISC-V ELF via appSource) resizes with a per-file step budget",
  { skip: !wasmAvailable ? "nano.wasm not available" : !isElf(MAGICK) || !existsSync(MAGICK_PHOTO) ? "local magick build absent" : false },
  async () => {
    const nano = await boot({ ramMB: 512, scripting: false });
    try {
      const folder = await mountFiles(
        nano,
        [fileLike("my photo.jpg", new Uint8Array(readFileSync(MAGICK_PHOTO))), fileLike("notes.txt", new TextEncoder().encode("x"))],
        { at: "/work" },
      );
      const src = async () => new Uint8Array(readFileSync(MAGICK));
      let r = await runTool(nano, { tool: "imagemagick", preset: "thumbnail", values: { size: 32 }, folder, appSource: src });
      assert.equal(r.exitCode, 0, r.output);
      assert.match(r.output, /^my photo\.jpg$/m);
      assert.deepEqual(r.changes.added, ["out/thumbs/my photo.jpg"]);
      r = await runTool(nano, { tool: "imagemagick", command: "magick identify -format '%m %wx%h' 'out/thumbs/my photo.jpg'", appSource: src });
      assert.match(r.output, /^JPEG (32x\d+|\d+x32)$/m);
      r = await runTool(nano, { tool: "imagemagick", preset: "webp", values: { size: 40 }, appSource: src });
      assert.equal(r.exitCode, 0, r.output);
      const webp = nano.fs.readFile("/work/out/my photo.webp");
      assert.equal(new TextDecoder().decode(webp.subarray(8, 12)), "WEBP");
    } finally {
      nano.destroy();
    }
  },
);
