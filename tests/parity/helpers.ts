/**
 * Harness shared by the differential parity tests (`tests/parity/*.test.ts`).
 *
 * The original implementation (`opencode-team-lead`, `tools/`) is imported dynamically from
 * `ORIGIN_DIR` (default: DEFAULT_ORIGIN_DIR). When a required file is missing, every parity file
 * registers one explicit skipped test carrying the reason, so a checkout without the original
 * never fails.
 *
 * Both implementations are driven through the same glue, a copy of what `tools/registry.js`
 * does around the library functions (registry.js itself depends on the opencode runtime and
 * cannot be imported): `serializeGetterPage` / `serializeGetterError` for spec_get,
 * `serializeRetrievalResult` / `serializeRetrievalError` for search and section reads,
 * `JSON.stringify(result)` or `{ error: message }` for the lifecycle tools, a raw string for
 * spec_format.
 *
 * Neutralised differences, and only these (AGENTS.md, "Écarts voulus"):
 *   - `warnings` in spec_validate results (removed on the port side, which must provide an array);
 *   - the optional `type` / `status` filters of spec_list (never passed here);
 *   - `isError` / `structuredContent` / `outputSchema`, resources and prompts (MCP layer only;
 *     `mcp.test.ts` checks them without comparing them to the original);
 *   - the `created: YYYY-MM-DD` date written by spec_create (see `normalizeCreated`).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { specCreate, specDelete, specFormat, specList, specUpdate, specValidate } from "../../src/lifecycle.js";
import { MAX_CURSOR_BYTES, PAGE_BYTES } from "../../src/limits.js";
import {
  paginateArtifact,
  serializeGetterError,
  serializeGetterPage,
} from "../../src/pagination.js";
import {
  buildSpecDocument,
  serializeRetrievalError,
  serializeRetrievalResult,
  specReadSection,
  specSearch,
} from "../../src/retrieval.js";
import type { ReadSectionInput, RetrievalOptions, SearchInput } from "../../src/retrieval.js";
import { specGet } from "../../src/spec-get.js";

export const DEFAULT_ORIGIN_DIR = "/Users/mickael/Documents/git/opencode-team-lead/tools";
export const originDir = resolve(process.env.ORIGIN_DIR ?? DEFAULT_ORIGIN_DIR);

const ORIGIN_FILES = ["lifecycle.js", "artifact-pagination.js", "spec-retrieval.js"] as const;

export interface SpecPaths {
  specs: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  io?: unknown;
}

export interface PaginateOptions {
  tool: string;
  projectRoot: string;
  artifactPath: string;
  content: string;
  metadata: Record<string, unknown>;
  cursor?: unknown;
}

/** The surface both implementations share, with the signatures of the original (`projectRoot, paths, ...`). */
export interface Lib {
  specGet(root: string, paths: SpecPaths, id: string, cursor?: unknown): Promise<unknown>;
  specCreate(root: string, paths: SpecPaths, title: string, type?: string | null, content?: string | null): Promise<unknown>;
  specUpdate(root: string, paths: SpecPaths, id: string, oldString: string, newString: string): Promise<unknown>;
  specValidate(root: string, paths: SpecPaths, id: string): Promise<unknown>;
  specList(root: string, paths: SpecPaths): Promise<unknown>;
  specDelete(root: string, paths: SpecPaths, id: string): Promise<unknown>;
  specFormat(): string;
  specSearch(root: string, paths: SpecPaths, input: unknown, options?: CallOptions): Promise<unknown>;
  specReadSection(root: string, paths: SpecPaths, input: unknown, options?: CallOptions): Promise<unknown>;
  serializeGetterPage(page: unknown): string;
  serializeGetterError(error: unknown): string;
  serializeRetrievalResult(result: unknown): string;
  serializeRetrievalError(error: unknown): string;
  paginateArtifact(options: PaginateOptions): unknown;
  buildSpecDocument(content: string, file: string, specId: string, canonicalPath?: string): unknown;
  PAGE_BYTES: number;
  MAX_CURSOR_BYTES: number;
}

