/**
 * npm-dev-dependencies.test.ts — the shared `allowDevDependencies` policy option of the opt-in npm-scripts
 * mode (ordinary single-package npm TypeScript projects with a pinned `typescript` devDependency).
 * Covers acceptance, mismatched dev dependencies (lock agreement, reachability, dev flag, bounds) and the
 * default isolation (the option off or absent keeps the legacy production-only profile everywhere).
 *
 * Synthetic documents, fake process runners and a mocked executor only: no Docker, no network, no npm, no
 * real typescript. Written without running the compiler or this file; it shows nothing about a real run.
 * In particular it does not show that the real `typescript` tarball fits the unchanged cache export limits.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressAttestation, EgressGuard } from "../acquisition-policy.js";
import type { ProcessExecutor } from "../docker-sandbox.js";
import { createRunDir } from "../fixture-workspace.js";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../fixture-pipeline-driver.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import { runAcquisition, npmAcquireArgs, manifestListsDevDependencies, type AcquireProcessOutcome, type AcquireRunner } from "../npm-acquire-driver.js";
import { checkNpmFixture } from "../npm-lock-policy.js";
import { checkOperatorFixture, type OperatorFixtureResult } from "../npm-operator-fixture.js";
import { NpmRegistryAcquisition, OPERATOR_FIXTURE_ID } from "../npm-registry-acquisition.js";
import { SCRIPTS_INSTALL_MANIFEST_NAME, installManifestListsDev, runScriptsPipeline } from "../npm-scripts-driver.js";
import { NpmScriptsPipeline } from "../npm-scripts-pipeline.js";
import { planNpmScripts } from "../npm-scripts-policy.js";
import { lockEntry, operatorDoc, textsOf, withExtraRootPackages, type OperatorDoc } from "./operator-fixture-helpers.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graveyard-dev-deps-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const DEV = { allowDevDependencies: true } as const;
const TSC_BUILD = "node node_modules/typescript/bin/tsc -p tsconfig.json";

/** One pinned `typescript` devDependency and nothing else. Synthetic tarball bytes, real-looking lock entry. */
function tsDoc(withScripts = false): OperatorDoc {
  const name = "ts-project";
  const version = "1.0.0";
  const d: OperatorDoc = {
    pkg: { name, version, private: true, devDependencies: { typescript: "5.4.5" } },
    lock: {
      name,
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name, version, devDependencies: { typescript: "5.4.5" } },
        "node_modules/typescript": lockEntry("typescript", "5.4.5", {
          dev: true,
          license: "Apache-2.0",
          bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" },
          engines: { node: ">=14.17" },
        }),
      },
    },
  };
  if (withScripts) d.pkg["scripts"] = { build: TSC_BUILD, test: "node --test" };
  return d;
}

/** alpha -> beta -> gamma (production) plus a dev-only `helper` that also depends on beta. */
function mixedDoc(): OperatorDoc {
  const d = operatorDoc();
  d.pkg["devDependencies"] = { helper: "^1.0.0" };
  d.lock["packages"][""]["devDependencies"] = { helper: "^1.0.0" };
  d.lock["packages"]["node_modules/helper"] = lockEntry("helper", "1.0.0", { dev: true, dependencies: { beta: "^2.0.0" } });
  return d;
}

const check = (d: OperatorDoc, opts: { allowDevDependencies?: boolean } = DEV): OperatorFixtureResult => {
  const t = textsOf(d);
  return checkOperatorFixture(t.packageJson, t.packageLock, opts);
};
const violationsOf = (r: OperatorFixtureResult): string => {
  assert.equal(r.ok, false, "expected a rejection");
  return r.ok ? "" : r.violations.join("\n");
};

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

