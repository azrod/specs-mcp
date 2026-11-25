import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { PAGE_BYTES, MAX_CURSOR_BYTES } from "./limits.js";

const messages = {
  INVALID_ARGUMENT: "Invalid argument. Use nonempty string filters and filename-stem identifiers, not paths.",
  INVALID_QUERY: "Use 1–32 distinct letter/number tokens in a query of at most 512 UTF-8 bytes.",
  SPEC_NOT_FOUND: "Specification not found in the configured corpus.",
  SECTION_NOT_FOUND: "Section not found in the verified specification.",
  AMBIGUOUS_ID: "Multiple specifications have the same case-insensitive filename identifier.",
  CORPUS_UNAVAILABLE: "Cannot safely enumerate or read the complete specification corpus.",
  SOURCE_UNAVAILABLE: "Cannot safely read the selected specification.",
  STALE_SOURCE: "Specification changed. Rerun spec_search and use its new selector and source_hash.",
  INVALID_CURSOR: "Invalid section cursor. Restart from spec_search.",
  STALE_CURSOR: "Specification changed during pagination. Discard previous pages and rerun spec_search.",
  PAGE_BUDGET_EXCEEDED: "Required source metadata and content cannot fit within the 16,384-byte budget.",
} as const;

export type RetrievalErrorCode = keyof typeof messages;

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode) {
    super(messages[code]);
    this.code = code;
  }
}

/** Subset of `fs/promises` used by the retrieval engine, injectable for tests. */
export interface RetrievalDirent {
  name: string;
  isFile(): boolean;
}

export interface RetrievalFileHandle {
  stat(): Promise<{ isFile(): boolean; dev: number | bigint; ino: number | bigint }>;
  readFile(options: { encoding: "utf8"; signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

export interface RetrievalIo {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readdir(path: string, options: { withFileTypes: true }): Promise<RetrievalDirent[]>;
  open(path: string, flags: number): Promise<RetrievalFileHandle>;
  stat(path: string): Promise<{ dev: number | bigint; ino: number | bigint }>;
}

export interface RetrievalOptions {
  signal?: AbortSignal;
  io?: RetrievalIo;
}

export interface RetrievalPaths {
  specs: string;
}

export interface SearchInput {
  query: string;
  id?: string;
  type?: string;
  status?: string;
}

export interface ReadSectionInput {
  id: string;
  section_id: string;
  source_hash: string;
  cursor?: string;
}

export interface SpecFile {
  root: string;
  directory: string;
  canonicalRoot: string;
  path: string;
  spec_id: string;
}

export interface SpecLine {
  start: number;
  end: number;
  text: string;
}

export interface SpecSection {
  section_id: string;
  section: string[];
  start: number;
  end: number;
  directEnd: number;
  level?: number;
}

export interface SpecPassage {
  start: number;
  end: number;
  section: SpecSection;
}

export interface SpecDocument {
  content: string;
  file: string;
  spec_id: string;
  canonicalPath: string;
  title: string | null;
  type: string | null;
  status: string | null;
  source_hash: string;
  lines: SpecLine[];
  sections: SpecSection[];
  passages: SpecPassage[];
}

export interface SourceFields {
  spec_id: string;
  title: string | null;
  type: string | null;
  status: string | null;
  file: string;
  source_hash: string;
  section_id: string;
  section: string[];
}

export interface Citation extends SourceFields {
  line_start: number;
  line_end: number;
  excerpt: string;
  partial_start_line: boolean;
  partial_end_line: boolean;
}

export interface SearchResponse {
  query: string;
  corpus_files: number;
  matched_passages: number;
  results: Citation[];
  truncated: boolean;
}

export interface SectionPage extends SourceFields {
  section_line_start: number | null;
  section_line_end: number | null;
  content: string;
  pagination: { has_more: boolean; next_cursor: string | null };
}

interface Candidate extends SpecPassage {
  document: SpecDocument;
  score: number;
  evidence: number;
  evidenceEnd: number;
}

interface CursorIdentity {
  v: 1;
  t: string;
  a: string;
  h: string;
  s: string;
}

function fail(code: RetrievalErrorCode): never {
  throw new RetrievalError(code);
}
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const tokens = (text: string): string[] => [...new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).map((token) => token.toLowerCase()))];
const checkSignal = (options: RetrievalOptions): void => options.signal?.throwIfAborted();
const errno = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

export function serializeRetrievalError(error: unknown): string {
  // Never echo arbitrary input, filesystem diagnostics, cursors or source text.
  const code: RetrievalErrorCode = error instanceof RetrievalError ? error.code : "SOURCE_UNAVAILABLE";
  return JSON.stringify({ code, error: messages[code] });
}

export function serializeRetrievalResult(result: unknown): string {
  return bytes(result) <= PAGE_BYTES ? JSON.stringify(result)
    : serializeRetrievalError(new RetrievalError("PAGE_BUDGET_EXCEEDED"));
}

function validId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id.trim() || id === "." || id === ".." || /[/\\\0]/.test(id)) fail("INVALID_ARGUMENT");
}

