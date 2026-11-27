import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpecsConfig, ToolContext } from "./config.js";
import { registerSpecTools } from "./tools.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

export interface CreatedServer {
  server: McpServer;
  getContext(): Promise<ToolContext>;
}

/** First `file://` root announced by the client via `roots/list`, or null when there is none. */
async function firstFileRoot(server: McpServer): Promise<string | null> {
  if (!server.server.getClientCapabilities()?.roots) return null;
  try {
    const { roots } = await server.server.listRoots();
    for (const { uri } of roots) {
      if (uri.startsWith("file://")) return resolve(fileURLToPath(uri));
    }
  } catch {
    // The client advertised roots but could not list them: fall back like a client without roots.
  }
  return null;
}

export function createServer(config: SpecsConfig): CreatedServer {
  const server = new McpServer({ name: pkg.name.replace(/^@[^/]+\//, ""), version: pkg.version }, { capabilities: { tools: {} } });

  let discoveredRoot: Promise<string> | undefined;
  const resolveRoot = (): Promise<string> => {
    if (config.projectRoot !== null) return Promise.resolve(config.projectRoot);
    discoveredRoot ??= firstFileRoot(server).then((root) => root ?? process.cwd());
    return discoveredRoot;
  };

  const getContext = async (): Promise<ToolContext> => ({
    projectRoot: await resolveRoot(),
    paths: config.paths,
  });

  registerSpecTools(server, getContext);
  return { server, getContext };
}
