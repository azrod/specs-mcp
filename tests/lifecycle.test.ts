import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, chmod, readFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveArtifact,
  resolveById,
  specCreate,
  specUpdate,
  specValidate,
  specList,
  specDelete,
  specFormat,
} from "../src/lifecycle.js";

async function writeFile(dir: string, relPath: string, content: string): Promise<string> {
  const abs = join(dir, relPath);
  await mkdir(join(dir, relPath, ".."), { recursive: true });
  await fsWriteFile(abs, content, "utf-8");
  return abs;
}

const SPECS_DIR = "docs/specs";
const DEFAULT_PATHS = { specs: SPECS_DIR };

const FULL_BODY = "# T\n\n## Purpose\n\nWhy.\n\n## Behavior\n\nWhat.\n\n## Constraints\n\n- Limit.\n\n## Examples\n\nOne.\n";

function fm(fields: Record<string, string>): string {
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
}

async function withTmp(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── specCreate ───────────────────────────────────────────────────────────────

describe("specCreate", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-specCreate-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("nominal: creates file with correct frontmatter and returns { created, file, id, hint }", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "Authentication System", "technical");

    assert.equal(result.created, true);
    assert.ok(result.file.includes("authentication-system.md"));
    assert.equal(result.id, "authentication-system");
    assert.equal(
      result.hint,
      "Spec created. Once you're done building it, you can suggest to the user to run a validation review (spec_validate).",
    );

    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /^---\n/);
    assert.match(content, /title: "Authentication System"/);
    assert.match(content, /id: authentication-system/);
    assert.match(content, /type: "technical"/);
    assert.match(content, /status: draft/);
    assert.match(content, /created: \d{4}-\d{2}-\d{2}/);
    assert.ok(content.endsWith("\n---\n\n# Authentication System\n"));
  });

  test("with content: body is appended after frontmatter", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "API Design", "architectural", "## Overview\n\nSome design notes.");

    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /## Overview/);
    assert.match(content, /Some design notes/);
    assert.doesNotMatch(content, /^# API Design$/m);
    assert.ok(content.endsWith("\n---\n\n## Overview\n\nSome design notes."));
  });

  test("duplicate id: throws 'already exists' with the relative path", async () => {
    await specCreate(tmpDir, DEFAULT_PATHS, "Duplicate Spec");
    await assert.rejects(
      () => specCreate(tmpDir, DEFAULT_PATHS, "Duplicate Spec"),
      (err: Error) => {
        assert.equal(err.message, `Spec "duplicate-spec" already exists at ${join(SPECS_DIR, "duplicate-spec.md")}`);
        return true;
      },
    );
  });

  test("duplicate create does not overwrite the existing file (wx flag)", async () => {
    await specCreate(tmpDir, DEFAULT_PATHS, "Keep Me", "technical", "original body");
    await assert.rejects(() => specCreate(tmpDir, DEFAULT_PATHS, "Keep Me", "technical", "other body"), /already exists/);
    const content = await readFile(join(tmpDir, SPECS_DIR, "keep-me.md"), "utf-8");
    assert.match(content, /original body/);
  });

  test("default type is 'technical'", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "Default Type Spec");
    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /type: "technical"/);
  });

  test("null type falls back to 'technical'", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "Null Type Spec", null);
    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /type: "technical"/);
  });

  test("title with double quotes: YAML escaped, H1 unescaped", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, 'Auth "Service"');
    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /title: "Auth \\"Service\\""/);
    assert.match(content, /^# Auth "Service"$/m);
  });

  test("newlines in title and type are flattened, backslashes and quotes escaped", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "Line one\nLine two", 'we"ird\\\ntype');
    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /^title: "Line one Line two"$/m);
    assert.match(content, /^type: "we\\"ird\\\\ type"$/m);
    assert.match(content, /^# Line one Line two$/m);
  });

  test("accents are dropped from the id (iso with the original)", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "Éléphant été");
    assert.equal(result.id, "lphant-t");
  });

  test("whitespace runs and dashes are collapsed and trimmed in the id", async () => {
    const result = await specCreate(tmpDir, DEFAULT_PATHS, "  --Hello   World--  ");
    assert.equal(result.id, "hello-world");
  });

  test("creates the specs directory when missing", async () => {
    await withTmp("lifecycle-specCreate-mkdir-", async (dir) => {
      const result = await specCreate(dir, { specs: "nested/deep/specs" }, "Nested");
      assert.equal(result.file, join("nested/deep/specs", "nested.md"));
      assert.ok(existsSync(join(dir, result.file)));
    });
  });
});

