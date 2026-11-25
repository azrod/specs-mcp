import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function toolText(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

export function toolError(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { ...toolText(text, structured), isError: true };
}
