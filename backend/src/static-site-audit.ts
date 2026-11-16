/**
 * static-site-audit.ts — bounded, read-only STATIC SITE audit profile for a pinned GitHub commit that
 * has a root index.html and no package.json. Written without a shell or a test run (UNVERIFIED until
 * the operator runs the suite and a real-Docker check; see backend/DEVELOPMENT.md).
 *
 * What it does. Inside the guarded acquisition container (the afterCheckout hook of GitAcquisition,
 * same `docker exec` argument-array form as github-source.ts, no shell) it lists the tree with the
 * existing `git ls-tree -r -l -z --full-tree` step, re-validates every record and path, and reads
 * capped regular HTML and CSS blobs with `git cat-file blob <id>` (ids are 40-hex values git itself
 * printed and this module re-validates). Image and every other blob is never read or copied. The host
 * gets no checkout, no archive and no file copy; it only receives text that is parsed as DATA here.
 * Nothing is executed, imported, built, installed or fetched, no site asset URL is requested over the
 * network, and no agent (so no source for Kiro) is involved.
 *
 * What it reports. Local page and asset references (href, src, srcset, poster, inline style url(),
 * CSS url() and @import) that do not resolve to a committed regular file. The scope is partial on
 * purpose: only those attributes are checked, script-built references and `#id` anchors are not, and
 * unread files are listed. Findings are diagnostics. Zero findings does not mean the site works, and
 * the existence of index.html is never a pass claim. No repair is attempted or claimed.
 *
 * Reference rules (conservative, browser-like): entities in attribute values are decoded; leading and
 * trailing whitespace is removed; a URL with a scheme (http:, mailto:, data:, ...) or a `//host` form
 * is external and never requested; the fragment, then the query, is removed; each path segment is
 * percent-decoded once (an encoded `/`, `\` or control character is "unsafe"); `.` and `..` are
 * collapsed and a path that climbs above the repository root is "escapes the site root" and never
 * looked up; a root-relative path is resolved from the repository root (which is only the site root
 * when the site is served from the repository root). Matching is exact and case-sensitive, as on
 * GitHub Pages; a path that differs only by letter case is reported as a case mismatch. A directory
 * (or a page reference without extension) resolves through `<dir>/index.html` or `<path>.html` for
 * pages only. A `<base href>` makes every link in that file unauditable here, so the file is skipped.
 * Comments, script, style (read as CSS), textarea and title text never yield HTML references.
 *
 * @module static-site-audit
 */

import {
  ACQ_UID_GID,
  DEFAULT_ACQUISITION_LIMITS,
  GIT_SHA_RE,
  WORK_DIR,
  gitSteps,
  sanitize,
  unsafePathReason,
} from "./acquisition-policy.js";
import type { ProcessExecutor, ProcessResult } from "./docker-sandbox.js";
import type { HandoffInfo } from "./git-acquisition.js";

export const STATIC_SITE_LIMITS = Object.freeze({
  maxHtmlFiles: 40,
  maxCssFiles: 20,
  /** Per file. A larger file is listed as not read, never truncated and parsed. */
  maxFileBytes: 256 * 1024,
  /** Sum of the files read. */
  maxTotalBytes: 2 * 1024 * 1024,
  maxRefsPerFile: 2000,
  maxTagBytes: 8 * 1024,
  /** Findings kept in the result, the scope finding included. */
  maxFindings: 60,
  maxNotReadListed: 20,
});

const STEP_TIMEOUT_MS = 30_000;
const MIN_STEP_MS = 1_000;
const MIN_BLOB_MS = 2_000;

export type StaticSiteFindingCode =
  | "static-site-scope"
  | "missing-local-page"
  | "missing-local-asset"
  | "case-mismatch-reference"
  | "reference-escapes-site-root"
  | "unsafe-reference-path"
  | "base-href-not-audited";

export interface AuditFinding {
  code: StaticSiteFindingCode;
  detail: string;
}

// ---------------------------------------------------------------------------
// Tree (pure parsing of `git ls-tree -r -l -z --full-tree`)
// ---------------------------------------------------------------------------

