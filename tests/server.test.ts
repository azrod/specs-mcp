import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig, type SpecsConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { toolError, toolText } from "../src/result.js";

async function connect(config: SpecsConfig, roots?: string[]) {
  const created = createServer(config);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: roots ? { roots: {} } : {} });
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map((uri) => ({ uri })) }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, client, close: () => Promise.all([client.close(), created.server.close()]) };
}

test("server starts over an in-memory transport and answers listTools", async () => {
  const { client, close } = await connect(resolveConfig([], {}));
  try {
    const { tools } = await client.listTools();
    assert.ok(Array.isArray(tools));
    assert.equal(client.getServerVersion()?.name, "specs-mcp");
  } finally {
    await close();
  }
});

test("getContext: explicit root from config wins over client roots", async () => {
  const { getContext, close } = await connect(resolveConfig(["--root", "/tmp/explicit"], {}), ["file:///tmp/from-client"]);
  try {
    const ctx = await getContext();
    assert.equal(ctx.projectRoot, resolve("/tmp/explicit"));
    assert.deepEqual(ctx.paths, { specs: "docs/specs" });
  } finally {
    await close();
  }
});

test("getContext: first file:// client root is used when config has no root", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "specs-mcp-roots-")));
  const { getContext, close } = await connect(resolveConfig([], {}), [pathToFileURL(dir).href, "file:///tmp/second"]);
  try {
    assert.equal((await getContext()).projectRoot, dir);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getContext: falls back to process.cwd() when the client announces no roots", async () => {
  const { getContext, close } = await connect(resolveConfig([], {}));
  try {
    assert.equal((await getContext()).projectRoot, process.cwd());
  } finally {
    await close();
  }
});

test("getContext: falls back to process.cwd() when the client announces an empty roots list", async () => {
  const { getContext, close } = await connect(resolveConfig([], {}), []);
  try {
    assert.equal((await getContext()).projectRoot, process.cwd());
  } finally {
    await close();
  }
});

test("getContext carries the configured specs directory", async () => {
  const { getContext, close } = await connect(resolveConfig(["--root", "/tmp/x", "--specs-dir", "private/specs"], {}));
  try {
    assert.equal((await getContext()).paths.specs, "private/specs");
  } finally {
    await close();
  }
});

test("toolText / toolError build CallToolResult objects", () => {
  assert.deepEqual(toolText("ok"), { content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(toolText("ok", { a: 1 }), { content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 } });
  assert.deepEqual(toolError("boom"), { content: [{ type: "text", text: "boom" }], isError: true });
  assert.deepEqual(toolError("boom", { error: "boom" }), {
    content: [{ type: "text", text: "boom" }],
    structuredContent: { error: "boom" },
    isError: true,
  });
});