describe("dev dependencies: acceptance", () => {
  it("accepts a single pinned typescript devDependency and binds its tarball integrity like any other package", () => {
    const d = tsDoc();
    const r = check(d);
    if (!r.ok) return assert.fail(r.violations.join("; "));
    assert.equal(r.packageCount, 1);
    assert.equal(r.devPackageCount, 1);
    assert.equal(r.rootDependencyCount, 0);
    assert.deepEqual(r.packages, [
      { name: "typescript", version: "5.4.5", integrity: (d.lock["packages"]["node_modules/typescript"] as { integrity: string }).integrity },
    ]);
  });

  it("accepts production and dev packages together; a package reachable from dependencies is not dev", () => {
    const r = check(mixedDoc());
    if (!r.ok) return assert.fail(r.violations.join("; "));
    assert.equal(r.packageCount, 4);
    assert.equal(r.devPackageCount, 1);
    assert.deepEqual(r.packages.map((p) => p.name), ["alpha", "beta", "gamma", "helper"]);
  });

  it("plans a TypeScript project with the option and carries it on the plan", () => {
    const t = textsOf(tsDoc(true));
    const plan = planNpmScripts(t, { dependencyAcquisition: true, ...DEV });
    if (!plan.ok) return assert.fail(JSON.stringify(plan.findings));
    assert.equal(plan.allowDevDependencies, true);
    assert.equal(plan.expectedPackages, 1);
    assert.equal(plan.buildScript, TSC_BUILD);
    const sanitized = JSON.parse(plan.sanitizedPackageJson) as Record<string, unknown>;
    assert.deepEqual(sanitized["devDependencies"], { typescript: "5.4.5" });
    assert.equal("scripts" in sanitized, false);
  });
});

// ---------------------------------------------------------------------------
// Mismatched dev dependencies
// ---------------------------------------------------------------------------