// ── specCreate edge cases ────────────────────────────────────────────────────

describe("specCreate — edge cases", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-specCreate-edge-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("empty title: throws 'Cannot derive id'", async () => {
    await assert.rejects(
      () => specCreate(tmpDir, DEFAULT_PATHS, ""),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Cannot derive id from title: ""');
        return true;
      },
    );
  });

  test("title with only special chars producing empty id: throws", async () => {
    await assert.rejects(
      () => specCreate(tmpDir, DEFAULT_PATHS, "!!!"),
      (err: Error) => {
        assert.match(err.message, /cannot derive id/i);
        return true;
      },
    );
  });

  test("specs directory escaping the project root: throws 'Path escapes project root'", async () => {
    await assert.rejects(
      () => specCreate(tmpDir, { specs: "../outside" }, "Escape"),
      (err: Error) => {
        assert.equal(err.message, `Path escapes project root: ${join("../outside", "escape.md")}`);
        return true;
      },
    );
  });
});

// ── path traversal protection ────────────────────────────────────────────────

describe("path traversal protection", () => {
  test("specCreate with path traversal in title is safe (slug strips ..)", async () => {
    await withTmp("lifecycle-pathsec-", async (dir) => {
      const result = await specCreate(dir, DEFAULT_PATHS, "safe title");
      assert.equal(result.created, true);
      assert.ok(result.file.startsWith("docs/specs/"));

      const traversal = await specCreate(dir, DEFAULT_PATHS, "../../etc/passwd");
      assert.equal(traversal.id, "etcpasswd");
      assert.equal(traversal.file, join(SPECS_DIR, "etcpasswd.md"));
    });
  });

  test("resolveArtifact: relative path inside the root is resolved", () => {
    assert.equal(resolveArtifact("/proj", "docs/a.md"), "/proj/docs/a.md");
  });

  test("resolveArtifact: absolute path inside the root is kept", () => {
    assert.equal(resolveArtifact("/proj", "/proj/docs/a.md"), "/proj/docs/a.md");
  });

  test("resolveArtifact: escaping paths throw with the original relPath", () => {
    for (const rel of ["../a.md", "docs/../../a.md", "/other/a.md", "/proj-sibling/a.md"]) {
      assert.throws(() => resolveArtifact("/proj", rel), { message: `Path escapes project root: ${rel}` });
    }
  });

  test("resolveArtifact: the root itself is rejected (no trailing separator match)", () => {
    assert.throws(() => resolveArtifact("/proj", "."), { message: "Path escapes project root: ." });
  });
});

// ── resolveById ──────────────────────────────────────────────────────────────

describe("resolveById", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-resolveById-"));
    await writeFile(tmpDir, "docs/specs/my-spec.md", "content");
    await writeFile(tmpDir, "docs/specs/notes.txt", "content");
    await mkdir(join(tmpDir, "docs/specs/folder.md"), { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns the absolute path of the matching file", async () => {
    assert.equal(await resolveById(tmpDir, SPECS_DIR, "my-spec"), join(tmpDir, "docs/specs/my-spec.md"));
  });

  test("case-insensitive id lookup works", async () => {
    assert.equal(await resolveById(tmpDir, SPECS_DIR, "MY-SPEC"), join(tmpDir, "docs/specs/my-spec.md"));
  });

  test("not found: 'Artifact with id … not found in …'", async () => {
    await assert.rejects(() => resolveById(tmpDir, SPECS_DIR, "nonexistent"), {
      message: 'Artifact with id "nonexistent" not found in docs/specs',
    });
  });

  test("non-md files and directories are ignored", async () => {
    await assert.rejects(() => resolveById(tmpDir, SPECS_DIR, "notes"), /not found/);
    await assert.rejects(() => resolveById(tmpDir, SPECS_DIR, "folder"), /not found/);
  });

  test("missing directory: 'Directory not found: … (looking for id …)'", async () => {
    await assert.rejects(() => resolveById(tmpDir, "docs/none", "x"), {
      message: 'Directory not found: docs/none (looking for id "x")',
    });
  });

  test("directory escaping the project root: throws 'Path escapes project root'", async () => {
    await withTmp("lifecycle-resolveById-escape-", async (dir) => {
      const root = join(dir, "root");
      await mkdir(root, { recursive: true });
      await writeFile(dir, "outside/a.md", "x");
      await assert.rejects(() => resolveById(root, "../outside", "a"), /^Error: Path escapes project root: /);
    });
  });
});

