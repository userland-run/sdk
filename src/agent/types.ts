// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Types for the agent tool registry (`@userland-run/nano-sdk/agent`). Kept
 * type-only against the core so the agent entry stays tiny (no VM runtime is
 * bundled into it).
 */

import type { DirEntry, ExecOptions, ExecResult, ScriptEngineOptions } from "../types";

type MaybePromise<T> = T | Promise<T>;

/** A JSON Schema fragment describing a tool's `args`. */
export type JsonSchema = Record<string, unknown>;

/**
 * Capability class of a tool. `read` never mutates the VM; `edit` writes
 * files; `exec` runs commands / installs; `network` reaches off-machine.
 * Absent → treated as `exec` (the safe default).
 */
export type AgentToolKind = "read" | "edit" | "exec" | "network";

/** Result of running a tool. `output` is the agent-readable text. */
export interface AgentToolResult {
  ok: boolean;
  output: string;
  /** Optional structured payload for programmatic callers. */
  data?: unknown;
}

/**
 * One capability an LLM agent can invoke. The shape is model-agnostic: map it
 * to Claude / OpenAI tool definitions, an MCP server, or WebMCP via
 * {@link exposeWebMcp}.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema of the `args` object passed to {@link AgentTool.execute}. */
  inputSchema: JsonSchema;
  /** Capability class (default `exec`). Drives approval and WebMCP hints. */
  kind?: AgentToolKind;
  /** True when the tool only reads state. */
  readOnly?: boolean;
  /** Run the tool. Never throws: failures come back as `{ ok: false }`. */
  execute(args: Record<string, unknown>): Promise<AgentToolResult>;
}

/** A mutating call awaiting the host's approval. */
export interface AgentApprovalRequest {
  tool: string;
  kind: AgentToolKind;
  args: Record<string, unknown>;
  /** Short human summary (command / path) for a confirmation UI. */
  summary: string;
}

/** Approve (true) or reject (false) a mutating call. */
export type AgentApprove = (req: AgentApprovalRequest) => MaybePromise<boolean>;

/**
 * The VM surface the tools drive. Both `Nano` (sync fs) and
 * `NanoWorkerClient` (async fs) satisfy it; every call is awaited.
 */
export interface AgentHost {
  fs: {
    readText(path: string): MaybePromise<string | null>;
    list(path: string): MaybePromise<DirEntry[] | null>;
    exists(path: string): MaybePromise<boolean>;
    writeFile(path: string, content: string | Uint8Array, mode?: number): MaybePromise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
  };
  shExec(line: string, opts?: ExecOptions): Promise<ExecResult>;
  node(args: string[], opts?: ExecOptions): Promise<ExecResult>;
  installApp?(ref: string): Promise<{ name: string; version: string }>;
  script?(source: string, opts?: ScriptEngineOptions): Promise<unknown>;
  listeners?(): MaybePromise<Array<{ port: number; ownerPid: number; kind: string }>>;
}

/** Capability grant + limits for {@link createVmTools}. */
export interface AgentToolsOptions {
  /** Filesystem tools. Default "readonly". */
  fs?: "none" | "readonly" | "readwrite";
  /** `run_shell` (sh lines via shExec). Default false. */
  exec?: boolean;
  /** `run_node`. Default false. */
  node?: boolean;
  /** `install_app` from the signed catalog. Default false. */
  install?: boolean;
  /** `run_script` in the sandboxed Boa engine (fs scoped to `fs`). Default false. */
  script?: boolean;
  /** Prefix for every tool name (namespacing several VMs). Default "". */
  prefix?: string;
  /** Cap on a tool's output text; the middle is elided. Default 32_000 chars. */
  maxOutputChars?: number;
  /** Instruction budget for run_shell (run_node keeps the node default). */
  maxSteps?: number;
  /** Called before any non-`read` tool runs. Absent → mutating calls run. */
  approve?: AgentApprove;
}
