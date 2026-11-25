import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.js";
import { MAX_CURSOR_BYTES as LIMITS_MAX_CURSOR_BYTES, PAGE_BYTES as LIMITS_PAGE_BYTES } from "../src/limits.js";
import {
  MAX_CURSOR_BYTES,
  PAGE_BYTES,
  PaginationError,
  paginateArtifact,
  serializeGetterError,
  serializeGetterPage,
} from "../src/pagination.js";

type Page = ReturnType<typeof paginateArtifact>;
type Options = Parameters<typeof paginateArtifact>[0];

const options = {
  tool: "spec_get", projectRoot: "/project", artifactPath: "/project/docs/specs/test.md",
  metadata: { file: "docs/specs/test.md", frontmatter: {} } as Record<string, unknown>,
};
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string | null): Record<string, unknown> =>
  JSON.parse(Buffer.from(String(value), "base64url").toString()) as Record<string, unknown>;
const size = (page: unknown): number => Buffer.byteLength(JSON.stringify(page), "utf8");

function collect(content: string, overrides: Partial<Options> = {}): Page[] {
  let cursor: string | null | undefined;
  let text = "";
  const pages: Page[] = [];
  do {
    const page = paginateArtifact({ ...options, content, ...overrides, cursor });
    assert.ok(size(page) <= PAGE_BYTES);
    assert.equal(JSON.stringify(page), serializeGetterPage(page));
    if (page.pagination.has_more) {
      assert.ok(page.content.length > 0);
      assert.equal(typeof page.pagination.next_cursor, "string");
      assert.ok(Buffer.byteLength(String(page.pagination.next_cursor)) <= 1024);
      // Every valid surrogate pair must stay within one page.
      assert.ok(!(/[\uD800-\uDBFF]$/.test(page.content) && /^[\uDC00-\uDFFF]/.test(content.slice(text.length + page.content.length))));
    } else assert.equal(page.pagination.next_cursor, null);
    text += page.content;
    pages.push(page);
    cursor = page.pagination.next_cursor;
    assert.ok(pages.length <= content.length + 1, "pagination must terminate");
  } while (cursor !== null);
  assert.equal(text, content);
  return pages;
}

test("limits are the iso values and are re-exported by the pagination module", () => {
  assert.equal(PAGE_BYTES, 16384);
  assert.equal(MAX_CURSOR_BYTES, 1024);
  assert.equal(LIMITS_PAGE_BYTES, PAGE_BYTES);
  assert.equal(LIMITS_MAX_CURSOR_BYTES, MAX_CURSOR_BYTES);
});

test("PaginationError carries the code and the iso message", () => {
  const messages = {
    INVALID_CURSOR: "Invalid pagination cursor. Restart without a cursor.",
    STALE_CURSOR: "Artifact changed during pagination. Discard previous pages and restart without a cursor.",
    PAGE_BUDGET_EXCEEDED: "Artifact metadata and page envelope leave insufficient room within the page budget.",
  } as const;
  for (const [code, message] of Object.entries(messages) as [keyof typeof messages, string][]) {
    const error = new PaginationError(code);
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.deepEqual(JSON.parse(serializeGetterError(error)), { error: message, code });
  }
});

test("lossless pages: empty, small, long lines, line endings, escaping and Unicode", () => {
  for (const content of ["", "small", "line\r\nline\nlast", "x".repeat(PAGE_BYTES * 5),
    ('"\\\u0000\u0001\b\f\t é😀\r\n').repeat(9000), "😀".repeat(20000),
    "\ud800".repeat(10000), ("line\n").repeat(20000)]) {
    collect(content);
  }
});

test("final envelopes at and around the exact budget, and complete-line preference", () => {
  const empty = paginateArtifact({ ...options, content: "" });
  const capacity = PAGE_BYTES - size(empty);
  assert.equal(size(collect("a".repeat(capacity))[0]), PAGE_BYTES);
  assert.equal(collect("a".repeat(capacity)).length, 1);
  assert.equal(collect("a".repeat(capacity - 1)).length, 1);
  assert.ok(collect("a".repeat(capacity + 1)).length > 1);
  const lines = collect("first\r\n" + "x".repeat(PAGE_BYTES * 2));
  assert.equal(lines[0].content, "first\r\n");
  assert.ok(lines[1].content.length > 1000, "long lines must split and advance");
  const first = collect("a".repeat(PAGE_BYTES * 2))[0];
  const crlf = collect("a".repeat(first.content.length - 1) + "\r\n" + "z".repeat(PAGE_BYTES * 2));
  assert.ok(crlf.every((p) => !p.content.endsWith("\r")));
});