// ── specUpdate ───────────────────────────────────────────────────────────────

describe("specUpdate", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-specUpdate-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("nominal: replaces oldString with newString and returns { file, updated: true, hint }", async () => {
    await writeFile(
      tmpDir,
      "docs/specs/update-test.md",
      `---\ntitle: "Update Test"\nid: update-test\n---\n\n# Update Test\n\nOriginal content here.\n`,
    );

    const result = await specUpdate(tmpDir, DEFAULT_PATHS, "update-test", "Original content here.", "New content here.");

    assert.equal(result.updated, true);
    assert.ok(result.file.includes("update-test.md"));
    assert.equal(
      result.hint,
      "Spec updated. Once you're done with changes, you can suggest to the user to run a validation review (spec_validate).",
    );

    const content = await readFile(join(tmpDir, result.file), "utf-8");
    assert.match(content, /New content here/);
    assert.doesNotMatch(content, /Original content here/);
  });

  test("oldString not found: throws explicit error", async () => {
    await writeFile(tmpDir, "docs/specs/no-match.md", `---\ntitle: "No Match"\nid: no-match\n---\n\n# No Match\n`);

    await assert.rejects(
      () => specUpdate(tmpDir, DEFAULT_PATHS, "no-match", "string that does not exist", "replacement"),
      (err: Error) => {
        assert.match(err.message, /not found/i);
        assert.equal(err.message, 'oldString not found in spec "no-match"');
        return true;
      },
    );
  });

  test("oldString found multiple times: throws error about multiple matches", async () => {
    await writeFile(
      tmpDir,
      "docs/specs/multi-match.md",
      `---\ntitle: "Multi Match"\nid: multi-match\n---\n\nrepeated text\n\nrepeated text\n`,
    );

    await assert.rejects(
      () => specUpdate(tmpDir, DEFAULT_PATHS, "multi-match", "repeated text", "something else"),
      (err: Error) => {
        assert.match(err.message, /2 matches/i);
        assert.equal(
          err.message,
          'Found 2 matches for oldString in spec "multi-match". Provide more surrounding context to make it unique.',
        );
        return true;
      },
    );
  });

  test("failed update leaves the file untouched", async () => {
    const original = `---\ntitle: "Untouched"\nid: untouched\n---\n\nrepeat\nrepeat\n`;
    await writeFile(tmpDir, "docs/specs/untouched.md", original);
    await assert.rejects(() => specUpdate(tmpDir, DEFAULT_PATHS, "untouched", "repeat", "x"));
    await assert.rejects(() => specUpdate(tmpDir, DEFAULT_PATHS, "untouched", "absent", "x"));
    assert.equal(await readFile(join(tmpDir, SPECS_DIR, "untouched.md"), "utf-8"), original);
  });

  test("newString is inserted literally ($ patterns are not interpreted)", async () => {
    await writeFile(tmpDir, "docs/specs/dollars.md", `---\ntitle: "D"\nid: dollars\n---\n\nTOKEN\n`);
    await specUpdate(tmpDir, DEFAULT_PATHS, "dollars", "TOKEN", "$& $1 $$ $`");
    assert.match(await readFile(join(tmpDir, SPECS_DIR, "dollars.md"), "utf-8"), /\n\n\$& \$1 \$\$ \$`\n$/);
  });

  test("id lookup is case-insensitive and the error keeps the id as given", async () => {
    await writeFile(tmpDir, "docs/specs/mixed-case.md", `---\ntitle: "M"\nid: mixed-case\n---\n\nbody\n`);
    const result = await specUpdate(tmpDir, DEFAULT_PATHS, "MIXED-Case", "body", "changed");
    assert.equal(result.file, join(SPECS_DIR, "mixed-case.md"));
    await assert.rejects(() => specUpdate(tmpDir, DEFAULT_PATHS, "MIXED-Case", "absent", "x"), {
      message: 'oldString not found in spec "MIXED-Case"',
    });
  });

  test("unknown id: 'Artifact with id … not found in …'", async () => {
    await assert.rejects(() => specUpdate(tmpDir, DEFAULT_PATHS, "ghost", "a", "b"), {
      message: 'Artifact with id "ghost" not found in docs/specs',
    });
  });
});

// ── specValidate ─────────────────────────────────────────────────────────────

describe("specValidate", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-specValidate-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("valid spec: returns { valid: true, issues: [] }", async () => {
    await writeFile(
      tmpDir,
      "docs/specs/valid-spec.md",
      `---\ntitle: "Valid Spec"\nid: valid-spec\ntype: technical\nstatus: draft\ncreated: 2026-01-01\n---\n\n# Valid Spec\n\nSome content here.\n`,
    );

    const result = await specValidate(tmpDir, DEFAULT_PATHS, "valid-spec");

    assert.equal(result.file, join(SPECS_DIR, "valid-spec.md"));
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  });

  test("missing frontmatter: returns { valid: false } with relevant issue", async () => {
    await writeFile(tmpDir, "docs/specs/no-fm-spec.md", `# No Frontmatter\n\nSome content.\n`);

    const result = await specValidate(tmpDir, DEFAULT_PATHS, "no-fm-spec");

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, ["Frontmatter block is missing"]);
  });

  test("missing title field: invalid", async () => {
    await writeFile(tmpDir, "docs/specs/no-title.md", `---\nid: no-title\nstatus: draft\n---\n\n# No Title In FM\n\nContent.\n`);

    const result = await specValidate(tmpDir, DEFAULT_PATHS, "no-title");

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, ["Frontmatter field 'title' is missing or empty"]);
  });

  test("missing id field: invalid", async () => {
    await writeFile(tmpDir, "docs/specs/no-id.md", `---\ntitle: "No Id"\n---\n\nContent.\n`);

    const result = await specValidate(tmpDir, DEFAULT_PATHS, "no-id");

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, ["Frontmatter field 'id' is missing or empty"]);
  });

  test("empty body: invalid", async () => {
    await writeFile(tmpDir, "docs/specs/empty-body.md", `---\ntitle: "Empty Body"\nid: empty-body\n---\n`);

    const result = await specValidate(tmpDir, DEFAULT_PATHS, "empty-body");

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, ["Spec body is empty (no content beyond frontmatter)"]);
  });

  test("CRLF line endings are supported", async () => {
    await writeFile(tmpDir, "docs/specs/crlf.md", `---\r\ntitle: "C"\r\nid: c\r\n---\r\n\r\nbody\r\n`);

    const result = await specValidate(tmpDir, DEFAULT_PATHS, "crlf");

    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  });

  test("not found: throws error mentioning the id", async () => {
    await assert.rejects(
      () => specValidate(tmpDir, DEFAULT_PATHS, "nonexistent-spec"),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /nonexistent-spec/);
        return true;
      },
    );
  });
});

