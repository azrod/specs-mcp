/**
 * Differential parity: spec_search and spec_read_section against the original
 * `tools/spec-retrieval.js`. Results, errors and section cursors are compared as serialized strings
 * (byte-identical), over exhaustive reads (every section of every document, every page) and a
 * seeded fuzz. Both implementations run on the same root path, each on a fresh copy.
 * No deviation is neutralised here: the retrieval tools have none.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  Sandbox,
  assertParity,
  assertPureParity,
  caseSensitiveFs,
  compose,
  decodeCursor,
  encodeCursor,
  files,
  finishExact,
  frontmatter,
  makeTools,
  parityDescribe,
  portLib,
  prng,
  runningAsRoot,
  walkSection,
} from "./helpers.js";
import type { Lib, Outcome, RunEnv, Scenario, Tools } from "./helpers.js";

const EMOJI = "😀";

interface DocLike {
  source_hash: string;
  sections: Array<{ section_id: string }>;
}

const parsed = (text: string | undefined): Record<string, unknown> => JSON.parse(text ?? "null") as Record<string, unknown>;
const resultsOf = (text: string): Array<Record<string, unknown>> => {
  const { results } = parsed(text);
  return Array.isArray(results) ? (results as Array<Record<string, unknown>>) : [];
};
const codeOf = (text: string | undefined): unknown => parsed(text).code;

/** Every section of every `.md` file below `dir`, every page of each, through the tools of the running implementation. */
async function readEverySection(env: RunEnv, dir = "specs", maxPages = 80): Promise<string[]> {
  const out: string[] = [];
  const entries = (await fs.readdir(join(env.root, dir), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md"));
  for (const { name } of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const content = await fs.readFile(join(env.root, dir, name), "utf8");
    const id = name.slice(0, -3);
    const doc = env.lib.buildSpecDocument(content, `${dir}/${name}`, id) as DocLike;
    for (const section of doc.sections) {
      out.push(...(await walkSection(env.t, { id, section_id: section.section_id, source_hash: doc.source_hash }, maxPages)));
    }
  }
  return out;
}

async function searchAll(t: Tools, inputs: readonly unknown[]): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) out.push(await t.spec_search(input));
  return out;
}

const lines = (count: number, make: (n: number) => string, eol = "\n"): string =>
  Array.from({ length: count }, (_, n) => make(n)).join(eol) + eol;

// ── Corpus ────────────────────────────────────────────────────────────────────

const auth =
  frontmatter({ title: '"Authentication"', id: "auth", type: "technical", status: "active" }) +
  `
Preamble about tokens and sessions, before any heading.

# Authentication

Intro paragraph with café, naïve and résumé.

## Login flow

\`\`\`js
## not a heading inside a fence
const token = "secret";
\`\`\`

After the fence, the token appears again.

### Nested detail

Deep text 日本語 テスト and ${EMOJI} emoji.

## Logout

~~~
# tilde fenced heading
~~~

#hashtag is not a heading
####### seven hashes are not a heading
    # indented code is not a heading
   ### three spaces still make a heading

Final words.
`;

const fences = `# Fences

\`\`\`\`md
\`\`\`
## inside a longer fence
\`\`\`
\`\`\`\`

## After the longer fence

\`\`\` has\`backtick in info
## this one is a real heading, the line above opens no fence

~~~ tilde info with \`backtick\` is fine
## hidden by a tilde fence
~~~

## Unclosed fence swallows the rest

\`\`\`
# swallowed heading
## another swallowed heading
`;

const nested = `Preamble line one.
Preamble line two.

# H1 one
text of one
## H2 a
text of a
### H3 deep
text of deep
#### H4
##### H5
###### H6
text of six
## H2 b
text of b
# H1 two
#
## 
text at the end
`;

const zebra = frontmatter({ title: '"Zebra Crossing"', id: "zebra", type: "functional", status: "draft" }) + "\n# Roads\n\nThe body never names the animal.\n";

const crlf = '---\r\ntitle: "Windows"\r\nid: crlf\r\ntype: technical\r\nstatus: active\r\n---\r\n\r\n# Windows doc\r\n\r\ntoken across\r\nlines\r\n\r\n## Second\r\n\r\ntoken again\r\n';

const richCorpus = {
  "specs/auth.md": auth,
  "specs/fences.md": fences,
  "specs/nested.md": nested,
  "specs/zebra.md": zebra,
  "specs/crlf.md": crlf,
  "specs/empty.md": "",
  "specs/only-frontmatter.md": frontmatter({ title: '"Only meta"', id: "only-frontmatter", type: "architectural", status: "deprecated" }),
  "specs/no-trailing-newline.md": "# Tail\n\nlast token without newline",
  "specs/unclosed-frontmatter.md": "---\ntitle: nope\n# Heading in a broken frontmatter\ntoken\n",
  "specs/unicode.md": "# Ünï Çödé\n\nÀ la carte: ñandú, größe, ЖЖЖ кириллица, العربية, 𝒳𝒴𝒵 ٣٤٥ ①②③ and ǅ.\n",
  "specs/Upper-Case.md": "# Upper\n\ntoken in a file whose name has capitals\n",
  "specs/sub/ignored.md": "# Nested directory, not part of the corpus\n\ntoken\n",
  "specs/notes.txt": "token in a text file",
  "specs/Directory.md/inner.md": "# inside a directory named like a spec\n\ntoken\n",
};

const bigSection = `# Big\n\n${lines(1_200, (n) => `row ${n} `.padEnd(70, "m"))}\n## After\n\nfollowing text\n`;

const queries: string[] = [
  "token",
  "tokens sessions",
  "TOKEN",
  "café",
  "cafe",
  "résumé naïve",
  "日本語",
  "テスト",
  "zebra",
  "authentication",
  "login flow",
  "fence",
  "secret",
  "tilde",
  "hashtag",
  "seven hashes",
  "heading",
  "swallowed",
  "unclosed",
  "windows",
  "second",
  "ünï çödé",
  "größe ñandú",
  "кириллица",
  "العربية",
  "𝒳𝒴𝒵",
  "٣٤٥",
  "①②③",
  "last",
  "meta",
  "H1 h2 h3 h4 h5 h6",
  "absent nowhere",
  "a",
  "the",
  "42",
  "x".repeat(300),
  "upper case",
  "preamble",
  "text",
  "end",
  "roads",
  "does not exist anywhere in this corpus",
  "  padded  query  ",
  "token-token_token.token",
  "Token TOKEN token",
  Array.from({ length: 32 }, (_, n) => `w${n}`).join(" "),
  Array.from({ length: 33 }, (_, n) => `w${n}`).join(" "),
];