// Resolve existing ancestors as well: ENOENT below an escaping symlink is not
// an empty, safe corpus. Both lexical and canonical containment must hold.
export async function safeDirectory(projectRoot: string, specPath: string, io: RetrievalIo):
  Promise<{ root: string; directory: string; canonicalRoot: string }> {
  const root = resolve(projectRoot);
  const directory = resolve(root, specPath);
  if (!within(root, directory)) fail("CORPUS_UNAVAILABLE");
  const canonicalRoot = await io.realpath(root);
  let ancestor = directory;
  for (;;) {
    try {
      const canonical = await io.realpath(ancestor);
      if (!within(canonicalRoot, canonical)) fail("CORPUS_UNAVAILABLE");
      return { root, directory, canonicalRoot };
    } catch (error) {
      if (errno(error) !== "ENOENT" || ancestor === root) throw error;
      // realpath of a dangling symlink returns ENOENT too; never treat it as
      // a genuinely absent directory (its target could be outside the root).
      try { if ((await io.lstat(ancestor)).isSymbolicLink()) fail("CORPUS_UNAVAILABLE"); }
      catch (statError) { if (errno(statError) !== "ENOENT") throw statError; }
      ancestor = dirname(ancestor);
    }
  }
}

export async function inventory(projectRoot: string, paths: RetrievalPaths, options: RetrievalOptions): Promise<SpecFile[]> {
  const io: RetrievalIo = options.io ?? fs;
  checkSignal(options);
  try {
    const location = await safeDirectory(projectRoot, paths.specs, io);
    let entries: RetrievalDirent[];
    try { entries = await io.readdir(location.directory, { withFileTypes: true }); }
    catch (error) { if (errno(error) === "ENOENT") entries = []; else throw error; }
    checkSignal(options);
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => ({ ...location, path: join(location.directory, entry.name), spec_id: entry.name.slice(0, -3) }))
      .sort((a, b) => compare(a.path, b.path));
    return files;
  } catch (error) {
    checkSignal(options);
    if (error instanceof RetrievalError) throw error;
    fail("CORPUS_UNAVAILABLE");
  }
}

export async function readDocument(file: SpecFile, options: RetrievalOptions, code: RetrievalErrorCode): Promise<SpecDocument> {
  const io: RetrievalIo = options.io ?? fs;
  checkSignal(options);
  try {
    const canonical = await io.realpath(file.path);
    if (!within(file.canonicalRoot, canonical)) fail(code);
    // Open the verified canonical target, not a mutable configured-directory
    // alias. Revalidate its identity before reading if an ancestor changed.
    const handle = await io.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const opened = await handle.stat();
      const current = await io.realpath(file.path);
      if (!opened.isFile() || current !== canonical || !within(file.canonicalRoot, current)) fail(code);
      const target = await io.stat(current);
      if (target.dev !== opened.dev || target.ino !== opened.ino) fail(code);
      content = await handle.readFile({ encoding: "utf8", signal: options.signal });
    } finally { await handle.close(); }
    checkSignal(options);
    return buildSpecDocument(content, relative(file.root, file.path), file.spec_id, canonical);
  } catch (error) {
    checkSignal(options);
    if (error instanceof RetrievalError) throw error;
    fail(code);
  }
}

export function assertUnique(files: SpecFile[]): void {
  const ids = new Set<string>();
  for (const file of files) {
    const id = file.spec_id.toLowerCase();
    if (ids.has(id)) fail("AMBIGUOUS_ID");
    ids.add(id);
  }
}

export async function loadSpecCorpus(projectRoot: string, paths: RetrievalPaths, options: RetrievalOptions = {}): Promise<SpecDocument[]> {
  const files = await inventory(projectRoot, paths, options);
  assertUnique(files);
  const documents: SpecDocument[] = [];
  for (const file of files) documents.push(await readDocument(file, options, "CORPUS_UNAVAILABLE"));
  return documents;
}