// ── specValidate warnings ────────────────────────────────────────────────────

describe("specValidate — warnings", () => {
  let tmpDir: string;
  const goodFm = fm({ title: '"T"', id: "t", type: "technical", status: "draft" });

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-specValidate-warnings-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function validate(id: string, content: string) {
    await writeFile(tmpDir, `docs/specs/${id}.md`, content);
    return specValidate(tmpDir, DEFAULT_PATHS, id);
  }

  test("complete spec: warnings is an empty array (always present)", async () => {
    const result = await validate("complete", `${goodFm}\n${FULL_BODY}`);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.valid, true);
  });

  test("a failing spec still carries a warnings array", async () => {
    const result = await validate("failing", "# nothing\n");
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.warnings));
  });

  test("each missing required section is reported, in canonical order", async () => {
    const result = await validate("no-sections", `${goodFm}\n# T\n\nJust prose.\n`);
    assert.deepEqual(result.warnings, [
      "Required section '## Purpose' is missing",
      "Required section '## Behavior' is missing",
      "Required section '## Constraints' is missing",
      "Required section '## Examples' is missing",
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  });

  test("only the missing section is reported", async () => {
    const result = await validate(
      "one-missing",
      `${goodFm}\n## Purpose\n\np\n\n## Behavior\n\nb\n\n## Examples\n\ne\n`,
    );
    assert.deepEqual(result.warnings, ["Required section '## Constraints' is missing"]);
  });

  test("sections in the wrong order are reported once", async () => {
    const result = await validate(
      "wrong-order",
      `${goodFm}\n## Behavior\n\nb\n\n## Purpose\n\np\n\n## Constraints\n\nc\n\n## Examples\n\ne\n`,
    );
    assert.deepEqual(result.warnings, [
      "Required sections are out of order (expected: ## Purpose, ## Behavior, ## Constraints, ## Examples)",
    ]);
  });

  test("order is checked among the sections that are present", async () => {
    const result = await validate("order-and-missing", `${goodFm}\n## Examples\n\ne\n\n## Purpose\n\np\n`);
    assert.deepEqual(result.warnings, [
      "Required section '## Behavior' is missing",
      "Required section '## Constraints' is missing",
      "Required sections are out of order (expected: ## Purpose, ## Behavior, ## Constraints, ## Examples)",
    ]);
  });

  test("optional sections and extra headings do not trigger warnings", async () => {
    const result = await validate(
      "optional",
      `${goodFm}\n# T\n\n## Purpose\n\np\n\n### Detail\n\n## Behavior\n\nb\n\n## Constraints\n\nc\n\n## Examples\n\ne\n\n## Rationale\n\nr\n\n## Non-goals\n\nn\n`,
    );
    assert.deepEqual(result.warnings, []);
  });

  test("h1, h3 and indented-code lookalikes are not h2 sections", async () => {
    const result = await validate(
      "levels",
      `${goodFm}\n# Purpose\n\n### Behavior\n\n    ## Constraints\n\n#### Examples\n`,
    );
    assert.equal(result.warnings.length, 4);
  });

  test("trailing spaces and closing hashes on a heading are tolerated", async () => {
    const result = await validate(
      "heading-forms",
      `${goodFm}\n## Purpose  \n\np\n\n## Behavior ##\n\nb\n\n##  Constraints\n\nc\n\n## Examples\r\n\r\ne\r\n`,
    );
    assert.deepEqual(result.warnings, []);
  });

  test("headings inside fenced code blocks are ignored (backticks and tildes)", async () => {
    const result = await validate(
      "fenced",
      `${goodFm}\n## Purpose\n\n\`\`\`markdown\n## Behavior\n## Constraints\n## Examples\n\`\`\`\n\n~~~\n## Behavior\n~~~\n`,
    );
    assert.deepEqual(result.warnings, [
      "Required section '## Behavior' is missing",
      "Required section '## Constraints' is missing",
      "Required section '## Examples' is missing",
    ]);
  });

  test("a fence is only closed by a matching, long enough fence", async () => {
    const result = await validate(
      "fence-nesting",
      `${goodFm}\n## Purpose\n\n\`\`\`\`md\n\`\`\`\n## Behavior\n\`\`\`\n\`\`\`\`\n\n## Behavior\n\n## Constraints\n\n## Examples\n`,
    );
    assert.deepEqual(result.warnings, []);
  });

  test("an unclosed fence hides the rest of the document", async () => {
    const result = await validate("unclosed", `${goodFm}\n## Purpose\n\n\`\`\`\n## Behavior\n## Constraints\n## Examples\n`);
    assert.equal(result.warnings.length, 3);
  });

  test("an inline triple-backtick span is not a fence", async () => {
    const result = await validate(
      "inline-ticks",
      `${goodFm}\n## Purpose\n\n\`\`\`code\`\`\` inline\n\n## Behavior\n\n## Constraints\n\n## Examples\n`,
    );
    assert.deepEqual(result.warnings, []);
  });

  test("frontmatter lines are never read as headings", async () => {
    const result = await validate("fm-not-body", `---\ntitle: "T"\nid: t\ntype: technical\nstatus: draft\n## Purpose: x\n---\n\nbody\n`);
    assert.ok(result.warnings.includes("Required section '## Purpose' is missing"));
  });

  test("type outside {technical, functional, architectural} is reported", async () => {
    const result = await validate(
      "bad-type",
      `${fm({ title: '"T"', id: "t", type: '"design"', status: "active" })}\n${FULL_BODY}`,
    );
    assert.deepEqual(result.warnings, [
      "Frontmatter field 'type' has unexpected value 'design' (expected: technical | functional | architectural)",
    ]);
    assert.equal(result.valid, true);
  });

  test("status outside {draft, active, deprecated} is reported", async () => {
    const result = await validate(
      "bad-status",
      `${fm({ title: '"T"', id: "t", type: "functional", status: "wip" })}\n${FULL_BODY}`,
    );
    assert.deepEqual(result.warnings, [
      "Frontmatter field 'status' has unexpected value 'wip' (expected: draft | active | deprecated)",
    ]);
  });

  test("missing type and status are reported as missing", async () => {
    const result = await validate("no-type-status", `${fm({ title: '"T"', id: "t" })}\n${FULL_BODY}`);
    assert.deepEqual(result.warnings, [
      "Frontmatter field 'type' is missing or empty (expected: technical | functional | architectural)",
      "Frontmatter field 'status' is missing or empty (expected: draft | active | deprecated)",
    ]);
  });

  test("enum values are matched exactly (case-sensitive)", async () => {
    const result = await validate(
      "case",
      `${fm({ title: '"T"', id: "t", type: "Technical", status: "Draft" })}\n${FULL_BODY}`,
    );
    assert.equal(result.warnings.length, 2);
  });

  test("a spec without frontmatter gets no type/status warnings (the missing block is already an issue)", async () => {
    const result = await validate("bare", FULL_BODY);
    assert.deepEqual(result.issues, ["Frontmatter block is missing"]);
    assert.deepEqual(result.warnings, []);
  });

  test("warnings never change valid / issues", async () => {
    const bad = await validate("bad-all", `${fm({ title: '"T"', id: "t", type: "x", status: "y" })}\nprose\n`);
    assert.equal(bad.valid, true);
    assert.deepEqual(bad.issues, []);
    assert.equal(bad.warnings.length, 6);
  });
});