test("metadata and both envelopes consume the budget; impossible progress fails explicitly", () => {
  const metadata = { ...options.metadata, frontmatter: { title: "é".repeat(2000) }, blocks: { total: 99, checked: 1 } };
  const pages = collect("z".repeat(PAGE_BYTES * 2), { metadata });
  for (const page of pages) {
    assert.deepEqual(page.frontmatter, metadata.frontmatter);
    assert.deepEqual(page.blocks, metadata.blocks);
  }
  const enormous = { ...metadata, frontmatter: { title: "x".repeat(PAGE_BYTES) } };
  for (const content of ["", "😀", "x".repeat(PAGE_BYTES * 2)]) {
    assert.throws(() => paginateArtifact({ ...options, metadata: enormous, content }), { code: "PAGE_BUDGET_EXCEEDED" });
  }
  const content = "😀".repeat(PAGE_BYTES);
  const probe = paginateArtifact({ ...options, content });
  const firstCodePointCursor = encode({ ...decode(probe.pagination.next_cursor), p: 2 });
  const emptyContinuing = { ...probe, content: "", pagination: { has_more: true, next_cursor: firstCodePointCursor } };
  const padding = PAGE_BYTES - size(emptyContinuing) - 1;
  assert.throws(() => paginateArtifact({ ...options, content, metadata: { ...options.metadata, file: String(options.metadata.file) + "x".repeat(padding) } }), { code: "PAGE_BUDGET_EXCEEDED" });
});

test("stateless deterministic versioned cursors reject malformed or misplaced continuations", async () => {
  const content = "😀abc".repeat(PAGE_BYTES);
  const first = paginateArtifact({ ...options, content });
  const cursor = String(first.pagination.next_cursor);
  assert.deepEqual(paginateArtifact({ ...options, content }), first);
  const specifier = "../src/pagination.js?fresh";
  const fresh = await import(specifier) as typeof import("../src/pagination.js");
  assert.notEqual(fresh.paginateArtifact, paginateArtifact);
  assert.deepEqual(fresh.paginateArtifact({ ...options, content, cursor }), paginateArtifact({ ...options, content, cursor }));
  const marker = decode(cursor);
  assert.deepEqual(Object.keys(marker).sort(), ["a", "h", "p", "t", "v"]);
  for (const bad of ["", null, 3, "not-a-cursor", cursor + "=", "a".repeat(1025), "é".repeat(513),
    encode(null), encode({}), encode({ ...marker, v: 2 }), encode({ ...marker, t: "plan_get" }),
    encode({ ...marker, a: "another" }), encode({ ...marker, p: 0 }), encode({ ...marker, p: 1 }),
    encode({ ...marker, p: -1 }), encode({ ...marker, p: 1.5 }), encode({ ...marker, p: content.length }),
    encode({ ...marker, p: Number.MAX_SAFE_INTEGER + 1 }), encode({ ...marker, extra: true })]) {
    assert.throws(() => paginateArtifact({ ...options, content, cursor: bad }), { code: "INVALID_CURSOR" });
  }
  for (const change of [{ tool: "plan_get" }, { projectRoot: "/other" }, { artifactPath: "/project/docs/specs/other.md" }]) {
    assert.throws(() => paginateArtifact({ ...options, content, cursor, ...change }), { code: "INVALID_CURSOR" });
  }
  for (const changed of [content.replace("a", "b"), "shorter"]) {
    assert.throws(() => paginateArtifact({ ...options, content: changed, cursor }), { code: "STALE_CURSOR" });
  }
});

test("cursor checks: non-object payloads, a bad hash and the stale check before the range", () => {
  const content = "abc\n".repeat(PAGE_BYTES);
  const cursor = String(paginateArtifact({ ...options, content }).pagination.next_cursor);
  const marker = decode(cursor);
  for (const payload of ["text", 5, true, [], [marker]]) {
    assert.throws(() => paginateArtifact({ ...options, content, cursor: encode(payload) }), { code: "INVALID_CURSOR" });
  }
  assert.throws(() => paginateArtifact({ ...options, content, cursor: "%%%" }), { code: "INVALID_CURSOR" });
  assert.throws(() => paginateArtifact({ ...options, content, cursor: encode({ ...marker, h: "A".repeat(64) }) }), { code: "INVALID_CURSOR" });
  assert.throws(() => paginateArtifact({ ...options, content, cursor: encode({ ...marker, h: "a".repeat(63) }) }), { code: "INVALID_CURSOR" });
  assert.throws(() => paginateArtifact({ ...options, content, cursor: encode({ ...marker, p: String(marker.p) }) }), { code: "INVALID_CURSOR" });
  // A well-formed cursor whose hash no longer matches is stale even when its position is out of range.
  assert.throws(() => paginateArtifact({ ...options, content: "short", cursor }), { code: "STALE_CURSOR" });
  // Same content but a position past the end is invalid, not stale.
  assert.throws(() => paginateArtifact({ ...options, content, cursor: encode({ ...marker, p: content.length + 1 }) }), { code: "INVALID_CURSOR" });
});

