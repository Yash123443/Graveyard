/**
 * npm-lock-root-engines.test.ts — the lock-root `engines` opt-in carried from planNpmScripts to the
 * registry acquisition gate, and sanitizeManifest keeping a `__proto__` key. Mocked executor only:
 * no docker process, no network. UNVERIFIED until run by the operator.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressAttestation, EgressGuard } from "../acquisition-policy.js";
import type { ProcessExecutor } from "../docker-sandbox.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import { checkOperatorFixture } from "../npm-operator-fixture.js";
import { NpmRegistryAcquisition, OPERATOR_FIXTURE_ID } from "../npm-registry-acquisition.js";
import { planNpmScripts, sanitizeManifest } from "../npm-scripts-policy.js";
import { operatorDoc, textsOf } from "./operator-fixture-helpers.js";

function docWithEngines(pkgEngines: Record<string, string>, lockEngines: Record<string, string>) {
  const d = operatorDoc();
  d.pkg["scripts"] = { build: "node build.mjs", test: "node test.mjs" };
  d.pkg["engines"] = pkgEngines;
  d.lock["packages"][""]["engines"] = lockEngines;
  return d;
}

describe("planNpmScripts lock root engines", () => {
  it("matches engines by own key/value pairs regardless of key order and reports the opt-in", () => {
    const d = docWithEngines({ node: ">=18", npm: ">=9" }, { npm: ">=9", node: ">=18" });
    const t = textsOf(d);
    const plan = planNpmScripts({ packageJson: t.packageJson, packageLock: t.packageLock }, { dependencyAcquisition: true });
    assert.equal(plan.ok, true);
    if (plan.ok) assert.equal(plan.lockRootEngines, true);
  });

  it("rejects differing engines and reports no opt-in without lock engines", () => {
    const d = docWithEngines({ node: ">=18" }, { node: ">=20" });
    const t = textsOf(d);
    assert.equal(planNpmScripts({ packageJson: t.packageJson, packageLock: t.packageLock }, { dependencyAcquisition: true }).ok, false);
    const plain = operatorDoc();
    plain.pkg["scripts"] = { build: "node build.mjs", test: "node test.mjs" };
    const p = textsOf(plain);
    const plan = planNpmScripts({ packageJson: p.packageJson, packageLock: p.packageLock }, { dependencyAcquisition: true });
    assert.equal(plan.ok, true);
    if (plan.ok) assert.equal(plan.lockRootEngines, false);
  });
});

describe("sanitizeManifest", () => {
  it("keeps an own __proto__ key so the strict gate rejects it", () => {
    const d = operatorDoc();
    const text = JSON.stringify(d.pkg).replace("{", '{"__proto__":{"polluted":true},');
    const out = sanitizeManifest(text);
    assert.match(out, /"__proto__"/);
    const r = checkOperatorFixture(out, textsOf(d).packageLock);
    assert.equal(r.ok, false);
  });
});

describe("registry acquisition gate for lock root engines", () => {
  function setup(): { acq: NpmRegistryAcquisition; calls: string[]; runDir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "gy-engines-"));
    const staging = join(root, "staging");
    const runDir = join(root, "run");
    const driver = join(root, "driver.js");
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
    const acq = new NpmRegistryAcquisition({ executor, egress, stagingRoot: staging, driverPath: driver });
    return { acq, calls, runDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("rejects lock root engines by default and passes the gate only with the explicit opt-in", async () => {
    const t = textsOf(docWithEngines({ node: ">=18" }, { node: ">=18" }));
    const operatorFixture = { packageJson: t.packageJson, packageLock: t.packageLock };
    const base = { executionId: "regacq-abc123-1:1", fixture: OPERATOR_FIXTURE_ID, operatorFixture, image: NODE_FIXTURE_IMAGE };
    const s = setup();
    try {
      // The manifest here still has scripts/engines, so use the sanitized one as the real caller does.
      const sanitized = { packageJson: sanitizeManifest(t.packageJson), packageLock: t.packageLock };
      const denied = await s.acq.acquire({ ...base, operatorFixture: sanitized, runDir: s.runDir });
      assert.equal(denied.kind, "rejected");
      assert.equal(s.calls.length, 0);
      const allowed = await s.acq.acquire({ ...base, operatorFixture: sanitized, runDir: s.runDir, allowLockRootEngines: true });
      assert.notEqual(allowed.kind, "rejected");
    } finally {
      s.cleanup();
    }
  });
});