describe("dev dependencies: mismatches are rejected", () => {
  it("rejects a lock root whose devDependencies differ from package.json, or exist only in the lock", () => {
    const spec = tsDoc();
    spec.lock["packages"][""]["devDependencies"]["typescript"] = "5.4.6";
    assert.match(violationsOf(check(spec)), /lock root: devDependencies differ/);

    const lockOnly = operatorDoc();
    lockOnly.lock["packages"][""]["devDependencies"] = { alpha: "^1.0.0" };
    assert.match(violationsOf(check(lockOnly)), /lock root: devDependencies differ/);

    const pkgOnly = tsDoc();
    delete pkgOnly.lock["packages"][""]["devDependencies"];
    assert.match(violationsOf(check(pkgOnly)), /lock root: devDependencies differ/);
  });

  it("requires the dev flag on exactly the entries reachable only through devDependencies", () => {
    const missing = tsDoc();
    delete missing.lock["packages"]["node_modules/typescript"]["dev"];
    assert.match(violationsOf(check(missing)), /reachable only from devDependencies, so dev must be true/);

    const falseFlag = tsDoc();
    falseFlag.lock["packages"]["node_modules/typescript"]["dev"] = false;
    assert.match(violationsOf(check(falseFlag)), /dev must be true when present/);

    const prodMarkedDev = mixedDoc();
    prodMarkedDev.lock["packages"]["node_modules/beta"]["dev"] = true;
    assert.match(violationsOf(check(prodMarkedDev)), /beta: reachable from dependencies, so dev must not be set/);
  });

  it("rejects unreachable entries, missing entries, and a package listed in both maps", () => {
    const orphan = tsDoc();
    orphan.lock["packages"]["node_modules/orphan"] = lockEntry("orphan", "1.0.0", { dev: true });
    assert.match(violationsOf(check(orphan)), /orphan is not reachable/);

    const absent = tsDoc();
    absent.pkg["devDependencies"]["ghost"] = "1.0.0";
    absent.lock["packages"][""]["devDependencies"]["ghost"] = "1.0.0";
    assert.match(violationsOf(check(absent)), /dependency ghost has no node_modules entry/);

    const both = mixedDoc();
    both.pkg["devDependencies"]["alpha"] = "^1.0.0";
    assert.match(violationsOf(check(both)), /alpha is listed in both dependencies and devDependencies/);
  });

  it("rejects scoped, nested, optional, peer and platform-filtered entries and fields", () => {
    const scoped = tsDoc();
    scoped.pkg["devDependencies"] = { "@types/node": "20.0.0" };
    scoped.lock["packages"][""]["devDependencies"] = { "@types/node": "20.0.0" };
    delete scoped.lock["packages"]["node_modules/typescript"];
    scoped.lock["packages"]["node_modules/@types/node"] = lockEntry("@types/node", "20.0.0", {
      dev: true,
      resolved: "https://registry.npmjs.org/@types/node/-/node-20.0.0.tgz",
    });
    assert.match(violationsOf(check(scoped)), /not a plain unscoped name|flat node_modules/);

    const nested = tsDoc();
    nested.lock["packages"]["node_modules/typescript/node_modules/inner"] = lockEntry("inner", "1.0.0", { dev: true });
    assert.match(violationsOf(check(nested)), /flat node_modules/);

    for (const flag of ["optional", "peer", "devOptional"]) {
      const d = tsDoc();
      d.lock["packages"]["node_modules/typescript"][flag] = true;
      assert.match(violationsOf(check(d)), new RegExp(flag), flag);
    }
    for (const field of ["optionalDependencies", "peerDependencies"]) {
      const d = tsDoc();
      d.pkg[field] = { alpha: "^1.0.0" };
      assert.match(violationsOf(check(d)), new RegExp(`${field} is not allowed`), field);
    }
    const platform = tsDoc();
    platform.lock["packages"]["node_modules/typescript"]["os"] = ["linux"];
    assert.equal(check(platform).ok, false);
    const installScript = tsDoc();
    installScript.lock["packages"]["node_modules/typescript"]["hasInstallScript"] = true;
    assert.equal(check(installScript).ok, false);
  });

  it("rejects spec forms that are not plain ranges and an entry without a sha512 integrity", () => {
    const git = tsDoc();
    git.pkg["devDependencies"]["typescript"] = "github:microsoft/TypeScript";
    git.lock["packages"][""]["devDependencies"]["typescript"] = "github:microsoft/TypeScript";
    assert.equal(check(git).ok, false);

    const noIntegrity = tsDoc();
    delete noIntegrity.lock["packages"]["node_modules/typescript"]["integrity"];
    assert.equal(check(noIntegrity).ok, false);

    const wrongHost = tsDoc();
    wrongHost.lock["packages"]["node_modules/typescript"]["resolved"] = "https://evil.example/typescript-5.4.5.tgz";
    assert.equal(check(wrongHost).ok, false);
  });

  it("keeps the existing package bound: dev packages count towards the 8", () => {
    const d = withExtraRootPackages(operatorDoc(), 5); // 3 + 5 = 8 production packages
    d.pkg["devDependencies"] = { typescript: "5.4.5" };
    d.lock["packages"][""]["devDependencies"] = { typescript: "5.4.5" };
    d.lock["packages"]["node_modules/typescript"] = lockEntry("typescript", "5.4.5", { dev: true });
    assert.match(violationsOf(check(d)), /between 1 and 8 packages/);
  });

  it("rejects the same mismatches through the planner (original manifest check and sanitized gate)", () => {
    const d = tsDoc(true);
    delete d.lock["packages"]["node_modules/typescript"]["dev"];
    const plan = planNpmScripts(textsOf(d), { dependencyAcquisition: true, ...DEV });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.ok(plan.findings.length > 0 && plan.findings.every((f) => f.code === "dependency-policy-rejected"));

    const peer = tsDoc(true);
    peer.pkg["peerDependencies"] = { alpha: "^1.0.0" };
    const p2 = planNpmScripts(textsOf(peer), { dependencyAcquisition: true, ...DEV });
    assert.equal(p2.ok, false);
    if (!p2.ok) assert.match(p2.findings.map((f) => f.detail).join("\n"), /peerDependencies/);
  });
});

// ---------------------------------------------------------------------------
// Default isolation
// ---------------------------------------------------------------------------

