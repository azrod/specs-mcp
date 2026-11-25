import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, dirname, isAbsolute, resolve, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface SpecPaths {
  specs: string;
}

export interface SpecCreateResult {
  created: true;
  file: string;
  id: string;
  hint: string;
}

export interface SpecUpdateResult {
  file: string;
  updated: true;
  hint: string;
}

export interface SpecValidateResult {
  file: string;
  valid: boolean;
  issues: string[];
  warnings: string[];
}

export interface SpecListEntry {
  file: string;
  title: string | null;
  id: string | null;
  type: string | null;
  status: string | null;
  created: string | null;
}

export interface SpecListUnreadable {
  file: string;
  error: string;
}

export interface SpecListFilters {
  type?: string;
  status?: string;
}

export interface SpecDeleteResult {
  deleted: true;
  file: string;
}

const REQUIRED_SECTIONS = ["Purpose", "Behavior", "Constraints", "Examples"] as const;
const SPEC_TYPES = ["technical", "functional", "architectural"] as const;
const SPEC_STATUSES = ["draft", "active", "deprecated"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

/**
 * Resolve a relative artifact path against projectRoot.
 * If path is already absolute, return as-is.
 */
export function resolveArtifact(projectRoot: string, relPath: string): string {
  const resolved = isAbsolute(relPath) ? relPath : join(projectRoot, relPath);
  const normalizedRoot = resolve(projectRoot) + sep;
  const normalizedPath = resolve(resolved);
  if (!normalizedPath.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return normalizedPath;
}

/**
 * List all *.md files in a directory (non-recursive).
 * Returns relative-to-projectRoot paths.
 */
async function listMdFiles(projectRoot: string, dirRelPath: string): Promise<string[]> {
  const absDir = join(projectRoot, dirRelPath);
  try {
    const entries = await readdir(absDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(dirRelPath, e.name));
  } catch {
    return [];
  }
}

/** Today's date as ISO string (YYYY-MM-DD). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Generate a filesystem-safe id from a human title.
 * Lowercases, replaces spaces with dashes, strips non-alphanumeric/dash chars.
 */
function titleToId(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Find the absolute path of a .md file in `dir` whose name (without extension)
 * matches `id` (case-insensitive). Throws if not found.
 */
export async function resolveById(projectRoot: string, dir: string, id: string): Promise<string> {
  const absDir = join(projectRoot, dir);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    throw new Error(`Directory not found: ${dir} (looking for id "${id}")`);
  }
  const target = id.toLowerCase();
  const match = entries.find(
    (e) => e.isFile() && e.name.endsWith(".md") && e.name.slice(0, -3).toLowerCase() === target,
  );
  if (!match) {
    throw new Error(`Artifact with id "${id}" not found in ${dir}`);
  }
  const finalPath = join(absDir, match.name);
  return resolveArtifact(projectRoot, finalPath);
}

/** Create a new spec file. */
export async function specCreate(
  projectRoot: string,
  paths: SpecPaths,
  title: string,
  type: string | null = "technical",
  content: string | null = null,
): Promise<SpecCreateResult> {
  const id = titleToId(title);
  if (!id) throw new Error(`Cannot derive id from title: "${title}"`);
  const relPath = join(paths.specs, `${id}.md`);
  const absPath = resolveArtifact(projectRoot, relPath);

  await mkdir(dirname(absPath), { recursive: true });

  const headingTitle = title.replace(/[\r\n]/g, " ");
  const safeTitle = headingTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeType = `"${(type ?? "technical").replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const frontmatter = `---\ntitle: "${safeTitle}"\nid: ${id}\ntype: ${safeType}\nstatus: draft\ncreated: ${today()}\n---\n`;
  const body = content != null ? `\n${content}` : `\n# ${headingTitle}\n`;
  try {
    await writeFile(absPath, frontmatter + body, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (isErrno(err, "EEXIST")) throw new Error(`Spec "${id}" already exists at ${relPath}`);
    throw err;
  }

  return {
    created: true,
    file: relPath,
    id,
    hint: `Spec created. Once you're done building it, you can suggest to the user to run a validation review (spec_validate).`,
  };
}

/** Update a spec by replacing oldString with newString. */
export async function specUpdate(
  projectRoot: string,
  paths: SpecPaths,
  id: string,
  oldString: string,
  newString: string,
): Promise<SpecUpdateResult> {
  const absPath = await resolveById(projectRoot, paths.specs, id);
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    throw new Error(`Spec file not found: ${absPath}`);
  }

  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`oldString not found in spec "${id}"`);
  }
  if (occurrences > 1) {
    throw new Error(
      `Found ${occurrences} matches for oldString in spec "${id}". Provide more surrounding context to make it unique.`,
    );
  }

  const updated = content.replace(oldString, () => newString);
  await writeFile(absPath, updated, "utf-8");

  const relPath = absPath.slice(resolve(projectRoot).length + 1);
  return {
    file: relPath,
    updated: true,
    hint: `Spec updated. Once you're done with changes, you can suggest to the user to run a validation review (spec_validate).`,
  };
}

