// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Built-in tool definitions (pure data — see ./types for the format). Each
 * runs a signed catalog app on the folder mounted at /work.
 */

import type { ToolDefinition, ToolField } from "./types";

const SAFE_NAME = "[A-Za-z0-9._-]{1,80}";
const SAFE_DIR = "[A-Za-z0-9._-]{1,40}(/[A-Za-z0-9._-]{1,40}){0,3}";
/** pdfcpu (AES-256 / PRECIS) rejects spaces; printable ASCII keeps it predictable. */
const PASSWORD = "[!-~]{4,64}";

/** Shell loop over every *.pdf in the folder: keeps going, exits non-zero if any file failed. */
const eachPdf = (body: string) => `st=0; for f in *.pdf; do [ -e "$f" ] || continue; ${body} || st=1; done; exit $st`;

const KEEP_ORIENTATION: ToolField = {
  id: "keepOrientation",
  label: "Keep the rotation tag",
  type: "checkbox",
  default: true,
  help: "Keeps only the EXIF Orientation value so portrait photos stay upright.",
};
const KEEP_ICC: ToolField = {
  id: "keepIcc",
  label: "Keep the color profile",
  type: "checkbox",
  default: true,
  help: "ICC profiles describe colors (e.g. Display P3); they carry no location.",
};

export const exifTool: ToolDefinition = {
  id: "exif",
  title: "Remove EXIF and GPS data from photos",
  description: "Strip GPS location, camera and date metadata from JPEG, PNG, WebP and HEIC photos without re-encoding them.",
  apps: [{ ref: "exifstrip", command: "exifstrip" }],
  accepts: ["jpg", "jpeg", "png", "webp", "heic", "heif", "avif"],
  maxBytes: 512 * 1024 * 1024,
  examples: { files: ["IMG_0412.jpg", "IMG_0413.heic", "trip/beach.png"] },
  presets: [
    {
      id: "strip-copy",
      label: "Remove metadata, save clean copies",
      description: "Writes a metadata-free copy of every photo into a cleaned/ folder (subfolders are kept). Your originals stay as they are.",
      fields: [
        { id: "outDir", label: "Output folder", type: "text", default: "cleaned", pattern: SAFE_DIR, help: "Created inside the folder you picked." },
        KEEP_ORIENTATION,
        KEEP_ICC,
      ],
      command: "exifstrip strip{{keepOrientation? --keep-orientation}}{{keepIcc? --keep-icc}} -o {{outDir}} .",
      outputs: "new",
      outputsLabel: "clean copies in the output folder",
    },
    {
      id: "strip-inplace",
      label: "Remove metadata in place",
      description: "Removes the metadata from the photos themselves. Saving overwrites the originals in your folder.",
      fields: [KEEP_ORIENTATION, KEEP_ICC],
      command: "exifstrip strip{{keepOrientation? --keep-orientation}}{{keepIcc? --keep-icc}} .",
      outputs: "in-place",
      outputsLabel: "the original files, rewritten",
    },
    {
      id: "show",
      label: "Check what your photos reveal",
      description: "Lists, per photo, whether it carries GPS coordinates, the camera model and the capture date. Changes nothing.",
      command: "exifstrip show .",
      outputs: "none",
      outputsLabel: "a report in the output pane",
    },
  ],
  links: [{ label: "exifstrip source (AGPL-3.0-only OR LicenseRef-UEL)", href: "https://github.com/userland-run/nano/tree/main/apps/core/build/exifstrip" }],
};

const PASSWORD_FIELD = (label: string, help: string): ToolField => ({
  id: "password",
  label,
  type: "password",
  pattern: PASSWORD,
  env: "PDF_PASSWORD",
  help,
});

