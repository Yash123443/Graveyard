/**
 * manual-egress-check.ts — OPT-IN Docker integration harness for the egress proxy.
 *
 * Not production code and not wired into anything. It is skipped unless
 * GRAVEYARD_MANUAL_EGRESS=1, so `pnpm test` never touches Docker or the network.
 *
 * Topology it tries to build (all names carry a random per-run id):
 *   - an `--internal` Docker network with an explicit random 10.x /24 subnet
 *   - proxy container (node:22-alpine): internal network at a fixed IP, plus the default
 *     `bridge` network for its upstream. Runs the compiled `EgressProxy`.
 *   - client container (alpine:3.21): internal network only
 *
 * Checks, from inside the client container:
 *   1. positive control: the client can open TCP to the proxy
 *   2. direct TCP/443 to two public IPs fails (the control above rules out a broken client)
 *   3. proxy answers 403 to CONNECT example.com:443 and to two private targets
 *   4. proxy answers 200 to CONNECT github.com:443 (needs real egress from the proxy container)
 *
 * What a pass does NOT show: that `--internal` blocks every escape path, that the proxy is the
 * only reachable endpoint, or that the topology is safe on any other host. It shows only that
 * these probes behaved as listed during this run. Any precondition failure (image missing, no
 * Node in the proxy container, network not internal, unexpected attachments) fails closed.
 *
 * Both images (node:22-alpine, alpine:3.21) must already exist locally; nothing is pulled.
 * Both containers use the json-file log driver capped at 64k, one file.
 *
 * Commands use argument arrays (`shell: false`). Cleanup removes only the resources this run
 * attempted to create, and only after their `graveyard.manual-egress` label equals the run id.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPT_IN = process.env["GRAVEYARD_MANUAL_EGRESS"] === "1";
const PROXY_IMAGE = "node:22-alpine";
const CLIENT_IMAGE = "alpine:3.21";
const LABEL = "graveyard.manual-egress";
const PROXY_PORT = "3128";
const TOTAL_MS = 90_000;
const OUTPUT_CAP = 64 * 1024;
const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

class FailClosed extends Error {}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunOptions {
  timeoutMs: number;
  /** Written to stdin and left open until the process ends or `stopWhen` matches. */
  input?: string;
  /** When it returns true for the stdout so far, the docker client process is killed. */
  stopWhen?: (stdout: string) => boolean;
}