export const portLib: Lib = {
  specGet,
  specCreate,
  specUpdate,
  specValidate,
  specList: (root, paths) => specList(root, paths),
  specDelete,
  specFormat,
  specSearch: (root, paths, input, options) =>
    specSearch(root, paths, input as SearchInput, options as RetrievalOptions | undefined),
  specReadSection: (root, paths, input, options) =>
    specReadSection(root, paths, input as ReadSectionInput, options as RetrievalOptions | undefined),
  serializeGetterPage,
  serializeGetterError,
  serializeRetrievalResult,
  serializeRetrievalError,
  paginateArtifact,
  buildSpecDocument,
  PAGE_BYTES,
  MAX_CURSOR_BYTES,
};

type OriginLifecycle = Pick<Lib, "specGet" | "specCreate" | "specUpdate" | "specValidate" | "specList" | "specDelete" | "specFormat">;
type OriginPagination = Pick<
  Lib,
  "serializeGetterPage" | "serializeGetterError" | "paginateArtifact" | "PAGE_BYTES" | "MAX_CURSOR_BYTES"
>;
type OriginRetrieval = Pick<
  Lib,
  "specSearch" | "specReadSection" | "serializeRetrievalResult" | "serializeRetrievalError" | "buildSpecDocument"
>;

type OriginLoad = { available: true; lib: Lib } | { available: false; reason: string };

async function loadOrigin(): Promise<OriginLoad> {
  const missing: string[] = [];
  for (const name of ORIGIN_FILES) {
    try {
      await fs.access(join(originDir, name));
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      available: false,
      reason: `original implementation not found in ${originDir} (missing: ${missing.join(", ")}); set ORIGIN_DIR to the tools/ directory of opencode-team-lead to run the parity tests`,
    };
  }
  // A present but broken original is a real failure, not a skip: let the import error surface.
  const [lifecycle, pagination, retrieval]: unknown[] = await Promise.all(
    ORIGIN_FILES.map((name) => import(pathToFileURL(join(originDir, name)).href) as Promise<unknown>),
  );
  return {
    available: true,
    lib: {
      ...(lifecycle as OriginLifecycle),
      ...(pagination as OriginPagination),
      ...(retrieval as OriginRetrieval),
    },
  };
}

const origin = await loadOrigin();

/** `describe` when the original is available, otherwise one explicitly skipped test with the reason. */
export function parityDescribe(name: string, body: (originLib: Lib) => void): void {
  if (!origin.available) {
    test(`${name} (skipped: original implementation unavailable)`, { skip: origin.reason }, () => {});
    return;
  }
  const { lib } = origin;
  describe(name, () => body(lib));
}

// ── Tools: the registry glue, applied to either implementation ──────────────

export interface Tools {
  spec_get(args: { id: string; cursor?: unknown }): Promise<string>;
  spec_search(input: unknown, options?: CallOptions): Promise<string>;
  spec_read_section(input: unknown, options?: CallOptions): Promise<string>;
  spec_create(args: { title: string; type?: string; content?: string }): Promise<string>;
  spec_update(args: { id: string; old_string: string; new_string: string }): Promise<string>;
  spec_validate(args: { id: string }): Promise<string>;
  spec_list(): Promise<string>;
  spec_delete(args: { id: string }): Promise<string>;
  spec_format(): Promise<string>;
}

const errorJson = (err: unknown): string => JSON.stringify({ error: err instanceof Error ? err.message : String(err) });

/** Remove the port-only `warnings` array of a spec_validate result, after checking it is there. */
export function stripWarnings(text: string): string {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || "error" in parsed) return text;
  const result = parsed as Record<string, unknown>;
  assert.ok(
    Array.isArray(result.warnings) && result.warnings.every((w) => typeof w === "string"),
    `spec_validate must carry a warnings array of strings: ${text}`,
  );
  delete result.warnings;
  return JSON.stringify(result);
}