export const pdfTool: ToolDefinition = {
  id: "pdf",
  title: "Merge, split, compress and password-protect PDFs",
  description: "Merge, split, optimize, encrypt or decrypt a folder of PDFs with pdfcpu.",
  apps: [{ ref: "pdfcpu", command: "pdfcpu" }],
  accepts: ["pdf"],
  maxBytes: 512 * 1024 * 1024,
  examples: { files: ["contract.pdf", "invoice.pdf"] },
  notes: ["pdfcpu runs stateless (-c disable): there is no config directory in the sandbox."],
  presets: [
    {
      id: "merge",
      label: "Merge all PDFs into one",
      description: "Combines every PDF in the folder, in alphabetical order, into a single file in out/, with a bookmark per source file.",
      fields: [{ id: "name", label: "Output file", type: "text", default: "merged.pdf", pattern: SAFE_NAME }],
      command: "mkdir -p out && pdfcpu merge -c disable out/{{name}} *.pdf",
      outputsLabel: "one merged PDF in out/",
    },
    {
      id: "split",
      label: "Split into pages",
      description: "Splits each PDF into files of N pages (one page each by default) in out/split/, named after the source: report_1.pdf, report_2.pdf, …",
      fields: [{ id: "span", label: "Pages per file", type: "number", default: 1, min: 1, max: 9999 }],
      command: `mkdir -p out/split && ${eachPdf('pdfcpu split -c disable --force "$f" out/split {{span}}')}`,
      outputsLabel: "page files in out/split/",
    },
    {
      id: "optimize",
      label: "Optimize (compress)",
      description:
        "Rewrites each PDF without duplicate fonts, images and unused objects, using compressed object streams. Writes name-optimized.pdf into out/.",
      command: `mkdir -p out && ${eachPdf('pdfcpu optimize -c disable "$f" "out/${f%.pdf}-optimized.pdf"')}`,
      outputsLabel: "optimized copies in out/",
    },
    {
      id: "encrypt",
      label: "Add a password",
      description: "Encrypts each PDF with AES-256; the password is needed to open it. Writes name-locked.pdf into out/.",
      fields: [PASSWORD_FIELD("Password", "4–64 characters, no spaces. Kept out of the command line and of share links.")],
      command: `mkdir -p out && ${eachPdf('pdfcpu encrypt -c disable --upw "$PDF_PASSWORD" --opw "$PDF_PASSWORD" "$f" "out/${f%.pdf}-locked.pdf"')}`,
      outputsLabel: "encrypted copies in out/",
    },
    {
      id: "decrypt",
      label: "Remove a password",
      description: "Opens each password-protected PDF with the password you know and writes an unprotected copy, name-unlocked.pdf, into out/.",
      fields: [PASSWORD_FIELD("Current password", "The password that opens the files. Kept out of the command line and of share links.")],
      command: `mkdir -p out && ${eachPdf('pdfcpu decrypt -c disable --upw "$PDF_PASSWORD" "$f" "out/${f%.pdf}-unlocked.pdf"')}`,
      outputsLabel: "unprotected copies in out/",
    },
    {
      id: "info",
      label: "Show document info",
      description: "Prints page count, page size, PDF version, encryption and permissions for every PDF. Changes nothing.",
      command: "pdfcpu info -c disable *.pdf",
      outputs: "none",
      outputsLabel: "a report in the output pane",
    },
  ],
  links: [{ label: "pdfcpu (Apache-2.0)", href: "https://github.com/pdfcpu/pdfcpu" }],
};

const SQL_FIELD: ToolField = {
  id: "sql",
  label: "SQL query",
  type: "textarea",
  default: "SELECT * FROM {{first:csv:name}} LIMIT 20;",
  help: "Each CSV file is a table named after the file (sales.csv → sales). Standard SQLite SQL: joins, GROUP BY, window functions.",
};
const IMPORTS = "{{each:csv:.import --csv <path> <name>}}";

export const csvSqlTool: ToolDefinition = {
  id: "csv-sql",
  title: "Query CSV files with SQL",
  description: "Import every CSV file as a SQLite table and query, join and export it with SQL.",
  apps: [{ ref: "sqlite3", command: "sqlite3" }],
  accepts: ["csv"],
  maxBytes: 512 * 1024 * 1024,
  examples: { files: ["sales.csv", "regions.csv"] },
  presets: [
    {
      id: "query",
      label: "Run a query",
      description: "Imports every CSV file as a table and prints the query result as a table.",
      fields: [SQL_FIELD],
      command: `sqlite3 :memory: ${IMPORTS} '.mode table' {{sql}}`,
      outputs: "none",
      outputsLabel: "a result table in the output pane",
    },
    {
      id: "export",
      label: "Save the result as CSV",
      description: "Runs the query and writes the result, with a header row, to a CSV file in out/.",
      fields: [SQL_FIELD, { id: "name", label: "Output file", type: "text", default: "result.csv", pattern: SAFE_NAME }],
      command: `mkdir -p out && sqlite3 :memory: ${IMPORTS} '.headers on' '.mode csv' '.once out/'{{name}} {{sql}}`,
      outputsLabel: "a CSV file in out/",
    },
    {
      id: "database",
      label: "Build a SQLite database",
      description: "Imports every CSV file into one SQLite database file, out/data.db, that any SQLite tool can open.",
      fields: [{ id: "name", label: "Database file", type: "text", default: "data.db", pattern: SAFE_NAME }],
      command: `mkdir -p out && rm -f out/{{name}} && sqlite3 out/{{name}} ${IMPORTS} '.tables'`,
      outputsLabel: "a database file in out/",
    },
    {
      id: "schema",
      label: "Show tables and columns",
      description: "Imports the CSV files and prints the table definitions SQLite derived from their header rows.",
      command: `sqlite3 :memory: ${IMPORTS} '.schema'`,
      outputs: "none",
      outputsLabel: "the schema in the output pane",
    },
  ],
  links: [{ label: "SQLite (public domain)", href: "https://sqlite.org/" }],
};

/**
 * Shell loop over the JPEG/PNG/WebP images at the top of the folder (any
 * case): one magick run per file, printing each name as it starts. Exits
 * non-zero if any file failed.
 */
const eachImage = (body: string) =>
  `st=0; for f in *.[jJ][pP]*[gG] *.[pP][nN][gG] *.[wW][eE][bB][pP]; do [ -e "$f" ] || continue; echo "$f"; ${body} || st=1; done; exit $st`;

