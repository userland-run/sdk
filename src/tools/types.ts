// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * The open tool-definition format of `@userland-run/nano-sdk/tools`.
 *
 * A tool is DATA: the catalog app(s) it needs, the file types it works on and
 * a list of presets. A preset is a small form plus a command TEMPLATE — a
 * shell line run in the tool's working directory (default `/work`, the copy of
 * the picked folder). No JavaScript runs from a definition: templates are
 * expanded by a fixed, quoting-safe engine (see {@link expandCommand}):
 *
 *   {{field}}             the field's value, shell-quoted (numbers as digits)
 *   {{field?TEXT}}        TEXT when the field is checked / non-empty, else nothing
 *                         (put the separating space inside: "strip{{keep? --keep}}")
 *   {{files:pdf,PDF}}     every matching file (relative path), each shell-quoted
 *   {{each:csv:TEXT}}     TEXT once per matching file, each shell-quoted as one
 *                         word, with <path> (double-quoted when it needs it, for
 *                         the tool's own argument syntax) and <name> (an SQL/shell
 *                         identifier made from the file's stem, unique per run)
 *   {{first:csv:name}}    raw name/path of the first matching file — for field
 *                         defaults ("SELECT * FROM {{first:csv:name}}")
 *
 * Secret fields (`env`) are never spliced into the command: they are exported
 * as that environment variable for the run, and the template refers to the
 * variable ("$PDF_PASSWORD"), so a password never shows up in the command box,
 * a share link or the terminal history.
 */

export type ToolFieldType = "text" | "textarea" | "number" | "select" | "checkbox" | "password";
export type ToolValue = string | number | boolean;
export type ToolValues = Record<string, ToolValue>;

export interface ToolField {
  /** Template name: letters, digits, underscore. */
  id: string;
  label: string;
  type: ToolFieldType;
  /** Default value. Strings may use {{first:EXT:name|path}} (expanded unquoted). */
  default?: ToolValue;
  /** Choices for `select`. */
  options?: { value: string; label?: string }[];
  /** Help text under the field. */
  help?: string;
  /** Whole-value regular expression (source) the value must match. */
  pattern?: string;
  min?: number;
  max?: number;
  /** Export the value as this environment variable instead of templating it (passwords). */
  env?: string;
  /** Allow an empty value (text/textarea/password). Default false. */
  optional?: boolean;
}

export interface ToolPreset {
  id: string;
  label: string;
  /** One or two plain sentences: what the preset does. */
  description: string;
  fields?: ToolField[];
  /** Command template (one shell line, run in the tool's cwd). */
  command: string;
  /**
   * Where results land: "none" (prints a report), "in-place" (rewrites the
   * user's files — the UI warns before saving), or "new" (new files only).
   * Default "new".
   */
  outputs?: "none" | "in-place" | "new";
  /** Short words for the result location ("copies in cleaned/"). */
  outputsLabel?: string;
}

/** A catalog app the tool installs: a ref ("pdfcpu" / "pdfcpu@0.16.1"), and the command it provides. */
export interface ToolApp {
  ref: string;
  /** Shell command name. Default: the ref's name. */
  command?: string;
  /**
   * Runner tier: "wasm" (wasm-app, host wasm engine; default) or "riscv" (a
   * static Linux ELF on the RISC-V VM — instruction-bounded, see
   * {@link ToolDefinition.stepsPerFile}).
   */
  tier?: "wasm" | "riscv";
}

export interface ToolDefinition {
  /** Stable id (`<nano-tool tool="…">`). */
  id: string;
  title: string;
  description?: string;
  /** Catalog apps installed (signature-verified) before the first run. */
  apps: (string | ToolApp)[];
  /** File extensions the tool works on (lowercase, no dot). */
  accepts: string[];
  /** Mount size cap in bytes. Default 256 MiB. */
  maxBytes?: number;
  /**
   * Guest instruction budget per accepted file, for tools whose apps run on the
   * RISC-V VM (the run's budget is this × matching files, at least 2e9, capped
   * at 1e13). wasm-tier apps aren't instruction-bounded. Default 2e9.
   */
  stepsPerFile?: number;
  presets: ToolPreset[];
  /** Example folder listing used to preview commands before a folder is picked. */
  examples?: { files?: string[] };
  notes?: string[];
  /** License / upstream links for the UI. */
  links?: { label: string; href: string }[];
}

/** Context a template is expanded against. */
export interface ToolContext {
  /** Relative POSIX paths of the files in the working directory. */
  files: string[];
}

export interface ToolProgress {
  phase: "install" | "run" | "diff";
  label: string;
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
}