export interface TreeFile {
  id: string;
  size: number;
}

export interface SiteTree {
  files: ReadonlyMap<string, TreeFile>;
  dirs: ReadonlySet<string>;
  /** Submodule paths (mode 160000). Content below them is not in the commit's blobs and is not verifiable. */
  gitlinks: readonly string[];
  lowerFiles: ReadonlySet<string>;
  lowerDirs: ReadonlySet<string>;
}

const TREE_LINE_RE = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}) +(-|[0-9]{1,15})\t([\s\S]+)$/;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Throws on anything the acquisition tree policy would also have refused (symlink, unsafe path, odd entry). */
export function parseSiteTree(stdout: string): SiteTree {
  const files = new Map<string, TreeFile>();
  const dirs = new Set<string>();
  const gitlinks: string[] = [];
  const records = stdout.split("\0");
  if (records[records.length - 1] === "") records.pop();
  for (const rec of records) {
    const m = TREE_LINE_RE.exec(rec);
    if (m === null) throw new Error("unexpected tree entry");
    const mode = m[1] as string;
    const type = m[2] as string;
    const id = m[3] as string;
    const size = m[4] as string;
    const path = m[5] as string;
    if (unsafePathReason(path) !== null) throw new Error("unsafe path in tree");
    if (mode === "160000" && type === "commit") {
      gitlinks.push(path);
    } else if ((mode === "100644" || mode === "100755") && type === "blob" && size !== "-") {
      files.set(path, { id, size: Number(size) });
    } else {
      throw new Error("unsupported tree entry");
    }
    const segs = path.split("/");
    for (let k = 1; k < segs.length; k += 1) dirs.add(segs.slice(0, k).join("/"));
  }
  return {
    files,
    dirs,
    gitlinks: gitlinks.sort(cmp),
    lowerFiles: new Set([...files.keys()].map((p) => p.toLowerCase())),
    lowerDirs: new Set([...dirs].map((p) => p.toLowerCase())),
  };
}

// ---------------------------------------------------------------------------
// Reference resolution (pure)
// ---------------------------------------------------------------------------

export type RefKind = "page" | "asset";

export type RefOutcome =
  | { kind: "no-target" }
  | { kind: "external" }
  | { kind: "found" }
  | { kind: "missing"; target: string }
  | { kind: "case-mismatch"; target: string }
  | { kind: "escapes-site-root" }
  | { kind: "unsafe" }
  | { kind: "unverifiable" };

// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Resolves one raw attribute or CSS value found in `fromFile` against the committed tree. Never throws. */
export function resolveReference(raw: string, fromFile: string, kind: RefKind, tree: SiteTree): RefOutcome {
  // eslint-disable-next-line no-control-regex
  let v = raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (v === "" || v.startsWith("#")) return { kind: "no-target" };
  if (SCHEME_RE.test(v) || v.startsWith("//") || v.startsWith("\\\\")) return { kind: "external" };
  v = v.replace(/\\/g, "/");
  const hash = v.indexOf("#");
  if (hash !== -1) v = v.slice(0, hash);
  const q = v.indexOf("?");
  if (q !== -1) v = v.slice(0, q);
  if (v === "") return { kind: "no-target" };

  const stack: string[] = v.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  const trailingSlash = v.endsWith("/");
  let dirLike = trailingSlash;
  for (const seg of v.split("/")) {
    if (seg === "") continue;
    let d = seg;
    try {
      d = decodeURIComponent(seg);
    } catch {
      // Malformed escape: the browser sends the text as written, so it is matched literally.
    }
    if (d.includes("/") || d.includes("\\") || CTRL_RE.test(d)) return { kind: "unsafe" };
    if (d === ".") {
      dirLike = true;
      continue;
    }
    if (d === "..") {
      if (stack.length === 0) return { kind: "escapes-site-root" };
      stack.pop();
      dirLike = true;
      continue;
    }
    dirLike = false;
    stack.push(d);
  }
  // The last pushed segment resets dirLike, so the written trailing slash is restored after folding.
  if (trailingSlash) dirLike = true;
  const target = stack.join("/");

  if (target === "") return tree.files.has("index.html") ? { kind: "found" } : { kind: "missing", target: "/" };
  for (const g of tree.gitlinks) {
    if (target === g || target.startsWith(`${g}/`)) return { kind: "unverifiable" };
  }
  if (!dirLike && tree.files.has(target)) return { kind: "found" };
  if (tree.dirs.has(target)) {
    return kind === "page" && tree.files.has(`${target}/index.html`) ? { kind: "found" } : { kind: "missing", target };
  }
  if (kind === "page" && !dirLike && tree.files.has(`${target}.html`)) return { kind: "found" };
  const lower = target.toLowerCase();
  if ((!dirLike && tree.lowerFiles.has(lower)) || tree.lowerDirs.has(lower)) return { kind: "case-mismatch", target };
  return { kind: "missing", target };
}

