import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { resolveById, type SpecPaths } from "./lifecycle.js";
import { paginateArtifact, type PageEnvelope } from "./pagination.js";

export type SpecPage = { file: string; frontmatter: Record<string, string> } & PageEnvelope;

/** Get one bounded page of a spec by id (filename without extension). */
export async function specGet(projectRoot: string, paths: SpecPaths, id: string, cursor?: unknown): Promise<SpecPage> {
  const absPath = await resolveById(projectRoot, paths.specs, id);
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    throw new Error(`Spec file not found: ${absPath}`);
  }
  const relPath = absPath.slice(resolve(projectRoot).length + 1);
  return paginateArtifact({
    tool: "spec_get", projectRoot, artifactPath: absPath, content, cursor,
    metadata: { file: relPath, frontmatter: parseFrontmatter(content) },
  });
}
