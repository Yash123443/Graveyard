/**
 * manual-github-e2e-check.ts — OPT-IN end-to-end harness for the GitHub worker path: real API over
 * real localhost HTTP, the real worker composition (startWorker -> composeWorker -> GithubJobRunner
 * -> OperatorEgressGuard -> GitAcquisition) and REAL Docker, for ONE exact pinned public commit:
 *
 *   https://github.com/octocat/Hello-World  @  7fd1a60b01f91b314f59955a4e4d4e80d8edf11d
 *
 * Status: written without being compiled or run. A pass is evidence only once an operator has run it
 * and recorded the output (see backend/DEVELOPMENT.md). Nothing here claims it has run.
 *
 * Skipped unless GRAVEYARD_MANUAL_GITHUB_E2E=1, so `pnpm test` (which globs dist-test/test/*.js)
 * reports it as skipped and never touches Docker or the network. The single explicit command is:
 *
 *   pnpm run test:github-e2e
 *
 * Inputs: none are required. Optional:
 *   GRAVEYARD_GITHUB_E2E_GIT_IMAGE  git-containing image, default alpine/git:2.47.2. Must already
 *                                   exist locally (never pulled) and provide `git` and `sleep`.
 * Also required locally: a running Docker daemon and the image node:22-alpine (never pulled).
 * Outbound access to github.com:443 from the Docker host's default bridge network.
 *
 * What it does (the topology and the cleanup pattern are those of manual-clone-check.ts):
 *   1. Fails closed, before creating anything, unless Docker answers, both images exist locally and
 *      the compiled egress proxy files exist in dist-test.
 *   2. Creates a per-run `--internal` Docker network (random /24, label graveyard.manual-github-e2e)
 *      and ONE proxy container (node:22-alpine, hardened, read-only bind of four compiled files)
 *      running EgressProxy for target github.com only, attached to that network at a fixed address
 *      and to the default bridge for upstream, labelled graveyard.egress-proxy=github.com. It checks
 *      with docker inspect and one probe (CONNECT example.com:443 must answer 403) that the topology
 *      is what it expects. The worker's own OperatorEgressGuard then repeats its checks per job.
 *   3. Creates temporary directories under backend/.tmp-fixtures (gitignored): database and
 *      catalogs, a placeholder fixtures root, staging, an EMPTY npm cache directory and the GitHub
 *      runs root. The real data/ database is never opened.
 *   4. Starts the real API (buildApp) on 127.0.0.1 with an ephemeral port, then the real worker
 *      through startWorker with an explicit environment object (not process.env): GitHub catalog
 *      with exactly the one pin above, the proxy topology from step 2, agents `off`, NO registry
 *      egress variables. No test seam is injected except the log sink.
 *   5. POST /api/jobs with consent, checks 401 without a token and 403 with another well-formed
 *      token, then polls GET /api/jobs/:id/result with the owner token until terminal.
 *   6. Expects: status completed, stage done, outcome unsupported-repository, stored verdict
 *      unsupported-repository, sourceKind github-pinned, the pinned URL and commit, analysis not
 *      supported with exactly the findings no-package-json, no-package-lock and no-build-script
 *      (Hello-World has no package files), repair.verified and repair.patchApplied both false, no
 *      infrastructure record, Cache-Control no-store, and no token in any body or in the worker log.
 *   7. Cleanup, in order: worker.stop() (an active job settles only with cleanup proof), app.close(),
 *      an independent docker query for acquisition and sandbox containers of the job's execution ids
 *      (a leaked acquisition container is removed by exact label match and reported as a problem),
 *      removal of the proxy container and network (only if the run label matches), then removeRunDir
 *      for every temporary directory. Anything left over is a reported problem and fails the test.
 *
 * What runs where: the only repository content that reaches the host is the root file listing and
 * (here) nothing else, because none of the four files exists. No repository code is executed, no
 * registry is contacted, no npm install happens, no agent runs, no build or test container is created.
 *
 * What a pass would show: on this machine, the real API and worker fetched exactly the pinned commit
 * through the single-host proxy on an internal network, reported it as unsupported-repository, and
 * left no container, network or temporary data behind. It would not show a supported-repository run,
 * registry acquisition, repair, other repositories, or isolation of the topology (the proxy probe is a
 * narrow spot check, not proof).
 *
 * Fail closed: if Docker, an image, the network, the proxy or GitHub access fails, the harness throws
 * and prints FAIL-CLOSED. It then makes no claim about the worker, the proxy or GitHub.
 *
 * SUPPORTED FIXTURE MODE (added later by Kiro; written without being compiled or run, UNVERIFIED).
 * Opt-in on top of the opt-in above: set BOTH
 *   GRAVEYARD_GITHUB_E2E_SUPPORTED_URL     canonical public URL, https://github.com/<owner>/<repo>
 *   GRAVEYARD_GITHUB_E2E_SUPPORTED_COMMIT  full lowercase 40-hex commit of that repository
 * Setting only one, or an invalid value, fails closed before anything is created. Without either
 * variable the default Hello-World mode above runs unchanged. The harness cannot check that the
 * repository is public or that its root files fit the supported class; the operator supplies a
 * fixture whose root holds exactly package.json (no scripts), package-lock.json (lockfileVersion 3,
 * one is-number@7.0.0 entry), build.mjs and test.mjs (see backend/README.md).
 * Differences from the default mode:
 *   - a SECOND per-run `--internal` network (adjacent /24) and a SECOND hardened proxy container
 *     for registry.npmjs.org only (label graveyard.egress-proxy=registry.npmjs.org), created by the
 *     same helper and rolled back by the same label-checked cleanup. Each proxy must answer 403 to
 *     CONNECT example.com:443 and to the other proxy's host;
 *   - the worker environment adds GRAVEYARD_REGISTRY_EGRESS_NETWORK / _PROXY_CONTAINER / _PROXY_URL
 *     and the pin catalog holds exactly the supplied URL and commit. Agents stay off;
 *   - expected result: completed, done, outcome passing, verdict verified, sourceKind github-pinned
 *     with the supplied URL and commit, pipeline passed with install, build and test stages all
 *     passed, Tester report passed, no analyst or fixer output, repair.verified and
 *     repair.patchApplied false, no infrastructure record, 401 and 403 auth checks, no token leak;
 *   - cleanup additionally queries, by label and by name, the registry acquisition containers of the
 *     registry execution ids derived from each attempt's execution id (`<uuid>-npm:<n>`), besides
 *     the git acquisition and sandbox containers, and removes both proxies and both networks.
 * It does not modify production policy and publishes nothing. A pass would show only what the
 * assertions list, on this machine, for this one repository and commit.
 *
 * STATIC SITE MODE (added later by Kiro; written without being compiled or run, UNVERIFIED).
 * Opt-in on top of the opt-in above: set GRAVEYARD_GITHUB_E2E_STATIC=1. It cannot be combined with the
 * supported-fixture variables (fails closed). It uses the same isolated topology, API and worker as the
 * default mode (github.com proxy only, NO registry egress, agents off) with a different fixed pin:
 *   https://github.com/yash123443/mumbai-tour @ 6d193fab40659cb5c568855f8294abf324adc4ea
 * Expected result: completed, done, outcome static-site-audited, verdict static-site-audited,
 * sourceKind github-pinned with that URL and commit, profile static-site, executed false,
 * repairAttempted false, repair.verified/patchApplied false, no verifiedDiff, no analyst or fixer
 * output, no infrastructure record, audit.read.html > 0, 401 and 403 checks, no token leak. The
 * audit counts and finding codes/details the worker stored are printed (bounded). The audit is
 * diagnostics only: the harness makes no claim that the site works or is broken.
 *
 * NPM SCRIPTS REPAIR MODE (added later by Kiro; written without being compiled or run, UNVERIFIED).
 * Opt-in on top of the supported mode: set GRAVEYARD_GITHUB_E2E_NPM_REPAIR=1 AND both supported variables
 * (the operator-supplied public URL and full commit SHA). It cannot be combined with
 * GRAVEYARD_GITHUB_E2E_STATIC=1 (fails closed). Only in this mode the worker environment sets
 * GRAVEYARD_GITHUB_NPM_SCRIPTS=1 and GRAVEYARD_WORKER_AGENTS=kiro-v2 (LIVE Kiro: the bounded, redacted
 * build-entry source of that public repository is sent to Kiro). Every other mode keeps agents off.
 * Same topology (github.com proxy and registry proxy on per-run internal networks), same API and
 * worker, ONE job, the same time budgets as the supported mode. The operator must supply a public
 * repository whose scripts.build is `node FILE`, which fails at the build stage, and whose scripts.test is
 * `node --test` or `node --test FILE` (see npm-scripts-repair.ts); the harness cannot check that.
 * Expected result (anything else is a problem): completed, done, outcome repair-verified, verdict
 * repository-failing, runMode npm-scripts, the exact supplied URL and commit, baseline pipeline failed at
 * build with prepare and install passed, verification status verified with class npm-scripts-build-entry,
 * the patched copy's prepare/install/build/test passed with TAP counts (at least one passed, none failed or
 * cancelled), verifiedDiff equal to the stored fixer diff and to its recorded sha256, repair.verified
 * true, repair.patchApplied false, originalModified false, no infrastructure record. Cleanup also queries
 * the derived repair execution id (`<uuid>-fix:<n>`) besides the main id. For a result that is not
 * verified, only fixed-vocabulary status/reason/code fields of the baseline, Analyst, Fixer and
 * verification are printed (no token, no source, no diff, no model text).
 * Caveats: it shows nothing about other repositories, the original snapshot is checked only through the
 * stored record (its run directory is removed with the job), and Kiro's output is not deterministic.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";
import { GIT_SHA_RE } from "../acquisition-policy.js";
import { deriveRegistryExecutionId } from "../github-runner.js";
import { NPM_SCRIPTS_PATCH_CLASS, isBuildEntryName, testCountsAcceptable } from "../build-entry.js";
import { deriveRepairExecutionId } from "../npm-scripts-repair.js";
import { NPM_ACQ_LABEL_ID, npmAcquisitionContainerName } from "../npm-registry-acquisition.js";
import { ACQ_LABEL_ID, acquisitionContainerName } from "../git-acquisition.js";
import { EGRESS_PROXY_LABEL, PROBE_SCRIPT } from "../egress-guard.js";
import { LABEL_EXECUTION, containerNameFor, spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { executionIdFor } from "../leases.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import type { ResultView } from "../result-view.js";
import { validateGithubUrl } from "../url.js";
import { startWorker, type StartResult } from "../worker-process.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_GITHUB_E2E"] === "1";

/** The single pinned public repository this harness is allowed to touch. */
const PINNED_URL = "https://github.com/octocat/Hello-World";
const PINNED_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const EXPECTED_FINDINGS = ["no-build-script", "no-package-json", "no-package-lock"];
/** Catalog key only, in the placeholder fixture catalog the worker requires. Never submitted, never fetched. */
const PLACEHOLDER_URL = "https://github.com/graveyard-local/unused-placeholder";
const PLACEHOLDER_FIXTURE = "placeholder";

