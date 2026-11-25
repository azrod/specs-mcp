import { describe, it, test, beforeEach, afterEach } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  buildSpecDocument,
  loadSpecCorpus,
  specSearch,
  specReadSection,
  serializeRetrievalError,
  serializeRetrievalResult,
} from "../src/retrieval.js";
import type {
  ReadSectionInput,
  RetrievalDirent,
  RetrievalIo,
  RetrievalOptions,
  SearchInput,
  SectionPage,
} from "../src/retrieval.js";
import { MAX_CURSOR_BYTES, PAGE_BYTES } from "../src/limits.js";

const hash = (content: string): string => createHash("sha256").update(content).digest("hex");
const paths = { specs: "specs" };
const errorCode = (code: string) => (error: unknown): true => {
  const result = JSON.parse(serializeRetrievalError(error));
  assert.equal(result.code, code);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= PAGE_BYTES);
  return true;
};
const bounded = (value: unknown): void => {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= PAGE_BYTES);
  assert.deepEqual(JSON.parse(serializeRetrievalResult(value)), value);
};
const entry = (name: string): RetrievalDirent => ({ name, isFile: () => true });
const nextCursor = (page: SectionPage): string => {
  assert.ok(page.pagination.next_cursor);
  return page.pagination.next_cursor;
};

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "spec-retrieval-")); await fs.mkdir(join(root, "specs")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const write = (name: string, content: string): Promise<void> => fs.writeFile(join(root, "specs", name + ".md"), content);
const search = (query: unknown, rest: Record<string, unknown> = {}, options?: RetrievalOptions) =>
  specSearch(root, paths, { query, ...rest } as unknown as SearchInput, options);
const read = (id: string, content: string, section_id = "preamble", rest: Record<string, unknown> = {}, options?: RetrievalOptions) =>
  specReadSection(root, paths, { id, source_hash: hash(content), section_id, ...rest } as unknown as ReadSectionInput, options);

describe("exact-source corpus and sections", () => {
  it("includes only immediate regular Markdown files, preserves legacy/missing metadata and filename IDs", async () => {
    await write("Actual", '---\ntitle: "A \\"title\\""\nid: wrong\nstatus: implemented\n---\n# Rule\n');
    await write("bare", "unstructured text");
    await fs.writeFile(join(root, "specs", "ignore.txt"), "not a spec");
    await fs.mkdir(join(root, "specs", "nested"));
    await fs.writeFile(join(root, "specs", "nested", "ignore.md"), "nested");
    await fs.symlink(join(root, "specs", "bare.md"), join(root, "specs", "alias.md"));
    const docs = await loadSpecCorpus(root, paths);
    assert.deepEqual(docs.map((doc) => doc.spec_id), ["Actual", "bare"]);
    assert.equal(docs[0].status, "implemented");
    assert.equal(docs[1].title, null);
    assert.equal(docs[0].file, "specs/Actual.md");
  });

  it("uses configured in-project directories and safe symlink aliases", async () => {
    await write("rule", "hello");
    await fs.symlink(join(root, "specs"), join(root, "alias"));
    assert.equal((await loadSpecCorpus(root, { specs: "alias" }))[0].file, "alias/rule.md");
    assert.equal((await loadSpecCorpus(root, { specs: join(root, "specs") }))[0].file, "specs/rule.md");
    assert.deepEqual(await loadSpecCorpus(root, { specs: "missing/deep" }), []);
  });

  it("rejects traversal, external directory aliases and missing paths below those aliases", async () => {
    await fs.symlink(tmpdir(), join(root, "escape"));
    await fs.symlink(join(tmpdir(), "nonexistent-retrieval-target"), join(root, "dangling"));
    for (const specs of ["../escape", "escape", "escape/no-such-child", "dangling/child"]) {
      await assert.rejects(loadSpecCorpus(root, { specs }), errorCode("CORPUS_UNAVAILABLE"));
    }
  });

  it("rejects case-ambiguous inventories deterministically", async () => {
    // macOS commonly has a case-insensitive filesystem; inject enumeration to
    // exercise the ambiguity independently of the platform's filename rules.
    const io: RetrievalIo = { ...fs, readdir: async () => [entry("Rule.md"), entry("rule.md")] };
    await assert.rejects(loadSpecCorpus(root, paths, { io }), errorCode("AMBIGUOUS_ID"));
  });

  it("refuses a directory alias retargeted between canonical validation and opening", async () => {
    await write("r", "internal rule");
    const outside = await fs.mkdtemp(join(tmpdir(), "retrieval-outside-"));
    try {
      await fs.writeFile(join(outside, "r.md"), "external secret");
      await fs.symlink(join(root, "specs"), join(root, "alias"));
      let readContent = false;
      const io: RetrievalIo = { ...fs, open: async (path, flags) => {
        assert.equal(path, await fs.realpath(join(root, "specs/r.md")));
        await fs.unlink(join(root, "alias"));
        await fs.symlink(outside, join(root, "alias"));
        const handle = await fs.open(path, flags);
        return { stat: () => handle.stat(), close: () => handle.close(),
          readFile: (options) => { readContent = true; return handle.readFile(options); } };
      } };
      await assert.rejects(loadSpecCorpus(root, { specs: "alias" }, { io }), errorCode("CORPUS_UNAVAILABLE"));
      assert.equal(readContent, false);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it("does not return partial corpora after enumeration or file-read failures", async () => {
    await write("a", "visible"); await write("b", "unreadable");
    const io: RetrievalIo = { ...fs, open: async (path, flags) => {
      if (path.endsWith("b.md")) throw Object.assign(new Error("private path and contents"), { code: "EACCES" });
      return fs.open(path, flags);
    } };
    await assert.rejects(loadSpecCorpus(root, paths, { io }), errorCode("CORPUS_UNAVAILABLE"));
    const denied: RetrievalIo = { ...fs, readdir: async () => { throw new Error("denied"); } };
    await assert.rejects(loadSpecCorpus(root, paths, { io: denied }), errorCode("CORPUS_UNAVAILABLE"));
    await fs.writeFile(join(root, "not-directory"), "file");
    await assert.rejects(loadSpecCorpus(root, { specs: "not-directory" }), errorCode("CORPUS_UNAVAILABLE"));
  });

  it("hashes the complete decoded text and keeps retrieval cursors distinct from getter cursors", async () => {
    const content = '---\r\ntitle: "😀"\r\n---\r\n# Rule\r\n' + "é".repeat(30_000);
    const doc = buildSpecDocument(content, "specs/rule.md", "rule");
    assert.equal(doc.source_hash, hash(content));
    await write("rule", content);
    const first = await read("rule", content, "line:4");
    const decoded = JSON.parse(Buffer.from(nextCursor(first), "base64url").toString());
    assert.equal(decoded.h, doc.source_hash);
    assert.deepEqual(Object.keys(decoded).sort(), ["a", "h", "p", "s", "t", "v"]);
  });

  it("recognizes ATX ancestry and exact direct/context bounds, including repeated titles and skipped levels", () => {
    const content = "preface\r\n# Root ###\r\nroot\r\n### Repeat\r\na\r\n### Repeat\r\nb\r\n## Next\r\nc\r\n";
    const doc = buildSpecDocument(content, "specs/r.md", "r");
    assert.deepEqual(doc.sections.map((s) => s.section_id), ["preamble", "line:2", "line:4", "line:6", "line:8"]);
    assert.deepEqual(doc.sections[2].section, ["# Root ###", "### Repeat"]);
    const source = (s: { start: number; end: number; directEnd: number }, direct = false): string =>
      content.slice(s.start, direct ? s.directEnd : s.end);
    assert.equal(source(doc.sections[1], true), "# Root ###\r\nroot\r\n");
    assert.equal(source(doc.sections[1]), content.slice(content.indexOf("# Root")));
    assert.equal(source(doc.sections[2]), "### Repeat\r\na\r\n");
    assert.equal(doc.lines.length, 9);
  });

  it("ignores headings in frontmatter and CommonMark-like code fences only", () => {
    const content = ["---", "# not a heading", "title: legacy", "---", "   # Yes", "````js", "## no", "```", "### still no", "````", "  ~~~lang", "# no", "  ~~~~", "## Yes", "    # unsupported indentation", "Setext", "===", "####### no", "#not", "```has`backtick", "### Yes"].join("\n");
    const doc = buildSpecDocument(content, "specs/r.md", "r");
    assert.deepEqual(doc.sections.map((s) => s.section_id), ["preamble", "line:5", "line:14", "line:21"]);
    assert.ok(doc.content.includes("Setext"));
  });

  it("segments direct text losslessly into <=2000 code points without splitting CRLF or surrogate pairs", () => {
    for (const content of ["", "plain", "\n", "# H\n" + "😀é\r\n".repeat(2_000), "a".repeat(1_999) + "\r\n" + "😀".repeat(3_000)]) {
      const doc = buildSpecDocument(content, "specs/r.md", "r");
      assert.equal(doc.passages.map((p) => content.slice(p.start, p.end)).join(""), content);
      for (const p of doc.passages) {
        const text = content.slice(p.start, p.end);
        assert.ok(Array.from(text).length <= 2_000);
        assert.ok(!/[\ud800-\udbff]$/.test(text));
        assert.ok(!(text.endsWith("\r") && content[p.end] === "\n"));
      }
    }
  });
});

describe("cited lexical search", () => {
  it("validates Unicode queries, OR tokens and bounded input; never executes search syntax", async () => {
    await write("rule", "# Café\nÉTÉ １２ hello world\n");
    for (const query of ["ÉTÉ", "absent hello", "(hello|world).*", "hello OR nomatch", "１２"]) {
      const result = await search(query); assert.ok(result.results.length); bounded(result);
    }
    for (const query of ["", " .* + ", "é".repeat(257), Array.from({ length: 33 }, (_, i) => `t${i}`).join(" "), null]) {
      await assert.rejects(search(query), errorCode("INVALID_QUERY"));
    }
    assert.ok((await search("hello ".repeat(32))).results.length);
  });

  it("filters exact metadata case-insensitively and uses actual filename stems", async () => {
    await write("Actual", '---\nid: wrong\ntype: Technical\nstatus: Deprecated\n---\nrule');
    assert.equal((await search("rule", { id: "ACTUAL", type: "technical", status: "deprecated" })).results[0].spec_id, "Actual");
    assert.equal((await search("rule", { type: "missing" })).results.length, 0);
    await assert.rejects(search("rule", { id: "wrong" }), errorCode("SPEC_NOT_FOUND"));
    for (const rest of [{ id: "" }, { type: " " }, { status: null }, { id: "../Actual" }, { id: "/Actual" }, { id: "a\\b" }]) {
      await assert.rejects(search("rule", rest), errorCode("INVALID_ARGUMENT"));
    }
  });

  it("ranks distinct matches first, headings/title above body-only and stable paths/offsets last", async () => {
    await write("a-body", "# Plain\nalpha\n");
    await write("b-heading", "# Alpha\nplain\n");
    await write("c-title", '---\ntitle: Alpha\n---\nplain\n');
    await write("d-both", "# Plain\nalpha beta\n");
    const result = await search("alpha beta");
    assert.deepEqual(result.results.map((r) => r.spec_id), ["d-both", "b-heading", "c-title", "a-body"]);
    await write("z-tie", "# First\nalpha\n# Second\nalpha\n");
    const tie = await search("alpha", { id: "z-tie" });
    assert.deepEqual(tie.results.map((r) => r.section_id), ["line:1", "line:3"]);
  });

  it("deduplicates metadata-only candidates instead of filling the list with unrelated passages", async () => {
    await write("r", '---\ntitle: Needle\n---\n' + Array.from({ length: 20 }, (_, i) => `# Section ${i}\nunrelated\n`).join(""));
    const result = await search("needle");
    // Frontmatter itself is source text and contains a real lexical match;
    // all remaining metadata-only passages contribute at most one candidate.
    assert.equal(result.matched_passages, 2);
  });

  it("returns exact excerpts, ancestry, original inclusive lines and full-line flags", async () => {
    const content = '---\r\ntitle: "Auth"\r\nid: wrong\r\n---\r\n# Auth\r\n## Rules\r\nDeny access by default.\r\n';
    await write("auth", content);
    const hit = (await search("deny")).results[0];
    assert.equal(hit.file, "specs/auth.md"); assert.equal(hit.source_hash, hash(content));
    assert.deepEqual(hit.section, ["# Auth", "## Rules"]);
    assert.equal(hit.section_id, "line:6"); assert.equal(hit.line_start, 6); assert.equal(hit.line_end, 7);
    assert.equal(hit.excerpt, "## Rules\r\nDeny access by default.\r\n");
    assert.equal(hit.partial_start_line, false); assert.equal(hit.partial_end_line, false);
    assert.equal(content.split(/\r?\n/).slice(hit.line_start - 1, hit.line_end).join("\r\n") + "\r\n", hit.excerpt);
  });

  it("handles empty/missing corpora, zero matches and fixed top-five truncation", async () => {
    assert.deepEqual(await search("needle"), { query: "needle", corpus_files: 0, matched_passages: 0, results: [], truncated: false });
    for (let i = 0; i < 7; i++) await write(`r${i}`, "needle");
    const result = await search("needle");
    assert.equal(result.corpus_files, 7); assert.equal(result.matched_passages, 7);
    assert.equal(result.results.length, 5); assert.equal(result.truncated, true);
    assert.equal((await search("absent")).truncated, false);
    assert.equal((await specSearch(root, { specs: "missing" }, { query: "needle" })).corpus_files, 0);
  });

  it("bounds escaped multibyte excerpts, shortens around evidence and retains partial-line locations", async () => {
    const content = ('"\\\u0001😀 '.repeat(400) + "needle ").repeat(5);
    await write("long", content);
    const result = await search("needle"); bounded(result);
    for (const hit of result.results) {
      assert.ok(content.includes(hit.excerpt)); assert.ok(hit.excerpt.toLowerCase().includes("n"));
      assert.equal(hit.line_start, 1); assert.equal(hit.line_end, 1);
      assert.equal(hit.partial_end_line, true);
      assert.ok(!/[\ud800-\udbff]$/.test(hit.excerpt));
    }
  });

  it("marks byte-budget omissions even when fewer than five candidates matched", async () => {
    const content = '---\ntitle: "' + "x".repeat(7_500) + '"\n---\nneedle\n';
    for (const id of ["a", "b", "c"]) await write(id, content);
    const result = await search("needle");
    bounded(result);
    assert.equal(result.matched_passages, 3);
    assert.ok(result.results.length > 0 && result.results.length < 3);
    assert.equal(result.truncated, true);
    for (const hit of result.results) assert.ok(hit.excerpt.includes("needle"));
  });

  it("preserves Unicode token evidence when lowercasing expands a character", async () => {
    const content = '---\ntitle: "' + "x".repeat(15_000) + '"\n---\n' + "prefix ".repeat(100) + "İSTANBUL\n";
    await write("r", content);
    const result = await search("İSTANBUL");
    bounded(result);
    assert.equal(result.results.length, 1);
    assert.ok(result.results[0].excerpt.includes("İSTANBUL"));
  });

  it("fails when the highest-ranked mandatory envelope cannot fit instead of skipping it", async () => {
    await write("a", "# needle " + "x".repeat(PAGE_BYTES) + "\nbody");
    await write("z", "needle");
    await assert.rejects(search("needle"), errorCode("PAGE_BUDGET_EXCEEDED"));
  });

  it("observes create/delete/branch replacement and same-size preserved-timestamp edits every call", async () => {
    await write("r", "oldtoken"); const stat = await fs.stat(join(root, "specs/r.md"));
    assert.equal((await search("oldtoken")).results.length, 1);
    await write("r", "newtoken"); await fs.utimes(join(root, "specs/r.md"), stat.atime, stat.mtime);
    assert.equal((await search("oldtoken")).results.length, 0);
    assert.equal((await search("newtoken")).results[0].source_hash, hash("newtoken"));
    await fs.unlink(join(root, "specs/r.md")); await write("branch", "branchrule");
    assert.equal((await search("newtoken")).results.length, 0);
    assert.equal((await search("branchrule")).results[0].spec_id, "branch");
  });
});

describe("version-checked section reading", () => {
  it("expands a search hit into exactly its subsection tree and not its neighbor", async () => {
    const content = "preamble\n# Root\nintro\n## Rule\nneedle\n### Detail\nchild\n## Neighbor\nother\n";
    await write("r", content);
    const hit = (await search("needle")).results[0];
    const page = await specReadSection(root, paths, { id: hit.spec_id, section_id: hit.section_id, source_hash: hit.source_hash });
    assert.equal(page.content, "## Rule\nneedle\n### Detail\nchild\n");
    assert.equal(page.section_line_start, 4); assert.equal(page.section_line_end, 7);
    assert.deepEqual(page.pagination, { has_more: false, next_cursor: null });
    assert.equal((await read("R", content)).content, "preamble\n");
  });

  it("returns null line bounds only for an empty document's preamble", async () => {
    for (const content of ["", "\n", "no final newline"]) {
      await write("r", content); const page = await read("r", content); bounded(page);
      assert.equal(page.content, content);
      assert.equal(page.section_line_start, content ? 1 : null);
      assert.equal(page.section_line_end, content ? 1 : null);
    }
  });

  it("checks hash before resolving a stale selector, including same-size timestamp-preserved edits", async () => {
    const content = "# Old\nold\n"; await write("r", content);
    const stat = await fs.stat(join(root, "specs/r.md"));
    await write("r", "# New\nnew\n"); await fs.utimes(join(root, "specs/r.md"), stat.atime, stat.mtime);
    await assert.rejects(read("r", content, "line:1"), errorCode("STALE_SOURCE"));
    await assert.rejects(read("r", content, "line:99"), errorCode("STALE_SOURCE"));
    await assert.rejects(read("r", content, "invalid-selector"), errorCode("STALE_SOURCE"));
  });

  it("reconstructs large sections exactly across stateless bounded Unicode/CRLF/control-character pages", async () => {
    for (const body of ["line 😀\r\n".repeat(8_000), "😀\\\"\u0001".repeat(12_000), "x".repeat(35_000)]) {
      const content = "# Other\n" + "padding\n".repeat(2_000) + "# Target\n" + body + "\n# End\nstop";
      await write("r", content);
      const section_id = `line:${2_002}`;
      const expected = "# Target\n" + body + "\n";
      let cursor: string | null | undefined, reconstructed = "", count = 0;
      do {
        const page = await read("r", content, section_id, cursor === undefined ? {} : { cursor });
        bounded(page); reconstructed += page.content; count++;
        assert.equal(page.section_line_start, 2_002);
        if (page.pagination.has_more) { assert.ok(page.content); assert.ok(page.pagination.next_cursor); }
        else assert.equal(page.pagination.next_cursor, null);
        assert.ok(!/[\ud800-\udbff]$/.test(page.content));
        assert.ok(!page.content.endsWith("\r"));
        cursor = page.pagination.next_cursor;
      } while (cursor);
      assert.ok(count > 1); assert.equal(reconstructed, expected);
    }
  });

  it("rejects malformed, oversized, wrong-identity and invalid-position cursors", async () => {
    const content = "# Root\n" + "😀".repeat(30_000) + "\n## Child\ntext";
    await write("r", content); await write("other", content);
    const first = await read("r", content, "line:1");
    const cursor = nextCursor(first);
    const decoded: Record<string, unknown> = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const invalid of ["", "bad!", "a".repeat(MAX_CURSOR_BYTES + 1), encode({ ...decoded, v: 2 }), encode({ ...decoded, t: "spec_get" }),
      encode({ ...decoded, p: -1 }), encode({ ...decoded, p: 0 }), encode({ ...decoded, p: 999_999 }),
      encode({ ...decoded, p: 8 }), encode({ ...decoded, extra: true })]) {
      await assert.rejects(read("r", content, "line:1", { cursor: invalid }), errorCode("INVALID_CURSOR"));
    }
    await assert.rejects(read("other", content, "line:1", { cursor }), errorCode("INVALID_CURSOR"));
    await assert.rejects(read("r", content, `line:3`, { cursor }), errorCode("INVALID_CURSOR"));
    await assert.rejects(read("r", content, "line:1", { cursor, source_hash: "0".repeat(64) }), errorCode("INVALID_CURSOR"));
    // A getter-style cursor ({v,t,a,h,p} without `s`) is not a section cursor.
    const getter = encode({ v: 1, t: "spec_get", a: hash(JSON.stringify([resolve(root), resolve(join(root, "specs/r.md"))])), h: hash(content), p: 100 });
    await assert.rejects(read("r", content, "line:1", { cursor: getter }), errorCode("INVALID_CURSOR"));
  });

  it("rejects valid continuations after edits as STALE_CURSOR, and deletion is not EOF", async () => {
    const content = "# Rule\n" + "old ".repeat(20_000); await write("r", content);
    const first = await read("r", content, "line:1");
    await write("r", "# Rule\nnew");
    await assert.rejects(read("r", content, "line:1", { cursor: nextCursor(first) }), errorCode("STALE_CURSOR"));
    await fs.unlink(join(root, "specs/r.md"));
    await assert.rejects(read("r", content, "line:1", { cursor: nextCursor(first) }), errorCode("SPEC_NOT_FOUND"));
  });

  it("reports missing sections, invalid hashes, ambiguous IDs and unreadable selected files", async () => {
    await write("r", "text");
    await assert.rejects(read("r", "text", "line:9"), errorCode("SECTION_NOT_FOUND"));
    await assert.rejects(read("r", "text", "../r"), errorCode("SECTION_NOT_FOUND"));
    for (const source_hash of ["ABC", "A".repeat(64), "", null]) {
      await assert.rejects(read("r", "text", "preamble", { source_hash }), errorCode("INVALID_ARGUMENT"));
    }
    await assert.rejects(read("../r", "text"), errorCode("INVALID_ARGUMENT"));
    await assert.rejects(read("missing", "text"), errorCode("SPEC_NOT_FOUND"));
    const ambiguous: RetrievalIo = { ...fs, readdir: async () => [entry("r.md"), entry("R.md")] };
    await assert.rejects(read("r", "text", "preamble", {}, { io: ambiguous }), errorCode("AMBIGUOUS_ID"));
    const unreadable: RetrievalIo = { ...fs, open: async () => { throw new Error("private"); } };
    await assert.rejects(read("r", "text", "preamble", {}, { io: unreadable }), errorCode("SOURCE_UNAVAILABLE"));
  });

  it("does not share mutable state or cursors between projects", async () => {
    const content = "# Rule\n" + "text\n".repeat(10_000); await write("r", content);
    const other = await fs.mkdtemp(join(tmpdir(), "spec-retrieval-other-"));
    try {
      await fs.mkdir(join(other, "specs")); await fs.writeFile(join(other, "specs/r.md"), content);
      const page = await read("r", content, "line:1");
      await assert.rejects(specReadSection(other, paths, { id: "r", section_id: "line:1", source_hash: hash(content), cursor: nextCursor(page) }), errorCode("INVALID_CURSOR"));
      const again = await read("r", content, "line:1", { cursor: nextCursor(page) });
      assert.ok(again.content); bounded(again);
    } finally { await fs.rm(other, { recursive: true, force: true }); }
  });

  it("bounds oversized metadata and unexpected diagnostics without content or false EOF", async () => {
    const content = "# " + "x".repeat(PAGE_BYTES) + "\nbody"; await write("r", content);
    await assert.rejects(read("r", content, "line:1"), errorCode("PAGE_BUDGET_EXCEEDED"));
    const error = JSON.parse(serializeRetrievalError(new Error("secret".repeat(30_000))));
    assert.equal(error.code, "SOURCE_UNAVAILABLE"); assert.ok(!("content" in error)); assert.ok(!("pagination" in error));
  });

  it("propagates cancellation without scanning when already aborted", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    let enumerated = false;
    const options: RetrievalOptions = { signal: controller.signal, io: { ...fs, readdir: async () => { enumerated = true; return []; } } };
    await assert.rejects(search("needle", {}, options), /cancelled/);
    await assert.rejects(read("r", "text", "preamble", {}, options), /cancelled/);
    assert.equal(enumerated, false);
  });
});

const defaults = { specs: "docs/specs" };
const custom = { specs: "private/specifications" };
const section = "## Needle\r\nneedle remains private\r\n" + '😀é "\\\u0001\r\n'.repeat(7_000) + "### Child\r\nchild rule\r\n";
const source = '---\r\ntitle: Fixture\r\ntype: Technical\r\nstatus: Deprecated\r\n---\r\n# Root\r\n' + section + "## Neighbor\r\nnot selected\r\n";

interface Fixture { root: string; file: string; paths: { specs: string } }

async function fixture(t: TestContext, specPaths: { specs: string } = defaults, content = source): Promise<Fixture> {
  const dir = await fs.mkdtemp(join(tmpdir(), "retrieval-engine-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = join(dir, specPaths.specs, "actual.md");
  await fs.mkdir(join(dir, specPaths.specs), { recursive: true });
  await fs.writeFile(file, content);
  return { root: dir, file, paths: specPaths };
}

// Mirrors the serialization boundary of the registered tools: every outcome is bounded JSON.
async function call(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let output: string;
  try { output = serializeRetrievalResult(await run()); }
  catch (error) { output = serializeRetrievalError(error); }
  assert.ok(Buffer.byteLength(output) <= PAGE_BYTES);
  return JSON.parse(output);
}
const searchCall = (f: Fixture, input: Record<string, unknown>) =>
  call(() => specSearch(f.root, f.paths, input as unknown as SearchInput));
const readCall = (f: Fixture, input: Record<string, unknown>) =>
  call(() => specReadSection(f.root, f.paths, input as unknown as ReadSectionInput));
const sectionInput = (hit: { spec_id: string; section_id: string; source_hash: string }) =>
  ({ id: hit.spec_id, section_id: hit.section_id, source_hash: hit.source_hash });
type Hit = Parameters<typeof sectionInput>[0] & { file: string; section: string[]; line_start: number; line_end: number; excerpt: string };
type Page = { error?: unknown; source_hash: string; section_line_start: number; section_line_end: number; content: string;
  pagination: { has_more: boolean; next_cursor: string | null } };

for (const specPaths of [defaults, custom]) {
  test(`cited search and lossless section pagination are stateless across calls: ${specPaths.specs}`, async (t) => {
    const f = await fixture(t, specPaths);
    const found = await searchCall(f, { query: "needle", type: "technical", status: "deprecated" });
    assert.equal(found.error, undefined);
    const hit = (found.results as Hit[])[0];
    assert.equal(hit.file, `${specPaths.specs}/actual.md`);
    assert.equal(hit.spec_id, "actual");
    assert.equal(hit.source_hash, hash(source));
    assert.equal(hit.section_id, "line:7");
    assert.deepEqual(hit.section, ["# Root", "## Needle"]);
    assert.equal(hit.line_start, 7);
    assert.equal(source.split(/\r?\n/).slice(hit.line_start - 1, hit.line_end).join("\r\n") + "\r\n", hit.excerpt);
    const input = sectionInput(hit);
    let page = await readCall(f, input) as unknown as Page;
    assert.equal(page.pagination.has_more, true);
    const pages: Page[] = [];
    do {
      assert.equal(page.error, undefined);
      assert.equal(page.source_hash, hit.source_hash);
      assert.equal(page.section_line_start, 7);
      assert.equal(page.section_line_end, 7_010);
      pages.push(page);
      assert.ok(pages.length < 100);
      if (!page.pagination.has_more) { assert.equal(page.pagination.next_cursor, null); break; }
      assert.ok(page.content);
      assert.ok(page.pagination.next_cursor);
      assert.ok(Buffer.byteLength(page.pagination.next_cursor) <= MAX_CURSOR_BYTES);
      page = await readCall(f, { ...input, cursor: page.pagination.next_cursor }) as unknown as Page;
    } while (true);
    assert.equal(pages.map((item) => item.content).join(""), section);
  });
}

test("failures are bounded JSON, never partial content or false EOF", async (t) => {
  const f = await fixture(t);
  const hit = ((await searchCall(f, { query: "needle" })).results as Hit[])[0];
  const input = sectionInput(hit);
  const first = await readCall(f, input) as unknown as Page;
  const cases: [string, Record<string, unknown>, string][] = [
    ["search", { query: "x".repeat(100_000) }, "INVALID_QUERY"],
    ["search", { query: "needle", status: "" }, "INVALID_ARGUMENT"],
    ["search", { query: "needle", id: "missing" }, "SPEC_NOT_FOUND"],
    ["read", { ...input, section_id: "line:999999" }, "SECTION_NOT_FOUND"],
    ["read", { ...input, cursor: "x".repeat(100_000) }, "INVALID_CURSOR"],
    ["read", { ...input, source_hash: "0".repeat(64) }, "STALE_SOURCE"],
  ];
  const check = async (kind: string, args: Record<string, unknown>, code: string): Promise<void> => {
    const result = await (kind === "search" ? searchCall(f, args) : readCall(f, args));
    assert.equal(result.code, code);
    assert.equal(result.content, undefined);
    assert.equal(result.pagination, undefined);
    assert.equal(result.results, undefined);
  };
  for (const args of cases) await check(...args);
  const stat = await fs.stat(f.file);
  await fs.writeFile(f.file, source.replace("private", "changed"));
  await fs.utimes(f.file, stat.atime, stat.mtime);
  await check("read", input, "STALE_SOURCE");
  await check("read", { ...input, cursor: first.pagination.next_cursor }, "STALE_CURSOR");
  assert.notEqual(((await searchCall(f, { query: "needle" })).results as Hit[])[0].source_hash, hit.source_hash);
  const overflow = "# needle " + "x".repeat(PAGE_BYTES) + "\nbody";
  await fs.writeFile(f.file, overflow);
  await check("search", { query: "needle" }, "PAGE_BUDGET_EXCEEDED");
  await check("read", { id: "actual", section_id: "line:1", source_hash: hash(overflow) }, "PAGE_BUDGET_EXCEEDED");
  if (process.getuid?.() !== 0 && process.platform !== "win32") {
    await fs.chmod(f.file, 0);
    try {
      await check("search", { query: "needle" }, "CORPUS_UNAVAILABLE");
      await check("read", input, "SOURCE_UNAVAILABLE");
    } finally { await fs.chmod(f.file, 0o600); }
  } else t.diagnostic("Unreadable-file case unavailable as root/Windows; deterministic engine fault injection covers it.");
  await fs.rm(f.file);
  await fs.rmdir(join(f.root, defaults.specs));
  await fs.writeFile(join(f.root, defaults.specs), "not a directory");
  await check("search", { query: "needle" }, "CORPUS_UNAVAILABLE");
});

test("independent locations cannot mix section cursors", async (t) => {
  const a = await fixture(t), b = await fixture(t);
  const hit = ((await searchCall(a, { query: "needle" })).results as Hit[])[0];
  const input = sectionInput(hit);
  const page = await readCall(a, input) as unknown as Page;
  assert.equal((await readCall(b, { ...input, cursor: page.pagination.next_cursor })).code, "INVALID_CURSOR");
  await fs.writeFile(b.file, "different corpus");
  assert.equal(((await searchCall(b, { query: "needle" })).results as Hit[]).length, 0);
  assert.ok(((await searchCall(a, { query: "needle" })).results as Hit[]).length);
});