parityDescribe("parity: spec_search and spec_read_section", (originLib: Lib) => {
  let sandbox: Sandbox;
  before(async () => {
    sandbox = await Sandbox.create("specs-parity-retrieval-");
  });
  after(async () => {
    await sandbox.dispose();
  });

  const parity = (name: string, scenario: Scenario<Outcome>, check?: (expected: Outcome) => void): void => {
    test(name, async () => {
      const expected = await assertParity(sandbox, originLib, scenario);
      check?.(expected);
    });
  };

  // ── Document model ────────────────────────────────────────────────────────

  test("buildSpecDocument: identical documents (lines, sections, passages) for the corpus", async () => {
    for (const [name, content] of Object.entries({ ...richCorpus, "specs/big.md": bigSection })) {
      const id = name.replace(/^specs\//, "").replace(/\.md$/, "");
      await assertPureParity(originLib, (lib) => lib.buildSpecDocument(content, name, id, `/canonical/${name}`), name);
    }
  });

  test("buildSpecDocument: passage splitting around 2000 code points (LF, CRLF, emoji, lone surrogates)", async () => {
    for (let length = 1_990; length <= 2_010; length += 1) {
      for (const [label, unit] of [["ascii", "a"], ["emoji", EMOJI], ["accent", "é"], ["lone", "\ud83d"]] as const) {
        const body = unit.repeat(length);
        for (const content of [
          `# T\n\n${body}\n`,
          `# T\r\n\r\n${body}\r\n`,
          `${body}\n${body}\n`,
          `# T\n${"a".repeat(length - 1)}\r\n${"b".repeat(length)}\r\n`,
          `# T\n${"a".repeat(length - 1)}\r\n`,
          `# T\n${"a".repeat(length)}\r\n`,
        ]) {
          await assertPureParity(originLib, (lib) => lib.buildSpecDocument(content, "f.md", "f"), `${label} ${length}`);
        }
      }
    }
  });

  // ── spec_search ───────────────────────────────────────────────────────────

  parity("search: queries over the rich corpus, every section of every document read back", {
    setup: files({ ...richCorpus, "specs/big.md": bigSection }),
    run: async (env) => finishExact(env, [...(await searchAll(env.t, queries.map((query) => ({ query })))), ...(await readEverySection(env))]),
  }, ({ outputs }) => {
    const searches = outputs.slice(0, queries.length);
    assert.ok(searches.filter((text) => resultsOf(text).length > 0).length >= 25, "most queries must find something");
    assert.ok(searches.some((text) => codeOf(text) === "INVALID_QUERY"));
    assert.ok(searches.some((text) => parsed(text).truncated === true));
    const sections = outputs.slice(queries.length);
    assert.ok(sections.length > 40);
    assert.ok(sections.some((text) => (parsed(text).pagination as { has_more?: boolean } | undefined)?.has_more === true), "a section must span several pages");
    assert.ok(sections.some((text) => parsed(text).content === ""), "an empty section must be read");
  });

  parity("search: result ordering, ties and the five-result cap across many files", {
    setup: files(Object.fromEntries([
      ...Array.from({ length: 12 }, (_, n) => [`specs/doc-${String(n).padStart(2, "0")}.md`, `# Doc ${n}\n\nshared token ${"token ".repeat(n % 4)}\n`] as const),
      ["specs/B-upper.md", "token\n"],
      ["specs/a-lower.md", "token\n"],
      ["specs/é-accent.md", "token\n"],
      ["specs/10.md", "token\n"],
      ["specs/2.md", "token\n"],
      ["specs/a b.md", "token\n"],
    ])),
    run: async (env) => finishExact(env, await searchAll(env.t, [{ query: "token" }, { query: "shared" }, { query: "doc token" }, { query: "2 10" }])),
  }, ({ outputs }) => {
    assert.equal(resultsOf(outputs[0] ?? "").length, 5);
    assert.equal(parsed(outputs[0]).truncated, true);
  });

  parity("search: filters id / type / status (case-insensitive, combined, empty results)", {
    setup: files(richCorpus),
    run: async (env) => finishExact(env, await searchAll(env.t, [
      { query: "token", id: "auth" },
      { query: "token", id: "AUTH" },
      { query: "token", id: "upper-case" },
      { query: "token", id: "nope" },
      { query: "token", id: "sub" },
      { query: "token", type: "technical" },
      { query: "token", type: "TECHNICAL" },
      { query: "token", type: "functional" },
      { query: "token", type: "unknown-type" },
      { query: "token", status: "active" },
      { query: "token", status: "Active" },
      { query: "token", status: "draft" },
      { query: "token", type: "technical", status: "active" },
      { query: "token", type: "technical", status: "draft" },
      { query: "token", id: "auth", type: "functional" },
      { query: "zebra", type: "functional" },
      { query: "zebra", status: "draft", id: "zebra" },
      { query: "meta", type: "architectural", status: "deprecated" },
      { query: "token", id: "empty" },
    ])),
  }, ({ outputs }) => {
    assert.ok(resultsOf(outputs[0] ?? "").length > 0);
    assert.equal(codeOf(outputs[3]), "SPEC_NOT_FOUND");
  });

  const invalidInputs: unknown[] = [
    {},
    { query: "" },
    { query: "   " },
    { query: "!!! ???" },
    { query: 42 },
    { query: null },
    { query: ["token"] },
    { query: "token", id: "" },
    { query: "token", id: "   " },
    { query: "token", id: 5 },
    { query: "token", id: "a/b" },
    { query: "token", id: "a\\b" },
    { query: "token", id: "a\u0000b" },
    { query: "token", id: "." },
    { query: "token", id: ".." },
    { query: "token", id: "../auth" },
    { query: "token", id: null },
    { query: "token", type: "" },
    { query: "token", type: " " },
    { query: "token", type: 3 },
    { query: "token", type: null },
    { query: "token", status: "" },
    { query: "token", status: false },
    { query: "token", id: "ok", type: "", status: 1 },
    { query: "é".repeat(256) },
    { query: "é".repeat(257) },
    { query: "a".repeat(512) },
    { query: "a".repeat(513) },
    { query: `${"a ".repeat(255)}a` },
    { query: "日".repeat(170) },
    { query: "日".repeat(171) },
    { query: "token", extra: "ignored" },
    "a string",
    42,
    [],
    null,
    undefined,
  ];

  parity("search: invalid and borderline arguments (validation order, error codes)", {
    setup: files(richCorpus),
    run: async (env) => finishExact(env, await searchAll(env.t, invalidInputs)),
  }, ({ outputs }) => {
    assert.ok(outputs.some((text) => codeOf(text) === "INVALID_ARGUMENT"));
    assert.ok(outputs.some((text) => codeOf(text) === "INVALID_QUERY"));
    assert.ok(outputs.some((text) => codeOf(text) === "SOURCE_UNAVAILABLE"), "null/undefined input must surface as SOURCE_UNAVAILABLE");
  });

  parity("search: missing, empty and nested corpora", {
    run: async (env) => {
      const outputs: string[] = [await env.t.spec_search({ query: "token" })];
      await fs.mkdir(join(env.root, "specs"));
      outputs.push(await env.t.spec_search({ query: "token" }), await env.t.spec_search({ query: "token", id: "x" }));
      return finishExact(env, outputs);
    },
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).corpus_files, 0);
    assert.equal(codeOf(outputs[2]), "SPEC_NOT_FOUND");
  });

  parity("search: budget — large passages, heavy JSON escaping, long metadata, long headings", {
    setup: files({
      "specs/a-emoji.md": `# Emoji\n\n${EMOJI.repeat(900)} token ${EMOJI.repeat(1_000)}\n`,
      "specs/b-quotes.md": `# Quotes\n\n${'"\\'.repeat(900)} token ${'"\\'.repeat(1_000)}\n`,
      "specs/c-accents.md": `# Accents\n\n${"é".repeat(1_900)} token\n`,
      "specs/d-controls.md": `# Controls\n\n${"\u0001\u2028".repeat(900)} token ${"\t".repeat(900)}\n`,
      "specs/e-huge-token.md": `# Huge\n\n${"é".repeat(1_900)}\n`,
      "specs/f-more.md": `# More\n\n${"lorem ".repeat(300)} token ${"ipsum ".repeat(300)}\n`,
      "specs/g-more.md": `# More\n\n${"lorem ".repeat(300)} token ${"ipsum ".repeat(300)}\n`,
      "specs/h-more.md": `# More\n\n${"lorem ".repeat(300)} token ${"ipsum ".repeat(300)}\n`,
    }),
    run: async (env) => finishExact(env, [
      ...(await searchAll(env.t, [
        { query: "token" },
        { query: `${"é".repeat(1_900)}` },
        { query: "lorem token" },
        { query: "emoji" },
        { query: "huge" },
      ])),
      ...(await readEverySection(env)),
    ]),
  }, ({ outputs }) => {
    const first = parsed(outputs[0]);
    assert.ok(Array.isArray(first.results) && (first.results as unknown[]).length >= 1);
    assert.ok(outputs.slice(0, 5).some((text) => parsed(text).truncated === true), "the byte budget must truncate a search");
    assert.ok(resultsOf(outputs[0] ?? "").some((r) => r.partial_start_line === true || r.partial_end_line === true), "a citation must have been windowed");
  });

  test("search: long title / status / headings sweep up to PAGE_BUDGET_EXCEEDED", async () => {
    let sawBudgetError = false;
    let sawResult = false;
    for (const size of [0, 500, 4_000, 8_000, 12_000, 14_000, 15_000, 15_800, 16_000, 16_100, 16_200, 16_300, 16_384, 17_000, 30_000]) {
      for (const field of ["title", "status", "heading", "type", "nested-headings"] as const) {
        const long = "q".repeat(size);
        const content =
          field === "heading"
            ? `# ${long}\n\ntoken here\n`
            : field === "nested-headings"
              ? `# ${long.slice(0, size >> 2)}\n## ${long.slice(0, size >> 2)}\n### ${long.slice(0, size >> 2)}\n#### ${long.slice(0, size >> 2)}\n\ntoken here\n`
              : `${frontmatter({ [field]: `"${long}"` })}\n# Heading\n\ntoken here\n`;
        const expected = await assertParity(sandbox, originLib, {
          setup: files({ "specs/doc.md": content, "specs/other.md": "# Other\n\ntoken there\n" }),
          run: async (env) => finishExact(env, [
            await env.t.spec_search({ query: "token" }),
            await env.t.spec_search({ query: "token", id: "doc" }),
            ...(await readEverySection(env)),
          ]),
        }, `${field} size=${size}`);
        for (const text of expected.outputs) {
          if (codeOf(text) === "PAGE_BUDGET_EXCEEDED") sawBudgetError = true;
          if (resultsOf(text).length > 0) sawResult = true;
        }
      }
    }
    assert.ok(sawBudgetError && sawResult, "the sweep must cross the budget in both directions");
  });

  test("serializeRetrievalResult / serializeRetrievalError: size boundary, shapes and error kinds", async () => {
    for (let length = 16_300; length <= 16_420; length += 1) {
      const shape = { query: "q", corpus_files: 1, matched_passages: 1, results: [{ excerpt: "a".repeat(length - 100) }], truncated: false };
      await assertPureParity(originLib, (lib) => lib.serializeRetrievalResult(shape), `length=${length}`);
    }
    for (const shape of [{}, [], null, "text", 0, { a: "é".repeat(8_192) }, { a: EMOJI.repeat(4_096) }, { a: "é".repeat(8_180) }]) {
      await assertPureParity(originLib, (lib) => lib.serializeRetrievalResult(shape));
    }
    const thrown = async (lib: Lib, run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
        return null;
      } catch (error) {
        return error;
      }
    };
    await sandbox.reset(files(richCorpus));
    const paths = { specs: "specs" };
    const real: Array<(lib: Lib) => Promise<unknown>> = [
      (lib) => lib.specSearch(sandbox.root, paths, { query: "!!!" }),
      (lib) => lib.specSearch(sandbox.root, paths, { query: "token", id: "nope" }),
      (lib) => lib.specSearch(sandbox.root, paths, { query: "token", id: "../x" }),
      (lib) => lib.specReadSection(sandbox.root, paths, { id: "auth", source_hash: "bad", section_id: "preamble" }),
      (lib) => lib.specReadSection(sandbox.root, paths, { id: "nope", source_hash: "0".repeat(64), section_id: "preamble" }),
      (lib) => lib.specReadSection(sandbox.root, paths, { id: "auth", source_hash: "0".repeat(64), section_id: "preamble" }),
    ];
    for (const run of real) {
      await assertPureParity(originLib, async (lib) => lib.serializeRetrievalError(await thrown(lib, () => run(lib))));
    }
    const foreign: unknown[] = [new Error("boom"), new TypeError("x"), "text", null, undefined, 3, { code: "STALE_CURSOR" }, Object.assign(new Error("e"), { code: "STALE_CURSOR" })];
    for (const error of foreign) await assertPureParity(originLib, (lib) => lib.serializeRetrievalError(error));
  });

  // ── spec_read_section ─────────────────────────────────────────────────────

  const hashOf = (lib: Lib, content: string): string => (lib.buildSpecDocument(content, "specs/doc.md", "doc") as DocLike).source_hash;

  parity("read_section: invalid arguments and not-found cases", {
    setup: files({ "specs/doc.md": nested, "specs/Other.md": "# Other\n" }),
    run: async (env) => {
      const hash = hashOf(env.lib, nested);
      const call = (input: unknown): Promise<string> => env.t.spec_read_section(input);
      const base = { id: "doc", source_hash: hash, section_id: "preamble" };
      return finishExact(env, [
        await call(base),
        await call({ ...base, id: "DOC" }),
        await call({ ...base, id: "other" }),
        await call({ ...base, id: "" }),
        await call({ ...base, id: "  " }),
        await call({ ...base, id: "." }),
        await call({ ...base, id: ".." }),
        await call({ ...base, id: "a/b" }),
        await call({ ...base, id: "a\\b" }),
        await call({ ...base, id: "a\u0000" }),
        await call({ ...base, id: 3 }),
        await call({ ...base, id: undefined }),
        await call({ ...base, id: "ghost" }),
        await call({ ...base, source_hash: "" }),
        await call({ ...base, source_hash: hash.toUpperCase() }),
        await call({ ...base, source_hash: hash.slice(1) }),
        await call({ ...base, source_hash: `${hash}0` }),
        await call({ ...base, source_hash: 12 }),
        await call({ ...base, source_hash: undefined }),
        await call({ ...base, source_hash: "0".repeat(64) }),
        await call({ ...base, section_id: undefined }),
        await call({ ...base, section_id: 5 }),
        await call({ ...base, section_id: "" }),
        await call({ ...base, section_id: "Preamble" }),
        await call({ ...base, section_id: "preamble " }),
        await call({ ...base, section_id: "line:0" }),
        await call({ ...base, section_id: "line:01" }),
        await call({ ...base, section_id: "line:-1" }),
        await call({ ...base, section_id: "line:3" }),
        await call({ ...base, section_id: "line:4" }),
        await call({ ...base, section_id: "line:999" }),
        await call({ ...base, section_id: "line:12345678901234567890" }),
        await call({ ...base, section_id: "LINE:4" }),
        await call({ ...base, section_id: "line:4\n" }),
        await call({ ...base, cursor: "" }),
        await call({ ...base, cursor: 5 }),
        await call({ ...base, cursor: null }),
        await call({ ...base, cursor: "AAAA" }),
        await call(null),
        await call(undefined),
        await call("doc"),
        await call({}),
        await call({ id: "doc" }),
      ]);
    },
  }, ({ outputs }) => {
    const codes = new Set(outputs.map((text) => codeOf(text)));
    for (const code of ["INVALID_ARGUMENT", "SPEC_NOT_FOUND", "SECTION_NOT_FOUND", "STALE_SOURCE", "INVALID_CURSOR", "SOURCE_UNAVAILABLE"]) {
      assert.ok(codes.has(code), `missing code ${code}`);
    }
    assert.equal(parsed(outputs[0]).section_id, "preamble");
  });

  parity("read_section: validation order (hash and section checked before reading, staleness before section lookup)", {
    setup: files({ "specs/doc.md": nested }),
    run: async (env) => {
      const stale = "f".repeat(64);
      return finishExact(env, [
        await env.t.spec_read_section({ id: "doc", source_hash: stale, section_id: "nope" }),
        await env.t.spec_read_section({ id: "doc", source_hash: stale, section_id: "line:4" }),
        await env.t.spec_read_section({ id: "doc", source_hash: stale, section_id: 7 }),
        await env.t.spec_read_section({ id: "ghost", source_hash: "bad", section_id: 7 }),
        await env.t.spec_read_section({ id: "ghost", source_hash: stale, section_id: "preamble" }),
        await env.t.spec_read_section({ id: "doc", source_hash: stale, section_id: "preamble", cursor: "bad" }),
        await env.t.spec_read_section({ id: "../x", source_hash: "bad", section_id: 7 }),
      ]);
    },
  });

  // ── Section cursors ───────────────────────────────────────────────────────

  const bigDocId = "big";

  test("section cursors: forged and malformed cursors get the same answer", async () => {
    await sandbox.reset(files({ "specs/big.md": bigSection, "specs/other.md": bigSection.replace("row 1 ", "row X ") }));
    const toolsFor = (lib: Lib): Tools => makeTools(lib, sandbox.root, { specs: "specs" }, lib !== originLib);
    const doc = originLib.buildSpecDocument(bigSection, "specs/big.md", bigDocId) as DocLike;
    const section = doc.sections.find((s) => s.section_id !== "preamble");
    assert.ok(section);
    const input = { id: bigDocId, section_id: section.section_id, source_hash: doc.source_hash };
    const first = parsed(await toolsFor(originLib).spec_read_section(input));
    const valid = (first.pagination as { next_cursor: string }).next_cursor;
    assert.equal(typeof valid, "string");
    const good = decodeCursor(valid);
    assert.deepEqual(Object.keys(good).sort(), ["a", "h", "p", "s", "t", "v"]);

    const forged: Array<[string, unknown]> = [
      ["valid", valid],
      ["empty", ""],
      ["garbage", "!!!"],
      ["padding", `${valid}=`],
      ["non-canonical tail", `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`],
      ["truncated", valid.slice(0, -9)],
      ["1025 bytes", "A".repeat(1_025)],
      ["1024 bytes", "A".repeat(1_024)],
      ["number", 1],
      ["null", null],
      ["array", [valid]],
      ["object", { p: 1 }],
      ["JSON string", encodeCursor("x")],
      ["JSON array", encodeCursor([good])],
      ["JSON null", encodeCursor(null)],
      ["missing key", encodeCursor({ v: good.v, t: good.t, a: good.a, h: good.h, p: good.p })],
      ["extra key", encodeCursor({ ...good, x: 1 })],
      ["version", encodeCursor({ ...good, v: 2 })],
      ["tool spec_get", encodeCursor({ ...good, t: "spec_get" })],
      ["identity", encodeCursor({ ...good, a: "0".repeat(64) })],
      ["hash", encodeCursor({ ...good, h: "0".repeat(64) })],
      ["section digest", encodeCursor({ ...good, s: "0".repeat(64) })],
      ["position 0", encodeCursor({ ...good, p: 0 })],
      ["position negative", encodeCursor({ ...good, p: -1 })],
      ["position fractional", encodeCursor({ ...good, p: 0.5 })],
      ["position string", encodeCursor({ ...good, p: String(good.p) })],
      ["position unsafe", encodeCursor({ ...good, p: 2 ** 55 })],
      ["position 1", encodeCursor({ ...good, p: 1 })],
      ["position mid-line", encodeCursor({ ...good, p: Number(good.p) + 3 })],
      ["position at the end", encodeCursor({ ...good, p: bigSection.length })],
      ["position past the end", encodeCursor({ ...good, p: bigSection.length * 2 })],
      ["key order", Buffer.from(JSON.stringify({ p: good.p, s: good.s, a: good.a, h: good.h, t: good.t, v: good.v })).toString("base64url")],
    ];
    for (const [label, cursor] of forged) {
      const expected = await toolsFor(originLib).spec_read_section({ ...input, cursor });
      const actual = await toolsFor(portLib).spec_read_section({ ...input, cursor });
      assert.equal(actual, expected, `cursor: ${label}`);
    }

    const otherSection = doc.sections.find((s) => s !== section && s.section_id !== "preamble");
    assert.ok(otherSection);
    for (const [label, override] of [
      ["same cursor, other section", { section_id: otherSection.section_id }],
      ["same cursor, other hash", { source_hash: "1".repeat(64) }],
      ["same cursor, other spec", { id: "other" }],
      ["same cursor, preamble", { section_id: "preamble" }],
    ] as const) {
      const args = { ...input, ...override, cursor: valid };
      const expected = await toolsFor(originLib).spec_read_section(args);
      assert.equal(await toolsFor(portLib).spec_read_section(args), expected, label);
    }
  });

  test("section cursors: each implementation accepts the other's cursors, page after page", async () => {
    await sandbox.reset(files({ "specs/big.md": bigSection }));
    const origin = makeTools(originLib, sandbox.root, { specs: "specs" }, false);
    const port = makeTools(portLib, sandbox.root, { specs: "specs" }, true);
    const doc = originLib.buildSpecDocument(bigSection, "specs/big.md", bigDocId) as DocLike;
    const section = doc.sections.find((s) => s.section_id !== "preamble");
    assert.ok(section);
    const input = { id: bigDocId, section_id: section.section_id, source_hash: doc.source_hash };
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const args = cursor === undefined ? input : { ...input, cursor };
      const fromOrigin = await origin.spec_read_section(args);
      assert.equal(await port.spec_read_section(args), fromOrigin, `page ${pages}`);
      pages += 1;
      const next = (parsed(fromOrigin).pagination as { next_cursor: string | null }).next_cursor;
      if (next === null) break;
      cursor = next;
      assert.ok(pages < 100);
    }
    assert.ok(pages >= 4);
  });

  const staleCase = (
    name: string,
    mutate: (root: string) => Promise<void>,
    check: (outputs: string[]) => void,
  ): void => {
    parity(`stale: ${name}`, {
      setup: files({ "specs/big.md": bigSection }),
      run: async (env) => {
        const doc = env.lib.buildSpecDocument(bigSection, "specs/big.md", bigDocId) as DocLike;
        const section = doc.sections.find((s) => s.section_id !== "preamble");
        assert.ok(section);
        const input = { id: bigDocId, section_id: section.section_id, source_hash: doc.source_hash };
        const first = await env.t.spec_read_section(input);
        const cursor = (parsed(first).pagination as { next_cursor: string }).next_cursor;
        await mutate(env.root);
        return finishExact(env, [
          first,
          await env.t.spec_read_section({ ...input, cursor }),
          await env.t.spec_read_section(input),
          await env.t.spec_search({ query: "row" }),
        ]);
      },
    }, ({ outputs }) => check(outputs));
  };

  staleCase("one character changed", (root) => fs.writeFile(join(root, "specs/big.md"), bigSection.replace("row 5 ", "row Z ")), (outputs) => {
    assert.equal(codeOf(outputs[1]), "STALE_CURSOR");
    assert.equal(codeOf(outputs[2]), "STALE_SOURCE");
  });
  staleCase("file shortened", (root) => fs.writeFile(join(root, "specs/big.md"), "# Big\n"), (outputs) => {
    assert.equal(codeOf(outputs[1]), "STALE_CURSOR");
  });
  staleCase("file rewritten with identical content", (root) => fs.writeFile(join(root, "specs/big.md"), bigSection), (outputs) => {
    assert.equal(codeOf(outputs[1]), undefined);
    assert.equal(codeOf(outputs[2]), undefined);
  });
  staleCase("file deleted", (root) => fs.rm(join(root, "specs/big.md")), (outputs) => {
    assert.equal(codeOf(outputs[1]), "SPEC_NOT_FOUND");
  });
  staleCase("file replaced by a directory", async (root) => {
    await fs.rm(join(root, "specs/big.md"));
    await fs.mkdir(join(root, "specs/big.md"));
  }, (outputs) => {
    assert.equal(codeOf(outputs[1]), "SPEC_NOT_FOUND");
  });

  // ── Corpus and filesystem safety ──────────────────────────────────────────

  const safetyOutputs = async (env: RunEnv): Promise<string[]> => [
    await env.t.spec_search({ query: "token" }),
    await env.t.spec_search({ query: "token", id: "doc" }),
    await env.t.spec_read_section({ id: "doc", source_hash: "0".repeat(64), section_id: "preamble" }),
    await env.t.spec_read_section({ id: "doc", source_hash: hashOf(env.lib, "# T\n\ntoken\n"), section_id: "preamble" }),
  ];

  parity("safety: specs directory is a symlink to a directory outside the root", {
    setup: compose(files({ "outside-docs/doc.md": "# T\n\ntoken\n" }), async ({ root }) => {
      await fs.symlink(join(root, "..", "outside"), join(root, "specs"));
      await fs.writeFile(join(root, "..", "outside", "doc.md"), "# T\n\ntoken\n");
    }),
    run: async (env) => finishExact(env, await safetyOutputs(env)),
  }, ({ outputs }) => {
    assert.ok(outputs.every((text) => codeOf(text) === "CORPUS_UNAVAILABLE"), outputs.join("\n"));
  });

  parity("safety: specs directory is a symlink to a directory inside the root", {
    setup: compose(files({ "real/doc.md": "# T\n\ntoken\n" }), async ({ root }) => {
      await fs.symlink(join(root, "real"), join(root, "specs"));
    }),
    run: async (env) => finishExact(env, [...(await safetyOutputs(env)), ...(await readEverySection(env))]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).corpus_files, 1);
  });

  parity("safety: an ancestor of the specs directory is a symlink leaving the root (even when the directory does not exist)", {
    setup: async ({ root }) => {
      await fs.symlink(join(root, "..", "outside"), join(root, "docs"));
    },
    specs: "docs/specs",
    run: async (env) => finishExact(env, await safetyOutputs(env)),
  }, ({ outputs }) => {
    assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE");
  });

  parity("safety: dangling symlink as the specs directory or as one of its ancestors", {
    setup: async ({ root }) => {
      await fs.symlink(join(root, "nowhere"), join(root, "specs"));
      await fs.symlink(join(root, "nowhere"), join(root, "docs"));
    },
    run: async (env) => {
      const nested = makeTools(env.lib, env.root, { specs: "docs/deeper/specs" }, env.impl === "port");
      return finishExact(env, [...(await safetyOutputs(env)), await nested.spec_search({ query: "token" })]);
    },
  }, ({ outputs }) => {
    assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE");
    assert.equal(codeOf(outputs[4]), "CORPUS_UNAVAILABLE");
  });

  parity("safety: file symlinks in the specs directory are not enumerated (inside or outside the root)", {
    setup: compose(files({ "specs/real.md": "# Real\n\ntoken\n", "inside.md": "# Inside\n\ntoken\n" }), async ({ root }) => {
      await fs.writeFile(join(root, "..", "outside", "leak.md"), "# Leak\n\ntoken\n");
      await fs.symlink(join(root, "..", "outside", "leak.md"), join(root, "specs", "leak.md"));
      await fs.symlink(join(root, "inside.md"), join(root, "specs", "inside-link.md"));
      await fs.symlink(join(root, "specs", "missing.md"), join(root, "specs", "dangling.md"));
    }),
    run: async (env) => finishExact(env, [
      await env.t.spec_search({ query: "token" }),
      await env.t.spec_search({ query: "token", id: "leak" }),
      await env.t.spec_read_section({ id: "leak", source_hash: "0".repeat(64), section_id: "preamble" }),
      await env.t.spec_read_section({ id: "inside-link", source_hash: "0".repeat(64), section_id: "preamble" }),
    ]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).corpus_files, 1);
    assert.equal(codeOf(outputs[1]), "SPEC_NOT_FOUND");
  });

  parity("safety: specs directory outside the root (relative and absolute), root problems", {
    setup: files({ "outside-specs/doc.md": "# T\n\ntoken\n" }),
    run: async (env) => {
      const outputs: string[] = [];
      for (const specs of ["../outside", "../../etc", "/", env.outside, "specs/../../outside", "./", ""]) {
        outputs.push(await makeTools(env.lib, env.root, { specs }, env.impl === "port").spec_search({ query: "token" }));
      }
      for (const root of [join(env.root, "nope"), join(env.root, "outside-specs", "doc.md"), `${env.root}/./`, `${env.root}//`]) {
        const tools = makeTools(env.lib, root, { specs: "outside-specs" }, env.impl === "port");
        outputs.push(await tools.spec_search({ query: "token" }));
        outputs.push(await tools.spec_read_section({ id: "doc", source_hash: "0".repeat(64), section_id: "preamble" }));
      }
      return finishExact(env, outputs);
    },
  }, ({ outputs }) => {
    assert.ok(outputs.slice(0, 4).every((text) => codeOf(text) === "CORPUS_UNAVAILABLE"));
  });

  parity("safety: the project root is itself reached through a symlink (cursor identity uses the real path)", {
    setup: files({ "specs/big.md": bigSection }),
    run: async (env) => {
      const link = join(env.root, "..", "root-link");
      await fs.rm(link, { force: true });
      await fs.symlink(env.root, link);
      const viaLink = makeTools(env.lib, link, { specs: "specs" }, env.impl === "port");
      const doc = env.lib.buildSpecDocument(bigSection, "specs/big.md", bigDocId) as DocLike;
      const section = doc.sections.find((s) => s.section_id !== "preamble");
      assert.ok(section);
      const input = { id: bigDocId, section_id: section.section_id, source_hash: doc.source_hash };
      const direct = await walkSection(env.t, input);
      const through = await walkSection(viaLink, input);
      assert.deepStrictEqual(through.map((p) => parsed(p).pagination), direct.map((p) => parsed(p).pagination));
      const crossed = await env.t.spec_read_section({ ...input, cursor: ((parsed(through[0]).pagination as { next_cursor: string }).next_cursor) });
      return finishExact(env, [...direct, ...through, crossed, await viaLink.spec_search({ query: "row" })]);
    },
  });

  test("safety: unreadable spec file", { skip: runningAsRoot() ? "running as root" : false }, async () => {
    await assertParity(sandbox, originLib, {
      setup: compose(files({ "specs/ok.md": "# Ok\n\ntoken\n", "specs/locked.md": "# Locked\n\ntoken\n" }), async ({ root }) => {
        await fs.chmod(join(root, "specs", "locked.md"), 0o000);
      }),
      run: async (env) => {
        const outputs = [
          await env.t.spec_search({ query: "token" }),
          await env.t.spec_search({ query: "token", id: "ok" }),
          await env.t.spec_read_section({ id: "locked", source_hash: "0".repeat(64), section_id: "preamble" }),
          await env.t.spec_read_section({ id: "ok", source_hash: "0".repeat(64), section_id: "preamble" }),
        ];
        await fs.chmod(join(env.root, "specs", "locked.md"), 0o600);
        return finishExact(env, outputs);
      },
    });
  });

  test("safety: unreadable specs directory", { skip: runningAsRoot() ? "running as root" : false }, async () => {
    await assertParity(sandbox, originLib, {
      setup: compose(files({ "specs/ok.md": "# Ok\n\ntoken\n" }), async ({ root }) => {
        await fs.chmod(join(root, "specs"), 0o000);
      }),
      run: async (env) => {
        const outputs = [
          await env.t.spec_search({ query: "token" }),
          await env.t.spec_read_section({ id: "ok", source_hash: "0".repeat(64), section_id: "preamble" }),
        ];
        await fs.chmod(join(env.root, "specs"), 0o755);
        return finishExact(env, outputs);
      },
    });
  });

  test("ambiguous ids on a case-sensitive filesystem", async (ctx) => {
    const probe = await fs.mkdtemp(join(tmpdir(), "specs-parity-probe-"));
    const sensitive = await caseSensitiveFs(probe).finally(() => fs.rm(probe, { recursive: true, force: true }));
    if (!sensitive) {
      ctx.skip("case-insensitive filesystem (the injected-readdir test below covers the same code path)");
      return;
    }
    const expected = await assertParity(sandbox, originLib, {
      setup: files({ "specs/Rule.md": "# Upper\n\ntoken\n", "specs/rule.md": "# Lower\n\ntoken\n", "specs/other.md": "# Other\n\ntoken\n" }),
      run: async (env) => finishExact(env, [
        await env.t.spec_search({ query: "token" }),
        await env.t.spec_search({ query: "token", id: "other" }),
        await env.t.spec_search({ query: "token", id: "rule" }),
        await env.t.spec_read_section({ id: "RULE", source_hash: "0".repeat(64), section_id: "preamble" }),
        await env.t.spec_read_section({ id: "other", source_hash: "0".repeat(64), section_id: "preamble" }),
      ]),
    });
    assert.equal(codeOf(expected.outputs[0]), "AMBIGUOUS_ID");
    assert.equal(codeOf(expected.outputs[3]), "AMBIGUOUS_ID");
  });

  // ── Injected I/O (same fake for both implementations) ────────────────────

  const realIo = () => ({
    realpath: (path: string) => fs.realpath(path),
    lstat: (path: string) => fs.lstat(path),
    readdir: (path: string, options: { withFileTypes: true }) => fs.readdir(path, options),
    open: (path: string, flags: number) => fs.open(path, flags),
    stat: (path: string) => fs.stat(path),
  });
  type Io = ReturnType<typeof realIo>;

  const entry = (name: string, file = true) => ({ name, isFile: () => file });
  const enoent = (): Error => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const eacces = (): Error => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

  const withIo = (env: RunEnv, mutate: (io: Io, env: RunEnv) => Partial<Io>) => ({ io: { ...realIo(), ...mutate(realIo(), env) } });

  const ioScenario = (
    name: string,
    mutate: (io: Io, env: RunEnv) => Partial<Io>,
    check?: (outputs: string[]) => void,
  ): void => {
    parity(`io: ${name}`, {
      setup: files({ "specs/doc.md": "# T\n\ntoken\n", "specs/Other.md": "# O\n\ntoken\n" }),
      run: async (env) => {
        const options = withIo(env, mutate);
        const hash = hashOf(env.lib, "# T\n\ntoken\n");
        return finishExact(env, [
          await env.t.spec_search({ query: "token" }, options),
          await env.t.spec_search({ query: "token", id: "doc" }, options),
          await env.t.spec_read_section({ id: "doc", source_hash: hash, section_id: "preamble" }, options),
          await env.t.spec_read_section({ id: "doc", source_hash: hash, section_id: "line:1" }, options),
        ]);
      },
    }, ({ outputs }) => check?.(outputs));
  };

  ioScenario("untouched real io", () => ({}), (outputs) => assert.equal(parsed(outputs[0]).corpus_files, 2));
  ioScenario("readdir fails with EACCES", () => ({ readdir: async () => { throw eacces(); } }), (outputs) => assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE"));
  ioScenario("readdir fails with ENOENT (empty corpus)", () => ({ readdir: async () => { throw enoent(); } }), (outputs) => assert.equal(parsed(outputs[0]).corpus_files, 0));
  ioScenario("readdir lists names differing only by case", () => ({
    readdir: async () => [entry("Rule.md"), entry("rule.md"), entry("x.md")] as never,
  }), (outputs) => assert.equal(codeOf(outputs[0]), "AMBIGUOUS_ID"));
  ioScenario("readdir lists directories and odd names", () => ({
    readdir: async () => [entry("doc.md"), entry("dir.md", false), entry(".md"), entry("a.MD"), entry("é.md")] as never,
  }));
  ioScenario("realpath of the root fails", (io, env) => ({
    realpath: (path) => (path === env.root ? Promise.reject(enoent()) : io.realpath(path)),
  }), (outputs) => assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE"));
  ioScenario("realpath of the specs directory fails with EACCES", (io, env) => ({
    realpath: (path) => (path === join(env.root, "specs") ? Promise.reject(eacces()) : io.realpath(path)),
  }), (outputs) => assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE"));
  ioScenario("lstat of a dangling ancestor fails with a non-ENOENT error", (io, env) => ({
    realpath: (path) => (path === join(env.root, "specs") ? Promise.reject(enoent()) : io.realpath(path)),
    lstat: async () => { throw eacces(); },
  }));
  ioScenario("realpath of a document escapes the root", (io, env) => ({
    realpath: (path) => (path === join(env.root, "specs", "doc.md") ? Promise.resolve(join(env.outside, "doc.md")) : io.realpath(path)),
  }), (outputs) => {
    assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE");
    assert.equal(codeOf(outputs[2]), "SOURCE_UNAVAILABLE");
  });
  ioScenario("document swapped for an escaping path between the two realpath calls", (io, env) => {
    const seen = new Map<string, number>();
    return {
      realpath: (path) => {
        const count = (seen.get(path) ?? 0) + 1;
        seen.set(path, count);
        return count >= 2 && path === join(env.root, "specs", "doc.md") ? Promise.resolve(join(env.outside, "doc.md")) : io.realpath(path);
      },
    };
  }, (outputs) => assert.equal(codeOf(outputs[2]), "SOURCE_UNAVAILABLE"));
  ioScenario("document swapped for another file with the same content (inode changes)", (io) => ({
    stat: async (path) => {
      const real = await io.stat(path);
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as typeof real, real, { ino: Number(real.ino) + 1 });
    },
  }), (outputs) => assert.equal(codeOf(outputs[2]), "SOURCE_UNAVAILABLE"));
  ioScenario("open fails", () => ({ open: async () => { throw eacces(); } }), (outputs) => assert.equal(codeOf(outputs[0]), "CORPUS_UNAVAILABLE"));
  ioScenario("opened handle is not a regular file", (io) => ({
    open: async (path, flags) => {
      const handle = await io.open(path, flags);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => Object.assign(await stat(), { isFile: () => false }) as never;
      return handle;
    },
  }), (outputs) => assert.equal(codeOf(outputs[2]), "SOURCE_UNAVAILABLE"));
  ioScenario("handle read fails, handle is still closed", (io) => ({
    open: async (path, flags) => {
      const handle = await io.open(path, flags);
      handle.readFile = async () => { throw eacces(); };
      return handle;
    },
  }), (outputs) => assert.equal(codeOf(outputs[1]), "CORPUS_UNAVAILABLE"));
  ioScenario("content changes between inventory and read (hash mismatch)", (io, env) => ({
    open: async (path, flags) => {
      await fs.writeFile(join(env.root, "specs", "doc.md"), "# T\n\nchanged token\n");
      return io.open(path, flags);
    },
  }));

  test("io: both implementations call the io in the same order with the same arguments", async () => {
    const trace = async (lib: Lib, impl: "origin" | "port"): Promise<string[][]> => {
      const log: string[][] = [];
      await sandbox.reset(files({ "specs/doc.md": "# T\n\ntoken\n", "specs/b.md": "# B\n\ntoken\n" }));
      const t = makeTools(lib, sandbox.root, { specs: "specs" }, impl === "port");
      const base = realIo();
      const rel = (value: string): string => value.replace(sandbox.root, "<root>");
      const io = {
        realpath: (p: string) => (log.push(["realpath", rel(p)]), base.realpath(p)),
        lstat: (p: string) => (log.push(["lstat", rel(p)]), base.lstat(p)),
        readdir: (p: string, o: { withFileTypes: true }) => (log.push(["readdir", rel(p)]), base.readdir(p, o)),
        open: (p: string, f: number) => (log.push(["open", rel(p), String(f)]), base.open(p, f)),
        stat: (p: string) => (log.push(["stat", rel(p)]), base.stat(p)),
      };
      log.push(["--search"]);
      await t.spec_search({ query: "token" }, { io });
      log.push(["--section"]);
      await t.spec_read_section({ id: "doc", source_hash: hashOf(lib, "# T\n\ntoken\n"), section_id: "preamble" }, { io });
      return log;
    };
    assert.deepStrictEqual(await trace(portLib, "port"), await trace(originLib, "origin"));
  });

  test("abort signals: aborted before and during the call", async () => {
    const attempt = async (lib: Lib, impl: "origin" | "port", mode: "before" | "during"): Promise<unknown> => {
      await sandbox.reset(files({ "specs/doc.md": "# T\n\ntoken\n" }));
      const t = makeTools(lib, sandbox.root, { specs: "specs" }, impl === "port");
      const controller = new AbortController();
      const base = realIo();
      const io = mode === "before" ? base : { ...base, readdir: async (p: string, o: { withFileTypes: true }) => { controller.abort(); return base.readdir(p, o); } };
      if (mode === "before") controller.abort();
      const outcome = async (run: () => Promise<string>): Promise<unknown> => {
        try {
          return { ok: await run() };
        } catch (error) {
          return { threw: (error as Error).name, message: (error as Error).message };
        }
      };
      return [
        await outcome(() => t.spec_search({ query: "token" }, { signal: controller.signal, io })),
        await outcome(() => t.spec_read_section({ id: "doc", source_hash: "0".repeat(64), section_id: "preamble" }, { signal: controller.signal, io })),
      ];
    };
    for (const mode of ["before", "during"] as const) {
      const expected = await attempt(originLib, "origin", mode);
      assert.deepStrictEqual(await attempt(portLib, "port", mode), expected, mode);
      assert.ok(JSON.stringify(expected).includes("AbortError"), `${mode}: the abort must surface as an AbortError`);
    }
  });

  // ── Seeded fuzz ───────────────────────────────────────────────────────────

  const VOCAB = ["alpha", "beta", "gamma", "delta", "token", "session", "café", "naïve", "日本語", "テスト", "über", "ñandú", "x1", "42", "zebra", "fence", "héllo", "ÜNÏ", "résumé", "data", "a", "emoji😀word"];

  const randomDoc = (next: () => number): string => {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const words = (min: number, max: number): string =>
      Array.from({ length: min + Math.floor(next() * (max - min + 1)) }, () => pick(VOCAB)).join(next() < 0.9 ? " " : "  ");
    const eol = next() < 0.2 ? "\r\n" : "\n";
    const out: string[] = [];
    if (next() < 0.6) {
      out.push("---", `title: "${words(1, 3)}"`, `type: ${pick(["technical", "functional", "architectural"])}`, `status: ${pick(["draft", "active", "Active"])}`, next() < 0.9 ? "---" : "---   ");
    }
    const count = 4 + Math.floor(next() * 140);
    for (let i = 0; i < count; i += 1) {
      const roll = next();
      if (roll < 0.18) out.push(`${" ".repeat(Math.floor(next() * 5))}${"#".repeat(1 + Math.floor(next() * 7))}${next() < 0.1 ? "" : " "}${words(0, 4)}`);
      else if (roll < 0.26) out.push(pick(["```", "```js", "~~~", "````", "``` a`b", "  ```", "~~~~", "    ```"]));
      else if (roll < 0.31) out.push(pick(["```", "~~~", "````", "~~~~  ", "``` x"]));
      else if (roll < 0.4) out.push("");
      else if (roll < 0.42) out.push("---");
      else if (roll < 0.44) out.push(words(300, 500));
      else out.push(words(1, 40));
    }
    return out.join(eol) + (next() < 0.8 ? eol : "");
  };

  test("fuzz: random corpora, random queries and filters, every section read back", async () => {
    let nonEmpty = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = prng(seed * 104_729);
      const corpus: Record<string, string> = {};
      const docs = 1 + Math.floor(next() * 8);
      for (let i = 0; i < docs; i += 1) corpus[`specs/${["Doc", "doc", "zeta", "Alpha", "ünï", "n-1"][i % 6]}${i}.md`] = randomDoc(next);
      const inputs: unknown[] = [];
      for (let i = 0; i < 14; i += 1) {
        const query = Array.from({ length: 1 + Math.floor(next() * 4) }, () => VOCAB[Math.floor(next() * VOCAB.length)]).join(" ");
        const input: Record<string, unknown> = { query };
        if (next() < 0.25) input.type = ["technical", "FUNCTIONAL", "architectural"][Math.floor(next() * 3)];
        if (next() < 0.25) input.status = ["draft", "ACTIVE"][Math.floor(next() * 2)];
        if (next() < 0.2) input.id = Object.keys(corpus)[Math.floor(next() * docs)]?.slice(6, -3);
        inputs.push(input);
      }
      const expected = await assertParity(sandbox, originLib, {
        setup: files(corpus),
        run: async (env) => finishExact(env, [...(await searchAll(env.t, inputs)), ...(await readEverySection(env))]),
      }, `seed=${seed}`);
      nonEmpty += expected.outputs.filter((text) => resultsOf(text).length > 0).length;
    }
    assert.ok(nonEmpty > 100, `fuzz must produce real results (got ${nonEmpty})`);
  });

  test("fuzz: buildSpecDocument on random documents", async () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const content = randomDoc(prng(seed * 7_907));
      await assertPureParity(originLib, (lib) => lib.buildSpecDocument(content, "specs/x.md", "x", "/c/x.md"), `seed=${seed}`);
    }
  });
});