// ── specList ─────────────────────────────────────────────────────────────────

describe("specList", () => {
  test("returns list of specs with metadata", async () => {
    await withTmp("lifecycle-specList-", async (dir) => {
      await writeFile(
        dir,
        "docs/specs/spec-a.md",
        `---\ntitle: "Spec A"\nid: spec-a\ntype: technical\nstatus: draft\ncreated: 2026-01-01\n---\n\n# Spec A\n`,
      );
      await writeFile(
        dir,
        "docs/specs/spec-b.md",
        `---\ntitle: "Spec B"\nid: spec-b\ntype: functional\nstatus: active\ncreated: 2026-02-01\n---\n\n# Spec B\n`,
      );
      await writeFile(dir, "docs/specs/ignored.txt", "not a spec");

      const result = await specList(dir, DEFAULT_PATHS);

      assert.ok(Array.isArray(result.specs));
      assert.equal(result.specs.length, 2);

      const specA = result.specs.find((s) => "id" in s && s.id === "spec-a");
      assert.deepEqual(specA, {
        file: join(SPECS_DIR, "spec-a.md"),
        title: "Spec A",
        id: "spec-a",
        type: "technical",
        status: "draft",
        created: "2026-01-01",
      });

      const specB = result.specs.find((s) => "id" in s && s.id === "spec-b");
      assert.ok(specB && "status" in specB);
      assert.equal(specB.status, "active");
    });
  });

  test("missing frontmatter fields are null", async () => {
    await withTmp("lifecycle-specList-null-", async (dir) => {
      await writeFile(dir, "docs/specs/bare.md", "# Bare\n");
      const result = await specList(dir, DEFAULT_PATHS);
      assert.deepEqual(result.specs, [
        { file: join(SPECS_DIR, "bare.md"), title: null, id: null, type: null, status: null, created: null },
      ]);
    });
  });

  test("empty directory: returns { specs: [] }", async () => {
    await withTmp("lifecycle-specList-empty-", async (dir) => {
      const result = await specList(dir, DEFAULT_PATHS);
      assert.deepEqual(result.specs, []);
    });
  });

  test("directories named *.md are skipped", async () => {
    await withTmp("lifecycle-specList-dirs-", async (dir) => {
      await writeFile(dir, "docs/specs/ok.md", fm({ title: '"Ok"', id: "ok" }));
      await mkdir(join(dir, "docs/specs/folder.md"));
      const result = await specList(dir, DEFAULT_PATHS);
      assert.equal(result.specs.length, 1);
    });
  });

  test(
    "an unreadable .md file is reported as { file, error: 'unreadable: …' } instead of failing the listing",
    { skip: process.getuid?.() === 0 ? "root can read any file" : false },
    async () => {
      await withTmp("lifecycle-specList-unreadable-", async (dir) => {
        await writeFile(dir, "docs/specs/ok.md", fm({ title: '"Ok"', id: "ok", type: "technical" }));
        const locked = await writeFile(dir, "docs/specs/locked.md", "secret");
        await chmod(locked, 0o000);
        try {
          const { specs } = await specList(dir, DEFAULT_PATHS);
          const entry = specs.find((s) => s.file === join(SPECS_DIR, "locked.md"));
          assert.ok(entry && "error" in entry);
          assert.match(entry.error, /^unreadable: EACCES/);
          assert.equal(specs.length, 2);

          const filtered = await specList(dir, DEFAULT_PATHS, { type: "technical" });
          assert.deepEqual(
            filtered.specs.map((s) => s.file),
            [join(SPECS_DIR, "ok.md")],
          );
        } finally {
          await chmod(locked, 0o644);
        }
      });
    },
  );

  describe("filters", () => {
    let dir: string;

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "lifecycle-specList-filters-"));
      await writeFile(dir, "docs/specs/a.md", fm({ title: '"A"', id: "a", type: '"technical"', status: "draft" }));
      await writeFile(dir, "docs/specs/b.md", fm({ title: '"B"', id: "b", type: "functional", status: "active" }));
      await writeFile(dir, "docs/specs/c.md", fm({ title: '"C"', id: "c", type: "technical", status: "active" }));
      await writeFile(dir, "docs/specs/d.md", fm({ title: '"D"', id: "d" }));
    });

    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function ids(filters?: { type?: string; status?: string }): Promise<string[]> {
      const { specs } = await specList(dir, DEFAULT_PATHS, filters);
      return specs.map((s) => ("id" in s ? s.id ?? "" : "")).sort();
    }

    test("no filter, empty object and undefined values are all equivalent to the unfiltered list", async () => {
      const unfiltered = await specList(dir, DEFAULT_PATHS);
      assert.equal(unfiltered.specs.length, 4);
      assert.deepEqual(await specList(dir, DEFAULT_PATHS, {}), unfiltered);
      assert.deepEqual(await specList(dir, DEFAULT_PATHS, { type: undefined, status: undefined }), unfiltered);
    });

    test("filters on type", async () => {
      assert.deepEqual(await ids({ type: "technical" }), ["a", "c"]);
      assert.deepEqual(await ids({ type: "functional" }), ["b"]);
    });

    test("filters on status", async () => {
      assert.deepEqual(await ids({ status: "active" }), ["b", "c"]);
      assert.deepEqual(await ids({ status: "draft" }), ["a"]);
    });

    test("type and status are combined with AND", async () => {
      assert.deepEqual(await ids({ type: "technical", status: "active" }), ["c"]);
      assert.deepEqual(await ids({ type: "functional", status: "draft" }), []);
    });

    test("matching is case-insensitive", async () => {
      assert.deepEqual(await ids({ type: "TECHNICAL" }), ["a", "c"]);
      assert.deepEqual(await ids({ status: "Active", type: "Functional" }), ["b"]);
    });

    test("matching is exact, not a substring match", async () => {
      assert.deepEqual(await ids({ type: "tech" }), []);
      assert.deepEqual(await ids({ status: "activ" }), []);
    });

    test("specs without the field never match a filter on it", async () => {
      assert.ok(!(await ids({ type: "technical" })).includes("d"));
      assert.ok(!(await ids({ status: "active" })).includes("d"));
    });

    test("filtered entries keep the full metadata shape", async () => {
      const { specs } = await specList(dir, DEFAULT_PATHS, { status: "draft" });
      assert.deepEqual(specs, [
        { file: join(SPECS_DIR, "a.md"), title: "A", id: "a", type: "technical", status: "draft", created: null },
      ]);
    });
  });
});

