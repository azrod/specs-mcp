/**
 * Parse the YAML frontmatter block from a markdown string.
 * Returns a plain object with string values, or {} if absent / unparseable.
 * Supports only the simple "key: value" format used by these tools.
 *
 * Exact port of `parseFrontmatter` from the original `lifecycle.js`.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
    if (key) result[key] = value;
  }
  return result;
}
