/**
 * static-site-audit.test.ts — the read-only static site audit profile: reference resolution, HTML and
 * CSS extraction, the capped reader (fake executor, no Docker, no git, no network) and the result
 * payload as presented by result-view. Nothing here shows that the real flow works against Docker or
 * GitHub, and nothing is run from any repository.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProcessExecutor, ProcessOptions, ProcessResult } from "../docker-sandbox.js";
import type { HandoffInfo } from "../git-acquisition.js";
import { presentResult } from "../result-view.js";
import {
  STATIC_SITE_LIMITS,
  extractCssRefs,
  extractHtmlRefs,
  parseSiteTree,
  readStaticSite,
  resolveReference,
  staticSiteResultPayload,
} from "../static-site-audit.js";

const COMMIT = "a".repeat(40);
let counter = 0;
const nextId = (): string => (++counter).toString(16).padStart(40, "0");

interface Entry {
  path: string;
  size?: number;
  mode?: string;
  text?: string;
}

function listing(entries: Entry[]): { stdout: string; ids: Map<string, Entry & { id: string }> } {
  const ids = new Map<string, Entry & { id: string }>();
  const recs = entries.map((e) => {
    const id = nextId();
    const size = e.size ?? (e.text === undefined ? 10 : Buffer.byteLength(e.text, "utf8"));
    ids.set(id, { ...e, id });
    return `${e.mode ?? "100644"} blob ${id} ${String(size).padStart(7)}\t${e.path}`;
  });
  return { stdout: `${recs.join("\0")}\0`, ids };
}

const proc = (extra: Partial<ProcessResult>): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...extra,
});

function info(files: number, extra: Partial<HandoffInfo> = {}): HandoffInfo {
  return {
    containerName: "graveyard-acq-test",
    commit: COMMIT,
    manifest: { files, totalBytes: 100, submodulesSkipped: 0 },
    dockerBinary: "docker",
    remainingMs: 100_000,
    ...extra,
  };
}

function fakeGit(entries: Entry[]): { exec: ProcessExecutor; calls: string[][]; read: string[]; files: number } {
  const l = listing(entries);
  const calls: string[][] = [];
  const read: string[] = [];
  const exec: ProcessExecutor = (_f: string, args: readonly string[], _o: ProcessOptions) => {
    calls.push([...args]);
    if (args.includes("ls-tree")) return Promise.resolve(proc({ stdout: l.stdout }));
    const id = args[args.length - 1] as string;
    const e = l.ids.get(id);
    if (e === undefined) return Promise.resolve(proc({ exitCode: 128 }));
    read.push(e.path);
    return Promise.resolve(proc({ stdout: e.text ?? "" }));
  };
  return { exec, calls, read, files: entries.length };
}

const SITE: Entry[] = [
  { path: "index.html", text: "<a href=about.html>x</a>" },
  { path: "about.html", text: "" },
  { path: "css/site.css", text: "" },
  { path: "images/my photo.jpg" },
  { path: "img/Logo.png" },
  { path: "sub/page.html", text: "" },
  { path: "sub/index.html", text: "" },
  { path: "docs/readme.txt" },
  { path: "photo.jpg" },
  { path: "section/index.html", text: "" },
];

describe("resolveReference", () => {
  const tree = parseSiteTree(listing(SITE).stdout);
  const r = (v: string, from = "index.html", kind: "page" | "asset" = "asset"): string => {
    const o = resolveReference(v, from, kind, tree);
    return o.kind === "missing" || o.kind === "case-mismatch" ? `${o.kind}:${o.target}` : o.kind;
  };

  it("finds files through queries, fragments, percent-encoding, literal spaces and root paths", () => {
    assert.equal(r("about.html?x=1#top", "index.html", "page"), "found");
    assert.equal(r("images/my%20photo.jpg"), "found");
    assert.equal(r("images/my photo.jpg"), "found");
    assert.equal(r("/images/my%20photo.jpg", "sub/page.html"), "found");
    assert.equal(r("../css/site.css", "sub/page.html"), "found");
    assert.equal(r("  css/./site.css\n"), "found");
    assert.equal(r("/", "sub/page.html", "page"), "found");
  });

  it("matches case-sensitively and reports a case-only difference separately", () => {
    assert.equal(r("img/logo.png"), "case-mismatch:img/logo.png");
    assert.equal(r("img/Logo.png"), "found");
  });

  it("resolves directories and extensionless pages only for pages", () => {
    assert.equal(r("sub/", "index.html", "page"), "found");
    assert.equal(r("sub", "index.html", "page"), "found");
    assert.equal(r("about", "index.html", "page"), "found");
    assert.equal(r("sub/", "index.html", "asset"), "missing:sub");
    assert.equal(r("about", "index.html", "asset"), "missing:about");
    assert.equal(r("docs/", "index.html", "page"), "missing:docs");
    assert.equal(r("about.html/", "index.html", "page"), "missing:about.html");
  });

  it("keeps the trailing slash after folding path segments", () => {
    assert.equal(r("photo.jpg"), "found");
    assert.equal(r("photo.jpg/"), "missing:photo.jpg");
    assert.equal(r("photo.jpg/", "index.html", "page"), "missing:photo.jpg");
    assert.equal(r("./photo.jpg/"), "missing:photo.jpg");
    assert.equal(r("sub/../photo.jpg/"), "missing:photo.jpg");
    assert.equal(r("photo.jpg/."), "missing:photo.jpg");
    assert.equal(r("section/", "index.html", "page"), "found");
    assert.equal(r("section/./", "index.html", "page"), "found");
    assert.equal(r("sub/../section/", "index.html", "page"), "found");
    assert.equal(r("section/", "index.html", "asset"), "missing:section");
  });

  it("reports missing files with the resolved path", () => {
    assert.equal(r("nope/a b.png"), "missing:nope/a b.png");
    assert.equal(r("images/missing%20photo.jpg"), "missing:images/missing photo.jpg");
  });

  it("never looks up external, fragment-only, traversing or encoded-separator references", () => {
    for (const v of ["https://x.test/a.png", "//cdn.test/a.js", "mailto:a@b.test", "data:image/png;base64,AAAA", "javascript:void(0)", "HTTP://X.TEST"]) {
      assert.equal(r(v), "external", v);
    }
    assert.equal(r("#top"), "no-target");
    assert.equal(r("?x=1"), "no-target");
    assert.equal(r(""), "no-target");
    assert.equal(r("../../x.png"), "escapes-site-root");
    assert.equal(r("%2e%2e/x.png"), "escapes-site-root");
    assert.equal(r("/../x.png", "sub/page.html"), "escapes-site-root");
    assert.equal(r("a%2Fb.png"), "unsafe");
    assert.equal(r("a%5Cb.png"), "unsafe");
    assert.equal(r("a%00b.png"), "unsafe");
  });

  it("treats a malformed percent escape as literal text and a submodule path as unverifiable", () => {
    assert.equal(r("100%.jpg"), "missing:100%.jpg");
    const t = parseSiteTree(listing([{ path: "index.html" }]).stdout + `160000 commit ${nextId()} ${"-".padStart(7)}\tvendor/lib\0`);
    assert.equal(resolveReference("vendor/lib/a.js", "index.html", "asset", t).kind, "unverifiable");
  });
});

describe("extractHtmlRefs and extractCssRefs", () => {
  const values = (html: string): string[] => extractHtmlRefs(html).refs.map((x) => `${x.tag}.${x.attr}=${x.value}`);

  it("reads the conservative attribute subset, decodes entities and splits srcset", () => {
    const html = `<!DOCTYPE html><html><head><link rel=stylesheet href="css/site.css"><script src=js/app.js></script></head>
      <body><a href='about.html?a=1&amp;b=2'>x</a><img src="images/my photo.jpg" srcset="a.jpg 1x, b%20c.jpg 2x,d.jpg"><video poster=p.png src=v.mp4></video>
      <iframe src="f.html"></iframe><form action="post.php"></form><input type=image src=skip.png><div data-src="skip2.png"></div></body></html>`;
    assert.deepEqual(values(html), [
      "link.href=css/site.css",
      "script.src=js/app.js",
      "a.href=about.html?a=1&b=2",
      "img.src=images/my photo.jpg",
      "img.srcset=a.jpg",
      "img.srcset=b%20c.jpg",
      "img.srcset=d.jpg",
      "video.src=v.mp4",
      "video.poster=p.png",
      "iframe.src=f.html",
    ]);
  });

  it("ignores comments, script, textarea and title text, and unterminated markup", () => {
    const html = [
      `<!-- <img src="comment.png"> -->`,
      `<script>document.write('<img src="script.png">'); var a = "<a href=x.html>";</script>`,
      `<textarea><img src="textarea.png"></textarea><title><a href="title.html"></title>`,
      `<p>1 < 2 and <b>bold</b></p><img src="real.png">`,
      `<img src="unterminated.png`,
    ].join("\n");
    assert.deepEqual(values(html), ["img.src=real.png"]);
    assert.deepEqual(values(`<img src="a.png"><!-- never closed <img src="b.png">`), ["img.src=a.png"]);
  });

  it("collects style element and style attribute CSS and reports <base href>", () => {
    const x = extractHtmlRefs(`<base href="/x/"><style>body{background:url(bg.png)} /* url(no.png) */</style><div style="background:url(&quot;i m.png&quot;)"></div>`);
    assert.equal(x.baseHref, true);
    assert.deepEqual(x.refs, []);
    assert.deepEqual(x.inlineCss.flatMap(extractCssRefs), ["bg.png", "i m.png"]);
  });

  it("extracts CSS url() in all quote forms and @import, never from comments", () => {
    const css = `@import "a.css"; @import url('b.css'); /* url(c.png) */ .x{background:url( d.png )} .y{background:URL("e f.png")} .z{x:url()}`;
    assert.deepEqual(extractCssRefs(css), ["a.css", "b.css", "d.png", "e f.png"]);
  });

  it("caps the references per file and flags it", () => {
    const html = `<img src=a.png>`.repeat(STATIC_SITE_LIMITS.maxRefsPerFile + 5);
    const x = extractHtmlRefs(html);
    assert.equal(x.refs.length, STATIC_SITE_LIMITS.maxRefsPerFile);
    assert.equal(x.truncated, true);
  });

  it("stays linear on a long run of unterminated tags", () => {
    const html = "<a ".repeat(40_000);
    const t0 = Date.now();
    extractHtmlRefs(html);
    assert.ok(Date.now() - t0 < 5_000);
  });
});

describe("readStaticSite", () => {
  it("lists the tree, reads only HTML and CSS blobs with argument arrays, and reports missing references deterministically", async () => {
    const entries: Entry[] = [
      { path: "index.html", text: `<link href="css/site.css" rel=stylesheet><a href="about.html">a</a><a href="missing.html">m</a><img src="images/my%20photo.jpg"><img src="images/gone%20one.jpg"><img src="img/logo.png"><img src="../up.png"><img src="https://cdn.test/x.png"><!-- <img src="c.png"> -->` },
      { path: "about.html", text: `<a href="index.html#x">home</a><img src="/images/my photo.jpg">` },
      { path: "css/site.css", text: `body{background:url("../images/nope.jpg")} .a{background:url(../images/my%20photo.jpg)}` },
      { path: "images/my photo.jpg", size: 5_000_000 },
      { path: "img/Logo.png" },
    ];
    const g = fakeGit(entries);
    const res = await readStaticSite(g.exec, info(entries.length));
    assert.equal(res.kind, "audited");
    if (res.kind !== "audited") return;

    assert.deepEqual(g.read.sort(), ["about.html", "css/site.css", "index.html"], "no image blob is ever read");
    assert.ok(g.calls.every((c) => c[0] === "exec" && c.includes("git") && !c.includes("sh") && !c.includes("-c")));
    assert.deepEqual((g.calls[0] as string[]).slice(-6), ["ls-tree", "-r", "-l", "-z", "--full-tree", COMMIT]);

    const f = res.audit.findings;
    assert.equal(f[0]?.code, "static-site-scope");
    assert.deepEqual(
      f.slice(1).map((x) => x.code),
      ["missing-local-asset", "missing-local-page", "missing-local-asset", "case-mismatch-reference", "reference-escapes-site-root"],
    );
    assert.ok(f.every((x) => x.detail.length <= 300 && /^[\x20-\x7e]*$/.test(x.detail)));
    const refs = res.audit.facts.references;
    assert.deepEqual(
      { missing: refs.missing, caseMismatch: refs.caseMismatch, escapes: refs.escapesSiteRoot, external: refs.external, rootRelative: refs.rootRelative },
      { missing: 3, caseMismatch: 1, escapes: 1, external: 1, rootRelative: 1 },
    );
    assert.equal(res.audit.facts.readComplete, true);

    const again = await readStaticSite(fakeGit(entries).exec, info(entries.length));
    assert.deepEqual(again.kind === "audited" ? again.audit.findings : null, f);
  });

  it("is not a static site without a regular root index.html, and reads no blob", async () => {
    const entries: Entry[] = [{ path: "docs/index.html", text: "" }, { path: "readme.md" }];
    const g = fakeGit(entries);
    assert.deepEqual(await readStaticSite(g.exec, info(entries.length)), { kind: "not-static-site" });
    assert.deepEqual(g.read, []);
  });

  it("records oversize and over-limit files as not read and says the audit is incomplete", async () => {
    const entries: Entry[] = [{ path: "index.html", text: "<img src=a.png>" }, { path: "big.html", size: STATIC_SITE_LIMITS.maxFileBytes + 1 }];
    for (let i = 0; i <= STATIC_SITE_LIMITS.maxHtmlFiles; i += 1) entries.push({ path: `p${String(i).padStart(3, "0")}.html`, text: "" });
    const g = fakeGit(entries);
    const res = await readStaticSite(g.exec, info(entries.length));
    assert.equal(res.kind, "audited");
    if (res.kind !== "audited") return;
    assert.equal(res.audit.facts.readComplete, false);
    assert.equal(res.audit.facts.notRead.byReason["oversize"], 1);
    assert.equal(res.audit.facts.notRead.byReason["file-count-limit"], 2);
    assert.ok(!g.read.includes("big.html"));
    assert.equal(g.read[0], "index.html", "the entry page is read first");
  });

  it("stops reading with a recorded reason when the time budget is gone", async () => {
    const entries: Entry[] = [{ path: "index.html", text: "" }, { path: "a.html", text: "" }];
    const g = fakeGit(entries);
    let t = 0;
    const res = await readStaticSite(g.exec, info(entries.length, { remainingMs: 5_000 }), () => (t += 2_000));
    assert.equal(res.kind, "audited");
    if (res.kind !== "audited") return;
    assert.equal(res.audit.facts.readComplete, false);
    assert.ok((res.audit.facts.notRead.byReason["time-budget"] ?? 0) >= 1);
  });

  it("throws on a failed read, an abort, a truncated or malformed listing, a manifest mismatch and a symlink", async () => {
    const entries: Entry[] = [{ path: "index.html", text: "" }];
    const bad: ProcessExecutor = (_f, args) => Promise.resolve(args.includes("ls-tree") ? proc({ stdout: listing(entries).stdout }) : proc({ exitCode: 128 }));
    await assert.rejects(readStaticSite(bad, info(1)));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(readStaticSite(fakeGit(entries).exec, info(1, { signal: ac.signal })));
    await assert.rejects(readStaticSite(() => Promise.resolve(proc({ stdout: "x", truncated: true })), info(1)));
    await assert.rejects(readStaticSite(() => Promise.resolve(proc({ stdout: "garbage\0" })), info(1)));
    await assert.rejects(readStaticSite(fakeGit(entries).exec, info(2)), /manifest/);
    await assert.rejects(readStaticSite(fakeGit([{ path: "index.html", mode: "120000" }]).exec, info(1)));
    await assert.rejects(readStaticSite(fakeGit(entries).exec, { ...info(1), commit: "main" }));
  });
});

describe("staticSiteResultPayload through presentResult", () => {
  it("is a distinct outcome with no repair, no pass claim and findings under analysis.findings", async () => {
    const entries: Entry[] = [{ path: "index.html", text: `<img src="gone.png">` }];
    const res = await readStaticSite(fakeGit(entries).exec, info(1));
    assert.equal(res.kind, "audited");
    if (res.kind !== "audited") return;
    const payload = staticSiteResultPayload("https://github.com/o/r", COMMIT, res.audit);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 16 * 1024);

    const view = presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result: payload });
    assert.equal(view.outcome, "static-site-audited");
    assert.equal(view.repair.verified, false);
    assert.equal(view.repair.patchApplied, false);
    assert.equal(view.repair.patchProposed, false);
    assert.equal(view.verifiedDiff, null);
    assert.deepEqual((payload["analysis"] as { findings: Array<{ code: string }> }).findings.map((x) => x.code), ["static-site-scope", "missing-local-asset"]);

    for (const broken of [{ ...payload, executed: true }, { ...payload, repairAttempted: true }, { ...payload, sourceKind: "controlled-fixture" }, { ...payload, analysis: {} }]) {
      const v = presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result: broken });
      assert.equal(v.outcome, "completed-without-result");
    }
  });

  it("bounds the number and size of findings", async () => {
    const imgs = Array.from({ length: 400 }, (_, i) => `<img src="missing/${"x".repeat(100)}${i}.png">`).join("");
    const res = await readStaticSite(fakeGit([{ path: "index.html", text: imgs }]).exec, info(1));
    assert.equal(res.kind, "audited");
    if (res.kind !== "audited") return;
    assert.equal(res.audit.findings.length, STATIC_SITE_LIMITS.maxFindings);
    assert.ok(res.audit.facts.findingsOmitted > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(staticSiteResultPayload("https://github.com/o/r", COMMIT, res.audit)), "utf8") < 40 * 1024);
  });
});
