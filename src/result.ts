import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function toolText(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

export function toolError(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { ...toolText(text, structured), isError: true };
}

/**
 * Wrap the JSON text of a tool response: the text is kept as is, its parsed object becomes
 * `structuredContent`, and a top-level string `error` field marks the result as a tool error.
 */
export function jsonResult(text: string): CallToolResult {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return toolText(text);
  const structured = parsed as Record<string, unknown>;
  return typeof structured.error === "string" ? toolError(text, structured) : toolText(text, structured);
}
