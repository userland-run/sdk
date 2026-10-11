// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * WebMCP adapter: register {@link AgentTool}s with the browser's built-in agent
 * via `document.modelContext.registerTool` (`navigator.modelContext` is the
 * older spelling; either is accepted). The API is flag / origin-trial gated, so
 * this silently no-ops where it is absent. The minimal API surface is declared
 * locally rather than as ambient globals, so consumers' DOM typings are untouched.
 */

import type { AgentApprove, AgentTool, AgentToolKind } from "./types";

interface WebMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (args: Record<string, unknown>) => Promise<string>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}

interface ModelContextLike {
  registerTool(tool: WebMcpToolDescriptor, opts?: { signal?: AbortSignal; exposedTo?: string[] }): void;
}

export interface WebMcpOptions {
  /**
   * Gate non-read calls coming from the browser agent. Use this when the tools
   * weren't built with their own `approve` (e.g. a custom registry).
   */
  approve?: AgentApprove;
  /** Origins allowed to see the tools (passed through to `registerTool`). */
  exposedTo?: string[];
}

function modelContext(): ModelContextLike | undefined {
  const g = globalThis as { document?: { modelContext?: unknown }; navigator?: { modelContext?: unknown } };
  const ctx = (g.document?.modelContext ?? g.navigator?.modelContext) as ModelContextLike | undefined;
  return ctx && typeof ctx.registerTool === "function" ? ctx : undefined;
}

/** True when the page can register WebMCP tools. */
export function isWebMcpAvailable(): boolean {
  return modelContext() !== undefined;
}

/**
 * Register `tools` with the browser agent. Returns an unregister function
 * (call it on teardown). Tool output is marked untrusted: it is whatever the
 * sandboxed program printed.
 */
export function exposeWebMcp(tools: AgentTool[], opts: WebMcpOptions = {}): () => void {
  const ctx = modelContext();
  if (!ctx) return () => {};

  const controller = new AbortController();
  for (const tool of tools) {
    const kind: AgentToolKind = tool.kind ?? "exec";
    const readOnly = !!tool.readOnly || kind === "read";
    try {
      ctx.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          async execute(args) {
            const a = args ?? {};
            if (opts.approve && !readOnly) {
              const summary = String(a.command ?? a.path ?? a.file ?? a.ref ?? "");
              if (!(await opts.approve({ tool: tool.name, kind, args: a, summary })))
                return `${tool.name}: rejected by user`;
            }
            try {
              return (await tool.execute(a)).output;
            } catch (e) {
              return `${tool.name}: ${e instanceof Error ? e.message : String(e)}`;
            }
          },
          annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
        },
        { signal: controller.signal, ...(opts.exposedTo ? { exposedTo: opts.exposedTo } : {}) },
      );
    } catch (e) {
      console.warn("nano-sdk: WebMCP registerTool failed:", tool.name, e);
    }
  }
  return () => controller.abort();
}