function splitPair(text: string, position: number): boolean {
  const a = text.charCodeAt(position - 1), b = text.charCodeAt(position);
  return a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff;
}

function passageRanges(content: string, start: number, end: number): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  while (start < end) {
    let next = start, count = 0;
    while (next < end && count < 2_000) {
      next += (content.codePointAt(next) ?? 0) > 0xffff ? 2 : 1;
      count++;
    }
    if (next < end) {
      if (content[next - 1] === "\r" && content[next] === "\n") next--;
      const lineEnd = content.lastIndexOf("\n", next - 1) + 1;
      if (lineEnd > start) next = lineEnd;
    }
    ranges.push({ start, end: next });
    start = next;
  }
  return ranges;
}

/** Internal exact-source representation; offsets are UTF-16 string offsets. */
export function buildSpecDocument(content: string, file: string, spec_id: string, canonicalPath: string = file): SpecDocument {
  const lines: SpecLine[] = [];
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline + 1;
    lines.push({ start, end, text: content.slice(start, end).replace(/\r?\n$/, "") });
    start = end;
  }
  const metadata = parseFrontmatter(content);
  const headings: { section_id: string; start: number; level: number; section: string[] }[] = [];
  const ancestry: { level: number; text: string }[] = [];
  let frontmatter = lines[0]?.text === "---" && lines.slice(1).some((line) => /^---\s*$/.test(line.text));
  let fence: string | null = null;
  lines.forEach((line, index) => {
    if (frontmatter) { if (index && /^---\s*$/.test(line.text)) frontmatter = false; return; }
    if (fence) {
      const close = line.text.match(/^ {0,3}(`+|~+)[\t ]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    const opening = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) { fence = opening[1]; return; }
    const heading = line.text.match(/^ {0,3}(#{1,6})(?:\s|$)/);
    if (!heading) return;
    const level = heading[1].length;
    while (ancestry.length && ancestry[ancestry.length - 1].level >= level) ancestry.pop();
    ancestry.push({ level, text: line.text });
    headings.push({ section_id: `line:${index + 1}`, start: line.start, level, section: ancestry.map((item) => item.text) });
  });
  const sections: SpecSection[] = [{ section_id: "preamble", section: [], start: 0, end: headings[0]?.start ?? content.length, directEnd: headings[0]?.start ?? content.length }];
  headings.forEach((heading, index) => {
    const end = headings.slice(index + 1).find((next) => next.level <= heading.level)?.start ?? content.length;
    sections.push({ ...heading, end, directEnd: headings[index + 1]?.start ?? content.length });
  });
  const passages: SpecPassage[] = sections.flatMap((section) => passageRanges(content, section.start, section.directEnd)
    .map((range) => ({ ...range, section })));
  return { content, file, spec_id, canonicalPath, title: metadata.title ?? null, type: metadata.type ?? null,
    status: metadata.status ?? null, source_hash: digest(content), lines, sections, passages };
}

function lineAt(document: SpecDocument, offset: number): number {
  let low = 0, high = document.lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (document.lines[middle].start <= offset) low = middle; else high = middle - 1;
  }
  return low;
}

function sourceFields(document: SpecDocument, section: SpecSection): SourceFields {
  return { spec_id: document.spec_id, title: document.title, type: document.type, status: document.status,
    file: document.file, source_hash: document.source_hash, section_id: section.section_id, section: section.section };
}

function citation(candidate: Candidate, start: number = candidate.start, end: number = candidate.end): Citation {
  const { document, section } = candidate;
  const first = lineAt(document, start), last = lineAt(document, end - 1);
  const lastLine = document.lines[last];
  // Excluding just a line terminator still cites a complete line of text.
  const textEnd = lastLine.start + lastLine.text.length;
  return { ...sourceFields(document, section), line_start: first + 1, line_end: last + 1,
    excerpt: document.content.slice(start, end), partial_start_line: start > document.lines[first].start,
    partial_end_line: end < textEnd };
}

function validateQuery(input: SearchInput): string[] {
  const raw: unknown = input.query;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 512) fail("INVALID_QUERY");
  const query = tokens(raw);
  if (!query.length || query.length > 32) fail("INVALID_QUERY");
  for (const name of ["id", "type", "status"] as const) {
    const value: unknown = input[name];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) fail("INVALID_ARGUMENT");
  }
  if (input.id !== undefined) validId(input.id);
  return query;
}

function rankedCandidates(documents: SpecDocument[], query: string[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const document of documents) {
    const title = new Set(tokens(document.title ?? ""));
    const id = new Set(tokens(document.spec_id));
    let metadataOnly: Candidate | null = null;
    for (const passage of document.passages) {
      const text = document.content.slice(passage.start, passage.end);
      const body = new Set(tokens(text));
      const heading = new Set(tokens(passage.section.section.join("\n")));
      const matched = query.filter((token) => body.has(token) || heading.has(token) || title.has(token) || id.has(token));
      if (!matched.length) continue;
      const bodyMatch = query.some((token) => body.has(token));
      const score = matched.length * 1_000 + matched.filter((token) => heading.has(token) || title.has(token)).length * 10
        + matched.filter((token) => id.has(token)).length;
      // Locate real token evidence, not an arbitrary matching substring.
      const match = bodyMatch ? [...text.matchAll(/[\p{L}\p{N}]+/gu)].find((item) => query.includes(item[0].toLowerCase())) : null;
      const candidate: Candidate = { ...passage, document, score, evidence: match ? passage.start + match.index : passage.start,
        evidenceEnd: match ? passage.start + match.index + match[0].length : passage.start + ((text.codePointAt(0) ?? 0) > 0xffff ? 2 : 1) };
      if (bodyMatch) candidates.push(candidate);
      else if (!metadataOnly || score > metadataOnly.score) metadataOnly = candidate;
    }
    if (metadataOnly) candidates.push(metadataOnly);
  }
  return candidates.sort((a, b) => b.score - a.score || compare(a.document.file, b.document.file) || a.start - b.start);
}

function fitCitation(candidate: Candidate, response: SearchResponse): Citation | null {
  const full = citation(candidate);
  if (bytes({ ...response, results: [...response.results, full] }) <= PAGE_BYTES) return full;
  // Grow an exact, code-point-safe window around the first matching token.
  // Retain the complete token where possible, at least its first code point.
  const { document, evidence, evidenceEnd } = candidate;
  const minimumEnd = evidence + ((document.content.codePointAt(evidence) ?? 0) > 0xffff ? 2 : 1);
  let best: Citation | null = null, low = 1, high = candidate.end - candidate.start;
  while (low <= high) {
    const width = Math.floor((low + high) / 2);
    let start = Math.max(candidate.start, evidence - Math.floor((width - 1) / 2));
    let end = Math.min(candidate.end, Math.max(minimumEnd, start + width, evidenceEnd));
    if (splitPair(document.content, start)) start--;
    if (splitPair(document.content, end)) end--;
    if (document.content[start] === "\n" && document.content[start - 1] === "\r") start--;
    if (document.content[end - 1] === "\r" && document.content[end] === "\n") end--;
    const result = citation(candidate, start, end);
    if (bytes({ ...response, results: [...response.results, result] }) <= PAGE_BYTES) { best = result; low = width + 1; }
    else high = width - 1;
  }
  // A token itself may be enormous; preserve its first matching code point.
  if (!best) {
    const result = citation(candidate, evidence, minimumEnd);
    if (bytes({ ...response, results: [...response.results, result] }) <= PAGE_BYTES) best = result;
  }
  return best;
}

export async function specSearch(projectRoot: string, paths: RetrievalPaths, input: SearchInput, options: RetrievalOptions = {}): Promise<SearchResponse> {
  const query = validateQuery(input);
  const corpus = await loadSpecCorpus(projectRoot, paths, options);
  let documents = corpus;
  if (input.id !== undefined) {
    const wanted = input.id.toLowerCase();
    documents = documents.filter((document) => document.spec_id.toLowerCase() === wanted);
    if (!documents.length) fail("SPEC_NOT_FOUND");
  }
  for (const key of ["type", "status"] as const) {
    const wanted = input[key];
    if (wanted !== undefined) {
      documents = documents.filter((document) => document[key]?.toLowerCase() === wanted.toLowerCase());
    }
  }
  checkSignal(options);
  const candidates = rankedCandidates(documents, query);
  const response: SearchResponse = { query: input.query, corpus_files: corpus.length, matched_passages: candidates.length, results: [], truncated: false };
  for (const candidate of candidates.slice(0, 5)) {
    // Reserve the larger `false` boolean even if later omissions set it true.
    const result = fitCitation(candidate, response);
    if (!result) { if (!response.results.length) fail("PAGE_BUDGET_EXCEEDED"); break; }
    response.results.push(result);
  }
  response.truncated = response.results.length < candidates.length;
  return response;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function decode(cursor: unknown, identity: CursorIdentity): number {
  try {
    if (typeof cursor !== "string" || !cursor || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES || !/^[\w-]+$/.test(cursor)) throw new Error();
    const buffer = Buffer.from(cursor, "base64url");
    if (buffer.toString("base64url") !== cursor) throw new Error();
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).sort().join(",") !== "a,h,p,s,t,v" ||
        fields.v !== 1 || fields.t !== identity.t || fields.a !== identity.a || fields.h !== identity.h || fields.s !== identity.s ||
        typeof fields.p !== "number" || !Number.isSafeInteger(fields.p) || fields.p <= 0) throw new Error();
    return fields.p;
  } catch { fail("INVALID_CURSOR"); }
}

export function sectionPage(document: SpecDocument, section: SpecSection, identity: CursorIdentity, start: number): SectionPage {
  const content = document.content.slice(section.start, section.end);
  if (start && (start >= content.length || splitPair(content, start) || (content[start - 1] === "\r" && content[start] === "\n"))) fail("INVALID_CURSOR");
  const metadata = { ...sourceFields(document, section),
    section_line_start: content ? lineAt(document, section.start) + 1 : null,
    section_line_end: content ? lineAt(document, section.end - 1) + 1 : null };
  const page = (end: number): SectionPage => ({ ...metadata, content: content.slice(start, end), pagination: {
    has_more: end < content.length, next_cursor: end < content.length ? encode({ ...identity, p: end }) : null,
  } });
  if (content.length - start <= PAGE_BYTES && bytes(page(content.length)) <= PAGE_BYTES) return page(content.length);
  let low = start + 1, high = Math.min(content.length - 1, start + PAGE_BYTES), best = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let end = splitPair(content, middle) ? middle - 1 : middle;
    if (content[end - 1] === "\r" && content[end] === "\n") end--;
    if (bytes(page(end)) <= PAGE_BYTES) { best = end; low = middle + 1; } else high = middle - 1;
  }
  if (best <= start) fail("PAGE_BUDGET_EXCEEDED");
  const lineEnd = content.lastIndexOf("\n", best - 1) + 1;
  if (lineEnd > start) best = lineEnd;
  return page(best);
}

export async function specReadSection(projectRoot: string, paths: RetrievalPaths, input: ReadSectionInput, options: RetrievalOptions = {}): Promise<SectionPage> {
  validId(input.id);
  const sourceHash: unknown = input.source_hash;
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) fail("INVALID_ARGUMENT");
  const sectionId: unknown = input.section_id;
  if (typeof sectionId !== "string") fail("SECTION_NOT_FOUND");
  const files = await inventory(projectRoot, paths, options);
  const wanted = input.id.toLowerCase();
  const matches = files.filter((file) => file.spec_id.toLowerCase() === wanted);
  if (!matches.length) fail("SPEC_NOT_FOUND");
  if (matches.length > 1) fail("AMBIGUOUS_ID");
  const file = matches[0];
  const io: RetrievalIo = options.io ?? fs;
  // Compute identity only from caller-resolved paths, never cursor fields.
  let canonical: string;
  try { canonical = await io.realpath(file.path); } catch { fail("SOURCE_UNAVAILABLE"); }
  const identity: CursorIdentity = { v: 1, t: "spec_read_section", a: digest(JSON.stringify([await io.realpath(resolve(projectRoot)), canonical])),
    h: sourceHash, s: digest(sectionId) };
  const start = input.cursor === undefined ? 0 : decode(input.cursor, identity);
  const document = await readDocument(file, options, "SOURCE_UNAVAILABLE");
  if (document.source_hash !== sourceHash) fail(input.cursor === undefined ? "STALE_SOURCE" : "STALE_CURSOR");
  if (!/^(?:preamble|line:[1-9]\d*)$/.test(sectionId)) fail("SECTION_NOT_FOUND");
  const section = document.sections.find((item) => item.section_id === sectionId);
  if (!section) fail("SECTION_NOT_FOUND");
  return sectionPage(document, section, identity, start);
}