const PROXY_IMAGE = "node:22-alpine";
const DEFAULT_GIT_IMAGE = "alpine/git:2.47.2";
const GIT_IMAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const LABEL = "graveyard.manual-github-e2e";
const PROXY_PORT = "3128";
const POLL_MS = 500;

const SUPPORTED_URL_VAR = "GRAVEYARD_GITHUB_E2E_SUPPORTED_URL";
const SUPPORTED_COMMIT_VAR = "GRAVEYARD_GITHUB_E2E_SUPPORTED_COMMIT";
/** Supported mode is requested when either variable is set (even empty), so a half-set pair fails closed. */
const SUPPORTED_REQUESTED = process.env[SUPPORTED_URL_VAR] !== undefined || process.env[SUPPORTED_COMMIT_VAR] !== undefined;
const STATIC_VAR = "GRAVEYARD_GITHUB_E2E_STATIC";
/** Static site mode: a fixed public pin, no registry, no agents. Any other non-empty value fails closed. */
const STATIC_REQUESTED = process.env[STATIC_VAR] === "1";
const STATIC_URL = "https://github.com/yash123443/mumbai-tour";
const STATIC_COMMIT = "6d193fab40659cb5c568855f8294abf324adc4ea";
const REPAIR_VAR = "GRAVEYARD_GITHUB_E2E_NPM_REPAIR";
/** npm scripts repair mode: needs the supported URL/commit, excludes static. Any other non-empty value fails closed. */
const REPAIR_REQUESTED = process.env[REPAIR_VAR] === "1";
const MAX_PRINTED_FINDINGS = 25;
const MAX_PRINTED_DETAIL = 240;
const SETUP_MS = SUPPORTED_REQUESTED ? 240_000 : 120_000;
/** Upper bound for the job to reach a terminal state (default mode: the acquisition budget is 300 s). */
const JOB_DEADLINE_MS = SUPPORTED_REQUESTED ? 720_000 : 360_000;
const REGISTRY_HOST = "registry.npmjs.org";
const GITHUB_HOST = "github.com";

class FailClosed extends Error {}

interface Run { ok: boolean; code: number | null; stdout: string; stderr: string }