// ---------------------------------------------------------------------------
// Reference extraction (pure; the text is data, never executed)
// ---------------------------------------------------------------------------

export interface RawRef {
  value: string;
  kind: RefKind;
  tag: string;
  attr: string;
}

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY_RE, (m: string, e: string) => {
    if (e.startsWith("#")) {
      const cp = e.charAt(1) === "x" || e.charAt(1) === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

/** `url(...)` and `@import "..."` values of a CSS text (comments removed first). Bounded by the input size. */
export function extractCssRefs(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
  const re = /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^)\s"']*))\s*\)|@import\s+(?:"([^"\n]*)"|'([^'\n]*)')/gi;
  const out: string[] = [];
  for (const m of clean.matchAll(re)) {
    const v = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (v !== undefined && v !== "") out.push(v);
  }
  return out;
}

function parseSrcset(v: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < v.length && out.length < 50) {
    while (i < v.length && /[\s,]/.test(v.charAt(i))) i += 1;
    let j = i;
    while (j < v.length && !/\s/.test(v.charAt(j))) j += 1;
    let url = v.slice(i, j);
    i = j;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const c = v.indexOf(",", i);
      i = c === -1 ? v.length : c + 1;
    }
    if (url !== "") out.push(url);
  }
  return out;
}

const URL_ATTR_TABLE: Array<[string, ReadonlyArray<readonly [string, RefKind]>]> = [
  ["a", [["href", "page"]]],
  ["area", [["href", "page"]]],
  ["iframe", [["src", "page"]]],
  ["link", [["href", "asset"]]],
  ["img", [["src", "asset"], ["srcset", "asset"]]],
  ["source", [["src", "asset"], ["srcset", "asset"]]],
  ["script", [["src", "asset"]]],
  ["embed", [["src", "asset"]]],
  ["video", [["src", "asset"], ["poster", "asset"]]],
  ["audio", [["src", "asset"]]],
  ["track", [["src", "asset"]]],
];
const URL_ATTRS: ReadonlyMap<string, ReadonlyArray<readonly [string, RefKind]>> = new Map(URL_ATTR_TABLE);

/** Elements whose content is text, not markup. `style` content is returned as CSS; the others are dropped. */
const RAW_TEXT: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

const NAME_RE = /[A-Za-z][A-Za-z0-9:-]*/y;
const ATTR_NAME_RE = /[^\s>\/][^\s=>\/]*/y;
const UNQUOTED_RE = /[^\s>]*/y;
const SKIP_RE = /[\s\/]*/y;

type TagParse =
  | { kind: "tag"; name: string; attrs: Array<[string, string]>; end: number }
  | { kind: "text" }
  | { kind: "overlong"; next: number }
  | { kind: "eof" };