export function makeTools(lib: Lib, root: string, paths: SpecPaths, neutralize: boolean): Tools {
  const json = async (produce: () => Promise<unknown>): Promise<string> => {
    try {
      return JSON.stringify(await produce());
    } catch (err) {
      return errorJson(err);
    }
  };
  return {
    spec_get: async ({ id, cursor }) => {
      try {
        return lib.serializeGetterPage(await lib.specGet(root, paths, id, cursor));
      } catch (err) {
        return lib.serializeGetterError(err);
      }
    },
    spec_search: async (input, options) => {
      try {
        return lib.serializeRetrievalResult(await lib.specSearch(root, paths, input, options));
      } catch (error) {
        options?.signal?.throwIfAborted();
        return lib.serializeRetrievalError(error);
      }
    },
    spec_read_section: async (input, options) => {
      try {
        return lib.serializeRetrievalResult(await lib.specReadSection(root, paths, input, options));
      } catch (error) {
        options?.signal?.throwIfAborted();
        return lib.serializeRetrievalError(error);
      }
    },
    spec_create: ({ title, type, content }) =>
      json(() => lib.specCreate(root, paths, title, type ?? "technical", content ?? null)),
    spec_update: ({ id, old_string, new_string }) => json(() => lib.specUpdate(root, paths, id, old_string, new_string)),
    spec_validate: async ({ id }) => {
      const text = await json(() => lib.specValidate(root, paths, id));
      return neutralize ? stripWarnings(text) : text;
    },
    spec_list: () => json(() => lib.specList(root, paths)),
    spec_delete: ({ id }) => json(() => lib.specDelete(root, paths, id)),
    spec_format: async () => lib.specFormat(),
  };
}

// ── Sandbox: fresh, identical project roots at one fixed path ───────────────

export interface Env {
  root: string;
  /** A sibling directory outside the project root, recreated empty at every reset. */
  outside: string;
}

export type Setup = (env: Env) => Promise<void>;

/**
 * One temporary directory holding `project/` and `outside/`. Pagination cursors hash absolute
 * paths, so both implementations run against the same root path, each on a fresh copy.
 */
export class Sandbox implements Env {
  private constructor(
    readonly base: string,
    readonly root: string,
    readonly outside: string,
  ) {}

  static async create(prefix: string): Promise<Sandbox> {
    const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
    return new Sandbox(base, join(base, "project"), join(base, "outside"));
  }

  async reset(setup?: Setup): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.rm(this.outside, { recursive: true, force: true });
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.outside, { recursive: true });
    await setup?.(this);
  }

  async dispose(): Promise<void> {
    await fs.rm(this.base, { recursive: true, force: true });
  }
}

/** A setup writing `files` (path relative to the project root -> content), in insertion order. */
export function files(corpus: Readonly<Record<string, string | Buffer>>): Setup {
  return async ({ root }) => {
    for (const [name, content] of Object.entries(corpus)) {
      const target = join(root, name);
      await fs.mkdir(join(target, ".."), { recursive: true });
      await fs.writeFile(target, content);
    }
  };
}

export const compose =
  (...setups: Setup[]): Setup =>
  async (env) => {
    for (const setup of setups) await setup(env);
  };

/** Every file below `root` (relative path -> content), directories as `path/`, symlinks as `-> target`. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) out[key] = `-> ${await fs.readlink(path)}`;
      else if (entry.isDirectory()) {
        out[`${key}/`] = "";
        await walk(path);
      } else out[key] = await fs.readFile(path, "utf8").catch(() => "<unreadable>");
    }
  };
  await walk(root);
  return out;
}

/** Mask the `created` date spec_create stamps; any other shape stays visible and fails the comparison. */
export function normalizeCreated(text: string): string {
  return text
    .replace(/created: \d{4}-\d{2}-\d{2}/g, "created: <date>")
    .replace(/"created":"\d{4}-\d{2}-\d{2}"/g, '"created":"<date>"');
}

export function normalizeSnapshot(snap: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(snap).map(([key, value]) => [key, normalizeCreated(value)]));
}

// ── Parity runner ───────────────────────────────────────────────────────────

export interface RunEnv extends Env {
  t: Tools;
  lib: Lib;
  paths: SpecPaths;
  impl: "origin" | "port";
}

export interface Scenario<T> {
  setup?: Setup;
  /** Specs directory relative to the project root (default `specs`), or computed from the sandbox. */
  specs?: string | ((env: Env) => string);
  run(env: RunEnv): Promise<T>;
}

export async function runOn<T>(
  sandbox: Sandbox,
  lib: Lib,
  impl: "origin" | "port",
  scenario: Scenario<T>,
): Promise<T> {
  await sandbox.reset(scenario.setup);
  const specs = typeof scenario.specs === "function" ? scenario.specs(sandbox) : (scenario.specs ?? "specs");
  const paths: SpecPaths = { specs };
  const t = makeTools(lib, sandbox.root, paths, impl === "port");
  return scenario.run({ root: sandbox.root, outside: sandbox.outside, t, lib, paths, impl });
}

