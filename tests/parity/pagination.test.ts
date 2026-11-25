/**
 * Differential parity: spec_get and the pagination layer against the original
 * `tools/lifecycle.js` + `tools/artifact-pagination.js`. Pages and cursors are compared as
 * serialized strings (byte-identical), over full cursor walks. Both implementations run on the
 * same root path (cursors hash absolute paths), each on a fresh copy. No deviation is neutralised
 * here: spec_get has none.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { after, before, test } from "node:test";
import {
  Sandbox,
  assertParity,
  assertPureParity,
  decodeCursor,
  encodeCursor,
  files,
  finishExact,
  frontmatter,
  makeTools,
  parityDescribe,
  portLib,
  prng,
  reassemble,
  runOn,
  sha256,
  walkGet,
} from "./helpers.js";
import type { Lib, Outcome, Scenario } from "./helpers.js";

const EMOJI = "😀";
const doc = (body: string, fm = frontmatter()): string => `${fm}${body}`;

const lines = (count: number, make: (n: number) => string, eol = "\n"): string =>
  Array.from({ length: count }, (_, n) => make(n)).join(eol) + eol;

const pageOf = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
const cursorOf = (text: string): string => {
  const next = (pageOf(text).pagination as { next_cursor: string | null } | undefined)?.next_cursor;
  assert.equal(typeof next, "string", `expected a next_cursor in ${text.slice(0, 200)}`);
  return next as string;
};

/** Capture what a pure call throws (message + code) or returns, comparably across the two classes. */
const capture = (run: () => unknown): unknown => {
  try {
    return { ok: run() };
  } catch (err) {
    const error = err as Error & { code?: unknown };
    return { threw: error.message, code: error.code };
  }
};