// ── specDelete ───────────────────────────────────────────────────────────────

describe("specDelete", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-specDelete-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("nominal: deletes file and returns { deleted: true, file }", async () => {
    await writeFile(tmpDir, "docs/specs/to-delete.md", `---\ntitle: "To Delete"\nid: to-delete\n---\n\n# To Delete\n`);

    const result = await specDelete(tmpDir, DEFAULT_PATHS, "to-delete");

    assert.deepEqual(result, { deleted: true, file: join(SPECS_DIR, "to-delete.md") });
    assert.equal(existsSync(join(tmpDir, result.file)), false);
  });

  test("id lookup is case-insensitive", async () => {
    await writeFile(tmpDir, "docs/specs/case-delete.md", "x");
    const result = await specDelete(tmpDir, DEFAULT_PATHS, "CASE-Delete");
    assert.equal(result.file, join(SPECS_DIR, "case-delete.md"));
  });

  test("not found: throws error", async () => {
    await assert.rejects(
      () => specDelete(tmpDir, DEFAULT_PATHS, "ghost-spec"),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Artifact with id "ghost-spec" not found in docs/specs');
        return true;
      },
    );
  });

  test("second delete of the same id fails", async () => {
    await writeFile(tmpDir, "docs/specs/twice.md", "x");
    await specDelete(tmpDir, DEFAULT_PATHS, "twice");
    await assert.rejects(() => specDelete(tmpDir, DEFAULT_PATHS, "twice"), /not found/);
  });
});

