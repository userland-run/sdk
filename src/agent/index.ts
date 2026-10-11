// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * @userland-run/nano-sdk/agent — give an LLM agent a Linux sandbox. A
 * capability-scoped, model-agnostic VM tool registry plus a WebMCP adapter.
 */

export { createVmTools, truncateOutput } from "./tools";
export { exposeWebMcp, isWebMcpAvailable, type WebMcpOptions } from "./webmcp";
export type {
  AgentApprovalRequest,
  AgentApprove,
  AgentHost,
  AgentTool,
  AgentToolKind,
  AgentToolResult,
  AgentToolsOptions,
  JsonSchema,
} from "./types";