test("a cursor position inside a surrogate pair is invalid", () => {
  const content = "😀".repeat(PAGE_BYTES);
  const marker = decode(paginateArtifact({ ...options, content }).pagination.next_cursor);
  assert.throws(() => paginateArtifact({ ...options, content, cursor: encode({ ...marker, p: 3 }) }), { code: "INVALID_CURSOR" });
  const page = paginateArtifact({ ...options, content, cursor: encode({ ...marker, p: 4 }) });
  assert.ok(page.content.startsWith("😀"));
});

test("registered-boundary serializers bound errors and refuse oversized success", () => {
  for (const error of [new Error("\u0000😀".repeat(PAGE_BYTES)), "x".repeat(PAGE_BYTES), null]) {
    const raw = serializeGetterError(error);
    assert.ok(Buffer.byteLength(raw, "utf8") <= PAGE_BYTES);
    assert.equal(typeof JSON.parse(raw).error, "string");
  }
  const oversized = JSON.parse(serializeGetterPage({ content: "x".repeat(PAGE_BYTES) }));
  assert.equal(oversized.code, "PAGE_BUDGET_EXCEEDED");
  assert.equal(oversized.content, undefined);
  for (const [content, cursor, code] of [["x", "bad", "INVALID_CURSOR"], ["x".repeat(PAGE_BYTES), undefined, "PAGE_BUDGET_EXCEEDED"]] as const) {
    try {
      paginateArtifact({ ...options, content, cursor, metadata: { file: "x".repeat(PAGE_BYTES) } });
      assert.fail("expected pagination error");
    } catch (error) {
      const raw = serializeGetterError(error);
      assert.ok(Buffer.byteLength(raw, "utf8") <= PAGE_BYTES);
      assert.equal(JSON.parse(raw).code, code);
      assert.equal(JSON.parse(raw).content, undefined);
      assert.ok(!raw.includes("x".repeat(100)));
    }
  }
});

test("serializeGetterError truncation: 256 code points, then marker and last 256 code points", () => {
  assert.deepEqual(JSON.parse(serializeGetterError(new Error("boom"))), { error: "boom" });
  assert.deepEqual(JSON.parse(serializeGetterError("plain")), { error: "plain" });
  assert.deepEqual(JSON.parse(serializeGetterError(null)), { error: "null" });
  const exact = "é".repeat(256);
  assert.equal(JSON.parse(serializeGetterError(new Error(exact))).error, exact);
  const long = "a".repeat(256) + "m".repeat(1000) + "z".repeat(256);
  assert.equal(
    JSON.parse(serializeGetterError(new Error(long))).error,
    "a".repeat(256) + "… (diagnostic shortened) …" + "z".repeat(256),
  );
  const emoji = "😀".repeat(400);
  assert.equal(
    JSON.parse(serializeGetterError(new Error(emoji))).error,
    "😀".repeat(256) + "… (diagnostic shortened) …" + "😀".repeat(256),
  );
});

// Integration: real files in temporary directories, read back and paginated like a getter does.

const defaults = { specs: "docs/specs" };
const custom = { specs: "private/specifications" };
const body = ('long escaped line: "\\\u0000 é😀' + "x".repeat(400)).repeat(300);
const spec = '---\ntitle: "Pagination fixture"\n---\n## Rule\nAlways keep data private.\n' + body + '\n## Tail\nPublish all private data.\nSPEC_TAIL';

async function fixture(root: string, paths: { specs: string }, name = "large"): Promise<void> {
  await mkdir(join(root, paths.specs), { recursive: true });
  await writeFile(join(root, paths.specs, `${name}.md`), spec);
}

