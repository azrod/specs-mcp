import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveConfig } from "../src/config.js";

test("defaults: no root, specs under docs/specs", () => {
  const config = resolveConfig([], {});
  assert.equal(config.projectRoot, null);
  assert.deepEqual(config.paths, { specs: "docs/specs" });
});

test("root: --root wins over SPECS_ROOT", () => {
  const config = resolveConfig(["--root", "/tmp/from-arg"], { SPECS_ROOT: "/tmp/from-env" });
  assert.equal(config.projectRoot, resolve("/tmp/from-arg"));
});

test("root: SPECS_ROOT is used when --root is absent", () => {
  const config = resolveConfig([], { SPECS_ROOT: "/tmp/from-env" });
  assert.equal(config.projectRoot, resolve("/tmp/from-env"));
});

test("root: --root=<dir> form is accepted and relative roots are resolved", () => {
  const config = resolveConfig(["--root=some/dir"], {});
  assert.equal(config.projectRoot, resolve("some/dir"));
});

test("root: blank values count as absent", () => {
  assert.equal(resolveConfig([], { SPECS_ROOT: "  " }).projectRoot, null);
  assert.equal(resolveConfig(["--root", " "], { SPECS_ROOT: "/tmp/from-env" }).projectRoot, resolve("/tmp/from-env"));
});

test("specs dir: --specs-dir wins over SPECS_DIR", () => {
  const config = resolveConfig(["--specs-dir", "private/specifications"], { SPECS_DIR: "from/env" });
  assert.equal(config.paths.specs, "private/specifications");
});

test("specs dir: SPECS_DIR is used when --specs-dir is absent", () => {
  assert.equal(resolveConfig([], { SPECS_DIR: "from/env" }).paths.specs, "from/env");
});

test("specs dir: empty or blank value is an error", () => {
  const message = "paths.specs must be a non-empty string";
  assert.throws(() => resolveConfig(["--specs-dir", ""], {}), { message });
  assert.throws(() => resolveConfig(["--specs-dir", "   "], {}), { message });
  assert.throws(() => resolveConfig([], { SPECS_DIR: "" }), { message });
  assert.throws(() => resolveConfig([], { SPECS_DIR: "  " }), { message });
});

test("option without value is an error", () => {
  assert.throws(() => resolveConfig(["--root"], {}), { message: "--root requires a value" });
  assert.throws(() => resolveConfig(["--specs-dir", "--root", "/x"], {}), { message: "--specs-dir requires a value" });
});

test("paths is frozen", () => {
  const { paths } = resolveConfig([], {});
  assert.ok(Object.isFrozen(paths));
  assert.throws(() => {
    (paths as { specs: string }).specs = "other";
  }, TypeError);
});