function parseTag(html: string, start: number): TagParse {
  NAME_RE.lastIndex = start + 1;
  const nm = NAME_RE.exec(html);
  if (nm === null) return { kind: "text" };
  const name = nm[0].toLowerCase();
  let pos = NAME_RE.lastIndex;
  const limit = start + STATIC_SITE_LIMITS.maxTagBytes;
  const attrs: Array<[string, string]> = [];
  for (;;) {
    SKIP_RE.lastIndex = pos;
    SKIP_RE.exec(html);
    pos = SKIP_RE.lastIndex;
    if (pos >= html.length) return { kind: "eof" };
    if (pos > limit) return { kind: "overlong", next: limit };
    if (html.charAt(pos) === ">") return { kind: "tag", name, attrs, end: pos + 1 };
    ATTR_NAME_RE.lastIndex = pos;
    const an = ATTR_NAME_RE.exec(html);
    if (an === null) {
      pos += 1;
      continue;
    }
    pos = ATTR_NAME_RE.lastIndex;
    const attrName = an[0].toLowerCase();
    let p = pos;
    while (/\s/.test(html.charAt(p))) p += 1;
    let value = "";
    if (html.charAt(p) === "=") {
      p += 1;
      while (/\s/.test(html.charAt(p))) p += 1;
      const quote = html.charAt(p);
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, p + 1);
        if (close === -1) return { kind: "eof" };
        if (close > limit) return { kind: "overlong", next: limit };
        value = html.slice(p + 1, close);
        pos = close + 1;
      } else {
        UNQUOTED_RE.lastIndex = p;
        UNQUOTED_RE.exec(html);
        value = html.slice(p, UNQUOTED_RE.lastIndex);
        pos = UNQUOTED_RE.lastIndex;
      }
    }
    attrs.push([attrName, decodeEntities(value)]);
  }
}

export interface HtmlRefs {
  refs: RawRef[];
  /** Contents of `<style>` elements and `style=""` attributes (CSS text). */
  inlineCss: string[];
  baseHref: boolean;
  /** The per-file reference cap was reached; later references were not examined. */
  truncated: boolean;
}

/** Conservative attribute subset. Comments, script/style/textarea/title text and unterminated tags yield nothing. */
export function extractHtmlRefs(html: string): HtmlRefs {
  const refs: RawRef[] = [];
  const inlineCss: string[] = [];
  let baseHref = false;
  let truncated = false;
  let i = 0;
  scan: while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      if (e === -1) break;
      i = e + 3;
      continue;
    }
    const c = html.charAt(lt + 1);
    if (c === "!" || c === "?" || c === "/") {
      const e = html.indexOf(">", lt + 2);
      if (e === -1) break;
      i = e + 1;
      continue;
    }
    const t = parseTag(html, lt);
    if (t.kind === "eof") break;
    if (t.kind === "text") {
      i = lt + 1;
      continue;
    }
    if (t.kind === "overlong") {
      i = t.next;
      continue;
    }
    i = t.end;

    const attr = (n: string): string | undefined => t.attrs.find(([k]) => k === n)?.[1];
    if (t.name === "base" && attr("href") !== undefined) baseHref = true;
    const style = attr("style");
    if (style !== undefined) inlineCss.push(style);
    for (const [a, kind] of URL_ATTRS.get(t.name) ?? []) {
      const v = attr(a);
      if (v === undefined) continue;
      for (const value of a === "srcset" ? parseSrcset(v) : [v]) {
        if (refs.length >= STATIC_SITE_LIMITS.maxRefsPerFile) {
          truncated = true;
          break scan;
        }
        refs.push({ value, kind, tag: t.name, attr: a });
      }
    }
    if (RAW_TEXT.has(t.name)) {
      const closer = new RegExp(`</${t.name}(?=[\\s/>])`, "gi");
      closer.lastIndex = i;
      const m = closer.exec(html);
      const end = m === null ? html.length : m.index;
      if (t.name === "style") inlineCss.push(html.slice(i, end));
      i = end;
    }
  }
  return { refs, inlineCss, baseHref, truncated };
}

// ---------------------------------------------------------------------------
// Audit (pure)
// ---------------------------------------------------------------------------

export interface SiteText {
  path: string;
  kind: "html" | "css";
  text: string;
}