/** Runs `docker <args>` with no shell, a minimal environment, bounded output and a hard timeout. */
function docker(args: readonly string[], opts: RunOptions): Promise<Run> {
  return new Promise<Run>((resolveRun) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ENV_ALLOWLIST) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("docker", [...args], { shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => finish(null), 500);
    }, Math.max(1, opts.timeoutMs));
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += c.toString("utf8");
      if (opts.stopWhen?.(stdout) === true) child.kill();
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      stderr += `spawn error: ${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin.write(opts.input);
    else child.stdin.end();
  });
}

const brief = (r: Run): string =>
  `exit=${String(r.code)}${r.timedOut ? " (timed out)" : ""} ${r.stderr.trim().slice(0, 300)}`.trim();

function safeMountPath(p: string, what: string): string {
  const abs = resolve(p);
  if (!isAbsolute(abs) || /[,"'\r\n]/.test(abs)) {
    throw new FailClosed(`${what} path is unusable for a bind mount (must be absolute, no comma, quote or newline): ${abs}`);
  }
  return abs;
}

const HARDENING: readonly string[] = [
  "--pull", "never",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
  "--memory", "128m",
  "--memory-swap", "128m",
  "--cpus", "0.5",
  "--pids-limit", "64",
  "--user", "65532:65532",
  // Docker's "local" default log driver can be problematic here; pin json-file with a tiny cap.
  "--log-driver", "json-file",
  "--log-opt", "max-size=64k",
  "--log-opt", "max-file=1",
];

const PROXY_SCRIPT = `import { EgressProxy } from "/app/egress-proxy.js";
const proxy = new EgressProxy({
  bindHost: process.env.GRAVEYARD_PROXY_BIND,
  port: ${PROXY_PORT},
  onEvent: (e) => console.log(JSON.stringify(e)),
});
const a = await proxy.start();
console.log(JSON.stringify({ kind: "listening", host: a.host, port: a.port }));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { proxy.close().finally(() => process.exit(0)); });
`;

test(
  "manual egress topology check (opt-in: GRAVEYARD_MANUAL_EGRESS=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_EGRESS=1 to run against real Docker", timeout: TOTAL_MS + 60_000 },
  async () => {
    const runId = randomBytes(6).toString("hex");
    const base = `graveyard-egress-check`;
    const names = { net: `${base}-net-${runId}`, proxy: `${base}-proxy-${runId}`, client: `${base}-client-${runId}` };
    const attempted = { net: false, proxy: false, client: false };
    const octetA = 200 + randomInt(40);
    const octetB = randomInt(256);
    const subnet = `10.${octetA}.${octetB}.0/24`;
    // .1 is the Docker-reserved gateway of the subnet; the proxy takes .10.
    const proxyIp = `10.${octetA}.${octetB}.10`;
    const deadline = Date.now() + TOTAL_MS;
    const labelArgs = ["--label", `${LABEL}=${runId}`];
    const results: Array<{ name: string; ok: boolean; detail: string }> = [];
    let tmpDir: string | undefined;

    const d = (args: readonly string[], o: Omit<RunOptions, "timeoutMs"> & { timeoutMs?: number } = {}): Promise<Run> => {
      const left = deadline - Date.now();
      if (left <= 0) throw new FailClosed("overall timeout reached before the checks finished");
      return docker(args, { ...o, timeoutMs: Math.min(o.timeoutMs ?? 20_000, left) });
    };
    const must = async (what: string, args: readonly string[], o?: Omit<RunOptions, "timeoutMs"> & { timeoutMs?: number }): Promise<Run> => {
      const r = await d(args, o);
      if (r.code !== 0) throw new FailClosed(`${what} failed: ${brief(r)}`);
      return r;
    };
    const record = (name: string, ok: boolean, detail: string): void => {
      results.push({ name, ok, detail });
    };

    /** Removes only resources this run attempted to create and whose label equals the run id. */
    const cleanup = async (): Promise<string[]> => {
      const problems: string[] = [];
      const owned = async (kind: "container" | "network", name: string): Promise<boolean | "absent"> => {
        const fmt = kind === "container" ? `{{index .Config.Labels "${LABEL}"}}` : `{{index .Labels "${LABEL}"}}`;
        const args = kind === "container" ? ["inspect", "--type", "container", "--format", fmt, name] : ["network", "inspect", "--format", fmt, name];
        const r = await docker(args, { timeoutMs: 15_000 });
        if (r.code !== 0) {
          // Only an explicit Docker "not found" for this exact name counts as absent; anything else fails closed.
          // Names are [a-z0-9-] only, so they are safe inside the pattern.
          const notFound = new RegExp(`no such (container|network|object): ${name}\\b|network ${name} not found`, "i");
          return notFound.test(r.stderr) ? "absent" : false;
        }
        return r.stdout.trim() === runId;
      };
      const steps: Array<["container" | "network", string, boolean]> = [
        ["container", names.client, attempted.client],
        ["container", names.proxy, attempted.proxy],
        ["network", names.net, attempted.net],
      ];
      for (const [kind, name, was] of steps) {
        if (!was) continue;
        const own = await owned(kind, name);
        if (own === "absent") continue;
        if (own !== true) {
          problems.push(`${kind} ${name}: not removed (label check failed or inspect error)`);
          continue;
        }
        const rm = kind === "container" ? ["rm", "-f", name] : ["network", "rm", name];
        const r = await docker(rm, { timeoutMs: 30_000 });
        if (r.code !== 0) problems.push(`${kind} ${name}: remove failed: ${brief(r)}`);
        if ((await owned(kind, name)) !== "absent") problems.push(`${kind} ${name}: still present after removal`);
      }
      return problems;
    };

    const onSigint = (): void => {
      void cleanup().finally(() => process.exit(130));
    };
    process.once("SIGINT", onSigint);

    let failure: unknown;
    try {
      // Preconditions (fail closed).
      await must("docker daemon check", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
      for (const image of [PROXY_IMAGE, CLIENT_IMAGE]) {
        await must(`image ${image} must already exist locally (this harness never pulls)`, ["image", "inspect", "--format", "{{.Id}}", image]);
      }

      const here = dirname(fileURLToPath(import.meta.url));
      const compiledDir = resolve(here, "..");
      tmpDir = mkdtempSync(join(tmpdir(), "graveyard-egress-"));
      for (const f of ["egress-proxy.js", "acquisition-policy.js", "url.js"]) {
        const src = join(compiledDir, f);
        if (!existsSync(src)) throw new FailClosed(`compiled ${f} not found in ${compiledDir}; run pnpm run build:test first`);
        copyFileSync(src, join(tmpDir, f));
      }
      writeFileSync(join(tmpDir, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(tmpDir, "run.mjs"), PROXY_SCRIPT);
      const appDir = safeMountPath(tmpDir, "temporary app directory");

      // Topology.
      attempted.net = true;
      await must("create internal network", ["network", "create", "--driver", "bridge", "--internal", "--subnet", subnet, ...labelArgs, names.net]);
      const netInfo = JSON.parse((await must("inspect network", ["network", "inspect", names.net])).stdout) as Array<{ Internal?: boolean }>;
      if (netInfo[0]?.Internal !== true) throw new FailClosed(`network ${names.net} is not Internal; refusing to continue (platform: ${process.platform})`);

      attempted.proxy = true;
      await must("create proxy container", [
        "create", "--name", names.proxy, "--network", names.net, "--ip", proxyIp, ...HARDENING, ...labelArgs,
        "--mount", `type=bind,source=${appDir},target=/app,readonly`,
        "--env", `GRAVEYARD_PROXY_BIND=${proxyIp}`,
        PROXY_IMAGE, "node", "/app/run.mjs",
      ]);
      await must("connect proxy to default bridge (upstream)", ["network", "connect", "bridge", names.proxy]);
      attempted.client = true;
      await must("create client container", ["create", "--name", names.client, "--network", names.net, ...HARDENING, ...labelArgs, CLIENT_IMAGE, "sleep", "120"]);

      // Attachments must be exactly what was intended before anything starts.
      const attach = async (name: string): Promise<string[]> => {
        const j = JSON.parse((await must("inspect container", ["inspect", "--type", "container", name])).stdout) as Array<{
          NetworkSettings?: { Networks?: Record<string, unknown> };
        }>;
        return Object.keys(j[0]?.NetworkSettings?.Networks ?? {}).sort();
      };
      const clientNets = await attach(names.client);
      const proxyNets = await attach(names.proxy);
      if (clientNets.join() !== names.net) throw new FailClosed(`client networks are [${clientNets.join(", ")}], expected only ${names.net}`);
      if (proxyNets.join() !== ["bridge", names.net].sort().join()) throw new FailClosed(`proxy networks are [${proxyNets.join(", ")}], expected bridge + ${names.net}`);

      await must("start client", ["start", names.client]);
      await must("start proxy", ["start", names.proxy]);

      // Wait for the proxy, with logs for diagnosis.
      let ready = false;
      for (let i = 0; i < 20 && !ready; i += 1) {
        const st = await d(["inspect", "--format", "{{.State.Running}}", names.proxy], { timeoutMs: 10_000 });
        if (st.stdout.trim() !== "true") {
          const logs = await d(["logs", "--tail", "20", names.proxy], { timeoutMs: 10_000 });
          throw new FailClosed(
            `proxy container is not running (image ${PROXY_IMAGE}). logs: ${(logs.stdout + logs.stderr).trim().slice(0, 600)}`,
          );
        }
        ready = (await d(["exec", names.client, "nc", "-z", "-w", "2", proxyIp, PROXY_PORT], { timeoutMs: 10_000 })).code === 0;
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) throw new FailClosed("client could not reach the proxy on the internal network; no checks are meaningful");
      record("positive control: client reaches proxy", true, `${proxyIp}:${PROXY_PORT}`);

      // 2. Direct internet from the client must fail.
      for (const ip of ["1.1.1.1", "8.8.8.8"]) {
        const r = await d(["exec", names.client, "nc", "-z", "-w", "3", ip, "443"], { timeoutMs: 10_000 });
        record(`client cannot reach ${ip}:443 directly`, r.code !== 0 && r.code !== null, r.code === 0 ? "CONNECTED (unexpected)" : brief(r));
      }

      // 3 and 4. CONNECT through the proxy.
      const connect = async (authority: string, wantStatus: number): Promise<void> => {
        const input = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
        const r = await d(["exec", "-i", names.client, "nc", "-w", "4", proxyIp, PROXY_PORT], {
          timeoutMs: 15_000,
          input,
          stopWhen: (o) => o.includes("\r\n"),
        });
        const m = /^HTTP\/1\.1 (\d{3}) /.exec(r.stdout);
        const status = m === null ? null : Number(m[1]);
        record(`CONNECT ${authority} -> ${wantStatus}`, status === wantStatus, `got ${status === null ? `no HTTP status (${brief(r)})` : String(status)}`);
      };
      await connect("example.com:443", 403);
      await connect("169.254.169.254:80", 403);
      await connect("10.0.0.1:443", 403);
      await connect("github.com:443", 200);

      const logs = await d(["logs", "--tail", "40", names.proxy], { timeoutMs: 10_000 });
      console.log(`proxy events (sanitized, from container logs):\n${logs.stdout.trim().slice(0, 4000)}`);
    } catch (e) {
      failure = e;
    } finally {
      process.off("SIGINT", onSigint);
      const problems: string[] = [];
      if (tmpDir !== undefined) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
          problems.push(`temporary directory ${tmpDir}: remove failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        problems.push(...(await cleanup()));
      } catch (e) {
        problems.push(`cleanup threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  [${r.detail}]`);
      if (problems.length > 0) {
        console.log(`CLEANUP PROBLEMS (remove manually, run id ${runId}):\n${problems.join("\n")}`);
        failure ??= new Error("cleanup not confirmed");
      } else {
        const gone = (["client", "proxy", "net"] as const).filter((k) => attempted[k]).map((k) => names[k]);
        console.log(`cleanup confirmed for run ${runId}; inspect reported absent: ${gone.length > 0 ? gone.join(", ") : "(nothing was created)"}`);
      }
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about isolation or proxy behaviour. Platform: ${process.platform}.`);
      }
    }
    if (failure !== undefined) throw failure;
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) throw new Error(`${bad.length} check(s) failed: ${bad.map((b) => b.name).join("; ")}`);
  },
);