/**
 * Run the scenario on the original, then on the port, each on a fresh sandbox, and require
 * deep-strict-equal results. Returns the original's result so callers can add non-vacuity checks.
 */
export async function assertParity<T>(
  sandbox: Sandbox,
  originLib: Lib,
  scenario: Scenario<T>,
  label = "port diverges from the original",
): Promise<T> {
  const expected = await runOn(sandbox, originLib, "origin", scenario);
  const actual = await runOn(sandbox, portLib, "port", scenario);
  assert.deepStrictEqual(actual, expected, label);
  return expected;
}

/** Same, for a pure scenario (no filesystem). */
export async function assertPureParity<T>(
  originLib: Lib,
  run: (lib: Lib) => T | Promise<T>,
  label = "port diverges from the original",
): Promise<T> {
  const expected = await run(originLib);
  const actual = await run(portLib);
  assert.deepStrictEqual(actual, expected, label);
  return expected;
}

// ── Paging walkers ──────────────────────────────────────────────────────────

const nextCursorOf = (text: string, path: "pagination"): string | null => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const page = (parsed as Record<string, unknown>)[path];
  if (typeof page !== "object" || page === null) return null;
  const next = (page as Record<string, unknown>).next_cursor;
  return typeof next === "string" ? next : null;
};

/** Serialized pages of spec_get, following `next_cursor` until there is none (or `maxPages`). */
export async function walkGet(t: Tools, id: string, maxPages = 5_000): Promise<string[]> {
  const pages: string[] = [];
  let cursor: string | undefined;
  while (pages.length < maxPages) {
    const text = await t.spec_get({ id, cursor });
    pages.push(text);
    const next = nextCursorOf(text, "pagination");
    if (next === null) break;
    cursor = next;
  }
  return pages;
}

/** Serialized pages of spec_read_section, following `next_cursor`. */
export async function walkSection(
  t: Tools,
  input: { id: string; section_id: string; source_hash: string },
  maxPages = 5_000,
): Promise<string[]> {
  const pages: string[] = [];
  let cursor: string | undefined;
  while (pages.length < maxPages) {
    const text = await t.spec_read_section(cursor === undefined ? input : { ...input, cursor });
    pages.push(text);
    const next = nextCursorOf(text, "pagination");
    if (next === null) break;
    cursor = next;
  }
  return pages;
}

/** Concatenated `content` of successful pages, to check a walk is lossless. */
export function reassemble(pages: readonly string[]): string {
  return pages
    .map((page) => {
      const parsed = JSON.parse(page) as { content?: unknown };
      return typeof parsed.content === "string" ? parsed.content : "";
    })
    .join("");
}

export const sha256 = async (text: string): Promise<string> =>
  (await import("node:crypto")).createHash("sha256").update(text, "utf8").digest("hex");

// ── Misc fixtures ───────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) for the seeded fuzz scenarios. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const frontmatter = (fields: Record<string, string> = {}): string =>
  `---\n${Object.entries({ title: '"Doc"', id: "doc", type: "technical", status: "draft", created: "2026-01-01", ...fields })
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n`;

export const runningAsRoot = (): boolean => typeof process.getuid === "function" && process.getuid() === 0;

/** Whether `Rule.md` and `rule.md` can coexist in one directory. */
export async function caseSensitiveFs(dir: string): Promise<boolean> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "Probe.md"), "a");
  await fs.writeFile(join(dir, "probe.md"), "b");
  return (await fs.readdir(dir)).length === 2;
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

export const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export interface Outcome {
  outputs: string[];
  fs: Record<string, string>;
}

/** The comparable end state of a scenario: its serialized outputs and the project tree, `created` masked. */
export async function finish(env: Env, outputs: readonly string[]): Promise<Outcome> {
  return { outputs: outputs.map(normalizeCreated), fs: normalizeSnapshot(await snapshot(env.root)) };
}

/** Serialize a direct library call like the registry glue: JSON on success, `{ error }` on failure. */
export async function jsonCall(produce: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await produce());
  } catch (err) {
    return errorJson(err);
  }
}

/** Like `finish`, for scenarios that never run spec_create: outputs are compared byte for byte. */
export async function finishExact(env: Env, outputs: readonly string[]): Promise<Outcome> {
  return { outputs: [...outputs], fs: await snapshot(env.root) };
}