async function docker(args: readonly string[], timeoutMs = 20_000): Promise<Run> {
  try {
    const r = await spawnExecutor("docker", args, { timeoutMs, maxOutputBytes: 256 * 1024 });
    return {
      ok: r.exitCode === 0 && !r.timedOut && !r.aborted && !r.truncated,
      code: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  } catch {
    return { ok: false, code: null, stdout: "", stderr: "could not start docker" };
  }
}

interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpCall(port: number, method: "GET" | "POST", path: string, headers: Record<string, string>, body?: string): Promise<HttpReply> {
  return new Promise<HttpReply>((resolveReply, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("http request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function backendRoot(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    throw new FailClosed(`cannot read package.json at the expected backend root ${root}`);
  }
  if (name !== "graveyard-backend") throw new FailClosed(`${root} is not the graveyard-backend package`);
  return realpathSync(root);
}

const HARDENING: readonly string[] = [
  "--pull", "never", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
  "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "--pids-limit", "64", "--user", "65532:65532",
  "--log-driver", "json-file", "--log-opt", "max-size=64k", "--log-opt", "max-file=1",
];

const PROXY_SCRIPT = `import { EgressProxy } from "/app/egress-proxy.js";
const proxy = new EgressProxy({ target: process.env.GRAVEYARD_PROXY_TARGET, bindHost: process.env.GRAVEYARD_PROXY_BIND, port: ${PROXY_PORT}, onEvent: (e) => console.log(JSON.stringify(e)) });
const a = await proxy.start();
console.log(JSON.stringify({ kind: "listening", host: a.host, port: a.port }));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { proxy.close().finally(() => process.exit(0)); });
`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Fixed-vocabulary value for logging: short, restricted characters, never free text. */
const tok = (v: unknown): string =>
  typeof v === "string" ? (/^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : "(unprintable)") : typeof v === "number" && Number.isFinite(v) ? String(v) : v === null ? "null" : "?";
const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const stageOf = (list: unknown, name: string): Record<string, unknown> | undefined => {
  const s = Array.isArray(list) ? list.find((x) => isObj(x) && x["stage"] === name) : undefined;
  return isObj(s) ? s : undefined;
};
const stageLine = (list: unknown): string =>
  (Array.isArray(list) ? list : []).slice(0, 12).map((x) => (isObj(x) ? `${tok(x["stage"])}:${tok(x["status"])}/${tok(x["reason"])}/${tok(x["exitCode"])}` : "?")).join(",");
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test(
  "manual GitHub worker end-to-end harness (opt-in: GRAVEYARD_MANUAL_GITHUB_E2E=1; real Docker, real API, real worker, real github.com)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_GITHUB_E2E=1 (use `pnpm run test:github-e2e`) to run against real Docker and github.com", timeout: SUPPORTED_REQUESTED ? 1_200_000 : 600_000 },
  async () => {
    const runId = randomBytes(6).toString("hex");
    const names = {
      net: `graveyard-ghe2e-net-${runId}`, proxy: `graveyard-ghe2e-proxy-${runId}`,
      regNet: `graveyard-ghe2e-regnet-${runId}`, regProxy: `graveyard-ghe2e-regproxy-${runId}`,
    };
    const attempted = { net: false, proxy: false, regNet: false, regProxy: false };
    const octetA = 200 + randomInt(40);
    const octetB = randomInt(256);
    const octetC = (octetB + 1) % 256; // adjacent /24 for the registry network (supported mode only)
    const subnet = `10.${octetA}.${octetB}.0/24`;
    const proxyIp = `10.${octetA}.${octetB}.10`;
    const regSubnet = `10.${octetA}.${octetC}.0/24`;
    const regProxyIp = `10.${octetA}.${octetC}.10`;
    let supported = false;
    let targetUrl = PINNED_URL;
    let targetCommit = PINNED_COMMIT;
    const deadline = Date.now() + SETUP_MS;
    const labelArgs = ["--label", `${LABEL}=${runId}`];
    const log: string[] = [];
    const problems: string[] = [];
    const workerLog: string[] = [];
    const dirs: string[] = [];
    let tmpApp: string | undefined;
    let parent: string | undefined;
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let worker: Extract<StartResult, { started: true }> | undefined;
    let jobId: string | undefined;
    let token: string | undefined;
    let failure: unknown;

    const must = async (what: string, args: readonly string[], ms = 20_000): Promise<Run> => {
      const left = deadline - Date.now();
      if (left <= 0) throw new FailClosed("setup timeout reached");
      const r = await docker(args, Math.min(ms, left));
      if (!r.ok) throw new FailClosed(`${what} failed: exit=${String(r.code)} ${r.stderr.trim().slice(0, 300)}`);
      return r;
    };

    const owned = async (kind: "container" | "network", name: string): Promise<boolean | "absent"> => {
      const fmt = kind === "container" ? `{{index .Config.Labels "${LABEL}"}}` : `{{index .Labels "${LABEL}"}}`;
      const args = kind === "container" ? ["inspect", "--type", "container", "--format", fmt, name] : ["network", "inspect", "--format", fmt, name];
      const r = await docker(args, 15_000);
      if (r.code !== 0) return new RegExp(`no such (container|network|object): ${name}\\b|network ${name} not found`, "i").test(r.stderr) ? "absent" : false;
      return r.stdout.trim() === runId;
    };

    const removeOwned = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const [kind, name, was] of [
        ["container", names.proxy, attempted.proxy], ["container", names.regProxy, attempted.regProxy],
        ["network", names.net, attempted.net], ["network", names.regNet, attempted.regNet],
      ] as const) {
        if (!was) continue;
        const own = await owned(kind, name);
        if (own === "absent") continue;
        if (own !== true) { out.push(`${kind} ${name}: not removed (label check failed)`); continue; }
        await docker(kind === "container" ? ["rm", "-f", name] : ["network", "rm", name], 30_000);
        if ((await owned(kind, name)) !== "absent") out.push(`${kind} ${name}: still present after removal`);
      }
      return out;
    };

    /** Repair mode assertions on the stored result. Logs only fixed-vocabulary fields when not verified. */
    const checkNpmRepair = (view: ResultView, res: Record<string, unknown>): void => {
      const pipe = res["pipeline"];
      const analyst = res["analyst"];
      const fixer = res["fixer"];
      const v = res["verification"];
      if (view.outcome !== "repair-verified") {
        log.push(`not verified: verdict=${tok(res["verdict"])} runMode=${tok(res["runMode"])}`);
        if (isObj(pipe)) log.push(`baseline: status=${tok(pipe["status"])} reason=${tok(pipe["reason"])} failedStage=${tok(pipe["failedStage"])} stages=[${stageLine(pipe["stages"])}]`);
        else log.push("baseline: no pipeline record");
        log.push(`analyst: status=${isObj(analyst) ? tok(analyst["status"]) : "missing"} code=${isObj(analyst) ? tok(analyst["code"]) : "-"}`);
        log.push(`fixer: status=${isObj(fixer) ? tok(fixer["status"]) : "missing"} code=${isObj(fixer) ? tok(fixer["code"]) : "-"}`);
        if (isObj(v)) {
          const pv = v["patched"];
          log.push(`verification: status=${tok(v["status"])} reason=${tok(v["reason"])}${isObj(pv) ? ` patched=${tok(pv["status"])}/${tok(pv["reason"])} stages=[${stageLine(pv["stages"])}]` : ""}`);
        } else {
          log.push("verification: none recorded");
        }
      }
      if (res["verdict"] !== "repository-failing") problems.push(`stored result verdict is ${tok(res["verdict"])}, expected repository-failing`);
      if (res["runMode"] !== "npm-scripts") problems.push(`stored result runMode is ${tok(res["runMode"])}, expected npm-scripts`);
      if (res["sourceKind"] !== "github-pinned") problems.push("stored result sourceKind is not github-pinned");
      const src = res["source"];
      if (!isObj(src) || src["repoUrl"] !== targetUrl || src["commit"] !== targetCommit) problems.push("stored result source is not exactly the supplied public URL and commit");

      // Baseline: the unmodified pinned snapshot failed at build, after prepare and install passed.
      if (!isObj(pipe)) {
        problems.push("stored result has no baseline pipeline record");
      } else {
        if (pipe["status"] !== "failure" || pipe["failedStage"] !== "build") problems.push(`baseline pipeline ${tok(pipe["status"])}/${tok(pipe["failedStage"])}, expected failure/build`);
        const st = pipe["stages"];
        for (const [name, want] of [["prepare", "passed"], ["install", "passed"], ["build", "failed"]] as const) {
          const s = stageOf(st, name);
          if (s === undefined || s["status"] !== want) problems.push(`baseline stage ${name} is ${s === undefined ? "missing" : tok(s["status"])}, expected ${want}`);
        }
        const t = stageOf(st, "test");
        if (t !== undefined && t["status"] === "passed") problems.push("baseline test stage passed although the build failed");
      }
      const preTester = res["tester"];
      if (!isObj(preTester) || preTester["status"] !== "failed") problems.push("baseline Tester report is not failed");

      if (!isObj(analyst) || analyst["status"] !== "ok" || analyst["modelAuthored"] !== true) problems.push("Analyst did not produce a diagnosis (status ok, modelAuthored)");
      if (!isObj(fixer) || fixer["status"] !== "ok" || fixer["modelAuthored"] !== true || fixer["proposalOnly"] !== true || fixer["applied"] !== false) {
        problems.push("Fixer did not produce an unapplied proposal (status ok, proposalOnly, applied false)");
      }
      if (!isObj(v)) {
        problems.push("stored result has no verification record");
        return;
      }
      if (v["status"] !== "verified" || v["reason"] !== "all-stages-passed") problems.push(`verification ${tok(v["status"])}/${tok(v["reason"])}, expected verified/all-stages-passed`);
      if (v["patchClass"] !== NPM_SCRIPTS_PATCH_CLASS || v["runMode"] !== "npm-scripts") problems.push(`verification class ${tok(v["patchClass"])} / runMode ${tok(v["runMode"])}, expected ${NPM_SCRIPTS_PATCH_CLASS} / npm-scripts`);
      const target = v["targetPath"];
      if (!isBuildEntryName(target)) problems.push("verification targetPath is not a root build entry name");
      if (v["originalModified"] !== false) problems.push("verification originalModified is not false");
      if (v["distinctExecutionId"] !== true || v["sameCache"] !== true) problems.push("verification did not use a distinct execution id and the same cache");
      const cl = v["cleanup"];
      if (!isObj(cl) || cl["confirmed"] !== true || cl["stagingRemoved"] !== true || cl["cloneRemoved"] !== true) problems.push("verification cleanup is not fully confirmed");
      const vb = v["baseline"];
      if (!isObj(vb) || vb["status"] !== "failure" || vb["failedStage"] !== "build") problems.push("verification baseline is not failure/build");

      // The patched disposable copy: prepare, install, build, test passed, and tests were measured.
      const patched = v["patched"];
      const vt = v["tester"];
      if (!isObj(patched) || patched["status"] !== "success") {
        problems.push("patched copy pipeline did not succeed");
      } else {
        for (const name of ["prepare", "install", "build", "test"]) {
          const s = stageOf(patched["stages"], name);
          if (s === undefined || s["status"] !== "passed") problems.push(`patched stage ${name} is ${s === undefined ? "missing" : tok(s["status"])}, expected passed`);
        }
      }
      if (!isObj(vt) || vt["status"] !== "passed") problems.push("patched copy Tester report is not passed");
      if (!testCountsAcceptable(v["testCounts"])) {
        problems.push("patched test counts were not measured as acceptable (at least one passed, none failed or cancelled)");
      } else {
        const tc = v["testCounts"];
        if (isObj(tc)) log.push(`patched test counts: ${Object.entries(tc).slice(0, 8).map(([k, n]) => `${tok(k)}=${tok(n)}`).join(" ")}`);
      }

      // The verified diff is exactly the stored proposal and its recorded hash; the original is untouched.
      const diff = isObj(fixer) ? fixer["diff"] : undefined;
      if (typeof diff !== "string" || diff === "") {
        problems.push("stored Fixer proposal has no diff");
      } else {
        if (view.verifiedDiff !== diff) problems.push("verifiedDiff is not exactly the stored Fixer diff");
        if (v["diffSha256"] !== sha256Hex(diff)) problems.push("verification diffSha256 does not match the stored Fixer diff");
        if (typeof target === "string" && !diff.startsWith(`--- a/${target}\n+++ b/${target}\n`)) problems.push("the diff does not patch exactly the verified build entry");
      }
      const files = isObj(fixer) ? fixer["files"] : undefined;
      const pf = v["patchedFiles"];
      if (typeof target !== "string" || !Array.isArray(files) || files.length !== 1 || files[0] !== target || !Array.isArray(pf) || pf.length !== 1 || pf[0] !== target) {
        problems.push("proposal files and verification patchedFiles are not exactly the one build entry");
      }
      const o = v["originalTargetSha256"];
      const p = v["patchedTargetSha256"];
      if (typeof o !== "string" || typeof p !== "string" || !/^[0-9a-f]{64}$/.test(o) || !/^[0-9a-f]{64}$/.test(p) || o === p) problems.push("original and patched target hashes are not two distinct sha256 values");
      if (view.repair.patchApplied !== false) problems.push("a patch was reported applied to the original");
    };

    try {
      // ---- Fail-closed preconditions: nothing is created before all of these hold. ----
      const gitImage = process.env["GRAVEYARD_GITHUB_E2E_GIT_IMAGE"] ?? DEFAULT_GIT_IMAGE;
      if (gitImage.length > 255 || !GIT_IMAGE_RE.test(gitImage)) throw new FailClosed("GRAVEYARD_GITHUB_E2E_GIT_IMAGE is not a valid image reference");
      const canonical = validateGithubUrl(PINNED_URL);
      if (!canonical.ok || canonical.url !== PINNED_URL) throw new FailClosed("the pinned URL is not in canonical form");

      const staticVar = process.env[STATIC_VAR];
      if (staticVar !== undefined && staticVar !== "" && staticVar !== "1") throw new FailClosed(`${STATIC_VAR} must be exactly 1 when set`);
      if (STATIC_REQUESTED && SUPPORTED_REQUESTED) throw new FailClosed(`${STATIC_VAR}=1 cannot be combined with the supported fixture variables`);
      const repairVar = process.env[REPAIR_VAR];
      if (repairVar !== undefined && repairVar !== "" && repairVar !== "1") throw new FailClosed(`${REPAIR_VAR} must be exactly 1 when set`);
      if (REPAIR_REQUESTED && STATIC_REQUESTED) throw new FailClosed(`${REPAIR_VAR}=1 cannot be combined with ${STATIC_VAR}=1`);
      if (REPAIR_REQUESTED && !SUPPORTED_REQUESTED) throw new FailClosed(`${REPAIR_VAR}=1 requires ${SUPPORTED_URL_VAR} and ${SUPPORTED_COMMIT_VAR}`);
      if (STATIC_REQUESTED) {
        const sv = validateGithubUrl(STATIC_URL);
        if (!sv.ok || sv.url !== STATIC_URL) throw new FailClosed("the static site pin URL is not in canonical form");
        if (!GIT_SHA_RE.test(STATIC_COMMIT)) throw new FailClosed("the static site pin commit is not a full lowercase 40-hex SHA");
        targetUrl = STATIC_URL;
        targetCommit = STATIC_COMMIT;
        log.push(`mode: static site ${targetUrl} @ ${targetCommit} (no registry, agents off)`);
      }

      // Supported mode: both values are explicit operator input and are validated before Docker is contacted.
      if (SUPPORTED_REQUESTED) {
        const u = process.env[SUPPORTED_URL_VAR] ?? "";
        const c = process.env[SUPPORTED_COMMIT_VAR] ?? "";
        if (u === "" || c === "") throw new FailClosed(`supported mode needs both ${SUPPORTED_URL_VAR} and ${SUPPORTED_COMMIT_VAR}, non-empty`);
        const v = validateGithubUrl(u);
        if (!v.ok || v.url !== u) throw new FailClosed(`${SUPPORTED_URL_VAR} is not a canonical public GitHub repository URL`);
        if (!GIT_SHA_RE.test(c)) throw new FailClosed(`${SUPPORTED_COMMIT_VAR} is not a full lowercase 40-hex commit SHA`);
        if (u === PLACEHOLDER_URL) throw new FailClosed(`${SUPPORTED_URL_VAR} must not be the placeholder URL`);
        supported = true;
        targetUrl = u;
        targetCommit = c;
        log.push(`mode: ${REPAIR_REQUESTED ? "npm scripts repair (LIVE Kiro agents kiro-v2, GRAVEYARD_GITHUB_NPM_SCRIPTS=1)" : "supported fixture"} ${targetUrl} @ ${targetCommit}`);
      } else if (!STATIC_REQUESTED) {
        log.push("mode: default pinned Hello-World");
      }

      await must("docker daemon check", ["version", "--format", "{{.Server.Version}}"], 15_000).then((r) => log.push(`docker server ${r.stdout.trim()}`));
      for (const img of new Set([PROXY_IMAGE, gitImage, NODE_FIXTURE_IMAGE])) {
        await must(`image ${img} must already exist locally (never pulled)`, ["image", "inspect", "--format", "{{.Id}}", img]);
      }

      const root = backendRoot();
      const compiledDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      for (const f of ["egress-proxy.js", "acquisition-policy.js", "url.js", "fixture-pipeline-driver.js"]) {
        if (!existsSync(join(compiledDir, f))) throw new FailClosed(`compiled ${f} not found; run pnpm run test:github-e2e (it builds first)`);
      }

      // ---- Proxy topology (same shape as manual-clone-check.ts). ----
      tmpApp = mkdtempSync(join(tmpdir(), "graveyard-ghe2e-app-"));
      for (const f of ["egress-proxy.js", "acquisition-policy.js", "url.js"]) copyFileSync(join(compiledDir, f), join(tmpApp, f));
      writeFileSync(join(tmpApp, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(tmpApp, "run.mjs"), PROXY_SCRIPT);
      const appDir = resolve(tmpApp);
      if (/[,"'\r\n]/.test(appDir)) throw new FailClosed("temporary directory path is unusable for a bind mount");

      const provision = async (p: {
        host: string; net: string; proxy: string; subnet: string; ip: string; netKey: "net" | "regNet"; proxyKey: "proxy" | "regProxy";
      }): Promise<void> => {
        attempted[p.netKey] = true;
        await must(`create internal network ${p.net}`, ["network", "create", "--driver", "bridge", "--internal", "--subnet", p.subnet, ...labelArgs, p.net]);
        const netInfo = JSON.parse((await must(`inspect network ${p.net}`, ["network", "inspect", p.net])).stdout) as Array<{ Internal?: boolean }>;
        if (netInfo[0]?.Internal !== true) throw new FailClosed(`network ${p.net} is not Internal`);

        attempted[p.proxyKey] = true;
        await must(`create proxy container ${p.proxy}`, [
          "create", "--name", p.proxy, "--network", p.net, "--ip", p.ip, ...HARDENING, ...labelArgs,
          "--label", `${EGRESS_PROXY_LABEL}=${p.host}`,
          "--mount", `type=bind,source=${appDir},target=/app,readonly`, "--env", `GRAVEYARD_PROXY_BIND=${p.ip}`,
          "--env", `GRAVEYARD_PROXY_TARGET=${p.host}`,
          PROXY_IMAGE, "node", "/app/run.mjs",
        ]);
        await must(`connect ${p.proxy} to default bridge (upstream)`, ["network", "connect", "bridge", p.proxy]);
        const pj = JSON.parse((await must(`inspect ${p.proxy}`, ["inspect", "--type", "container", p.proxy])).stdout) as Array<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>;
        const pn = Object.keys(pj[0]?.NetworkSettings?.Networks ?? {}).sort().join();
        if (pn !== ["bridge", p.net].sort().join()) throw new FailClosed(`proxy ${p.proxy} networks are [${pn}]`);
        await must(`start ${p.proxy}`, ["start", p.proxy]);

        let listening = false;
        for (let i = 0; i < 20 && !listening; i += 1) {
          const l = await docker(["logs", "--tail", "20", p.proxy], 10_000);
          listening = (l.stdout + l.stderr).includes('"kind":"listening"');
          if (!listening) await delay(500);
        }
        if (!listening) throw new FailClosed(`proxy ${p.proxy} did not report listening`);
      };

      const refuses = async (proxy: string, ip: string, authority: string): Promise<void> => {
        const probe = await must(`proxy policy probe ${proxy} -> ${authority}`, [
          "exec", "--env", `GRAVEYARD_PROXY_BIND=${ip}`, "--env", `GRAVEYARD_PROBE_PORT=${PROXY_PORT}`, "--env", `GRAVEYARD_PROBE_AUTHORITY=${authority}`,
          proxy, "node", "-e", PROBE_SCRIPT,
        ], 15_000);
        if (!/^HTTP\/1\.1 403/.test(probe.stdout.trim())) throw new FailClosed(`proxy ${proxy} did not refuse ${authority} (got: ${probe.stdout.trim().slice(0, 80)})`);
        log.push(`proxy ${proxy} refused CONNECT ${authority} (403)`);
      };

      await provision({ host: GITHUB_HOST, net: names.net, proxy: names.proxy, subnet, ip: proxyIp, netKey: "net", proxyKey: "proxy" });
      await refuses(names.proxy, proxyIp, "example.com:443");
      if (supported) {
        // Second per-run topology, same helper and same rollback, for registry.npmjs.org only.
        await provision({ host: REGISTRY_HOST, net: names.regNet, proxy: names.regProxy, subnet: regSubnet, ip: regProxyIp, netKey: "regNet", proxyKey: "regProxy" });
        await refuses(names.regProxy, regProxyIp, "example.com:443");
        await refuses(names.proxy, proxyIp, `${REGISTRY_HOST}:443`);
        await refuses(names.regProxy, regProxyIp, `${GITHUB_HOST}:443`);
      }

      // ---- Temporary workspace under backend/.tmp-fixtures only (five separate sibling directories). ----
      parent = ensureOwnedParent(root);
      const dataDir = createRunDir(parent); dirs.push(dataDir);
      const fixturesDir = createRunDir(parent); dirs.push(fixturesDir);
      const stagingDir = createRunDir(parent); dirs.push(stagingDir);
      const cacheDir = createRunDir(parent); dirs.push(cacheDir);
      const runsDir = createRunDir(parent); dirs.push(runsDir);

      // The worker requires a fixture catalog entry with plain package.json, package-lock.json and
      // build.mjs. This placeholder is never reached: no job names PLACEHOLDER_URL.
      writeFixture(fixturesDir, PLACEHOLDER_FIXTURE, {
        "package.json": '{"name":"placeholder","version":"0.0.0","private":true}\n',
        "package-lock.json": '{"name":"placeholder","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"placeholder","version":"0.0.0"}}}\n',
        "build.mjs": "process.exit(0);\n",
      });
      const cfgDir = writeFixture(dataDir, "cfg", {
        "catalog.json": JSON.stringify({ [PLACEHOLDER_URL]: PLACEHOLDER_FIXTURE }),
        "github-pins.json": JSON.stringify({ [targetUrl]: targetCommit }),
      });
      const databasePath = join(dataDir, "ghe2e.sqlite");
      log.push(`temporary workspace: ${dirs.join(", ")}`);

      // ---- Real API on an ephemeral localhost port, on the temporary database. ----
      app = await buildApp({ logLevel: "silent", databasePath });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new FailClosed("API did not bind a TCP port");
      const port = (address as AddressInfo).port;
      log.push(`API listening on 127.0.0.1:${String(port)}`);

      // ---- Real worker composition: explicit environment, no registry variables, no seams but the log. ----
      const started = startWorker(
        {
          GRAVEYARD_WORKER_ENABLED: "1",
          DATABASE_PATH: databasePath,
          GRAVEYARD_FIXTURES_ROOT: fixturesDir,
          GRAVEYARD_STAGING_ROOT: stagingDir,
          GRAVEYARD_NPM_CACHE_DIR: cacheDir,
          GRAVEYARD_FIXTURE_CATALOG: join(cfgDir, "catalog.json"),
          GRAVEYARD_GITHUB_CATALOG: join(cfgDir, "github-pins.json"),
          GRAVEYARD_GITHUB_RUNS_ROOT: runsDir,
          GRAVEYARD_GITHUB_GIT_IMAGE: gitImage,
          GRAVEYARD_GITHUB_EGRESS_NETWORK: names.net,
          GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER: names.proxy,
          GRAVEYARD_GITHUB_EGRESS_PROXY_URL: `http://${proxyIp}:${PROXY_PORT}`,
          ...(supported
            ? {
                GRAVEYARD_REGISTRY_EGRESS_NETWORK: names.regNet,
                GRAVEYARD_REGISTRY_EGRESS_PROXY_CONTAINER: names.regProxy,
                GRAVEYARD_REGISTRY_EGRESS_PROXY_URL: `http://${regProxyIp}:${PROXY_PORT}`,
              }
            : {}),
          GRAVEYARD_WORKER_ID: `ghe2e-${randomBytes(3).toString("hex")}`,
          GRAVEYARD_WORKER_POLL_MS: "250",
          GRAVEYARD_WORKER_AGENTS: REPAIR_REQUESTED ? "kiro-v2" : "off",
          ...(REPAIR_REQUESTED ? { GRAVEYARD_GITHUB_NPM_SCRIPTS: "1" } : {}),
        },
        { log: (level, message, fields) => workerLog.push(`${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`) },
      );
      if (!started.started) throw new FailClosed(`worker refused to start: ${started.message}`);
      worker = started;
      const gh = worker.composed.config.github;
      if (worker.composed.config.agents !== (REPAIR_REQUESTED ? "kiro-v2" : "off")) throw new FailClosed(`agents must be ${REPAIR_REQUESTED ? "kiro-v2" : "off"} in this mode`);
      if (gh === null || gh === undefined) throw new FailClosed("worker started without the GitHub flow");
      if ((gh.npmScripts === true) !== REPAIR_REQUESTED) throw new FailClosed("npm scripts mode must be on exactly in npm repair mode");
      if (supported) {
        const re = gh.registryEgress;
        if (re === null || re === undefined || re.network !== names.regNet || re.proxyContainer !== names.regProxy || re.proxyUrl !== `http://${regProxyIp}:${PROXY_PORT}`) {
          throw new FailClosed("registry egress is not configured exactly as provisioned");
        }
      } else if (gh.registryEgress !== null) {
        throw new FailClosed("registry egress must not be configured in the default mode");
      }
      const pinKeys = Object.keys(gh.pins);
      if (pinKeys.length !== 1 || gh.pins[targetUrl] !== targetCommit) throw new FailClosed("the worker's pin catalog is not exactly the one expected pin");
      log.push(`worker started (real GithubJobRunner and OperatorEgressGuard, real Docker executor, agents ${REPAIR_REQUESTED ? "kiro-v2 (live Kiro), npm scripts on" : "off"}, ${supported ? "registry egress configured" : "no registry egress"})`);

      // ---- Authorized job creation. ----
      const created = await httpCall(port, "POST", "/api/jobs", {}, JSON.stringify({ repoUrl: targetUrl, consent: true }));
      if (created.status !== 202) throw new FailClosed(`job creation returned ${String(created.status)}`);
      const createdBody = JSON.parse(created.body) as { jobId?: unknown; token?: unknown };
      if (typeof createdBody.jobId !== "string" || typeof createdBody.token !== "string" || !/^[0-9a-f]{64}$/.test(createdBody.token)) {
        throw new FailClosed("job creation response had an unexpected shape");
      }
      jobId = createdBody.jobId;
      token = createdBody.token;
      log.push(`job ${jobId} created for the ${supported ? "supplied" : "pinned"} URL (token withheld from output)`);

      const resultPath = `/api/jobs/${jobId}/result`;
      const noAuth = await httpCall(port, "GET", resultPath, {});
      if (noAuth.status !== 401) problems.push(`GET result without a token returned ${String(noAuth.status)}, expected 401`);
      const wrong = await httpCall(port, "GET", resultPath, { authorization: `Bearer ${randomBytes(32).toString("hex")}` });
      if (wrong.status !== 403) problems.push(`GET result with another well-formed token returned ${String(wrong.status)}, expected 403`);

      // ---- Bounded wait for a terminal state. ----
      const end = Date.now() + JOB_DEADLINE_MS;
      let view: ResultView | undefined;
      let lastStatus = "(none)";
      for (;;) {
        const r = await httpCall(port, "GET", resultPath, { authorization: `Bearer ${token}` });
        if (r.status !== 200) throw new Error(`GET result returned ${String(r.status)}`);
        const cc = r.headers["cache-control"];
        if (typeof cc !== "string" || !/no-store/.test(cc)) problems.push("GET result response lacks Cache-Control: no-store");
        const cur = JSON.parse(r.body) as ResultView;
        lastStatus = `${cur.status}/${cur.stage}/${cur.outcome}`;
        if (r.body.includes(token)) problems.push("the result body contains the job token");
        if (cur.terminal) { view = cur; break; }
        if (Date.now() > end) break;
        await delay(POLL_MS);
      }

      if (view === undefined) {
        problems.push(`job did not reach a terminal state within ${String(JOB_DEADLINE_MS / 1000)} s (last: ${lastStatus})`);
      } else {
        log.push(`terminal: status=${view.status} stage=${view.stage} outcome=${view.outcome}`);
        if (view.status !== "completed") problems.push(`status ${view.status}, expected completed`);
        if (view.stage !== "done") problems.push(`stage ${view.stage}, expected done`);
        const expectedOutcome = REPAIR_REQUESTED ? "repair-verified" : supported ? "passing" : STATIC_REQUESTED ? "static-site-audited" : "unsupported-repository";
        if (STATIC_REQUESTED && view.verifiedDiff !== null) problems.push("a verified diff is present, expected none");
        if (view.outcome !== expectedOutcome) problems.push(`outcome ${view.outcome}, expected ${expectedOutcome}`);
        if (REPAIR_REQUESTED) {
          if (view.repair.verified !== true) problems.push("repair.verified is not true");
          if (view.repair.patchApplied !== false) problems.push("repair.patchApplied is not false");
          if (view.repair.patchProposed !== true || view.repair.diagnosed !== true) problems.push("repair.patchProposed or repair.diagnosed is not true");
        } else {
          if (view.repair.verified !== false || view.repair.patchApplied !== false) problems.push("repair.verified or repair.patchApplied is not false");
          if (view.repair.patchProposed !== false || view.repair.diagnosed !== false) problems.push("a patch proposal or diagnosis is present, expected none");
        }
        if (view.infrastructure !== null) {
          problems.push(`unexpected infrastructure record: ${view.infrastructure.kind}: ${view.infrastructure.message}`);
        }
        const res = view.result;
        if (res === null) {
          problems.push("no stored result");
        } else if (REPAIR_REQUESTED) {
          checkNpmRepair(view, res);
        } else if (supported) {
          // The fixture is run unmodified: nothing here edits, patches or substitutes any repository file.
          if (res["verdict"] !== "verified") problems.push(`stored result verdict is ${String(res["verdict"])}, expected verified`);
          if (res["sourceKind"] !== "github-pinned") problems.push("stored result sourceKind is not github-pinned");
          const src = res["source"];
          if (!isObj(src) || src["repoUrl"] !== targetUrl || src["commit"] !== targetCommit) problems.push("stored result source is not the supplied URL and commit");
          const pipe = res["pipeline"];
          if (!isObj(pipe)) {
            problems.push("stored result has no pipeline record");
          } else {
            if (pipe["status"] !== "passed") problems.push(`pipeline status ${String(pipe["status"])}, expected passed`);
            if (pipe["failedStage"] !== null) problems.push(`pipeline failedStage ${String(pipe["failedStage"])}, expected null`);
            if (pipe["packagesAdded"] !== 1 || pipe["expectedPackages"] !== 1) {
              problems.push(`pipeline packages added/expected ${String(pipe["packagesAdded"])}/${String(pipe["expectedPackages"])}, expected 1/1 (one is-number@7.0.0 lock)`);
            }
            const stages = Array.isArray(pipe["stages"]) ? pipe["stages"] : [];
            for (const name of ["install", "build", "test"]) {
              const s = stages.find((x) => isObj(x) && x["stage"] === name);
              if (!isObj(s) || s["status"] !== "passed") problems.push(`pipeline stage ${name} is not passed (${isObj(s) ? String(s["status"]) : "missing"})`);
            }
            log.push(`pipeline: ${String(pipe["status"])} stages=[${stages.map((x) => (isObj(x) ? `${String(x["stage"])}:${String(x["status"])}` : "?")).join(",")}]`);
          }
          const tester = res["tester"];
          if (!isObj(tester) || tester["status"] !== "passed" || tester["reason"] !== "all-stages-passed") {
            problems.push("Tester report is not passed/all-stages-passed");
          } else {
            for (const name of ["build", "test"]) {
              const t = tester[name];
              if (!isObj(t) || t["status"] !== "passed") problems.push(`Tester ${name} stage is not passed`);
            }
          }
          const analyst = res["analyst"];
          const fixer = res["fixer"];
          if (!isObj(analyst) || analyst["status"] !== "not-configured") problems.push("analyst is not not-configured (agents must be off)");
          if (!isObj(fixer) || fixer["status"] !== "not-configured") problems.push("fixer is not not-configured (agents must be off)");
        } else if (STATIC_REQUESTED) {
          // Nothing was executed and nothing was repaired; the findings are diagnostics, not a verdict on the site.
          if (res["verdict"] !== "static-site-audited") problems.push(`stored result verdict is ${String(res["verdict"])}, expected static-site-audited`);
          if (res["sourceKind"] !== "github-pinned") problems.push("stored result sourceKind is not github-pinned");
          const src = res["source"];
          if (!isObj(src) || src["repoUrl"] !== STATIC_URL || src["commit"] !== STATIC_COMMIT) problems.push("stored result source is not the pinned static site URL and commit");
          if (res["profile"] !== "static-site") problems.push(`stored result profile is ${String(res["profile"])}, expected static-site`);
          if (res["executed"] !== false) problems.push("stored result executed is not false");
          if (res["repairAttempted"] !== false) problems.push("stored result repairAttempted is not false");
          const analyst = res["analyst"];
          const fixer = res["fixer"];
          if (analyst !== undefined && !(isObj(analyst) && analyst["status"] === "not-configured")) problems.push("analyst output is present (agents must be off)");
          if (fixer !== undefined && !(isObj(fixer) && fixer["status"] === "not-configured")) problems.push("fixer output is present (agents must be off)");

          const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
          const audit = res["audit"];
          const read = isObj(audit) ? audit["read"] : undefined;
          const htmlRead = isObj(read) ? read["html"] : undefined;
          if (typeof htmlRead !== "number" || !(htmlRead > 0)) problems.push(`audit.read.html is ${String(htmlRead)}, expected a number greater than 0`);
          if (isObj(audit)) {
            const t = isObj(audit["tree"]) ? audit["tree"] : {};
            const d = isObj(audit["discovered"]) ? audit["discovered"] : {};
            const r = isObj(read) ? read : {};
            const nr = isObj(audit["notRead"]) ? audit["notRead"] : {};
            const refs = isObj(audit["references"]) ? audit["references"] : {};
            log.push(`audit tree: files=${num(t["files"])} directories=${num(t["directories"])}`);
            log.push(`audit discovered: html=${num(d["html"])} css=${num(d["css"])}; read: html=${num(r["html"])} css=${num(r["css"])} bytes=${num(r["bytes"])}; notRead=${num(nr["total"])}; readComplete=${String(audit["readComplete"])}`);
            log.push(
              `audit references: ${["extracted", "found", "missing", "caseMismatch", "escapesSiteRoot", "unsafe", "unverifiable", "external", "noTarget", "rootRelative"]
                .map((k) => `${k}=${num(refs[k])}`)
                .join(" ")}; baseHrefFiles=${num(audit["baseHrefFiles"])} refsTruncatedFiles=${num(audit["refsTruncatedFiles"])} findingsOmitted=${num(audit["findingsOmitted"])}`,
            );
          } else {
            problems.push("stored result has no audit facts");
          }
          const analysis = res["analysis"];
          const findings = isObj(analysis) && Array.isArray(analysis["findings"]) ? analysis["findings"] : null;
          if (findings === null) {
            problems.push("stored result has no analysis findings list");
          } else {
            log.push(`audit findings (${String(findings.length)} stored, showing up to ${String(MAX_PRINTED_FINDINGS)}):`);
            for (const f of findings.slice(0, MAX_PRINTED_FINDINGS)) {
              const code = isObj(f) && typeof f["code"] === "string" ? f["code"].slice(0, 60) : "?";
              const detail = isObj(f) && typeof f["detail"] === "string" ? f["detail"].slice(0, MAX_PRINTED_DETAIL) : "?";
              log.push(`  finding ${code}: ${detail}`);
            }
          }
        } else {
          if (res["verdict"] !== "unsupported-repository") problems.push("stored result verdict is not unsupported-repository");
          if (res["sourceKind"] !== "github-pinned") problems.push("stored result sourceKind is not github-pinned");
          const src = res["source"];
          if (!isObj(src) || src["repoUrl"] !== PINNED_URL || src["commit"] !== PINNED_COMMIT) problems.push("stored result source is not the pinned URL and commit");
          const analysis = res["analysis"];
          if (!isObj(analysis) || analysis["supported"] !== false) {
            problems.push("stored analysis is missing or says supported");
          } else {
            const findings = Array.isArray(analysis["findings"]) ? analysis["findings"] : [];
            const codes = findings.map((f) => (isObj(f) && typeof f["code"] === "string" ? f["code"] : "?")).sort();
            if (codes.join() !== EXPECTED_FINDINGS.join()) problems.push(`analysis findings [${codes.join()}], expected [${EXPECTED_FINDINGS.join()}]`);
            const facts = analysis["facts"];
            const present = isObj(facts) ? facts["present"] : undefined;
            if (!isObj(present) || Object.values(present).some((v) => v !== false)) problems.push("analysis facts say a required root file is present");
            log.push(`analysis findings: ${codes.join(", ")}`);
          }
        }
      }
    } catch (e) {
      failure = e;
    } finally {
      // ---- Cleanup, in order: worker (needs cleanup proof), API, containers, network, directories. ----
      if (worker !== undefined) {
        try { await worker.stop(); log.push("worker stopped"); } catch (e) { problems.push(`worker stop failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (app !== undefined) {
        try { await app.close(); } catch (e) { problems.push(`API close failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (jobId !== undefined) {
        // A job runs at most max_attempts (2) times; query both execution ids by label and by name.
        for (const attempt of [1, 2]) {
          const id = executionIdFor(jobId, attempt);
          const queries: Array<[string, readonly string[]]> = [
            ["acquisition label", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${ACQ_LABEL_ID}=${id}`]],
            ["acquisition name", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${acquisitionContainerName(id)}`]],
            ["sandbox label", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${LABEL_EXECUTION}=${id}`]],
            ["sandbox name", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${containerNameFor(id)}`]],
          ];
          if (supported) {
            // Registry acquisition runs under the derived id `<uuid>-npm:<n>`, which has its own labels and names.
            const regId = deriveRegistryExecutionId(id);
            if (regId === null) {
              problems.push(`could not derive the registry execution id for ${id}; registry containers were not queried`);
            } else {
              queries.push(
                ["registry acquisition label", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${NPM_ACQ_LABEL_ID}=${regId}`]],
                ["registry acquisition name", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${npmAcquisitionContainerName(regId)}`]],
              );
            }
          }
          if (REPAIR_REQUESTED) {
            // The verified repair runs under the derived id `<uuid>-fix:<n>`; query it by label and by name too.
            const fixId = deriveRepairExecutionId(id);
            if (fixId === null) {
              problems.push(`could not derive the repair execution id for ${id}; repair containers were not queried`);
            } else {
              queries.push(
                ["repair sandbox label", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${LABEL_EXECUTION}=${fixId}`]],
                ["repair sandbox name", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${containerNameFor(fixId)}`]],
              );
            }
          }
          for (const [what, args] of queries) {
            const q = await docker(args);
            if (!q.ok) { problems.push(`could not query leftover containers (${what}) for attempt ${String(attempt)}`); continue; }
            const ids = q.stdout.split(/\s+/).filter((s) => s !== "");
            if (ids.length === 0) continue;
            problems.push(`container left (${what}) for execution ${id}: ${ids.join(" ")}`);
            // Remove only by full container id taken from a query on this exact execution's label or name.
            for (const cid of ids) {
              if (/^[0-9a-f]{64}$/.test(cid)) await docker(["rm", "--force", "--volumes", cid], 30_000);
            }
          }
        }
        log.push(`independent docker ps: queried leftover acquisition${supported ? ", registry acquisition" : ""}${REPAIR_REQUESTED ? ", repair (derived fix id)" : ""} and sandbox containers for this job's execution ids`);
      }
      if (token !== undefined && workerLog.some((l) => l.includes(token as string))) problems.push("the worker log contains the job token");
      try { problems.push(...(await removeOwned())); } catch (e) { problems.push(`cleanup threw: ${e instanceof Error ? e.message : String(e)}`); }
      if (tmpApp !== undefined) {
        try { rmSync(tmpApp, { recursive: true, force: true }); } catch (e) { problems.push(`${tmpApp}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (parent !== undefined) {
        for (const d of dirs) {
          const r = removeRunDir(parent, d);
          if (r.removed) log.push(`removed ${d}`);
          else problems.push(...r.problems.map((p) => `removal: ${p}`));
        }
      }
      for (const l of log) console.log(`INFO  ${l}`);
      if (problems.length > 0 || failure !== undefined) {
        for (const l of workerLog.slice(-40)) console.log(`WORKER ${l}`);
      }
      if (problems.length > 0) console.log(`PROBLEMS (remove leftovers manually, run id ${runId}, label ${LABEL}=${runId}):\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about the worker, the proxy, Docker or GitHub.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`GitHub e2e harness found ${String(problems.length)} problem(s)`);
  },
);
