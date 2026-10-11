// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * `@userland-run/nano-sdk/tools` — run catalog apps on a user's local folder.
 *
 *  - an open, data-only tool definition format (./types) and built-ins
 *    (exif, pdf, csv-sql);
 *  - a quoting-safe command template engine (./template);
 *  - `runTool(nano, …)`: install the apps, expand/validate, run in /work, diff;
 *  - `<nano-tool>`: a framework-free web component around all of it.
 */

export type {
  ToolApp,
  ToolContext,
  ToolDefinition,
  ToolField,
  ToolFieldType,
  ToolPreset,
  ToolProgress,
  ToolValue,
  ToolValues,
} from "./types";
export {
  argQuote,
  checkDefinition,
  envExports,
  expandCommand,
  expandDefault,
  fieldDefault,
  fieldError,
  identifierOf,
  matchingFiles,
  MAX_COMMAND_LENGTH,
  resolveValues,
  shellQuote,
  toolApps,
  validateCommand,
  validateValues,
} from "./template";
export { BUILTIN_TOOLS, csvSqlTool, exifTool, imagemagickTool, pdfTool } from "./builtin";
export {
  installToolApps,
  listToolFiles,
  resolveTool,
  runTool,
  stepBudget,
  type DiffableFolder,
  type RunToolOptions,
  type RunToolResult,
  type ToolAppSource,
  type ToolNano,
} from "./run";
export { defineNanoTool, STYLES as NANO_TOOL_STYLES, type TerminalLoader } from "./element";