const SIZE = (d: number): ToolField => ({ id: "size", label: "Longest side (px)", type: "number", default: d, min: 16, max: 10000 });
const QUALITY = (d: number): ToolField => ({ id: "quality", label: "Quality (1–100)", type: "number", default: d, min: 1, max: 100 });
/**
 * Decode step. For photos larger than the target, `-define jpeg:size` lets
 * libjpeg decode at a reduced size (2–6× faster resizes of JPEG input; ignored
 * for other formats). It is only set when the image is larger: for a smaller
 * one libjpeg would decode at up to 2× and the result would be enlarged.
 * `magick identify` only reads the header, so the check is instant.
 */
const DECODE =
  "h=; set -- $(magick identify -format '%w %h ' \"$f\"); " +
  '{ [ "$1" -gt {{size}} ] || [ "$2" -gt {{size}} ]; } && h="-define jpeg:size={{size}}x{{size}}"; ' +
  'magick $h "$f" -auto-orient -strip';

export const imagemagickTool: ToolDefinition = {
  id: "imagemagick",
  title: "Batch resize and convert photos with ImageMagick",
  description: "Resize, make thumbnails, convert to WebP or PNG and recompress a folder of photos with ImageMagick 7.",
  apps: [{ ref: "imagemagick", command: "magick", tier: "riscv" }],
  accepts: ["jpg", "jpeg", "png", "webp"],
  maxBytes: 512 * 1024 * 1024,
  // Measured: ~3.8e9 instructions for a 12 MP JPEG → 1600 px; WebP/PNG and
  // full-size recompression need more. 15e9 per file leaves headroom.
  stepsPerFile: 15_000_000_000,
  examples: { files: ["IMG_0412.jpg", "IMG_0413.jpg", "logo.png"] },
  notes: ["ImageMagick runs on the RISC-V VM: about 3–8 s per 12-megapixel photo on a fast desktop; slower devices take longer."],
  presets: [
    {
      id: "web",
      label: "Resize for the web (JPEG)",
      description: "Scales every photo down so its longest side fits the size (smaller ones keep their size), applies the camera rotation, removes metadata and saves a JPEG in out/.",
      fields: [SIZE(1600), QUALITY(82)],
      command: `mkdir -p out && ${eachImage(`${DECODE} -resize {{size}}x{{size}}'>' -quality {{quality}} out/"\${f%.*}".jpg`)}`,
      outputsLabel: "resized JPEGs in out/",
    },
    {
      id: "thumbnail",
      label: "Make thumbnails",
      description: "Small, metadata-free JPEG thumbnails in out/thumbs/ — the fastest preset.",
      fields: [SIZE(800), QUALITY(80)],
      command: `mkdir -p out/thumbs && ${eachImage(`${DECODE} -thumbnail {{size}}x{{size}}'>' -quality {{quality}} out/thumbs/"\${f%.*}".jpg`)}`,
      outputsLabel: "thumbnails in out/thumbs/",
    },
    {
      id: "webp",
      label: "Convert to WebP",
      description: "Resizes and converts every image to WebP (fast encoder setting) in out/. WebP files are typically a quarter to a third smaller than JPEG.",
      fields: [SIZE(1600), QUALITY(80)],
      command: `mkdir -p out && ${eachImage(`${DECODE} -resize {{size}}x{{size}}'>' -define webp:method=0 -quality {{quality}} out/"\${f%.*}".webp`)}`,
      outputsLabel: "WebP files in out/",
    },
    {
      id: "png",
      label: "Convert to PNG",
      description: "Resizes and converts every image to lossless PNG in out/. PNG photos are large; keep the size modest.",
      fields: [SIZE(1600)],
      command: `mkdir -p out && ${eachImage(`${DECODE} -resize {{size}}x{{size}}'>' out/"\${f%.*}".png`)}`,
      outputsLabel: "PNG files in out/",
    },
    {
      id: "recompress",
      label: "Recompress JPEGs at full size",
      description: "Keeps the full resolution, applies the rotation, removes metadata and re-encodes at the chosen quality into out/.",
      fields: [QUALITY(80)],
      command: `mkdir -p out && ${eachImage('magick "$f" -auto-orient -strip -quality {{quality}} out/"${f%.*}".jpg')}`,
      outputsLabel: "recompressed JPEGs in out/",
    },
    {
      id: "info",
      label: "List sizes and formats",
      description: "Prints format, dimensions and file size of every image. Changes nothing.",
      command: eachImage('magick identify "$f"'),
      outputs: "none",
      outputsLabel: "a list in the output pane",
    },
  ],
  links: [{ label: "ImageMagick (ImageMagick License)", href: "https://github.com/ImageMagick/ImageMagick" }],
};

/** The built-in definitions by id. */
export const BUILTIN_TOOLS: Readonly<Record<string, ToolDefinition>> = {
  exif: exifTool,
  pdf: pdfTool,
  "csv-sql": csvSqlTool,
  imagemagick: imagemagickTool,
};
