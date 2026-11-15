/**
 * agent-contract.ts — evidence bounding and STRICT validation of agent output.
 *
 * Foundation only. Pure functions: no process, no filesystem, no network. Not wired to the server,
 * worker or any job. Written without running the compiler or tests (see backend/DEVELOPMENT.md).
 *
 * Trust model: everything a model returns is untrusted text. This module accepts it only if it
 *  - sits between exactly one pair of per-call nonce markers,
 *  - parses as JSON and matches a closed schema (unknown keys rejected, sizes bounded),
 *  - refers only to evidence ids and file paths that were actually supplied, and
 *  - for patches, is a strictly formatted unified diff over files that were supplied.
 * "unknown" answers are not diagnoses and not patches; they are reported as such, never upgraded.
 * Nothing here applies a patch or runs a command. A valid proposal is only data.
 *
 * Known limit: validation shows the output is well formed and consistent with the evidence. It does
 * not show the diagnosis is true or the patch is correct. Only independent build/test results do.
 *
 * @module agent-contract
 */

import { Buffer } from "node:buffer";

export const SCHEMA_VERSION = 1;

export const AGENT_LIMITS = Object.freeze({
  maxEvidenceItems: 16,
  maxEvidenceItemBytes: 4 * 1024,
  maxEvidenceTotalBytes: 32 * 1024,
  maxPathLength: 200,
  maxSummaryChars: 400,
  maxRootCauseChars: 1000,
  maxEvidenceRefs: 8,
  maxAffectedFiles: 10,
  maxDiffBytes: 24 * 1024,
  maxDiffLines: 400,
  maxDiffFiles: 5,
  maxDiffHunks: 30,
  maxDiffLineChars: 500,
  maxOutputBytes: 64 * 1024,
});

export type RejectCode =
  | "evidence-invalid"
  | "evidence-too-large"
  | "invalid-json"
  | "markers-missing"
  | "markers-ambiguous"
  | "output-too-large"
  | "schema-violation"
  | "unknown-diagnosis"
  | "no-patch"
  | "unknown-evidence-ref"
  | "path-not-in-evidence"
  | "unsafe-path"
  | "diff-invalid"
  | "diff-too-large"
  | "context-mismatch";

export type Validation<T> = { ok: true; value: T } | { ok: false; code: RejectCode; detail: string };

function fail(code: RejectCode, detail: string): { ok: false; code: RejectCode; detail: string } {
  return { ok: false, code, detail };
}

// ---------------------------------------------------------------------------
// Paths and text hygiene
// ---------------------------------------------------------------------------

const EVIDENCE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PATH_CHARS_RE = /^[A-Za-z0-9._@+/-]+$/;
const BLOCKED_SEGMENTS: ReadonlySet<string> = new Set([".git", ".kiro", ".github", "node_modules"]);
// Everything below 0x20 except tab (0x09) and newline (0x0A), plus DEL.
const CONTROL_EXCEPT_TAB_NL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const CONTROL_EXCEPT_NL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;

/** Relative, forward-slash, conservative characters, no traversal, no VCS/tooling/dependency dirs. */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > AGENT_LIMITS.maxPathLength) return false;
  if (!PATH_CHARS_RE.test(p) || p.startsWith("/")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.endsWith(".")) return false;
    if (BLOCKED_SEGMENTS.has(seg.toLowerCase())) return false;
  }
  return true;
}

/** Removes NUL and other control characters (keeps tab and newline); normalises line endings. */
export function sanitizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"']+/gi,
];

/**
 * Best-effort masking of well-known secret shapes plus exact literals (for example an API key the
 * operator configured). Best effort only: it is a second line of defence, not a guarantee.
 */
