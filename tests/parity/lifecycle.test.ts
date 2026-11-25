/**
 * Differential parity: spec_create / spec_update / spec_validate / spec_list / spec_delete /
 * spec_format against the original `tools/lifecycle.js`. See tests/parity/helpers.ts for the
 * harness and the (only) neutralised differences: `warnings` in spec_validate and the `created` date.
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
  files,
  finish,
  frontmatter,
  jsonCall,
  parityDescribe,
  portLib,
  runningAsRoot,
} from "./helpers.js";
import type { Lib, Outcome, RunEnv, Scenario } from "./helpers.js";

const parsed = (text: string | undefined): Record<string, unknown> => JSON.parse(text ?? "null") as Record<string, unknown>;

parityDescribe("parity: spec lifecycle", (originLib: Lib) => {
  let sandbox: Sandbox;
  before(async () => {
    sandbox = await Sandbox.create("specs-parity-lifecycle-");
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

  const created = (title: string, type?: string, content?: string) => ({ title, type, content });

  // ── spec_create ───────────────────────────────────────────────────────────

  parity("create: simple title", {
    run: async ({ t, ...env }) => finish(env, [await t.spec_create(created("Simple Title"))]),
  }, ({ outputs, fs: tree }) => {
    assert.equal(parsed(outputs[0]).id, "simple-title");
    assert.ok(tree["specs/simple-title.md"]?.startsWith('---\ntitle: "Simple Title"\nid: simple-title\n'));
  });

  parity("create: accents are dropped, not transliterated", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("Spécification Éléphant Été")),
      await t.spec_create(created("Ça va? Où?")),
      await t.spec_create(created("Cafe\u0301 décomposé")),
      await t.spec_create(created("日本語 only")),
    ]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).id, "spcification-lphant-t");
    assert.equal(parsed(outputs[1]).id, "a-va-o");
    assert.equal(parsed(outputs[3]).id, "only");
  });

  parity("create: quotes in the title", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created('He said "hello" and \'bye\'')),
      await t.spec_create(created('"')),
      await t.spec_create(created('a"b"c', 'quo"ted')),
    ]),
  }, ({ fs: tree }) => {
    assert.match(tree["specs/he-said-hello-and-bye.md"] ?? "", /^---\ntitle: "He said \\"hello\\" and 'bye'"\n/);
  });

  parity("create: backslashes in the title and the type", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("C:\\dir\\file")),
      await t.spec_create(created("trailing backslash \\", "back\\slash")),
      await t.spec_create(created('mix \\" mix', 'q\\"')),
    ]),
  }, ({ fs: tree }) => {
    assert.match(tree["specs/cdirfile.md"] ?? "", /title: "C:\\\\dir\\\\file"/);
  });

  parity("create: line breaks in the title and the type", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("Line one\nLine two\r\nThree\rFour")),
      await t.spec_create(created("typed", "multi\nline\r\ntype")),
      await t.spec_create(created("\n\nleading breaks\n\n")),
    ]),
  }, ({ fs: tree }) => {
    assert.match(tree["specs/line-one-line-two-three-four.md"] ?? "", /title: "Line one Line two {2}Three Four"\n/);
  });

  parity("create: collisions", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("Same Title")),
      await t.spec_create(created("Same Title", "functional", "other body")),
      await t.spec_create(created("same-title")),
      await t.spec_create(created("  SAME   title  ")),
      await t.spec_create(created("Same Title!!")),
    ]),
  }, ({ outputs, fs: tree }) => {
    assert.equal(parsed(outputs[0]).created, true);
    for (const text of outputs.slice(1)) assert.match(parsed(text).error as string, /^Spec "same-title" already exists at specs[\\/]same-title\.md$/);
    assert.ok(!tree["specs/same-title.md"]?.includes("other body"));
  });

  parity("create: collision with an unrelated pre-existing file", {
    setup: files({ "specs/taken.md": "# not touched\n" }),
    run: async ({ t, ...env }) => finish(env, [await t.spec_create(created("Taken", "technical", "x"))]),
  }, ({ fs: tree }) => {
    assert.equal(tree["specs/taken.md"], "# not touched\n");
  });

  parity("create: titles that yield no id", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("!!!")),
      await t.spec_create(created("   ")),
      await t.spec_create(created("")),
      await t.spec_create(created("éèà")),
      await t.spec_create(created("---")),
      await t.spec_create(created("line\nbreak!")),
    ]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).error, 'Cannot derive id from title: "!!!"');
    assert.equal(parsed(outputs[5]).id, "line-break");
  });

  parity("create: id normalisation (case, spaces, dashes, symbols)", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("--Leading and trailing--")),
      await t.spec_create(created("a   b\t\tc")),
      await t.spec_create(created("a - - b")),
      await t.spec_create(created("snake_case & CamelCase 2.0")),
      await t.spec_create(created("UPPER")),
      await t.spec_create(created("../../etc/passwd")),
      await t.spec_create(created("a/b\\c")),
    ]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[5]).id, "etcpasswd");
    assert.equal(parsed(outputs[2]).id, "a-b");
  });

  parity("create: explicit bodies (empty, CRLF, unicode, frontmatter-like)", {
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("Empty body", undefined, "")),
      await t.spec_create(created("Crlf body", "functional", "line1\r\nline2\r\n")),
      await t.spec_create(created("Unicode body", "architectural", "héllo 😀 𝒳 世界\n\n## Purpose\n")),
      await t.spec_create(created("Fm like", undefined, "---\ntitle: other\n---\n# x")),
      await t.spec_create(created("Dollar body", undefined, "$& $1 $$ $` $'")),
      await t.spec_create(created("Default heading")),
    ]),
  }, ({ fs: tree }) => {
    assert.ok(tree["specs/empty-body.md"]?.endsWith("---\n\n"));
    assert.ok(tree["specs/default-heading.md"]?.endsWith("\n# Default heading\n"));
  });

  parity("create: type given as null or undefined at library level", {
    run: async (env) => finish(env, [
      await jsonCall(() => env.lib.specCreate(env.root, env.paths, "Null type", null)),
      await jsonCall(() => env.lib.specCreate(env.root, env.paths, "Undefined type", undefined)),
      await jsonCall(() => env.lib.specCreate(env.root, env.paths, "Null content", "technical", null)),
    ]),
  }, ({ fs: tree }) => {
    assert.match(tree["specs/null-type.md"] ?? "", /\ntype: "technical"\n/);
  });

  parity("create: nested specs directory is created, absolute and escaping directories", {
    specs: "docs/deep/specs",
    run: async ({ t, ...env }) => finish(env, [await t.spec_create(created("Nested"))]),
  }, ({ fs: tree }) => {
    assert.ok(tree["docs/deep/specs/nested.md"]);
  });

  parity("create: specs directory escaping the project root", {
    specs: "../escape",
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_create(created("Escape")),
      await jsonCall(async () => (await fs.readdir(join(env.root, ".."))).sort()),
    ]),
  }, ({ outputs }) => {
    assert.match(parsed(outputs[0]).error as string, /^Path escapes project root: \.\.[\\/]escape[\\/]escape\.md$/);
  });

  parity("create: absolute specs directory outside, then inside, the project root", {
    specs: ({ outside }) => outside,
    run: async (env) => finish(env, [
      await env.t.spec_create(created("Outside absolute")),
      await jsonCall(async () => (await fs.readdir(env.outside)).sort()),
    ]),
  }, ({ outputs }) => {
    assert.match(parsed(outputs[0]).error as string, /^Path escapes project root: /);
    assert.equal(outputs[1], "[]");
  });

  parity("create: absolute specs directory inside the project root", {
    specs: ({ root }) => join(root, "abs-specs"),
    run: async ({ t, ...env }) => finish(env, [await t.spec_create(created("Inside absolute"))]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).created, true);
  });

  parity("create: specs path is a regular file", {
    setup: files({ specs: "i am a file" }),
    run: async ({ t, ...env }) => finish(env, [await t.spec_create(created("Blocked"))]),
  }, ({ outputs }) => {
    assert.ok(typeof parsed(outputs[0]).error === "string");
  });

  parity("create: filename too long", {
    run: async ({ t, ...env }) => finish(env, [await t.spec_create(created("x".repeat(300)))]),
  }, ({ outputs }) => {
    assert.ok(typeof parsed(outputs[0]).error === "string");
  });

  // ── spec_update ───────────────────────────────────────────────────────────

  const doc = "---\ntitle: \"Doc\"\nid: doc\n---\n# Doc\n\nalpha beta alpha\n\nunique line\n\n$& $1 $$ $` $'\n";

  parity("update: 0, 1 and N occurrences", {
    setup: files({ "specs/doc.md": doc }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "doc", old_string: "missing text", new_string: "x" }),
      await t.spec_update({ id: "doc", old_string: "alpha", new_string: "x" }),
      await t.spec_update({ id: "doc", old_string: "unique line", new_string: "replaced line" }),
      await t.spec_update({ id: "doc", old_string: "e", new_string: "E" }),
    ]),
  }, ({ outputs, fs: tree }) => {
    assert.equal(parsed(outputs[0]).error, 'oldString not found in spec "doc"');
    assert.match(parsed(outputs[1]).error as string, /^Found 2 matches for oldString in spec "doc"\. Provide more surrounding context/);
    assert.equal(parsed(outputs[2]).updated, true);
    assert.ok(tree["specs/doc.md"]?.includes("replaced line"));
  });

  parity("update: replacement patterns are literal ($&, $1, $$, $`, $')", {
    setup: files({ "specs/doc.md": doc }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "doc", old_string: "unique line", new_string: "[$&] [$1] [$$] [$`] [$']" }),
    ]),
  }, ({ fs: tree }) => {
    assert.ok(tree["specs/doc.md"]?.includes("[$&] [$1] [$$] [$`] [$']"));
  });

  parity("update: oldString with regular-expression characters is literal", {
    setup: files({ "specs/doc.md": "a.b (c) [d] * + ? ^ $ | \\ x\n" }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "doc", old_string: "(c) [d] * + ? ^ $ | \\", new_string: "ok" }),
      await t.spec_update({ id: "doc", old_string: ".", new_string: "!" }),
    ]),
  });

  parity("update: empty oldString", {
    setup: files({ "specs/one.md": "x", "specs/zero.md": "", "specs/many.md": "abc" }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "one", old_string: "", new_string: "Y" }),
      await t.spec_update({ id: "zero", old_string: "", new_string: "Y" }),
      await t.spec_update({ id: "many", old_string: "", new_string: "Y" }),
    ]),
  });

  parity("update: empty newString, multi-line and CRLF replacement, unicode", {
    setup: files({ "specs/doc.md": "a\r\nb\r\nc 😀 d\n" }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "doc", old_string: "b\r\n", new_string: "" }),
      await t.spec_update({ id: "doc", old_string: "😀", new_string: "x\ny\r\nz" }),
      await t.spec_update({ id: "doc", old_string: "\ud83d", new_string: "" }),
    ]),
  });

  parity("update: unknown id, wrong case id, missing directory", {
    setup: files({ "specs/Doc.md": "text\n" }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "nope", old_string: "text", new_string: "x" }),
      await t.spec_update({ id: "DOC", old_string: "text", new_string: "x" }),
      await t.spec_update({ id: "../Doc", old_string: "x", new_string: "y" }),
      await t.spec_update({ id: "Doc.md", old_string: "x", new_string: "y" }),
    ]),
  }, ({ outputs }) => {
    assert.match(parsed(outputs[0]).error as string, /^Artifact with id "nope" not found in specs$/);
    assert.equal(parsed(outputs[1]).updated, true);
  });

  parity("update: specs directory does not exist", {
    run: async ({ t, ...env }) => finish(env, [await t.spec_update({ id: "x", old_string: "a", new_string: "b" })]),
  }, ({ outputs }) => {
    assert.equal(parsed(outputs[0]).error, 'Directory not found: specs (looking for id "x")');
  });

  parity("update: file is a symlink, a directory or has a non-md name", {
    setup: compose(
      files({ "specs/real.md": "target text\n", "specs/other.txt": "x", "specs/Dir.md/inner.md": "y" }),
      async ({ root }) => { await fs.symlink(join(root, "specs", "real.md"), join(root, "specs", "link.md")); },
    ),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_update({ id: "link", old_string: "target", new_string: "x" }),
      await t.spec_update({ id: "Dir", old_string: "y", new_string: "z" }),
      await t.spec_update({ id: "other", old_string: "x", new_string: "z" }),
    ]),
  });

  test("update/get/delete: ids differing only by case resolve to the same first entry", async (ctx) => {
    const probeDir = await fs.mkdtemp(join(tmpdir(), "specs-parity-probe-"));
    const caseSensitive = await caseSensitiveFs(probeDir).finally(() => fs.rm(probeDir, { recursive: true, force: true }));
    if (!caseSensitive) {
      ctx.skip("case-insensitive filesystem");
      return;
    }
    await assertParity(sandbox, originLib, {
      setup: files({ "specs/Rule.md": "upper text\n", "specs/rule.md": "lower text\n" }),
      run: async ({ t, ...env }) => finish(env, [
        await t.spec_get({ id: "RULE" }),
        await t.spec_update({ id: "rule", old_string: "text", new_string: "T" }),
        await t.spec_delete({ id: "Rule" }),
        await t.spec_list(),
      ]),
    });
  });

  // ── spec_validate ─────────────────────────────────────────────────────────

  const validateCases: Record<string, string> = {
    "no frontmatter": "# Just a heading\n\ntext\n",
    "empty file": "",
    "whitespace-only file": " \n\t\n",
    "empty body": '---\ntitle: "T"\nid: t\n---\n',
    "whitespace-only body": '---\ntitle: "T"\nid: t\n---\n\n  \n\t\n',
    "valid": '---\ntitle: "T"\nid: t\ntype: technical\nstatus: draft\ncreated: 2026-01-01\n---\n\n# T\n\n## Purpose\n\nx\n',
    "valid with all required sections": `${frontmatter()}\n# T\n\n## Purpose\n\np\n\n## Behavior\n\nb\n\n## Constraints\n\nc\n\n## Examples\n\ne\n`,
    "sections out of order": `${frontmatter()}\n## Examples\n\ne\n\n## Purpose\n\np\n`,
    "missing title": "---\nid: t\n---\n# T\n",
    "missing id": '---\ntitle: "T"\n---\n# T\n',
    "empty title and id": "---\ntitle:\nid:   \n---\n# T\n",
    "missing both": "---\nstatus: draft\n---\n# T\n",
    "CRLF frontmatter": '---\r\ntitle: "T"\r\nid: t\r\n---\r\n\r\n# T\r\n',
    "unclosed frontmatter": '---\ntitle: "T"\nid: t\n\n# T\n',
    "frontmatter only, no trailing newline": '---\ntitle: "T"\nid: t\n---',
    "frontmatter after leading blank line": '\n---\ntitle: "T"\nid: t\n---\n# T\n',
    "single-quoted and escaped values": "---\ntitle: 'It\\'s'\nid: \"a\\\"b\"\n---\n# T\n",
    "BOM before frontmatter": '\ufeff---\ntitle: "T"\nid: t\n---\n# T\n',
    "body that is only a closing fence": "---\ntitle: T\nid: t\n---\n---\n",
  };
  for (const [name, content] of Object.entries(validateCases)) {
    parity(`validate: ${name}`, {
      setup: files({ "specs/doc.md": content }),
      run: async ({ t, ...env }) => finish(env, [await t.spec_validate({ id: "doc" })]),
    }, ({ outputs }) => {
      const result = parsed(outputs[0]);
      assert.ok(Array.isArray(result.issues), outputs[0]);
      assert.equal(result.valid, (result.issues as unknown[]).length === 0);
      assert.ok(!("warnings" in result), "warnings must have been neutralised on both sides");
    });
  }

  parity("validate: unknown id and missing directory", {
    setup: files({ "specs/doc.md": "x" }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_validate({ id: "ghost" }),
      await t.spec_validate({ id: "DOC" }),
    ]),
  });

  test("validate: the port always exposes warnings as an array of strings, the original never does", async () => {
    await sandbox.reset(files({ "specs/doc.md": "# bare\n" }));
    const paths = { specs: "specs" };
    const original = (await originLib.specValidate(sandbox.root, paths, "doc")) as Record<string, unknown>;
    assert.ok(!("warnings" in original));
    const port = (await portLib.specValidate(sandbox.root, paths, "doc")) as Record<string, unknown>;
    assert.ok(Array.isArray(port.warnings));
    const { warnings: _warnings, ...rest } = port;
    assert.deepStrictEqual(rest, original);
  });

  // ── spec_list ─────────────────────────────────────────────────────────────

  parity("list: mixed corpus, no filter", {
    setup: compose(
      files({
        "specs/a-first.md": frontmatter({ title: '"A"', id: "a-first", type: "functional", status: "active" }),
        "specs/b-bare.md": "# no frontmatter\n",
        "specs/c-partial.md": "---\ntitle: Only title\n---\nbody\n",
        "specs/d-crlf.md": '---\r\ntitle: "D"\r\nid: d-crlf\r\n---\r\nbody\r\n',
        "specs/e-empty.md": "",
        "specs/f-quotes.md": "---\ntitle: 'It\\'s \\\"x\\\"'\nid: f\n---\n",
        "specs/ignored.txt": "text",
        "specs/sub/nested.md": "nested",
        "specs/Dir.md/inner.md": "inside a directory named like a spec",
      }),
      async ({ root }) => {
        await fs.symlink(join(root, "specs", "a-first.md"), join(root, "specs", "link.md"));
        await fs.symlink(join(root, "specs", "missing-target.md"), join(root, "specs", "dangling.md"));
      },
    ),
    run: async ({ t, ...env }) => finish(env, [await t.spec_list()]),
  }, ({ outputs }) => {
    const { specs } = parsed(outputs[0]) as { specs: Array<Record<string, unknown>> };
    assert.equal(specs.length, 5 + 1);
    assert.ok(specs.some((s) => s.title === null && s.id === null));
  });

  parity("list: missing directory and empty directory", {
    run: async ({ t, ...env }) => {
      const missing = await t.spec_list();
      await fs.mkdir(join(env.root, "specs"));
      return finish(env, [missing, await t.spec_list()]);
    },
  }, ({ outputs }) => {
    assert.deepEqual(outputs, ['{"specs":[]}', '{"specs":[]}']);
  });

  parity("list: nested and absolute configured directories", {
    specs: ({ root }) => join(root, "docs", "specs"),
    setup: files({ "docs/specs/one.md": frontmatter({ id: "one" }) }),
    run: async ({ t, ...env }) => finish(env, [await t.spec_list()]),
  });

  test("list: unreadable files are reported with their errno message", { skip: runningAsRoot() ? "running as root" : false }, async () => {
    await assertParity(sandbox, originLib, {
      setup: compose(
        files({ "specs/ok.md": frontmatter(), "specs/locked.md": "secret" }),
        async ({ root }) => { await fs.chmod(join(root, "specs", "locked.md"), 0o000); },
      ),
      run: async ({ t, ...env }) => {
        const outcome = await finish(env, [await t.spec_list()]);
        await fs.chmod(join(env.root, "specs", "locked.md"), 0o600);
        return outcome;
      },
    });
  });

  // ── spec_delete ───────────────────────────────────────────────────────────

  parity("delete: existing, repeated, wrong case, then list", {
    setup: files({ "specs/Doc.md": frontmatter(), "specs/keep.md": frontmatter({ id: "keep" }) }),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_delete({ id: "doc" }),
      await t.spec_delete({ id: "doc" }),
      await t.spec_delete({ id: "" }),
      await t.spec_delete({ id: "../specs/keep" }),
      await t.spec_list(),
    ]),
  }, ({ outputs, fs: tree }) => {
    assert.equal(parsed(outputs[0]).deleted, true);
    assert.ok(!tree["specs/Doc.md"] && tree["specs/keep.md"]);
  });

  parity("delete: missing directory, directory entry and symlink", {
    setup: compose(
      files({ "specs/Dir.md/inner.md": "x", "specs/real.md": "real" }),
      async ({ root }) => { await fs.symlink(join(root, "specs", "real.md"), join(root, "specs", "link.md")); },
    ),
    run: async ({ t, ...env }) => finish(env, [
      await t.spec_delete({ id: "Dir" }),
      await t.spec_delete({ id: "link" }),
    ]),
  });

  test("delete: unlink failure message", { skip: runningAsRoot() ? "running as root" : false }, async () => {
    await assertParity(sandbox, originLib, {
      setup: compose(
        files({ "specs/fixed.md": "x" }),
        async ({ root }) => { await fs.chmod(join(root, "specs"), 0o555); },
      ),
      run: async ({ t, ...env }) => {
        const outcome = await finish(env, [await t.spec_delete({ id: "fixed" })]);
        await fs.chmod(join(env.root, "specs"), 0o755);
        return outcome;
      },
    });
  });

  // ── whole sessions and spec_format ────────────────────────────────────────

  parity("session: create → get → update → validate → list → delete", {
    run: async ({ t, ...env }: RunEnv) => {
      const outputs: string[] = [];
      outputs.push(await t.spec_create(created("Session Spec", "functional", "# Session Spec\n\n## Purpose\n\nwhy\n")));
      outputs.push(await t.spec_get({ id: "session-spec" }));
      outputs.push(await t.spec_update({ id: "session-spec", old_string: "why", new_string: "because" }));
      outputs.push(await t.spec_validate({ id: "session-spec" }));
      outputs.push(await t.spec_list());
      outputs.push(await t.spec_delete({ id: "session-spec" }));
      outputs.push(await t.spec_list());
      return finish(env, outputs);
    },
  });

  test("format: identical canonical text", async () => {
    const text = await assertPureParity(originLib, (lib) => lib.specFormat());
    assert.ok(text.length > 1_000 && text.includes("## Purpose") && text.includes("## Examples"));
  });

  test("format: identical through the tool glue", async () => {
    const expected = await assertParity(sandbox, originLib, { run: ({ t }) => t.spec_format() });
    assert.equal(expected, originLib.specFormat());
  });
});