export type NotReadReason = "oversize" | "file-count-limit" | "byte-budget" | "time-budget";

export interface NotRead {
  path: string;
  reason: NotReadReason;
}

export interface StaticSiteFacts {
  entry: "index.html";
  tree: { files: number; directories: number };
  discovered: { html: number; css: number };
  read: { html: number; css: number; bytes: number };
  notRead: { total: number; byReason: Record<string, number>; listed: NotRead[] };
  references: {
    extracted: number;
    found: number;
    missing: number;
    caseMismatch: number;
    escapesSiteRoot: number;
    unsafe: number;
    unverifiable: number;
    external: number;
    noTarget: number;
    rootRelative: number;
  };
  baseHrefFiles: number;
  refsTruncatedFiles: number;
  findingsOmitted: number;
  /** True when every discovered HTML and CSS file was read. The audit scope is still partial (see notes). */
  readComplete: boolean;
}

export interface StaticSiteAudit {
  findings: AuditFinding[];
  facts: StaticSiteFacts;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);

export function auditStaticSite(
  tree: SiteTree,
  texts: readonly SiteText[],
  notRead: readonly NotRead[],
  discovered: { html: number; css: number },
): StaticSiteAudit {
  const refs = {
    extracted: 0, found: 0, missing: 0, caseMismatch: 0, escapesSiteRoot: 0, unsafe: 0,
    unverifiable: 0, external: 0, noTarget: 0, rootRelative: 0,
  };
  const found: AuditFinding[] = [];
  const seen = new Set<string>();
  const add = (code: StaticSiteFindingCode, detail: string, key: string): void => {
    const k = `${code}\0${key}`;
    if (seen.has(k)) return;
    seen.add(k);
    found.push({ code, detail: sanitize(detail, 220) });
  };
  let baseHrefFiles = 0;
  let refsTruncatedFiles = 0;
  let htmlRead = 0;
  let cssRead = 0;
  let bytes = 0;

  for (const t of [...texts].sort((a, b) => cmp(a.path, b.path))) {
    bytes += Buffer.byteLength(t.text, "utf8");
    const list: RawRef[] = [];
    let fileTruncated = false;
    if (t.kind === "html") {
      htmlRead += 1;
      const x = extractHtmlRefs(t.text);
      if (x.baseHref) {
        baseHrefFiles += 1;
        add("base-href-not-audited", `${t.path}: a <base href> changes how every link resolves, so this file's references were not audited`, t.path);
        continue;
      }
      fileTruncated = x.truncated;
      list.push(...x.refs);
      for (const css of x.inlineCss) {
        for (const value of extractCssRefs(css)) list.push({ value, kind: "asset", tag: "style", attr: "url()" });
      }
    } else {
      cssRead += 1;
      for (const value of extractCssRefs(t.text)) list.push({ value, kind: "asset", tag: "css", attr: "url()" });
    }
    if (list.length > STATIC_SITE_LIMITS.maxRefsPerFile) {
      list.length = STATIC_SITE_LIMITS.maxRefsPerFile;
      fileTruncated = true;
    }
    if (fileTruncated) refsTruncatedFiles += 1;

    for (const r of list) {
      refs.extracted += 1;
      const out = resolveReference(r.value, t.path, r.kind, tree);
      const where = `${t.path}: <${r.tag} ${r.attr}> "${clip(r.value.trim(), 70)}"`;
      switch (out.kind) {
        case "no-target":
          refs.noTarget += 1;
          break;
        case "external":
          refs.external += 1;
          break;
        case "found":
          refs.found += 1;
          break;
        case "unverifiable":
          refs.unverifiable += 1;
          break;
        case "missing":
          refs.missing += 1;
          add(
            r.kind === "page" ? "missing-local-page" : "missing-local-asset",
            `${where} resolves to "${clip(out.target, 70)}", which is not a committed file`,
            `${t.path}\0${out.target}`,
          );
          break;
        case "case-mismatch":
          refs.caseMismatch += 1;
          add("case-mismatch-reference", `${where} resolves to "${clip(out.target, 70)}", which differs from a committed path only by letter case`, `${t.path}\0${out.target}`);
          break;
        case "escapes-site-root":
          refs.escapesSiteRoot += 1;
          add("reference-escapes-site-root", `${where} climbs above the repository root and was not looked up`, `${t.path}\0${r.value}`);
          break;
        case "unsafe":
          refs.unsafe += 1;
          add("unsafe-reference-path", `${where} contains an encoded separator or control character and was not looked up`, `${t.path}\0${r.value}`);
          break;
      }
      if (out.kind !== "no-target" && out.kind !== "external" && /^\s*\/(?!\/)/.test(r.value)) refs.rootRelative += 1;
    }
  }

  const byReason: Record<string, number> = {};
  for (const n of notRead) byReason[n.reason] = (byReason[n.reason] ?? 0) + 1;
  const readComplete = notRead.length === 0;
  const keep = found.slice(0, STATIC_SITE_LIMITS.maxFindings - 1);
  const omitted = found.length - keep.length;

  const scope =
    `Partial audit: read ${htmlRead} of ${discovered.html} HTML and ${cssRead} of ${discovered.css} CSS file(s)` +
    `${notRead.length === 0 ? "" : `, ${notRead.length} not read`}; ` +
    `only href, src, srcset, poster and CSS url()/@import references were checked; ${found.length} problem(s) found` +
    `${omitted > 0 ? `, ${omitted} not listed` : ""}.`;

  return {
    findings: [{ code: "static-site-scope", detail: sanitize(scope, 300) }, ...keep],
    facts: {
      entry: "index.html",
      tree: { files: tree.files.size, directories: tree.dirs.size },
      discovered,
      read: { html: htmlRead, css: cssRead, bytes },
      notRead: {
        total: notRead.length,
        byReason,
        listed: notRead.slice(0, STATIC_SITE_LIMITS.maxNotReadListed).map((n) => ({ path: sanitize(n.path, 120), reason: n.reason })),
      },
      references: refs,
      baseHrefFiles,
      refsTruncatedFiles,
      findingsOmitted: omitted,
      readComplete,
    },
  };
}