parityDescribe("parity: spec_get and pagination", (originLib: Lib) => {
  let sandbox: Sandbox;
  before(async () => {
    sandbox = await Sandbox.create("specs-parity-pagination-");
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

  /** Full cursor walk of one spec, compared page by page, plus a losslessness check. */
  const walkParity = (name: string, content: string, expectPages: (pages: number) => boolean): void => {
    parity(`get walk: ${name}`, {
      setup: files({ "specs/doc.md": content }),
      run: async ({ t, ...env }) => finishExact(env, await walkGet(t, "doc")),
    }, ({ outputs }) => {
      assert.ok(expectPages(outputs.length), `unexpected number of pages: ${outputs.length}`);
      assert.equal(reassemble(outputs), content);
      for (const page of outputs) assert.ok(Buffer.byteLength(page, "utf8") <= originLib.PAGE_BYTES);
    });
  };

  test("limits are identical", () => {
    assert.equal(portLib.PAGE_BYTES, originLib.PAGE_BYTES);
    assert.equal(portLib.MAX_CURSOR_BYTES, originLib.MAX_CURSOR_BYTES);
    assert.equal(originLib.PAGE_BYTES, 16_384);
    assert.equal(originLib.MAX_CURSOR_BYTES, 1_024);
  });

  // ── spec_get: content shapes ──────────────────────────────────────────────

  walkParity("small file (one page)", doc("# Small\n\nhello\n"), (n) => n === 1);
  walkParity("empty file", "", (n) => n === 1);
  walkParity("frontmatter only", frontmatter(), (n) => n === 1);
  walkParity("just under one page", doc(lines(200, (n) => `line ${n} `.padEnd(60, "x"))), (n) => n >= 1 && n <= 2);
  walkParity("above 16 KB", doc(lines(400, (n) => `line ${n} `.padEnd(80, "y"))), (n) => n >= 2);
  walkParity("above 64 KB", doc(lines(1_500, (n) => `line ${n} `.padEnd(80, "z"))), (n) => n >= 5);
  walkParity("above 64 KB, no newline at all", doc("n".repeat(70_000)), (n) => n >= 5);
  walkParity("CRLF, above 64 KB", doc(lines(1_500, (n) => `crlf ${n} `.padEnd(80, "c"), "\r\n"), frontmatter().replaceAll("\n", "\r\n")), (n) => n >= 5);
  walkParity("lone CR line endings", doc(lines(900, (n) => `cr ${n} `.padEnd(70, "r"), "\r")), (n) => n >= 3);
  walkParity("JSON-escaped characters everywhere", doc(lines(900, (n) => `q"uote\\back\tslash ${n} `.padEnd(60, "e"))), (n) => n >= 3);
  walkParity("accents and 3-byte characters", doc(lines(700, (n) => `é à ü 世界 ${n} `.padEnd(60, "é"))), (n) => n >= 2);
  walkParity("emoji only, no newline", doc(EMOJI.repeat(20_000)), (n) => n >= 3);
  walkParity("emoji mixed with ASCII lines", doc(lines(800, (n) => `${EMOJI}${n}${EMOJI.repeat(35)}`)), (n) => n >= 3);
  walkParity("trailing BOM and NUL bytes", doc(`\ufeff${"a".repeat(20_000)}\u0000${"b".repeat(20_000)}`), (n) => n >= 3);
  walkParity("one 200 KB line", doc("L".repeat(200_000)), (n) => n >= 12);

  test("get walk: emoji straddling the page boundary, sweep of the padding", async () => {
    for (let pad = 0; pad < 12; pad += 1) {
      const content = doc(`${"a".repeat(15_900 + pad)}${EMOJI.repeat(400)}\n${"é".repeat(8_300)}`);
      const expected = await assertParity(sandbox, originLib, {
        setup: files({ "specs/doc.md": content }),
        run: async ({ t, ...env }) => finishExact(env, await walkGet(t, "doc")),
      }, `pad=${pad}`);
      assert.equal(reassemble(expected.outputs), content, `pad=${pad}`);
    }
  });

  test("get walk: seeded random mixtures of ASCII, accents, emoji and line endings", async () => {
    const alphabet = ["a", "b", " ", "\n", "\r\n", "é", "世", EMOJI, "𝒳", '"', "\\", "\t", "\r"];
    for (const seed of [1, 7, 42, 2026, 31337, 123456]) {
      const next = prng(seed);
      const size = 18_000 + Math.floor(next() * 60_000);
      let body = "";
      while (body.length < size) body += alphabet[Math.floor(next() * alphabet.length)]?.repeat(1 + Math.floor(next() * 3));
      const content = doc(body);
      const expected = await assertParity(sandbox, originLib, {
        setup: files({ "specs/doc.md": content }),
        run: async ({ t, ...env }) => finishExact(env, await walkGet(t, "doc")),
      }, `seed=${seed}`);
      assert.equal(reassemble(expected.outputs), content, `seed=${seed}`);
    }
  });

  // ── spec_get: metadata ────────────────────────────────────────────────────

  parity("get: frontmatter metadata eating the page budget (sweep up to and past the limit)", {
    setup: files({
      "specs/a-100.md": doc("body\n", frontmatter({ title: `"${"t".repeat(100)}"` })),
      "specs/b-8000.md": doc("body\n".repeat(5_000), frontmatter({ title: `"${"t".repeat(8_000)}"` })),
      "specs/c-16000.md": doc("body\n".repeat(100), frontmatter({ title: `"${"t".repeat(16_000)}"` })),
      "specs/d-16200.md": doc("body\n".repeat(100), frontmatter({ title: `"${"t".repeat(16_200)}"` })),
      "specs/e-16300.md": doc("body\n".repeat(100), frontmatter({ title: `"${"t".repeat(16_300)}"` })),
      "specs/f-16384.md": doc("body\n".repeat(100), frontmatter({ title: `"${"t".repeat(16_384)}"` })),
      "specs/g-30000.md": doc("body\n", frontmatter({ title: `"${"t".repeat(30_000)}"` })),
      "specs/h-quoted.md": doc("body\n".repeat(3_000), frontmatter({ title: `"${'\\"'.repeat(3_000)}"`, status: EMOJI.repeat(500) })),
    }),
    run: async ({ t, ...env }) => {
      const outputs: string[] = [];
      for (const id of ["a-100", "b-8000", "c-16000", "d-16200", "e-16300", "f-16384", "g-30000", "h-quoted"]) {
        outputs.push(...(await walkGet(t, id, 50)));
      }
      return finishExact(env, outputs);
    },
  }, ({ outputs }) => {
    assert.ok(outputs.some((text) => pageOf(text).code === "PAGE_BUDGET_EXCEEDED"), "the sweep must reach the budget error");
    assert.ok(outputs.some((text) => pageOf(text).content !== undefined));
  });

  parity("get: frontmatter shapes (none, CRLF, quotes, unknown keys, duplicate keys)", {
    setup: files({
      "specs/none.md": "# no frontmatter\n",
      "specs/crlf.md": '---\r\ntitle: "C"\r\nid: crlf\r\n---\r\nbody\r\n',
      "specs/quotes.md": "---\ntitle: 'single'\nid: \"dbl\\\"esc\"\nextra key: some: value: here\n# comment: x\n---\nbody\n",
      "specs/dup.md": "---\ntitle: first\ntitle: second\n---\nbody\n",
      "specs/unclosed.md": "---\ntitle: nope\nbody\n",
    }),
    run: async ({ t, ...env }) => finishExact(env, await Promise.all(["none", "crlf", "quotes", "dup", "unclosed"].map((id) => t.spec_get({ id })))),
  });

  // ── spec_get: errors ──────────────────────────────────────────────────────

  parity("get: unknown id, missing directory, odd ids", {
    setup: files({ "specs/Doc.md": "x", "specs/Dir.md/inner.md": "y" }),
    run: async ({ t, ...env }) => finishExact(env, [
      await t.spec_get({ id: "nope" }),
      await t.spec_get({ id: "" }),
      await t.spec_get({ id: "../Doc" }),
      await t.spec_get({ id: "DOC" }),
      await t.spec_get({ id: "Dir" }),
      await t.spec_get({ id: EMOJI.repeat(400) }),
      await t.spec_get({ id: "x".repeat(1_000) }),
    ]),
  }, ({ outputs }) => {
    assert.match(pageOf(outputs[0] ?? "").error as string, /^Artifact with id "nope" not found in specs$/);
    assert.match(pageOf(outputs[5] ?? "").error as string, /diagnostic shortened/);
  });

  parity("get: specs directory missing", {
    run: async ({ t, ...env }) => finishExact(env, [await t.spec_get({ id: "x" })]),
  }, ({ outputs }) => {
    assert.equal(pageOf(outputs[0] ?? "").error, 'Directory not found: specs (looking for id "x")');
  });

  // ── spec_get: cursors ─────────────────────────────────────────────────────

  const multiPage = doc(lines(900, (n) => `row ${n} `.padEnd(70, "m")));

  test("cursors: forged and malformed cursors get the same answer", async () => {
    await sandbox.reset(files({ "specs/doc.md": multiPage, "specs/other.md": multiPage }));
    const toolsFor = (lib: Lib) => makeTools(lib, sandbox.root, { specs: "specs" }, lib === portLib);
    const first = pageOf(await toolsFor(originLib).spec_get({ id: "doc" }));
    const valid = (first.pagination as { next_cursor: string }).next_cursor;
    const good = decodeCursor(valid);
    const length = multiPage.length;
    const sha = await sha256(multiPage);

    const forged: Array<[string, unknown]> = [
      ["empty string", ""],
      ["not base64url", "!!!not-a-cursor!!!"],
      ["padding characters", `${valid}==`],
      ["non-canonical trailing bits", `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`],
      ["truncated", valid.slice(0, valid.length - 7)],
      ["too long (> 1024 bytes)", "A".repeat(1_025)],
      ["exactly 1024 bytes of garbage", "A".repeat(1_024)],
      ["a number", 12],
      ["null", null],
      ["an object", { a: 1 }],
      ["an array", [valid]],
      ["true", true],
      ["valid JSON, not an object", encodeCursor("text")],
      ["valid JSON array", encodeCursor([good])],
      ["JSON null", encodeCursor(null)],
      ["missing key", encodeCursor({ v: good.v, t: good.t, a: good.a, h: good.h })],
      ["extra key", encodeCursor({ ...good, x: 1 })],
      ["wrong version", encodeCursor({ ...good, v: 2 })],
      ["version as string", encodeCursor({ ...good, v: "1" })],
      ["wrong tool", encodeCursor({ ...good, t: "spec_read_section" })],
      ["wrong identity", encodeCursor({ ...good, a: "0".repeat(64) })],
      ["hash not hex", encodeCursor({ ...good, h: "z".repeat(64) })],
      ["hash upper case", encodeCursor({ ...good, h: String(good.h).toUpperCase() })],
      ["hash too short", encodeCursor({ ...good, h: "ab" })],
      ["stale hash", encodeCursor({ ...good, h: "0".repeat(64) })],
      ["position zero", encodeCursor({ ...good, p: 0 })],
      ["negative position", encodeCursor({ ...good, p: -5 })],
      ["fractional position", encodeCursor({ ...good, p: 1.5 })],
      ["position as string", encodeCursor({ ...good, p: "10" })],
      ["unsafe integer position", encodeCursor({ ...good, p: 2 ** 60 })],
      ["position at the end", encodeCursor({ ...good, p: length })],
      ["position past the end", encodeCursor({ ...good, p: length + 10 })],
      ["position one before the end", encodeCursor({ ...good, p: length - 1 })],
      ["position 1", encodeCursor({ ...good, p: 1 })],
      ["same position as the page", encodeCursor({ ...good })],
      ["keys in another order", Buffer.from(JSON.stringify({ p: good.p, v: good.v, t: good.t, a: good.a, h: good.h })).toString("base64url")],
      ["whitespace in the JSON", Buffer.from(JSON.stringify(good, null, 1)).toString("base64url")],
      ["stale and out of range", encodeCursor({ ...good, h: "0".repeat(64), p: length + 99 })],
      ["correct hash recomputed", encodeCursor({ ...good, h: sha })],
    ];

    for (const [label, cursor] of forged) {
      const expected = await toolsFor(originLib).spec_get({ id: "doc", cursor });
      const actual = await toolsFor(portLib).spec_get({ id: "doc", cursor });
      assert.equal(actual, expected, `cursor: ${label}`);
    }

    const other = await toolsFor(originLib).spec_get({ id: "other", cursor: valid });
    assert.equal(await toolsFor(portLib).spec_get({ id: "other", cursor: valid }), other, "cursor of another spec");
    assert.equal(pageOf(other).code, "INVALID_CURSOR");
  });

  test("cursors: both implementations accept each other's cursors, page after page", async () => {
    await sandbox.reset(files({ "specs/doc.md": doc(lines(2_000, (n) => `row ${n} `.padEnd(70, "m"))) }));
    const origin = makeTools(originLib, sandbox.root, { specs: "specs" }, false);
    const port = makeTools(portLib, sandbox.root, { specs: "specs" }, true);
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const fromOrigin = await origin.spec_get({ id: "doc", cursor });
      const fromPort = await port.spec_get({ id: "doc", cursor });
      assert.equal(fromPort, fromOrigin, `page ${pages}`);
      pages += 1;
      const next = (pageOf(fromOrigin).pagination as { next_cursor: string | null }).next_cursor;
      if (next === null) break;
      cursor = next;
      assert.ok(pages < 100);
    }
    assert.ok(pages > 5);
  });

  const staleScenario = (
    name: string,
    mutate: (env: { root: string }) => Promise<void>,
    expectedCode: "STALE_CURSOR" | "INVALID_CURSOR" | "error" | "still valid",
  ): void => {
    parity(`stale cursor: ${name}`, {
      setup: files({ "specs/doc.md": multiPage }),
      run: async ({ t, ...env }) => {
        const first = await t.spec_get({ id: "doc" });
        const second = await t.spec_get({ id: "doc", cursor: cursorOf(first) });
        const cursor = cursorOf(first);
        await mutate(env);
        return finishExact(env, [first, second, await t.spec_get({ id: "doc", cursor }), await t.spec_get({ id: "doc" })]);
      },
    }, ({ outputs }) => {
      const after = pageOf(outputs[2] ?? "");
      if (expectedCode === "error") assert.ok(typeof after.error === "string" && after.code === undefined);
      else if (expectedCode === "still valid") assert.equal(after.error, undefined);
      else assert.equal(after.code, expectedCode);
    });
  };

  staleScenario("one character changed", async ({ root }) => {
    await fs.writeFile(`${root}/specs/doc.md`, multiPage.replace("row 3 ", "row X "));
  }, "STALE_CURSOR");
  staleScenario("file shortened below the cursor", async ({ root }) => {
    await fs.writeFile(`${root}/specs/doc.md`, doc("tiny\n"));
  }, "STALE_CURSOR");
  staleScenario("file lengthened", async ({ root }) => {
    await fs.appendFile(`${root}/specs/doc.md`, "more\n");
  }, "STALE_CURSOR");
  staleScenario("file replaced by identical content", async ({ root }) => {
    await fs.writeFile(`${root}/specs/doc.md`, multiPage);
  }, "still valid");
  staleScenario("file deleted", async ({ root }) => {
    await fs.rm(`${root}/specs/doc.md`);
  }, "error");
  staleScenario("file recreated as a different spec (frontmatter changed)", async ({ root }) => {
    await fs.writeFile(`${root}/specs/doc.md`, doc(multiPage.slice(frontmatter().length), frontmatter({ status: "active" })));
  }, "STALE_CURSOR");

  parity("stale cursor: through spec_update", {
    setup: files({ "specs/doc.md": multiPage }),
    run: async ({ t, ...env }) => {
      const first = await t.spec_get({ id: "doc" });
      const update = await t.spec_update({ id: "doc", old_string: "row 5 ", new_string: "row five " });
      return finishExact(env, [first, update, await t.spec_get({ id: "doc", cursor: cursorOf(first) }), await t.spec_get({ id: "doc" })]);
    },
  }, ({ outputs }) => {
    assert.equal(pageOf(outputs[2] ?? "").code, "STALE_CURSOR");
  });

  parity("cursor identity depends on the root: a cursor from another root is rejected the same way", {
    setup: files({ "specs/doc.md": multiPage }),
    run: async ({ t, lib, paths, ...env }) => {
      const first = await t.spec_get({ id: "doc" });
      const elsewhere = makeTools(lib, `${env.root}/specs/..//`, paths, false);
      const trailing = makeTools(lib, `${env.root}/`, paths, false);
      return finishExact(env, [
        first,
        await elsewhere.spec_get({ id: "doc", cursor: cursorOf(first) }),
        await trailing.spec_get({ id: "doc", cursor: cursorOf(first) }),
        await trailing.spec_get({ id: "doc" }),
      ]);
    },
  });

  // ── Pure pagination: paginateArtifact, serializers ────────────────────────

  const paginateAll = (lib: Lib, content: string, metadata: Record<string, unknown>, tool = "spec_get"): unknown[] => {
    const out: unknown[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 2_000; i += 1) {
      const result = capture(() =>
        lib.paginateArtifact({ tool, projectRoot: "/proj/root", artifactPath: "/proj/root/specs/x.md", content, metadata, cursor }),
      );
      out.push(result);
      const next = (result as { ok?: { pagination?: { next_cursor?: string | null } } }).ok?.pagination?.next_cursor;
      if (typeof next !== "string") break;
      cursor = next;
    }
    return out;
  };

  test("paginateArtifact: content length sweep around one page (final-envelope transitions)", async () => {
    for (let length = 15_900; length <= 16_500; length += 1) {
      const content = "a".repeat(length);
      await assertPureParity(originLib, (lib) => paginateAll(lib, content, { file: "specs/x.md", frontmatter: { title: "T" } }), `length=${length}`);
    }
  });

  test("paginateArtifact: line-length sweep with LF, CRLF and CR endings", async () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      for (let lineLength = 1; lineLength <= 140; lineLength += 1) {
        const content = ("x".repeat(lineLength) + eol).repeat(Math.ceil(40_000 / (lineLength + eol.length)));
        await assertPureParity(
          originLib,
          (lib) => paginateAll(lib, content, { file: "f", frontmatter: {} }),
          `eol=${JSON.stringify(eol)} lineLength=${lineLength}`,
        );
      }
    }
  });

  test("paginateArtifact: surrogate pairs at every offset of the page boundary", async () => {
    for (let pad = 0; pad < 400; pad += 1) {
      const content = `${"a".repeat(16_000 + pad)}${EMOJI.repeat(120)}${"b".repeat(100)}`;
      const results = await assertPureParity(originLib, (lib) => paginateAll(lib, content, { file: "f" }), `pad=${pad}`);
      for (const result of results) {
        const page = (result as { ok?: { content: string } }).ok?.content ?? "";
        assert.ok(!/[\ud800-\udbff]$/.test(page) && !/^[\udc00-\udfff]/.test(page), `pad=${pad}: page split a surrogate pair`);
      }
    }
  });

  test("paginateArtifact: lone surrogates and control characters", async () => {
    const content = `${"\ud83d".repeat(9_000)}\n${"\ude00".repeat(9_000)}\u0000\u2028\u2029${"\ud83d\ude00".repeat(5_000)}`;
    await assertPureParity(originLib, (lib) => paginateAll(lib, content, { file: "f" }));
  });

  test("paginateArtifact: metadata sweep up to the budget error", async () => {
    for (let size = 0; size <= 17_000; size += 97) {
      const metadata = { file: "specs/x.md", frontmatter: { title: "t".repeat(size) } };
      for (const content of ["", "short", "line\n".repeat(5_000)]) {
        await assertPureParity(originLib, (lib) => paginateAll(lib, content, metadata), `size=${size}`);
      }
    }
  });

  test("paginateArtifact: tool name, identity and cursor argument types", async () => {
    const content = "row\n".repeat(20_000);
    const cursorFor = (lib: Lib): string => {
      const first = lib.paginateArtifact({ tool: "spec_get", projectRoot: "/r", artifactPath: "/r/a.md", content, metadata: {} }) as {
        pagination: { next_cursor: string };
      };
      return first.pagination.next_cursor;
    };
    const cursor = cursorFor(originLib);
    assert.equal(cursorFor(portLib), cursor);
    const variants: Array<[string, Record<string, unknown>]> = [
      ["same", {}],
      ["other tool", { tool: "spec_read_section" }],
      ["other root", { projectRoot: "/r2" }],
      ["root with trailing slash", { projectRoot: "/r/" }],
      ["unnormalised root", { projectRoot: "/r/./x/.." }],
      ["other artifact", { artifactPath: "/r/b.md" }],
      ["unnormalised artifact", { artifactPath: "/r/sub/../a.md" }],
      ["other content", { content: `${content}x` }],
      ["null cursor", { cursor: null }],
      ["number cursor", { cursor: 3 }],
      ["empty cursor", { cursor: "" }],
    ];
    for (const [label, override] of variants) {
      const args = { tool: "spec_get", projectRoot: "/r", artifactPath: "/r/a.md", content, metadata: { m: 1 }, cursor, ...override };
      assert.deepStrictEqual(
        capture(() => portLib.paginateArtifact(args)),
        capture(() => originLib.paginateArtifact(args)),
        label,
      );
    }
  });

  test("serializeGetterPage: size boundary and shapes", async () => {
    const shapes: unknown[] = [
      { content: "a" },
      { content: "a".repeat(16_300) },
      { content: "é".repeat(8_192) },
      { content: "é".repeat(8_193) },
      { content: "é".repeat(8_180) },
      { content: EMOJI.repeat(4_096) },
      { content: "x".repeat(20_000) },
      {},
      [],
      null,
      "text",
      42,
      { nested: { deep: ["x".repeat(16_390)] } },
    ];
    for (let length = 16_340; length <= 16_400; length += 1) shapes.push({ content: "a".repeat(length - 14) });
    for (const shape of shapes) {
      await assertPureParity(originLib, (lib) => capture(() => lib.serializeGetterPage(shape)));
    }
  });

  test("serializeGetterError: messages, truncation at 256 code points, non-Error values", async () => {
    const messages = [
      "",
      "short",
      "a".repeat(255),
      "a".repeat(256),
      "a".repeat(257),
      "a".repeat(2_000),
      EMOJI.repeat(256),
      EMOJI.repeat(257),
      EMOJI.repeat(1_000),
      `${"a".repeat(255)}${EMOJI}${"b".repeat(600)}`,
      `${"a".repeat(300)}\ud83d`,
      `${EMOJI}${"x".repeat(1_000)}${EMOJI}`,
      "x".repeat(256) + "é".repeat(300),
      "line\nbreak \"quote\" \\ backslash",
    ];
    const values: unknown[] = [
      ...messages.map((message) => new Error(message)),
      ...messages,
      new TypeError("typed"),
      Object.assign(new Error("with code"), { code: "ENOENT" }),
      undefined,
      null,
      42,
      { message: "an object" },
      ["array"],
      Symbol.for("sym").description,
    ];
    for (const value of values) {
      await assertPureParity(originLib, (lib) => lib.serializeGetterError(value));
    }
  });

  test("pagination errors keep their code through serializeGetterError", async () => {
    const budget = (lib: Lib): string => {
      try {
        lib.paginateArtifact({ tool: "spec_get", projectRoot: "/r", artifactPath: "/r/a.md", content: "x", metadata: { big: "y".repeat(20_000) } });
        return "no error";
      } catch (err) {
        return lib.serializeGetterError(err);
      }
    };
    const invalid = (lib: Lib): string => {
      try {
        lib.paginateArtifact({ tool: "spec_get", projectRoot: "/r", artifactPath: "/r/a.md", content: "x", metadata: {}, cursor: "bad" });
        return "no error";
      } catch (err) {
        return lib.serializeGetterError(err);
      }
    };
    const expectedBudget = await assertPureParity(originLib, budget);
    const expectedInvalid = await assertPureParity(originLib, invalid);
    assert.equal(pageOf(expectedBudget).code, "PAGE_BUDGET_EXCEEDED");
    assert.equal(pageOf(expectedInvalid).code, "INVALID_CURSOR");
  });

  test("paginateArtifact: seeded random contents, random metadata, walked to the end", async () => {
    const alphabet = ["a", "bc", " ", "\n", "\r\n", "\r", "é", "世", EMOJI, "\ud83d", "\ude00", '"', "\\", "\u0000"];
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = prng(seed * 7919);
      const size = Math.floor(next() * 70_000);
      let content = "";
      while (content.length < size) content += alphabet[Math.floor(next() * alphabet.length)]?.repeat(1 + Math.floor(next() * 6));
      const metadata = { file: "specs/x.md", frontmatter: { title: "t".repeat(Math.floor(next() * 3_000)) } };
      await assertPureParity(originLib, (lib) => paginateAll(lib, content, metadata), `seed=${seed}`);
    }
  });

  test("runOn leaves no state behind: a repeated spec_get is deterministic", async () => {
    const scenario: Scenario<string[]> = {
      setup: files({ "specs/doc.md": multiPage }),
      run: async ({ t }) => walkGet(t, "doc"),
    };
    const first = await runOn(sandbox, portLib, "port", scenario);
    const second = await runOn(sandbox, portLib, "port", scenario);
    assert.deepStrictEqual(second, first);
  });
});