export function redactSecrets(text: string, literals: readonly string[] = []): string {
  let out = text;
  for (const lit of literals) {
    if (lit.length >= 6) out = out.split(lit).join("[REDACTED]");
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/** Cuts to at most `maxBytes` UTF-8 bytes without leaving a broken trailing character. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, ""), truncated: true };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceKind = "log" | "file" | "manifest" | "stage-result";
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(["log", "file", "manifest", "stage-result"]);

export interface EvidenceItem {
  /** Letters, digits, "_" and "-", at most 40 characters. Unique within a request. */
  id: string;
  kind: EvidenceKind;
  /** Required for kind "file": relative path inside the repository. */
  path?: string;
  /** Claim that `text` is the entire file. Enables diff context verification if the text is unchanged. */
  complete?: boolean;
  text: string;
}

export interface PreparedEvidence {
  id: string;
  kind: EvidenceKind;
  path: string | null;
  text: string;
  /** Text was cut to the per-item limit. */
  truncated: boolean;
  /** Text is the whole file, byte for byte after hygiene (no cut, no redaction, no sanitising change). */
  complete: boolean;
}

export type PrepareResult =
  | { ok: true; items: PreparedEvidence[]; totalBytes: number }
  | { ok: false; code: "evidence-invalid" | "evidence-too-large"; detail: string };

/** Validates, sanitises, redacts and bounds evidence. Over-large totals are rejected, not silently dropped. */
export function prepareEvidence(items: readonly EvidenceItem[], literals: readonly string[] = []): PrepareResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: "evidence-invalid", detail: "at least one evidence item is required" };
  }
  if (items.length > AGENT_LIMITS.maxEvidenceItems) {
    return { ok: false, code: "evidence-too-large", detail: `more than ${AGENT_LIMITS.maxEvidenceItems} evidence items` };
  }
  const seen = new Set<string>();
  const out: PreparedEvidence[] = [];
  let total = 0;
  for (const it of items) {
    if (typeof it !== "object" || it === null) return { ok: false, code: "evidence-invalid", detail: "evidence item is not an object" };
    if (typeof it.id !== "string" || !EVIDENCE_ID_RE.test(it.id)) return { ok: false, code: "evidence-invalid", detail: "bad evidence id" };
    if (seen.has(it.id)) return { ok: false, code: "evidence-invalid", detail: `duplicate evidence id ${it.id}` };
    seen.add(it.id);
    if (typeof it.kind !== "string" || !EVIDENCE_KINDS.has(it.kind)) return { ok: false, code: "evidence-invalid", detail: `bad kind for ${it.id}` };
    if (typeof it.text !== "string") return { ok: false, code: "evidence-invalid", detail: `text of ${it.id} is not a string` };
    let path: string | null = null;
    if (it.path !== undefined) {
      if (!isSafeRelativePath(it.path)) return { ok: false, code: "evidence-invalid", detail: `unsafe path for ${it.id}` };
      path = it.path;
    }
    if (it.kind === "file" && path === null) return { ok: false, code: "evidence-invalid", detail: `file evidence ${it.id} needs a path` };

    const sanitized = sanitizeText(it.text);
    const redacted = redactSecrets(sanitized, literals);
    const cut = truncateUtf8(redacted, AGENT_LIMITS.maxEvidenceItemBytes);
    const unchanged = redacted === it.text && !cut.truncated;
    total += Buffer.byteLength(cut.text, "utf8");
    out.push({
      id: it.id,
      kind: it.kind,
      path,
      text: cut.text,
      truncated: cut.truncated,
      complete: it.kind === "file" && it.complete === true && unchanged,
    });
  }
  if (total > AGENT_LIMITS.maxEvidenceTotalBytes) {
    return { ok: false, code: "evidence-too-large", detail: `evidence exceeds ${AGENT_LIMITS.maxEvidenceTotalBytes} bytes` };
  }
  return { ok: true, items: out, totalBytes: total };
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

export function beginMarker(nonce: string): string {
  return `GRAVEYARD_JSON_BEGIN_${nonce}`;
}
export function endMarker(nonce: string): string {
  return `GRAVEYARD_JSON_END_${nonce}`;
}

const ANSI_CSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Finds exactly one marker pair for this call's nonce and parses the JSON between them.
 * Zero pairs, more than one begin or end marker, or markers out of order all fail closed.
 * (A model that echoes the prompt would repeat the markers and is therefore rejected.)
 */