/** h2 headings of a markdown body, ignoring anything inside fenced code blocks. */
function h2Headings(body: string): string[] {
  const headings: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === "") {
        fence = null;
      }
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    const heading = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) headings.push(heading[1]);
  }
  return headings;
}

function enumWarning(field: string, value: string | undefined, allowed: readonly string[]): string | null {
  if (value !== undefined && allowed.includes(value)) return null;
  const expected = `expected: ${allowed.join(" | ")}`;
  if (value === undefined || value === "") return `Frontmatter field '${field}' is missing or empty (${expected})`;
  return `Frontmatter field '${field}' has unexpected value '${value}' (${expected})`;
}

/** Validate a spec structurally (no LLM). `warnings` is advisory and never changes `valid` / `issues`. */
export async function specValidate(projectRoot: string, paths: SpecPaths, id: string): Promise<SpecValidateResult> {
  const absPath = await resolveById(projectRoot, paths.specs, id);
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    throw new Error(`Spec file not found: ${absPath}`);
  }

  const relPath = absPath.slice(resolve(projectRoot).length + 1);
  const issues: string[] = [];
  const warnings: string[] = [];
  const fm = parseFrontmatter(content);
  const hasFrontmatter = /^---\r?\n/.test(content);

  if (!hasFrontmatter) {
    issues.push("Frontmatter block is missing");
  } else {
    if (!fm.title) issues.push("Frontmatter field 'title' is missing or empty");
    if (!fm.id) issues.push("Frontmatter field 'id' is missing or empty");
  }

  // Body check: strip frontmatter and see if non-whitespace content remains
  const bodyWithoutFm = hasFrontmatter
    ? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    : content;
  if (!bodyWithoutFm.trim()) {
    issues.push("Spec body is empty (no content beyond frontmatter)");
  }

  if (hasFrontmatter) {
    for (const warning of [enumWarning("type", fm.type, SPEC_TYPES), enumWarning("status", fm.status, SPEC_STATUSES)]) {
      if (warning) warnings.push(warning);
    }
  }

  const headings = h2Headings(bodyWithoutFm);
  const positions = REQUIRED_SECTIONS.map((name) => headings.indexOf(name));
  REQUIRED_SECTIONS.forEach((name, i) => {
    if (positions[i] === -1) warnings.push(`Required section '## ${name}' is missing`);
  });
  const present = positions.filter((p) => p !== -1);
  if (present.some((p, i) => i > 0 && p < present[i - 1])) {
    warnings.push(
      `Required sections are out of order (expected: ${REQUIRED_SECTIONS.map((s) => `## ${s}`).join(", ")})`,
    );
  }

  return { file: relPath, valid: issues.length === 0, issues, warnings };
}

function matchesFilter(actual: string | null, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  return actual !== null && actual.toLowerCase() === wanted.toLowerCase();
}

/** List all specs, optionally filtered by exact (case-insensitive) frontmatter `type` / `status`. */
export async function specList(
  projectRoot: string,
  paths: SpecPaths,
  filters?: SpecListFilters,
): Promise<{ specs: Array<SpecListEntry | SpecListUnreadable> }> {
  const files = await listMdFiles(projectRoot, paths.specs);
  const all = await Promise.all(
    files.map(async (file): Promise<SpecListEntry | SpecListUnreadable> => {
      let content: string;
      try {
        content = await readFile(join(projectRoot, file), "utf-8");
      } catch (err) {
        return { file, error: `unreadable: ${errorMessage(err)}` };
      }
      const fm = parseFrontmatter(content);
      return {
        file,
        title: fm.title ?? null,
        id: fm.id ?? null,
        type: fm.type ?? null,
        status: fm.status ?? null,
        created: fm.created ?? null,
      };
    }),
  );
  const wantedType = filters?.type;
  const wantedStatus = filters?.status;
  if (wantedType === undefined && wantedStatus === undefined) return { specs: all };
  const specs = all.filter(
    (s) => "type" in s && matchesFilter(s.type, wantedType) && matchesFilter(s.status, wantedStatus),
  );
  return { specs };
}

