// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * The agent tool registry: capability-scoped VM tools an LLM can call, built
 * over any {@link AgentHost} (`Nano` or `NanoWorkerClient`). Read-only by
 * default — every mutating capability is opt-in, and an `approve` hook gates
 * each non-read call. Tools never throw (busy-VM and guest errors come back as
 * `{ ok: false }` text the agent can read) and their output is size-capped.
 */

import type {
  AgentHost,
  AgentTool,
  AgentToolKind,
  AgentToolResult,
  AgentToolsOptions,
  JsonSchema,
} from "./types";

const DEFAULT_MAX_OUTPUT = 32_000;

const ok = (output: string, data?: unknown): AgentToolResult => ({ ok: true, output, data });
const fail = (output: string): AgentToolResult => ({ ok: false, output });

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Keep the head and tail of long output, eliding the middle. */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 40);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n…[truncated ${cut} chars]…\n${tail ? text.slice(-tail) : ""}`;
}

interface ToolSpec {
  name: string;
  description: string;
  kind: AgentToolKind;
  inputSchema: JsonSchema;
  summary(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>): Promise<AgentToolResult>;
}

/**
 * Build the VM tool set for `host`. Which tools exist depends on the grant:
 *
 * | grant              | tools                                                   |
 * | ------------------ | ------------------------------------------------------- |
 * | `fs: "readonly"`   | `list_dir`, `read_file`, `file_exists` (default)        |
 * | `fs: "readwrite"`  | + `write_file`, `make_dir`, `move_path`, `delete_path`  |
 * | `exec`             | `run_shell`                                             |
 * | `node`             | `run_node`                                              |
 * | `install`          | `install_app` (when the host has `installApp`)          |
 * | `script`           | `run_script` (when the host has `script`)               |
 * | always             | `list_ports` (when the host has `listeners`)            |
 */
export function createVmTools(host: AgentHost, opts: AgentToolsOptions = {}): AgentTool[] {
  const fsGrant = opts.fs ?? "readonly";
  const prefix = opts.prefix ?? "";
  const max = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const specs: ToolSpec[] = [];

  const exitTail = (code: number): string => (code ? `\n[exit ${code}]` : "");

  if (fsGrant !== "none") {
    specs.push(
      {
        name: "list_dir",
        description: "List the entries of a directory in the VM filesystem.",
        kind: "read",
        inputSchema: obj({ path: { type: "string", description: "Directory path, e.g. /root." } }, ["path"]),
        summary: (a) => str(a.path),
        async run(a) {
          const path = str(a.path) || "/";
          const entries = await host.fs.list(path);
          if (!entries) return fail(`list_dir: not a directory: ${path}`);
          const lines = entries
            .slice()
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((e) => (e.type === "dir" ? `${e.name}/` : `${e.name}  (${e.size}b)`));
          return ok(lines.join("\n") || "(empty)", entries);
        },
      },
      {
        name: "read_file",
        description: "Read a text file from the VM filesystem.",
        kind: "read",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        summary: (a) => str(a.path),
        async run(a) {
          const path = str(a.path);
          const text = await host.fs.readText(path);
          return text == null ? fail(`read_file: not found: ${path}`) : ok(text);
        },
      },
      {
        name: "file_exists",
        description: "Check whether a path exists in the VM filesystem.",
        kind: "read",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        summary: (a) => str(a.path),
        async run(a) {
          const exists = await host.fs.exists(str(a.path));
          return ok(exists ? "true" : "false", exists);
        },
      },
    );
  }

  if (fsGrant === "readwrite") {
    specs.push(
      {
        name: "write_file",
        description: "Create or overwrite a text file in the VM filesystem.",
        kind: "edit",
        inputSchema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
        summary: (a) => str(a.path),
        async run(a) {
          const path = str(a.path);
          if (!path) return fail("write_file: missing path");
          const content = str(a.content);
          await host.fs.writeFile(path, content);
          return ok(`wrote ${path} (${content.length} chars)`);
        },
      },
      {
        name: "make_dir",
        description: "Create a directory (and missing parents) in the VM filesystem.",
        kind: "edit",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        summary: (a) => str(a.path),
        async run(a) {
          const path = str(a.path);
          if (!path) return fail("make_dir: missing path");
          await host.fs.mkdir(path);
          return ok(`created ${path}`);
        },
      },
      {
        name: "move_path",
        description: "Move or rename a file or directory in the VM filesystem.",
        kind: "edit",
        inputSchema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
        summary: (a) => `${str(a.from)} → ${str(a.to)}`,
        async run(a) {
          const from = str(a.from);
          const to = str(a.to);
          if (!from || !to) return fail("move_path: missing from/to");
          await host.fs.move(from, to);
          return ok(`moved ${from} → ${to}`);
        },
      },
      {
        name: "delete_path",
        description: "Delete a file or directory (recursively) from the VM filesystem.",
        kind: "edit",
        inputSchema: obj({ path: { type: "string" } }, ["path"]),
        summary: (a) => str(a.path),
        async run(a) {
          const path = str(a.path).trim();
          if (!path || path === "/" || path === "/*")
            return fail("delete_path: refusing to delete the filesystem root");
          await host.fs.remove(path);
          return ok(`deleted ${path}`);
        },
      },
    );
  }

  if (opts.exec) {
    specs.push({
      name: "run_shell",
      description:
        "Run a shell command line (sh: pipes, redirects, &&) in the VM from / and return its combined output. Use `cd dir && …` to change directory.",
      kind: "exec",
      inputSchema: obj({ command: { type: "string", description: "The sh command line." } }, ["command"]),
      summary: (a) => str(a.command),
      async run(a) {
        const command = str(a.command).trim();
        if (!command) return fail("run_shell: empty command");
        const r = await host.shExec(command, opts.maxSteps ? { maxSteps: opts.maxSteps } : undefined);
        const tail = r.cancelled ? "\n[cancelled]" : exitTail(r.exitCode);
        return { ok: !r.cancelled && r.exitCode === 0, output: (r.stdout || "(no output)") + tail };
      },
    });
  }

  if (opts.node) {
    specs.push({
      name: "run_node",
      description: "Run a JavaScript file with Node.js in the VM and return its output.",
      kind: "exec",
      inputSchema: obj(
        {
          file: { type: "string", description: "Path to the .js file." },
          args: { type: "array", items: { type: "string" }, description: "Extra arguments." },
          cwd: { type: "string", description: "Working directory." },
        },
        ["file"],
      ),
      summary: (a) => str(a.file),
      async run(a) {
        const file = str(a.file);
        if (!file) return fail("run_node: missing file");
        const extra = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === "string") : [];
        const cwd = str(a.cwd);
        const r = await host.node([file, ...extra], cwd ? { cwd } : undefined);
        // Warm Node can exit 134 after printing correct output; treat as benign.
        const good = r.exitCode === 0 || r.exitCode === 134;
        const tail = r.cancelled ? "\n[cancelled]" : good ? "" : exitTail(r.exitCode);
        return { ok: !r.cancelled && good, output: (r.stdout || "(no output)") + tail };
      },
    });
  }

  if (opts.install && host.installApp) {
    const installApp = host.installApp.bind(host);
    specs.push({
      name: "install_app",
      description:
        "Install a signed app from the userland.run catalog into the VM (e.g. \"node\", \"ripgrep\", \"ripgrep@14.1.0\").",
      kind: "exec",
      inputSchema: obj({ ref: { type: "string", description: "Catalog ref: name or name@version." } }, ["ref"]),
      summary: (a) => str(a.ref),
      async run(a) {
        const ref = str(a.ref).trim();
        if (!ref) return fail("install_app: missing ref");
        const m = await installApp(ref);
        return ok(`installed ${m.name}@${m.version}`, m);
      },
    });
  }

  if (opts.script && host.script) {
    const script = host.script.bind(host);
    specs.push({
      name: "run_script",
      description:
        "Evaluate JavaScript in a sandboxed engine (no Node APIs). The `nano.fs` bridge is available within the granted filesystem scope. Returns the value of the last expression as JSON.",
      kind: "exec",
      inputSchema: obj({ source: { type: "string", description: "JavaScript source." } }, ["source"]),
      summary: (a) => str(a.source).slice(0, 80),
      async run(a) {
        const source = str(a.source);
        if (!source) return fail("run_script: empty source");
        let logs = "";
        const sink = (c: string) => void (logs += c);
        const value = await script(source, {
          expose: { fs: fsGrant, webapis: ["console"] },
          timeoutMs: 10_000,
          onStdout: sink,
          onStderr: sink,
        });
        const shown = value === undefined ? "" : JSON.stringify(value, null, 2) ?? String(value);
        return ok([logs.trimEnd(), shown].filter(Boolean).join("\n") || "(no result)", value);
      },
    });
  }

  if (host.listeners) {
    const listeners = host.listeners.bind(host);
    specs.push({
      name: "list_ports",
      description: "List TCP ports that servers inside the VM are listening on.",
      kind: "read",
      inputSchema: obj({}, []),
      summary: () => "",
      async run() {
        const ports = await listeners();
        return ok(ports.map((p) => `${p.port}  (${p.kind}, pid ${p.ownerPid})`).join("\n") || "(none)", ports);
      },
    });
  }

  return specs.map((spec) => toTool(spec, prefix, max, opts.approve));
}

function toTool(
  spec: ToolSpec,
  prefix: string,
  max: number,
  approve: AgentToolsOptions["approve"],
): AgentTool {
  const name = prefix + spec.name;
  return {
    name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    kind: spec.kind,
    readOnly: spec.kind === "read",
    async execute(args) {
      const a = args ?? {};
      try {
        if (approve && spec.kind !== "read") {
          const allowed = await approve({ tool: name, kind: spec.kind, args: a, summary: spec.summary(a) });
          if (!allowed) return fail(`${name}: rejected by user`);
        }
        const r = await spec.run(a);
        return { ...r, output: truncateOutput(r.output, max) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(truncateOutput(`${name}: ${msg}`, max));
      }
    },
  };
}
