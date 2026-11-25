import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/frontmatter.js";

test("nominal: parses simple key: value pairs and unquotes values", () => {
  const content = `---\ntitle: "My Spec"\nid: my-spec\ntype: technical\nstatus: draft\ncreated: 2026-01-01\n---\n\n# My Spec\n`;
  assert.deepEqual(parseFrontmatter(content), {
    title: "My Spec",
    id: "my-spec",
    type: "technical",
    status: "draft",
    created: "2026-01-01",
  });
});

test("escaped quotes written by spec_create are unescaped", () => {
  assert.equal(parseFrontmatter('---\ntitle: "Auth \\"Service\\""\nid: auth-service\n---\n').title, 'Auth "Service"');
  assert.equal(parseFrontmatter("---\ntitle: 'It\\'s'\n---\n").title, "It's");
});

test("backslashes are kept as is", () => {
  assert.equal(parseFrontmatter('---\ntitle: "a\\\\b"\n---\n').title, "a\\\\b");
});

test("only the first colon splits key and value", () => {
  assert.deepEqual(parseFrontmatter("---\nbrief: docs/briefs/a.md\nurl: http://x:80/y\n---\n"), {
    brief: "docs/briefs/a.md",
    url: "http://x:80/y",
  });
});

test("lines without colon and empty keys are skipped", () => {
  assert.deepEqual(parseFrontmatter("---\nnot yaml\n: orphan value\nkept: yes\n---\nbody"), { kept: "yes" });
});

test("missing or unterminated frontmatter returns {}", () => {
  for (const content of ["", "small", "---\nbroken frontmatter", "---\nnot yaml\n---\nbody", "# Title\n---\na: b\n---\n"]) {
    assert.deepEqual(parseFrontmatter(content), {}, JSON.stringify(content));
  }
});

test("empty value is kept as an empty string", () => {
  assert.deepEqual(parseFrontmatter("---\nstatus:\n---\n"), { status: "" });
});

test("later duplicate key wins", () => {
  assert.equal(parseFrontmatter("---\nstatus: draft\nstatus: active\n---\n").status, "active");
});

test("CRLF line endings are supported", () => {
  assert.deepEqual(parseFrontmatter("---\r\ntitle: Windows\r\nid: win\r\n---\r\nbody"), { title: "Windows", id: "win" });
});

test("large document: only the leading block is parsed", () => {
  const content = '---\ntitle: "Whole document"\n---\n- [x] First\n' + '"\\ é😀\r\n'.repeat(12000) + "\n- [ ] Tail\nEND";
  assert.deepEqual(parseFrontmatter(content), { title: "Whole document" });
});

test("a closing delimiter is matched even right after the opening one", () => {
  assert.deepEqual(parseFrontmatter("---\n\n---\nbody"), {});
});