/** Delete a spec by id. */
export async function specDelete(projectRoot: string, paths: SpecPaths, id: string): Promise<SpecDeleteResult> {
  const absPath = await resolveById(projectRoot, paths.specs, id);
  try {
    await unlink(absPath);
  } catch {
    throw new Error(`Failed to delete spec "${id}" at ${absPath}`);
  }
  const relPath = absPath.slice(resolve(projectRoot).length + 1);
  return { deleted: true, file: relPath };
}

/**
 * Return the canonical format expected for a spec file.
 * Pure function — no parameters, no I/O, no side effects.
 */
export function specFormat(): string {
  return [
    "# Spec format — canonical reference",
    "",
    "## Frontmatter (required)",
    "",
    "```yaml",
    "---",
    'title: "Human-readable title"',
    "id: slug-derived-from-title        # auto-generated by spec_create",
    "type: technical                    # technical | functional | architectural",
    "status: draft                      # draft | active | deprecated",
    "created: YYYY-MM-DD                # auto-generated by spec_create",
    "---",
    "```",
    "",
    "## Required sections (in order)",
    "",
    "The body must contain these top-level sections (h2 headings), in this order:",
    "",
    "- `## Purpose` — One paragraph. Answers: why does this spec exist? What problem does it solve?",
    "  Not a feature description — a statement of intent.",
    "",
    "- `## Behavior` — The core of the spec. Describes what the system does, not how it does it.",
    "  Use prose. Concrete, specific, falsifiable statements.",
    "  Bullet lists are acceptable here when enumerating distinct cases.",
    "",
    "- `## Constraints` — Hard limits and non-negotiable invariants. Things the implementation must not violate.",
    '  Example: "Must not exceed 512 KB per artifact", "Must be idempotent on repeated calls".',
    "",
    "- `## Examples` — At least one concrete example showing the spec in action.",
    "  Code blocks, input/output pairs, or narrative walkthroughs — whatever is clearest.",
    "",
    "## Optional sections",
    "",
    "The following sections are optional (h2 headings, placed after the required ones):",
    "",
    "- `## Rationale` — Why this design was chosen over alternatives. Only needed when the decision is non-obvious.",
    "",
    "- `## Non-goals` — What this spec explicitly does NOT cover. Prevents scope creep and misinterpretation.",
    "",
    "## Style rules",
    "",
    "- Target length: 100–400 lines depending on complexity",
    "- Write in prose first, lists only for genuinely enumerable items",
    "- Concrete examples > abstract descriptions",
    "- Every constraint should be mechanically verifiable (testable or lint-enforceable)",
    "",
    "## What a spec is NOT",
    "",
    '- Not a ticket or user story ("As a user, I want…")',
    "- Not a verbose design doc with every alternative explored",
    "- Not pseudo-code or implementation instructions",
    "- Not a changelog entry",
    "",
    "## Minimal valid example",
    "",
    "```markdown",
    "---",
    'title: "Artifact Guard"',
    "id: artifact-guard",
    "type: technical",
    "status: active",
    "created: 2026-01-01",
    "---",
    "",
    "# Artifact Guard",
    "",
    "## Purpose",
    "",
    "Prevent agents from directly reading or modifying protected artifact directories",
    "(docs/specs/, docs/exec-plans/, docs/briefs/) except through the 19 lifecycle tools.",
    "",
    "## Behavior",
    "",
    "The guard intercepts read, edit, write, patch, shell, glob, and grep calls at the",
    "tool.execute.before hook. If the target path falls inside a protected directory",
    "and the caller is not a lifecycle tool, the call is rejected with a descriptive error.",
    "",
    "Lifecycle tools always bypass the guard — they are the intended access path.",
    "",
    "## Constraints",
    "",
    "- Must block access even when paths use backslashes or leading slashes.",
    "- Must NOT block access for any of the 19 lifecycle tools.",
    "- Must NOT block access to paths that merely share a prefix (e.g. docs/specs-extra/).",
    "",
    "## Examples",
    "",
    "```js",
    "// Blocked: direct read on protected path",
    'checkArtifactAccess({ tool: "read", args: { filePath: "docs/specs/auth.md" } }, dirs);',
    "// → Error: \"Direct 'read' access to 'docs/specs/auth.md' is blocked. Use spec_get …\"",
    "",
    "// Allowed: lifecycle tool",
    'checkArtifactAccess({ tool: "spec_get", args: { filePath: "docs/specs/auth.md" } }, dirs);',
    "// → null",
    "```",
    "```",
  ].join("\n");
}