// ---------------------------------------------------------------------------
// Reader (runs inside the acquisition container through the injected executor)
// ---------------------------------------------------------------------------

export type StaticSiteRead =
  /** No regular root index.html: the repository is not in this profile and the normal dispatch continues. */
  | { kind: "not-static-site" }
  | { kind: "audited"; audit: StaticSiteAudit };

const HTML_RE = /\.html?$/i;
const CSS_RE = /\.css$/i;

/**
 * Lists the tree, and, when a regular root index.html exists, reads capped HTML and CSS blobs and
 * audits them. THROWS on a transport problem, a malformed or unsafe listing, a listing that
 * disagrees with the acquisition manifest, a failed read or an abort, so the acquisition fails
 * closed as infrastructure. Limits (size, count, byte budget, time) never throw: the files not read
 * are recorded and the audit says so.
 */
export async function readStaticSite(
  executor: ProcessExecutor,
  info: HandoffInfo,
  now: () => number = Date.now,
): Promise<StaticSiteRead> {
  if (!GIT_SHA_RE.test(info.commit)) throw new Error("the commit is not a full lowercase SHA");
  const started = now();
  const timeLeft = (): number => info.remainingMs - (now() - started);
  const run = async (gitArgs: readonly string[], cap: number): Promise<ProcessResult> => {
    if (info.signal?.aborted === true) throw new Error("aborted");
    if (timeLeft() < MIN_STEP_MS) throw new Error("no time left for reading the static site");
    const r = await executor(
      info.dockerBinary,
      ["exec", "--user", ACQ_UID_GID, "--workdir", WORK_DIR, info.containerName, "git", ...gitArgs],
      {
        timeoutMs: Math.min(STEP_TIMEOUT_MS, timeLeft()),
        maxOutputBytes: cap,
        ...(info.signal === undefined ? {} : { signal: info.signal }),
      },
    );
    if (r.timedOut || r.aborted) throw new Error("a git read timed out or was aborted");
    if (r.exitCode !== 0) throw new Error("a git read failed");
    return r;
  };

  const listing = await run(gitSteps.listTree(info.commit), DEFAULT_ACQUISITION_LIMITS.maxTreeListBytes);
  if (listing.truncated) throw new Error("tree listing is larger than expected");
  const tree = parseSiteTree(listing.stdout);
  if (tree.files.size !== info.manifest.files) throw new Error("the tree listing disagrees with the acquisition manifest");
  if (!tree.files.has("index.html")) return { kind: "not-static-site" };

  const L = STATIC_SITE_LIMITS;
  const html = [...tree.files.keys()].filter((p) => HTML_RE.test(p)).sort(cmp);
  const entryAt = html.indexOf("index.html");
  if (entryAt > 0) html.unshift(...html.splice(entryAt, 1));
  const css = [...tree.files.keys()].filter((p) => CSS_RE.test(p)).sort(cmp);

  const texts: SiteText[] = [];
  const notRead: NotRead[] = [];
  let bytes = 0;
  let nHtml = 0;
  let nCss = 0;
  const candidates: Array<{ path: string; kind: "html" | "css" }> = [
    ...html.map((path) => ({ path, kind: "html" as const })),
    ...css.map((path) => ({ path, kind: "css" as const })),
  ];
  for (const c of candidates) {
    const f = tree.files.get(c.path) as TreeFile;
    const count = c.kind === "html" ? nHtml : nCss;
    const countLimit = c.kind === "html" ? L.maxHtmlFiles : L.maxCssFiles;
    if (f.size > L.maxFileBytes) notRead.push({ path: c.path, reason: "oversize" });
    else if (count >= countLimit) notRead.push({ path: c.path, reason: "file-count-limit" });
    else if (bytes + f.size > L.maxTotalBytes) notRead.push({ path: c.path, reason: "byte-budget" });
    else if (timeLeft() < MIN_BLOB_MS) notRead.push({ path: c.path, reason: "time-budget" });
    else {
      const r = await run(["cat-file", "blob", f.id], L.maxFileBytes + 1);
      if (r.truncated || Buffer.byteLength(r.stdout, "utf8") > L.maxFileBytes) {
        notRead.push({ path: c.path, reason: "oversize" });
        continue;
      }
      texts.push({ path: c.path, kind: c.kind, text: r.stdout });
      bytes += f.size;
      if (c.kind === "html") nHtml += 1;
      else nCss += 1;
    }
  }
  return { kind: "audited", audit: auditStaticSite(tree, texts, notRead, { html: html.length, css: css.length }) };
}