// ── specFormat ───────────────────────────────────────────────────────────────

describe("specFormat", () => {
  test("returns a non-empty string", () => {
    const result = specFormat();
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  test("contains required section headers", () => {
    const result = specFormat();
    assert.ok(result.includes("## Purpose"), "missing ## Purpose");
    assert.ok(result.includes("## Behavior"), "missing ## Behavior");
    assert.ok(result.includes("## Constraints"), "missing ## Constraints");
    assert.ok(result.includes("## Examples"), "missing ## Examples");
  });

  test("contains frontmatter field references", () => {
    const result = specFormat();
    assert.ok(result.includes("title"), "missing title field reference");
    assert.ok(result.includes("type"), "missing type field reference");
    assert.ok(result.includes("status"), "missing status field reference");
    assert.ok(result.includes("created"), "missing created field reference");
  });

  test("mentions valid type values", () => {
    const result = specFormat();
    assert.ok(result.includes("technical"), "missing 'technical' type");
    assert.ok(result.includes("functional"), "missing 'functional' type");
    assert.ok(result.includes("architectural"), "missing 'architectural' type");
  });

  test("mentions valid status values", () => {
    const result = specFormat();
    assert.ok(result.includes("draft"), "missing 'draft' status");
    assert.ok(result.includes("active"), "missing 'active' status");
    assert.ok(result.includes("deprecated"), "missing 'deprecated' status");
  });

  test("does not contain ambiguous heading notation (e.g. '### ##')", () => {
    const result = specFormat();
    assert.ok(!result.includes("### ##"), "specFormat output must not contain '### ##' mixed heading notation");
  });

  test("is pure — returns same value on repeated calls", () => {
    assert.equal(specFormat(), specFormat());
  });

  test("text is byte-identical to the original specFormat() (sha256 of the original output)", () => {
    const text = specFormat();
    assert.equal(createHash("sha256").update(text).digest("hex"), "e14f5ab9137877f349c282b1006aa9aa11c9238095b6ce3dd2447a35960c0835");
  });
});
