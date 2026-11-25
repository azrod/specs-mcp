import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./config.js";

export type GetContext = () => Promise<ToolContext>;

/** Registers the `spec_*` tools, resources and prompts. Filled in by the next work packages. */
export function registerSpecTools(_server: McpServer, _getContext: GetContext): void {}
