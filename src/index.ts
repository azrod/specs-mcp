#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const { server } = createServer(resolveConfig(process.argv.slice(2), process.env));
  await server.connect(new StdioServerTransport());
} catch (err) {
  // stdout carries the MCP protocol: report startup failures on stderr only.
  console.error(`[specs-mcp] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