// ---------------------------------------------------------------------------
// Result payload
// ---------------------------------------------------------------------------

/** The stored result of a static-site audit. Diagnostics only: no repair, nothing executed, no pass claim. */
export function staticSiteResultPayload(repoUrl: string, commit: string, audit: StaticSiteAudit): Record<string, unknown> {
  const f = audit.facts;
  const notes = [
    "The commit was fetched in a disposable container. Only the file listing and capped HTML and CSS blobs were read, as text. Nothing was built, run, installed or requested over the network.",
    "Checked: href, src, srcset, poster, inline style url(), CSS url() and @import. Not checked: references built by scripts, other attributes, #anchors, and files listed as not read.",
    "Findings are diagnostics from a conservative static check. They are not a repair, and no findings does not mean the site renders or works.",
  ];
  if (f.references.rootRelative > 0) {
    notes.push("Root-relative paths were resolved from the repository root, which is the site root only if the site is served from the root.");
  }
  return {
    verdict: "static-site-audited",
    sourceKind: "github-pinned",
    profile: "static-site",
    source: { repoUrl, commit },
    executed: false,
    repairAttempted: false,
    audit: f,
    analysis: { auditComplete: f.readComplete, findings: audit.findings.map((x) => ({ code: x.code, detail: x.detail })) },
    notes,
  };
}
