// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Agent tool registry + WebMCP adapter (@userland-run/nano-sdk/agent). The
// registry tests drive a fake host (sync fs like Nano, async fs like the worker
// client), so they need no wasm; one real-VM smoke runs when nano.wasm exists.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createVmTools, exposeWebMcp, isWebMcpAvailable } from "../dist/agent.js";
import { boot, wasmAvailable } from "./helpers/boot.mjs";

function fakeHost({ async = false } = {}) {
  const files = new Map([["/root/a.txt", "hello"]]);
  const calls = [];
  const wrap = (v) => (async ? Promise.resolve(v) : v);
  return {
    calls,
    files,
    fs: {
      readText: (p) => wrap(files.get(p) ?? null),
      list: (p) =>
        wrap(p === "/root" ? [{ name: "a.txt", type: "file", size: 5 }, { name: "src", type: "dir", size: 0 }] : null),
      exists: (p) => wrap(files.has(p)),
      writeFile: (p, c) => {
        calls.push(["writeFile", p]);
        files.set(p, c);
        return wrap(undefined);
      },
      mkdir: async (p) => void calls.push(["mkdir", p]),
      remove: async (p) => void calls.push(["remove", p]),
      move: async (a, b) => void calls.push(["move", a, b]),
    },
    async shExec(line) {
      calls.push(["shExec", line]);
      if (line === "busy") throw new Error("nano-sdk: the VM is busy serving (…)");
      if (line === "big") return { exitCode: 0, stdout: "x".repeat(100_000) };
      if (line === "false") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: `ran ${line}\n` };
    },
    async node(args) {
      calls.push(["node", ...args]);
      return { exitCode: 134, stdout: "42\n" };
    },
    async installApp(ref) {
      calls.push(["installApp", ref]);
      return { name: ref, version: "1.0.0" };
    },
    listeners: () => [{ port: 3000, ownerPid: 7, kind: "node" }],
  };
}

const names = (tools) => tools.map((t) => t.name).sort();
const byName = (tools, n) => tools.find((t) => t.name === n);

test("defaults register only read tools [feat:sdk.agent.tools]", () => {
  const tools = createVmTools(fakeHost());
  assert.deepEqual(names(tools), ["file_exists", "list_dir", "list_ports", "read_file"]);
  assert.ok(tools.every((t) => t.kind === "read" && t.readOnly));
});

test("capability grants add tools; fs:none removes fs tools [feat:sdk.agent.tools]", () => {
  const all = createVmTools(fakeHost(), { fs: "readwrite", exec: true, node: true, install: true, script: true });
  for (const n of ["write_file", "make_dir", "move_path", "delete_path", "run_shell", "run_node", "install_app"])
    assert.ok(byName(all, n), n);
  assert.equal(byName(all, "run_script"), undefined, "no script() on host → no run_script");
  assert.deepEqual(names(createVmTools(fakeHost(), { fs: "none" })), ["list_ports"]);
});

test("prefix namespaces tool names [feat:sdk.agent.tools]", () => {
  const tools = createVmTools(fakeHost(), { prefix: "vm1_" });
  assert.ok(tools.every((t) => t.name.startsWith("vm1_")));
});

for (const async of [false, true]) {
  test(`read tools work over ${async ? "async (worker)" : "sync (Nano)"} fs [feat:sdk.agent.tools]`, async () => {
    const tools = createVmTools(fakeHost({ async }));
    assert.equal((await byName(tools, "read_file").execute({ path: "/root/a.txt" })).output, "hello");
    assert.equal((await byName(tools, "list_dir").execute({ path: "/root" })).output, "a.txt  (5b)\nsrc/");
    const missing = await byName(tools, "read_file").execute({ path: "/nope" });
    assert.equal(missing.ok, false);
  });
}

