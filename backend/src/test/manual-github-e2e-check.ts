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
 */

import { randomBytes, randomInt } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";
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
const SETUP_MS = 120_000;
/** Upper bound for the job to reach a terminal state (the acquisition budget is 300 s). */
const JOB_DEADLINE_MS = 360_000;
const POLL_MS = 500;

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
const proxy = new EgressProxy({ target: "github.com", bindHost: process.env.GRAVEYARD_PROXY_BIND, port: ${PROXY_PORT}, onEvent: (e) => console.log(JSON.stringify(e)) });
const a = await proxy.start();
console.log(JSON.stringify({ kind: "listening", host: a.host, port: a.port }));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { proxy.close().finally(() => process.exit(0)); });
`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test(
  "manual GitHub worker end-to-end harness (opt-in: GRAVEYARD_MANUAL_GITHUB_E2E=1; real Docker, real API, real worker, real github.com)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_GITHUB_E2E=1 (use `pnpm run test:github-e2e`) to run against real Docker and github.com", timeout: 600_000 },
  async () => {
    const runId = randomBytes(6).toString("hex");
    const names = { net: `graveyard-ghe2e-net-${runId}`, proxy: `graveyard-ghe2e-proxy-${runId}` };
    const attempted = { net: false, proxy: false };
    const octetA = 200 + randomInt(40);
    const octetB = randomInt(256);
    const subnet = `10.${octetA}.${octetB}.0/24`;
    const proxyIp = `10.${octetA}.${octetB}.10`;
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
      for (const [kind, name, was] of [["container", names.proxy, attempted.proxy], ["network", names.net, attempted.net]] as const) {
        if (!was) continue;
        const own = await owned(kind, name);
        if (own === "absent") continue;
        if (own !== true) { out.push(`${kind} ${name}: not removed (label check failed)`); continue; }
        await docker(kind === "container" ? ["rm", "-f", name] : ["network", "rm", name], 30_000);
        if ((await owned(kind, name)) !== "absent") out.push(`${kind} ${name}: still present after removal`);
      }
      return out;
    };

    try {
      // ---- Fail-closed preconditions: nothing is created before all of these hold. ----
      const gitImage = process.env["GRAVEYARD_GITHUB_E2E_GIT_IMAGE"] ?? DEFAULT_GIT_IMAGE;
      if (gitImage.length > 255 || !GIT_IMAGE_RE.test(gitImage)) throw new FailClosed("GRAVEYARD_GITHUB_E2E_GIT_IMAGE is not a valid image reference");
      const canonical = validateGithubUrl(PINNED_URL);
      if (!canonical.ok || canonical.url !== PINNED_URL) throw new FailClosed("the pinned URL is not in canonical form");

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

      attempted.net = true;
      await must("create internal network", ["network", "create", "--driver", "bridge", "--internal", "--subnet", subnet, ...labelArgs, names.net]);
      const netInfo = JSON.parse((await must("inspect network", ["network", "inspect", names.net])).stdout) as Array<{ Internal?: boolean }>;
      if (netInfo[0]?.Internal !== true) throw new FailClosed("network is not Internal");

      attempted.proxy = true;
      await must("create proxy container", [
        "create", "--name", names.proxy, "--network", names.net, "--ip", proxyIp, ...HARDENING, ...labelArgs,
        "--label", `${EGRESS_PROXY_LABEL}=github.com`,
        "--mount", `type=bind,source=${appDir},target=/app,readonly`, "--env", `GRAVEYARD_PROXY_BIND=${proxyIp}`,
        PROXY_IMAGE, "node", "/app/run.mjs",
      ]);
      await must("connect proxy to default bridge (upstream)", ["network", "connect", "bridge", names.proxy]);
      const pj = JSON.parse((await must("inspect proxy", ["inspect", "--type", "container", names.proxy])).stdout) as Array<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>;
      const pn = Object.keys(pj[0]?.NetworkSettings?.Networks ?? {}).sort().join();
      if (pn !== ["bridge", names.net].sort().join()) throw new FailClosed(`proxy networks are [${pn}]`);
      await must("start proxy", ["start", names.proxy]);

      let listening = false;
      for (let i = 0; i < 20 && !listening; i += 1) {
        const l = await docker(["logs", "--tail", "20", names.proxy], 10_000);
        listening = (l.stdout + l.stderr).includes('"kind":"listening"');
        if (!listening) await delay(500);
      }
      if (!listening) throw new FailClosed("proxy did not report listening");
      const probe = await must("proxy policy probe", [
        "exec", "--env", `GRAVEYARD_PROXY_BIND=${proxyIp}`, "--env", `GRAVEYARD_PROBE_PORT=${PROXY_PORT}`, "--env", "GRAVEYARD_PROBE_AUTHORITY=example.com:443",
        names.proxy, "node", "-e", PROBE_SCRIPT,
      ], 15_000);
      if (!/^HTTP\/1\.1 403/.test(probe.stdout.trim())) throw new FailClosed(`proxy did not refuse example.com (got: ${probe.stdout.trim().slice(0, 80)})`);
      log.push("proxy refused CONNECT example.com:443 (403)");

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
        "github-pins.json": JSON.stringify({ [PINNED_URL]: PINNED_COMMIT }),
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
          GRAVEYARD_WORKER_ID: `ghe2e-${randomBytes(3).toString("hex")}`,
          GRAVEYARD_WORKER_POLL_MS: "250",
          GRAVEYARD_WORKER_AGENTS: "off",
        },
        { log: (level, message, fields) => workerLog.push(`${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`) },
      );
      if (!started.started) throw new FailClosed(`worker refused to start: ${started.message}`);
      worker = started;
      const gh = worker.composed.config.github;
      if (worker.composed.config.agents !== "off") throw new FailClosed("agents must be off in this harness");
      if (gh === null || gh === undefined) throw new FailClosed("worker started without the GitHub flow");
      if (gh.registryEgress !== null) throw new FailClosed("registry egress must not be configured in this harness");
      const pinKeys = Object.keys(gh.pins);
      if (pinKeys.length !== 1 || gh.pins[PINNED_URL] !== PINNED_COMMIT) throw new FailClosed("the worker's pin catalog is not exactly the one expected pin");
      log.push("worker started (real GithubJobRunner and OperatorEgressGuard, real Docker executor, agents off, no registry egress)");

      // ---- Authorized job creation. ----
      const created = await httpCall(port, "POST", "/api/jobs", {}, JSON.stringify({ repoUrl: PINNED_URL, consent: true }));
      if (created.status !== 202) throw new FailClosed(`job creation returned ${String(created.status)}`);
      const createdBody = JSON.parse(created.body) as { jobId?: unknown; token?: unknown };
      if (typeof createdBody.jobId !== "string" || typeof createdBody.token !== "string" || !/^[0-9a-f]{64}$/.test(createdBody.token)) {
        throw new FailClosed("job creation response had an unexpected shape");
      }
      jobId = createdBody.jobId;
      token = createdBody.token;
      log.push(`job ${jobId} created for the pinned URL (token withheld from output)`);

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
        if (view.outcome !== "unsupported-repository") problems.push(`outcome ${view.outcome}, expected unsupported-repository`);
        if (view.repair.verified !== false || view.repair.patchApplied !== false) problems.push("repair.verified or repair.patchApplied is not false");
        if (view.repair.patchProposed !== false || view.repair.diagnosed !== false) problems.push("a patch proposal or diagnosis is present, expected none");
        if (view.infrastructure !== null) {
          problems.push(`unexpected infrastructure record: ${view.infrastructure.kind}: ${view.infrastructure.message}`);
        }
        const res = view.result;
        if (res === null) {
          problems.push("no stored result");
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
        log.push("independent docker ps: queried leftover acquisition and sandbox containers for this job's execution ids");
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