export function extractMarkedJson(stdout: string, nonce: string): Validation<unknown> {
  const text = stripAnsi(stdout).replace(/\r\n?/g, "\n");
  const b = beginMarker(nonce);
  const e = endMarker(nonce);
  const nb = countOccurrences(text, b);
  const ne = countOccurrences(text, e);
  if (nb === 0 || ne === 0) return fail("markers-missing", "result markers not found");
  if (nb !== 1 || ne !== 1) return fail("markers-ambiguous", "result markers appear more than once");
  const from = text.indexOf(b) + b.length;
  const to = text.indexOf(e);
  if (to < from) return fail("markers-ambiguous", "result markers out of order");
  let inner = text.slice(from, to).trim();
  if (Buffer.byteLength(inner, "utf8") > AGENT_LIMITS.maxOutputBytes) return fail("output-too-large", "result exceeds size limit");
  const fenced = /^```[A-Za-z]*\n([\s\S]*?)\n?```$/.exec(inner);
  if (fenced !== null) inner = (fenced[1] ?? "").trim();
  try {
    return { ok: true, value: JSON.parse(inner) as unknown };
  } catch {
    return fail("invalid-json", "result between markers is not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// Small schema helpers
// ---------------------------------------------------------------------------

function plain(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  return v as Record<string, unknown>;
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  for (const r of required) if (!keys.includes(r)) return false;
  for (const k of keys) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

function boundedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0 || t.length > max || CONTROL_EXCEPT_NL_RE.test(t)) return null;
  return t;
}

function stringArray(v: unknown, maxItems: number, minItems: number): string[] | null {
  if (!Array.isArray(v) || v.length < minItems || v.length > maxItems) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") return null;
    out.push(x);
  }
  return new Set(out).size === out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Analyst diagnosis
// ---------------------------------------------------------------------------

export const DIAGNOSIS_CATEGORIES = [
  "build-failure",
  "test-failure",
  "dependency",
  "configuration",
  "syntax-or-type-error",
  "runtime-error",
  "other",
] as const;
export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number];
export type Confidence = "low" | "medium" | "high";

export interface Diagnosis {
  category: DiagnosisCategory;
  summary: string;
  rootCause: string;
  confidence: Confidence;
  evidenceRefs: string[];
  affectedFiles: string[];
}

export interface DiagnosisContext {
  evidenceIds: ReadonlySet<string>;
  /** Paths of file evidence that was actually supplied. */
  evidencePaths: ReadonlySet<string>;
}

/**
 * `verdict:"unknown"` is reported as code "unknown-diagnosis" (a non-result), never as a diagnosis.
 * A diagnosis must cite at least one supplied evidence id; it cannot name a file it was not shown.
 */
export function validateDiagnosis(raw: unknown, ctx: DiagnosisContext): Validation<Diagnosis> {
  const o = plain(raw);
  if (o === null) return fail("schema-violation", "diagnosis is not a plain object");
  if (o["schemaVersion"] !== SCHEMA_VERSION || o["role"] !== "analyst") return fail("schema-violation", "wrong schemaVersion or role");
  if (o["verdict"] === "unknown") {
    if (!exactKeys(o, ["schemaVersion", "role", "verdict"], ["reason"])) return fail("schema-violation", "unexpected keys in unknown verdict");
    if (o["reason"] !== undefined && boundedString(o["reason"], AGENT_LIMITS.maxSummaryChars) === null) return fail("schema-violation", "bad reason");
    return fail("unknown-diagnosis", "analyst reported no supported diagnosis");
  }
  if (o["verdict"] !== "diagnosis") return fail("schema-violation", "verdict must be diagnosis or unknown");
  if (!exactKeys(o, ["schemaVersion", "role", "verdict", "category", "summary", "rootCause", "confidence", "evidenceRefs", "affectedFiles"])) {
    return fail("schema-violation", "missing or unexpected keys");
  }
  const category = o["category"];
  if (typeof category !== "string" || !(DIAGNOSIS_CATEGORIES as readonly string[]).includes(category)) return fail("schema-violation", "bad category");
  const confidence = o["confidence"];
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return fail("schema-violation", "bad confidence");
  const summary = boundedString(o["summary"], AGENT_LIMITS.maxSummaryChars);
  const rootCause = boundedString(o["rootCause"], AGENT_LIMITS.maxRootCauseChars);
  if (summary === null || rootCause === null) return fail("schema-violation", "bad summary or rootCause");
  const refs = stringArray(o["evidenceRefs"], AGENT_LIMITS.maxEvidenceRefs, 1);
  if (refs === null) return fail("schema-violation", "evidenceRefs must be 1..8 unique strings");
  for (const r of refs) if (!ctx.evidenceIds.has(r)) return fail("unknown-evidence-ref", "diagnosis cites evidence that was not supplied");
  const files = stringArray(o["affectedFiles"], AGENT_LIMITS.maxAffectedFiles, 0);
  if (files === null) return fail("schema-violation", "affectedFiles must be up to 10 unique strings");
  for (const f of files) {
    if (!isSafeRelativePath(f)) return fail("unsafe-path", "affectedFiles contains an unsafe path");
    if (!ctx.evidencePaths.has(f)) return fail("path-not-in-evidence", "affectedFiles names a file that was not supplied");
  }
  return {
    ok: true,
    value: { category: category as DiagnosisCategory, summary, rootCause, confidence, evidenceRefs: refs, affectedFiles: files },
  };
}

// ---------------------------------------------------------------------------
// Fixer patch proposal
// ---------------------------------------------------------------------------

export interface FileEvidence {
  /** True only when `text` is the entire, unmodified file. */
  complete: boolean;
  text: string;
}

export interface ParsedDiff {
  /** The diff, newline-terminated. */
  diff: string;
  files: string[];
  hunks: number;
  added: number;
  removed: number;
  /** True only if every touched file was supplied complete and every old-side line matched it. */
  contextVerified: boolean;
}

export interface PatchProposal extends ParsedDiff {
  summary: string;
  /** A proposal only. Nothing in this module applies it. */
  proposalOnly: true;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function splitFileLines(text: string): string[] {
  const l = text.split("\n");
  if (l.length > 0 && l[l.length - 1] === "") l.pop();
  return l;
}

/**
 * Strict unified diff parser for modifications of supplied files only.
 * Accepted grammar: `--- a/P`, `+++ b/P`, then `@@ -a[,b] +c[,d] @@` hunks whose line counts match
 * exactly. Rejected: new/deleted/renamed files, mode changes, binary patches, git extended headers,
 * missing leading space on context lines, unsafe or unsupplied paths, oversize. Oversize is
 * rejected, never truncated, because a truncated diff is unusable.
 */
export function parseUnifiedDiff(diffIn: unknown, files: ReadonlyMap<string, FileEvidence>): Validation<ParsedDiff> {
  if (typeof diffIn !== "string" || diffIn.trim().length === 0) return fail("diff-invalid", "diff is empty");
  if (Buffer.byteLength(diffIn, "utf8") > AGENT_LIMITS.maxDiffBytes) return fail("diff-too-large", "diff exceeds byte limit");
  if (CONTROL_EXCEPT_TAB_NL_RE.test(diffIn)) return fail("diff-invalid", "diff contains control characters");
  const diff = diffIn.endsWith("\n") ? diffIn : `${diffIn}\n`;
  const lines = diff.split("\n");
  lines.pop();
  if (lines.length > AGENT_LIMITS.maxDiffLines) return fail("diff-too-large", "diff exceeds line limit");

  const names: string[] = [];
  let totalHunks = 0;
  let added = 0;
  let removed = 0;
  let verified = true;
  let i = 0;

  while (i < lines.length) {
    const m1 = /^--- a\/(.+)$/.exec(lines[i] ?? "");
    const m2 = /^\+\+\+ b\/(.+)$/.exec(lines[i + 1] ?? "");
    if (m1 === null || m2 === null || m1[1] !== m2[1]) return fail("diff-invalid", `expected a/b file headers at line ${i + 1}`);
    const path = m1[1] ?? "";
    if (!isSafeRelativePath(path)) return fail("unsafe-path", "diff touches an unsafe path");
    const ev = files.get(path);
    if (ev === undefined) return fail("path-not-in-evidence", "diff touches a file that was not supplied");
    if (names.includes(path)) return fail("diff-invalid", "file appears twice in diff");
    if (names.length >= AGENT_LIMITS.maxDiffFiles) return fail("diff-too-large", "diff touches too many files");
    names.push(path);
    i += 2;

    const fileLines = ev.complete ? splitFileLines(ev.text) : null;
    if (fileLines === null) verified = false;
    let fileHunks = 0;
    let nextFree = 1;

    while (i < lines.length && (lines[i] ?? "").startsWith("@@")) {
      const hm = HUNK_RE.exec(lines[i] ?? "");
      if (hm === null) return fail("diff-invalid", `bad hunk header at line ${i + 1}`);
      const oldStart = Number(hm[1]);
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      i += 1;
      if (oldCount === 0 && newCount === 0) return fail("diff-invalid", "empty hunk");
      if (oldCount > 0 && oldStart < 1) return fail("diff-invalid", "bad hunk start");
      const effStart = oldCount === 0 ? oldStart + 1 : oldStart;
      if (effStart < nextFree) return fail("diff-invalid", "hunks overlap or are out of order");

      let o = 0;
      let n = 0;
      let changed = 0;
      const oldSide: string[] = [];
      while (o < oldCount || n < newCount) {
        const l = lines[i];
        if (l === undefined) return fail("diff-invalid", "hunk ends before its declared length");
        const tag = l.charAt(0);
        const body = l.slice(1);
        if (body.length > AGENT_LIMITS.maxDiffLineChars) return fail("diff-too-large", "diff line too long");
        if (tag === " ") {
          o += 1;
          n += 1;
          oldSide.push(body);
        } else if (tag === "-") {
          o += 1;
          oldSide.push(body);
          removed += 1;
          changed += 1;
        } else if (tag === "+") {
          n += 1;
          added += 1;
          changed += 1;
        } else {
          return fail("diff-invalid", `bad hunk line ${i + 1} (context lines need a leading space)`);
        }
        if (o > oldCount || n > newCount) return fail("diff-invalid", "hunk line counts do not match header");
        i += 1;
      }
      for (let k = 0; k < 2 && (lines[i] ?? "").startsWith("\\"); k += 1) {
        if (lines[i] !== "\\ No newline at end of file") return fail("diff-invalid", "bad no-newline marker");
        i += 1;
      }
      if (changed === 0) return fail("diff-invalid", "hunk changes nothing");
      if (fileLines !== null) {
        if (oldCount === 0) {
          if (oldStart > fileLines.length) return fail("context-mismatch", "insertion point is past the end of the file");
        } else {
          for (let k = 0; k < oldSide.length; k += 1) {
            if (fileLines[oldStart - 1 + k] !== oldSide[k]) return fail("context-mismatch", "hunk does not match the supplied file");
          }
        }
      }
      nextFree = effStart + oldCount;
      fileHunks += 1;
      totalHunks += 1;
      if (totalHunks > AGENT_LIMITS.maxDiffHunks) return fail("diff-too-large", "diff has too many hunks");
    }
    if (fileHunks === 0) return fail("diff-invalid", "file header without hunks");
  }
  if (names.length === 0) return fail("diff-invalid", "diff touches no files");
  return { ok: true, value: { diff, files: names, hunks: totalHunks, added, removed, contextVerified: verified } };
}

/** `verdict:"unknown"` is reported as code "no-patch". */
export function validatePatchProposal(raw: unknown, files: ReadonlyMap<string, FileEvidence>): Validation<PatchProposal> {
  const o = plain(raw);
  if (o === null) return fail("schema-violation", "proposal is not a plain object");
  if (o["schemaVersion"] !== SCHEMA_VERSION || o["role"] !== "fixer") return fail("schema-violation", "wrong schemaVersion or role");
  if (o["verdict"] === "unknown") {
    if (!exactKeys(o, ["schemaVersion", "role", "verdict"], ["reason"])) return fail("schema-violation", "unexpected keys in unknown verdict");
    return fail("no-patch", "fixer reported no safe patch");
  }
  if (o["verdict"] !== "patch") return fail("schema-violation", "verdict must be patch or unknown");
  if (!exactKeys(o, ["schemaVersion", "role", "verdict", "summary", "diff"])) return fail("schema-violation", "missing or unexpected keys");
  const summary = boundedString(o["summary"], AGENT_LIMITS.maxSummaryChars);
  if (summary === null) return fail("schema-violation", "bad summary");
  const parsed = parseUnifiedDiff(o["diff"], files);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { ...parsed.value, summary, proposalOnly: true } };
}