async function read(root: string, paths: { specs: string }, id: string, cursor?: string | null, tool = "spec_get"): Promise<Page> {
  const file = `${paths.specs}/${id}.md`;
  const artifactPath = join(root, file);
  const content = await readFile(artifactPath, "utf8");
  return paginateArtifact({ tool, projectRoot: root, artifactPath, content, metadata: { file, frontmatter: parseFrontmatter(content) }, cursor });
}

async function collectFiles(root: string, paths: { specs: string }, id: string, first?: Page): Promise<{ pages: Page[]; content: string }> {
  const pages: Page[] = [];
  let page = first ?? await read(root, paths, id);
  while (true) {
    pages.push(page);
    assert.ok(pages.length < 100);
    assert.ok(size(page) <= PAGE_BYTES);
    if (!page.pagination.has_more) {
      assert.equal(page.pagination.next_cursor, null);
      break;
    }
    assert.ok(page.content.length > 0);
    page = await read(root, paths, id, page.pagination.next_cursor);
  }
  return { pages, content: pages.map((p) => p.content).join("") };
}

for (const paths of [defaults, custom]) {
  test(`lossless interleaved pagination of files and recreation: ${paths.specs}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pagination-files-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await fixture(root, paths);
    await fixture(root, paths, "second");
    const firstLarge = await read(root, paths, "large");
    const firstSecond = await read(root, paths, "second");
    assert.equal(firstLarge.pagination.has_more, true);
    assert.ok(!firstLarge.content.includes("Publish all private data"));
    // Continuations are stateless: interleaving two artifacts needs no shared state.
    const [large, second] = await Promise.all([collectFiles(root, paths, "large", firstLarge), collectFiles(root, paths, "second", firstSecond)]);
    assert.equal(large.content, spec);
    assert.equal(second.content, spec);
    assert.ok(large.pages.length > 4);
    for (const page of large.pages) {
      assert.equal(page.file, `${paths.specs}/large.md`);
      assert.deepEqual(page.frontmatter, { title: "Pagination fixture" });
    }
    assert.match(large.content, /Publish all private data\.\nSPEC_TAIL$/);
  });
}

test("continuations reject wrong identity and stale edits, and a restart reads the new content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pagination-errors-"));
  const other = await mkdtemp(join(tmpdir(), "pagination-other-"));
  t.after(() => Promise.all([root, other].map((dir) => rm(dir, { recursive: true, force: true }))));
  await fixture(root, defaults);
  await fixture(root, defaults, "another");
  await fixture(other, defaults);
  const first = await read(root, defaults, "large");
  const cursor = String(first.pagination.next_cursor);
  for (const attempt of [
    () => read(root, defaults, "another", cursor),
    () => read(other, defaults, "large", cursor),
    () => read(root, defaults, "large", cursor, "plan_get"),
    () => read(root, defaults, "large", "bad"),
  ]) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof PaginationError);
      assert.equal(error.code, "INVALID_CURSOR");
      const raw = JSON.parse(serializeGetterError(error));
      assert.equal(raw.content, undefined);
      assert.equal(raw.pagination, undefined);
      return true;
    });
  }
  const file = join(root, defaults.specs, "large.md");
  const changed = spec.replace("---", "+++"); // Same-length edit, not an mtime/length check.
  assert.equal(changed.length, spec.length);
  await writeFile(file, changed);
  await assert.rejects(() => read(root, defaults, "large", cursor), (error: unknown) => {
    assert.ok(error instanceof PaginationError);
    assert.equal(error.code, "STALE_CURSOR");
    const raw = JSON.parse(serializeGetterError(error));
    assert.equal(raw.code, "STALE_CURSOR");
    assert.equal(raw.content, undefined);
    return true;
  });
  const restarted = await collectFiles(root, defaults, "large");
  assert.equal(restarted.content, changed);
});

test("errors stay bounded for metadata overflow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pagination-bounded-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root, defaults);
  await writeFile(join(root, defaults.specs, "large.md"), `---\ntitle: ${"x".repeat(PAGE_BYTES)}\n---\nbody`);
  for (const cursor of [undefined, "z".repeat(1025)]) {
    await assert.rejects(() => read(root, defaults, "large", cursor), (error: unknown) => {
      const raw = serializeGetterError(error);
      assert.ok(Buffer.byteLength(raw, "utf8") <= PAGE_BYTES);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.code, cursor ? "INVALID_CURSOR" : "PAGE_BUDGET_EXCEEDED");
      assert.equal(parsed.content, undefined);
      assert.ok(!raw.includes("x".repeat(100)));
      return true;
    });
  }
});