test("approve gates mutating calls only [feat:sdk.agent.approve]", async () => {
  const host = fakeHost();
  const asked = [];
  const tools = createVmTools(host, {
    fs: "readwrite",
    exec: true,
    approve: (req) => (asked.push(req), false),
  });
  await byName(tools, "read_file").execute({ path: "/root/a.txt" });
  assert.equal(asked.length, 0, "read tools never ask");

  const r = await byName(tools, "run_shell").execute({ command: "rm -rf /tmp" });
  assert.equal(r.ok, false);
  assert.match(r.output, /rejected/);
  assert.deepEqual(asked[0], { tool: "run_shell", kind: "exec", args: { command: "rm -rf /tmp" }, summary: "rm -rf /tmp" });
  assert.ok(!host.calls.some(([m]) => m === "shExec"), "host never called");
});

test("errors, exit codes and truncation come back as text [feat:sdk.agent.tools]", async () => {
  const tools = createVmTools(fakeHost(), { exec: true, maxOutputChars: 1000 });
  const run = byName(tools, "run_shell");

  const busy = await run.execute({ command: "busy" });
  assert.equal(busy.ok, false);
  assert.match(busy.output, /busy serving/);

  const bad = await run.execute({ command: "false" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /\[exit 1\]/);

  const big = await run.execute({ command: "big" });
  assert.ok(big.output.length <= 1000);
  assert.match(big.output, /truncated \d+ chars/);
});

test("run_node treats exit 134 as benign; delete_path refuses / [feat:sdk.agent.tools]", async () => {
  const host = fakeHost();
  const tools = createVmTools(host, { fs: "readwrite", node: true });
  const r = await byName(tools, "run_node").execute({ file: "/app/x.js", cwd: "/app" });
  assert.equal(r.ok, true);
  assert.equal(r.output, "42\n");
  const del = await byName(tools, "delete_path").execute({ path: "/" });
  assert.equal(del.ok, false);
  assert.ok(!host.calls.some(([m]) => m === "remove"));
});

test("exposeWebMcp registers tools with hints and unregisters [feat:sdk.agent.webmcp]", async () => {
  assert.equal(isWebMcpAvailable(), false);
  assert.equal(typeof exposeWebMcp([]), "function", "no-op without modelContext");

  const registered = [];
  globalThis.document = {
    modelContext: { registerTool: (tool, opts) => registered.push({ tool, opts }) },
  };
  try {
    assert.equal(isWebMcpAvailable(), true);
    const tools = createVmTools(fakeHost(), { exec: true });
    const asked = [];
    const unregister = exposeWebMcp(tools, { approve: (req) => (asked.push(req.tool), true) });
    assert.equal(registered.length, tools.length);

    const read = registered.find((r) => r.tool.name === "read_file");
    assert.deepEqual(read.tool.annotations, { readOnlyHint: true, untrustedContentHint: true });
    assert.equal(await read.tool.execute({ path: "/root/a.txt" }), "hello");

    const sh = registered.find((r) => r.tool.name === "run_shell");
    assert.equal(sh.tool.annotations.readOnlyHint, false);
    assert.equal(await sh.tool.execute({ command: "ls" }), "ran ls\n");
    assert.deepEqual(asked, ["run_shell"]);

    unregister();
    assert.ok(registered.every((r) => r.opts.signal.aborted));
  } finally {
    delete globalThis.document;
  }
});

if (wasmAvailable) {
  let nano;
  after(() => nano?.destroy());

  test("tools drive a real VM [feat:sdk.agent.tools]", async () => {
    nano = await boot();
    const tools = createVmTools(nano, { fs: "readwrite", exec: true });
    assert.equal((await byName(tools, "write_file").execute({ path: "/app/n.txt", content: "3\n1\n2\n" })).ok, true);
    assert.equal((await byName(tools, "read_file").execute({ path: "/app/n.txt" })).output, "3\n1\n2\n");
    const r = await byName(tools, "run_shell").execute({ command: "sort -n /app/n.txt | head -1" });
    assert.equal(r.ok, true);
    assert.equal(r.output.trim(), "1");
  });
}