describe("dev dependencies: default isolation", () => {
  it("rejects a devDependencies project everywhere when the option is absent or false", () => {
    const variants: Array<{ allowDevDependencies?: boolean } | undefined> = [undefined, {}, { allowDevDependencies: false }];
    for (const opts of variants) {
      const t = textsOf(tsDoc(true));
      const plan = planNpmScripts(t, opts === undefined ? { dependencyAcquisition: true } : { dependencyAcquisition: true, ...opts });
      assert.equal(plan.ok, false, JSON.stringify(opts));
      if (!plan.ok) {
        assert.ok(plan.findings.length > 0 && plan.findings.every((f) => f.code === "dependency-policy-rejected"));
        assert.match(plan.findings[0]?.detail ?? "", /field devDependencies is not allowed/);
      }
      assert.match(violationsOf(checkOperatorFixture(t.packageJson, t.packageLock, opts ?? {})), /field devDependencies is not allowed/);
    }
  });

  it("keeps the legacy production profile identical with and without the option, and adds nothing to the plan or result", () => {
    const legacy = textsOf(operatorDoc());
    const off = checkOperatorFixture(legacy.packageJson, legacy.packageLock);
    const on = checkOperatorFixture(legacy.packageJson, legacy.packageLock, DEV);
    assert.equal(off.ok, true);
    assert.equal(on.ok, true);
    if (off.ok) assert.equal("devPackageCount" in off, false);

    const scripted = operatorDoc();
    scripted.pkg["scripts"] = { build: "node build.js", test: "node --test" };
    const t = textsOf(scripted);
    const plan = planNpmScripts(t, { dependencyAcquisition: true });
    assert.equal(plan.ok, true);
    if (plan.ok) assert.equal("allowDevDependencies" in plan, false);
    const planOn = planNpmScripts(t, { dependencyAcquisition: true, ...DEV });
    assert.equal(planOn.ok, true);
  });

  it("does not let a legacy lock carry a dev flag, and checkNpmFixture only tightens when the option is on", () => {
    const flagged = operatorDoc();
    flagged.lock["packages"]["node_modules/gamma"]["dev"] = true;
    assert.match(violationsOf(check(flagged, {})), /field dev is not allowed/);

    const optional = operatorDoc();
    optional.lock["packages"]["node_modules/gamma"]["optional"] = true;
    const t = textsOf(optional);
    assert.equal(checkNpmFixture(t.packageJson, t.packageLock).ok, true);
    assert.equal(checkNpmFixture(t.packageJson, t.packageLock, DEV).ok, false);
  });

  describe("registry acquisition revalidation", () => {
    function setup(): { acq: NpmRegistryAcquisition; calls: string[]; runDir: string } {
      const staging = join(tmp, "staging");
      const runDir = join(tmp, "run");
      const driver = join(tmp, "driver.js");
      mkdirSync(staging);
      mkdirSync(runDir);
      writeFileSync(driver, "// stand-in\n");
      const calls: string[] = [];
      const executor: ProcessExecutor = (_file, args) => {
        calls.push(String(args[0]));
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "unavailable", timedOut: false, aborted: false, truncated: false });
      };
      const egress: EgressGuard = {
        attest: (): Promise<EgressAttestation> => Promise.resolve({ verified: false, reason: "test: no egress" } as unknown as EgressAttestation),
      };
      return { acq: new NpmRegistryAcquisition({ executor, egress, stagingRoot: staging, driverPath: driver }), calls, runDir };
    }
    const base = { executionId: "regacq-abc123-1:1", fixture: OPERATOR_FIXTURE_ID, image: NODE_FIXTURE_IMAGE };

    it("rejects dev dependencies by default before anything is contacted, and passes the gate only with the option", async () => {
      const s = setup();
      const t = textsOf(tsDoc());
      const operatorFixture = { packageJson: t.packageJson, packageLock: t.packageLock };
      const extras: Array<{ allowDevDependencies?: boolean }> = [{}, { allowDevDependencies: false }];
      for (const extra of extras) {
        const denied = await s.acq.acquire({ ...base, operatorFixture, runDir: s.runDir, ...extra });
        assert.equal(denied.kind, "rejected");
      }
      assert.equal(s.calls.length, 0);
      const allowed = await s.acq.acquire({ ...base, operatorFixture, runDir: s.runDir, allowDevDependencies: true });
      assert.notEqual(allowed.kind, "rejected"); // stops at the (unverified) attestation, which this test never grants
      assert.equal(allowed.kind, "network-unavailable");
    });

    it("revalidates with the same option: a mismatched dev flag is rejected even when the option is set", async () => {
      const s = setup();
      const bad = tsDoc();
      delete bad.lock["packages"]["node_modules/typescript"]["dev"];
      const t = textsOf(bad);
      const r = await s.acq.acquire({
        ...base, operatorFixture: { packageJson: t.packageJson, packageLock: t.packageLock }, runDir: s.runDir, allowDevDependencies: true,
      });
      assert.equal(r.kind, "rejected");
      assert.equal(s.calls.length, 0);
    });
  });

  describe("NpmScriptsPipeline", () => {
    function pipelineSetup(): { runDir: string; cache: string; exec: ProcessExecutor; calls: { n: number } } {
      const runDir = createRunDir(tmp);
      mkdirSync(join(runDir, "src-0123456789ab"));
      writeFileSync(join(runDir, "src-0123456789ab", "package.json"), "{}\n");
      const cache = join(tmp, "cache");
      mkdirSync(cache);
      const calls = { n: 0 };
      const exec: ProcessExecutor = () => {
        calls.n += 1;
        return Promise.reject(new Error("docker must not be reached"));
      };
      return { runDir, cache, exec, calls };
    }
    const devManifest = `${JSON.stringify({ name: "ts-project", version: "1.0.0", private: true, devDependencies: { typescript: "5.4.5" } }, null, 2)}\n`;

    it("refuses an install manifest with devDependencies unless the option is set, and never reaches Docker", async () => {
      const s = pipelineSetup();
      const common = {
        executor: s.exec, runDir: s.runDir, snapshot: "src-0123456789ab", cacheDir: s.cache,
        installManifest: devManifest, expectedPackages: 1, driverPath: join(tmp, "missing-driver.js"),
      };
      const extras: Array<{ allowDevDependencies?: boolean }> = [{}, { allowDevDependencies: false }];
      for (const extra of extras) {
        const r = await new NpmScriptsPipeline({ ...common, ...extra }).run({ executionId: "job1:1", fixture: "src-0123456789ab" });
        assert.equal(r.status, "not-run");
        assert.equal(r.reason, "unconfigured");
        assert.match(r.detail, /dev dependency policy option is not enabled/);
      }
      // With the option it gets past that gate and stops at the missing trusted driver, before staging or Docker.
      const ok = await new NpmScriptsPipeline({ ...common, allowDevDependencies: true }).run({ executionId: "job1:1", fixture: "src-0123456789ab" });
      assert.equal(ok.reason, "driver-unavailable");
      assert.equal(s.calls.n, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Installation: --ignore-scripts stays, --include=dev only for a validated dev manifest
// ---------------------------------------------------------------------------

describe("dev dependencies: install arguments", () => {
  const PROXY = "http://10.231.4.10:3128";
  const OK: AcquireProcessOutcome = { exitCode: 0, signal: null, stdout: "added 1 package in 1s\n", stderr: "", timedOut: false, aborted: false, truncated: false };

  function acquireWith(manifest: string): Promise<{ args: string[]; env: Record<string, string> }> {
    const src = join(tmp, "src");
    const work = join(tmp, "work");
    mkdirSync(src, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(src, "package.json"), manifest);
    writeFileSync(join(src, "package-lock.json"), "{}\n");
    let seen: { args: string[]; env: Record<string, string> } | null = null;
    const runner: AcquireRunner = (spec) => {
      seen = { args: [...spec.args], env: { ...spec.env } };
      return Promise.resolve(OK);
    };
    // The export step fails (no cache is written); only the npm invocation is observed here.
    return runAcquisition({ sourceDir: src, workDir: work, proxyUrl: PROXY, runner }).then(() => {
      if (seen === null) throw new Error("npm was not invoked");
      return seen;
    });
  }

  it("acquisition adds exactly --include=dev for a manifest with devDependencies and keeps every isolation flag", async () => {
    const { args, env } = await acquireWith(JSON.stringify({ name: "x", devDependencies: { typescript: "5.4.5" } }));
    assert.equal(args[args.length - 1], "--include=dev");
    assert.equal(args.filter((a) => a === "--include=dev").length, 1);
    assert.deepEqual(args.slice(0, -1), npmAcquireArgs(PROXY, args[args.indexOf("--cache") + 1] as string, args[args.indexOf("--userconfig") + 1] as string, args[args.indexOf("--globalconfig") + 1] as string));
    for (const f of ["--ignore-scripts", "--no-audit", "--strict-ssl=true"]) assert.ok(args.includes(f), f);
    assert.equal(args[args.indexOf("--registry") + 1], "https://registry.npmjs.org/");
    assert.equal(args[args.indexOf("--proxy") + 1], PROXY);
    assert.equal(args.includes("--offline"), false);
    assert.equal(args.includes("--include=optional"), false);
    assert.equal(args.includes("--include=peer"), false);
    assert.equal(env["NODE_ENV"], "production");
  });

  it("acquisition adds nothing for a production-only, empty-dev or unparsable manifest", async () => {
    for (const manifest of [JSON.stringify({ name: "x", dependencies: { a: "1.0.0" } }), JSON.stringify({ name: "x", devDependencies: {} }), "not json"]) {
      const { args } = await acquireWith(manifest);
      assert.equal(args.some((a) => a.startsWith("--include")), false, manifest);
      rmSync(join(tmp, "src"), { recursive: true, force: true });
      rmSync(join(tmp, "work"), { recursive: true, force: true });
    }
    assert.equal(manifestListsDevDependencies(Buffer.from('{"devDependencies":{"a":"1.0.0"}}')), true);
    assert.equal(manifestListsDevDependencies(Buffer.from('{"devDependencies":["a"]}')), false);
    assert.equal(npmAcquireArgs(PROXY, "/c", "/u", "/g").includes("--include=dev"), false);
  });

  describe("offline scripts driver", () => {
    interface Call { args: string[]; env: Record<string, string> }
    function makeSource(installManifest: string): { source: string; work: string } {
      const source = join(tmp, "fixture");
      const work = join(tmp, "work");
      mkdirSync(source, { recursive: true });
      mkdirSync(work, { recursive: true });
      const t = textsOf(tsDoc(true));
      writeFileSync(join(source, "package.json"), t.packageJson);
      writeFileSync(join(source, "package-lock.json"), t.packageLock);
      writeFileSync(join(source, SCRIPTS_INSTALL_MANIFEST_NAME), installManifest);
      return { source, work };
    }
    function recorder(): { runner: ProcessRunner; calls: Call[] } {
      const calls: Call[] = [];
      const runner: ProcessRunner = (spec: ProcessSpec) => {
        calls.push({ args: [...spec.args], env: { ...spec.env } });
        const outcome: ProcessOutcome = { exitCode: 0, signal: null, stdout: "added 1 package", stderr: "", timedOut: false, aborted: false, truncated: false };
        return Promise.resolve(outcome);
      };
      return { runner, calls };
    }
    const sanitizedDev = `${JSON.stringify({ name: "ts-project", version: "1.0.0", private: true, devDependencies: { typescript: "5.4.5" } }, null, 2)}\n`;

    it("installs offline with --ignore-scripts and --include=dev for a dev manifest, and runs the two scripts with hooks disabled", async () => {
      const { source, work } = makeSource(sanitizedDev);
      const { runner, calls } = recorder();
      const result = await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner });
      assert.equal(result.status, "passed");
      assert.equal(calls.length, 3);
      const install = calls[0] as Call;
      assert.deepEqual(install.args.slice(0, 3), ["ci", "--offline", "--ignore-scripts"]);
      assert.equal(install.args.filter((a) => a === "--include=dev").length, 1);
      assert.equal(install.env["NODE_ENV"], "production"); // why --include=dev is needed
      assert.deepEqual(calls[1]?.args.slice(0, 3), ["run", "build", "--ignore-scripts"]);
      assert.deepEqual(calls[2]?.args.slice(0, 3), ["run", "test", "--ignore-scripts"]);
      assert.ok(calls.slice(1).every((c) => !c.args.some((a) => a.startsWith("--include"))));
    });

    it("adds no --include for a production-only install manifest", async () => {
      const { source, work } = makeSource(`${JSON.stringify({ name: "ts-project", version: "1.0.0", private: true })}\n`);
      const { runner, calls } = recorder();
      await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner });
      assert.equal(calls[0]?.args.some((a) => a.startsWith("--include")), false);
      assert.equal(installManifestListsDev(Buffer.from("{}")), false);
      assert.equal(installManifestListsDev(Buffer.from(sanitizedDev)), true);
    });
  });
});
