/**
 * acquisition-policy.test.ts — pure policy checks. No process, network or
 * filesystem is used. These tests show the policy rejects what it should; they
 * do not show that git, Docker or a proxy enforce anything.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACQUISITION_LIMITS,
  GIT_ENV,
  UnavailableEgressGuard,
  checkAcquisitionLimits,
  checkTreeListing,
  gitHardeningArgs,
  gitSteps,
  sanitize,
  unsafePathReason,
  validateEgressAttestation,
  validateSource,
} from "../acquisition-policy.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OID = "89abcdef0123456789abcdef0123456789abcdef";
const L = checkAcquisitionLimits();

const ent = (mode: string, type: string, size: string, path: string): string =>
  `${mode} ${type} ${OID} ${size.padStart(7, " ")}\t${path}\0`;
const file = (path: string, size = "10"): string => ent("100644", "blob", size, path);

const goodEgress = {
  verified: true,
  network: "acq-egress",
  proxyUrl: "http://egress-proxy:3128",
  allowedHosts: ["github.com"],
  evidence: "test attestation",
};

describe("validateSource", () => {
  it("accepts a canonical URL and full SHA, stripping .git", () => {
    const r = validateSource("https://github.com/owner/repo.git", SHA);
    assert.deepEqual(r, { ok: true, value: { repoUrl: "https://github.com/owner/repo", commit: SHA } });
  });

  it("rejects anything but a full lowercase 40-hex SHA", () => {
    for (const bad of [
      "main", "HEAD", "v1.0.0", SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}0`, ` ${SHA}`, `${SHA}\n`,
      "--upload-pack=touch /tmp/x", "-c", "", "0".repeat(64), 5, null, undefined,
    ]) {
      const r = validateSource("https://github.com/owner/repo", bad);
      assert.equal(r.ok, false, String(bad));
    }
  });

  it("rejects non-GitHub, credentialed, ported, ssh and traversal URLs without echoing them", () => {
    for (const bad of [
      "http://github.com/o/r", "https://evil.com/o/r", "https://user@github.com/o/r",
      "https://github.com:443/o/r", "git@github.com:o/r.git", "ssh://github.com/o/r", "file:///etc/passwd",
      "https://github.com/o/r/../x", "https://github.com/o/..", "https://github.com/o/r?x=1",
      "https://github.com/o/r%2e", "https://github.com\\o\\r", "https://github.com/o/r extra", 42, null,
    ]) {
      const r = validateSource(bad, SHA);
      assert.equal(r.ok, false, String(bad));
      if (!r.ok && typeof bad === "string") assert.ok(!r.reason.includes(bad));
    }
  });
});

describe("egress attestation", () => {
  it("the default guard never verifies", async () => {
    const a = await new UnavailableEgressGuard().attest();
    assert.equal(a.verified, false);
    assert.equal(validateEgressAttestation(a).ok, false);
  });

  it("accepts a dedicated network with a plain http proxy and exactly github.com", () => {
    const r = validateEgressAttestation(goodEgress);
    assert.equal(r.ok, true);
  });

  it("rejects default Docker networks in any case, and host-sharing forms", () => {
    for (const n of ["bridge", "Bridge", "host", "none", "default", "container:abc", "docker_gwbridge", "ingress", "", "-x", "a b"]) {
      assert.equal(validateEgressAttestation({ ...goodEgress, network: n }).ok, false, n);
    }
  });

  it("rejects malformed or credentialed proxy URLs", () => {
    for (const p of [
      "https://egress-proxy:3128", "http://user:pw@egress-proxy:3128", "http://egress-proxy", "http://egress-proxy:3128/",
      "http://egress-proxy:99999", "http://egress-proxy:0", "egress-proxy:3128", "http://a:1 --x", 5,
    ]) {
      assert.equal(validateEgressAttestation({ ...goodEgress, proxyUrl: p }).ok, false, String(p));
    }
  });

  it("rejects any allowlist that is not exactly github.com", () => {
    for (const h of [
      [], ["github.com", "example.com"], ["*.github.com"], ["*"], ["raw.githubusercontent.com"], "github.com", undefined,
    ]) {
      assert.equal(validateEgressAttestation({ ...goodEgress, allowedHosts: h }).ok, false);
    }
  });

  it("rejects missing evidence, unverified, and non-object input", () => {
    assert.equal(validateEgressAttestation({ ...goodEgress, evidence: " " }).ok, false);
    assert.equal(validateEgressAttestation({ verified: false, reason: "x" }).ok, false);
    assert.equal(validateEgressAttestation({ ...goodEgress, verified: "true" }).ok, false);
    assert.equal(validateEgressAttestation(null).ok, false);
    assert.equal(validateEgressAttestation("ok").ok, false);
  });
});

describe("limits", () => {
  it("defaults are internally consistent", () => {
    assert.deepEqual(checkAcquisitionLimits(), { ...DEFAULT_ACQUISITION_LIMITS });
  });

  it("rejects out-of-range, non-finite and inconsistent values", () => {
    assert.throws(() => checkAcquisitionLimits({ depth: 0 }));
    assert.throws(() => checkAcquisitionLimits({ depth: 1000 }));
    assert.throws(() => checkAcquisitionLimits({ stepTimeoutMs: Number.NaN }));
    assert.throws(() => checkAcquisitionLimits({ diskMb: 4096 }));
    assert.throws(() => checkAcquisitionLimits({ maxFiles: 1.5 }));
    assert.throws(() => checkAcquisitionLimits({ memoryMb: 256, diskMb: 256 }));
    assert.throws(() => checkAcquisitionLimits({ maxTotalBytes: 200 * 1024 * 1024 }));
    assert.throws(() => checkAcquisitionLimits({ stepTimeoutMs: 400_000, totalTimeoutMs: 300_000 }));
  });
});

describe("git invocation", () => {
  const cfg = (): string[] => {
    const a = gitHardeningArgs("http://egress-proxy:3128");
    const out: string[] = [];
    for (let i = 0; i < a.length; i += 2) {
      assert.equal(a[i], "-c");
      out.push(String(a[i + 1]));
    }
    return out;
  };

  it("disables hooks, credential helpers, non-https protocols, submodules, LFS and redirects", () => {
    const c = cfg();
    for (const need of [
      "core.hooksPath=/dev/null", "core.symlinks=false", "credential.helper=", "protocol.allow=never",
      "protocol.https.allow=always", "protocol.file.allow=never", "protocol.ext.allow=never",
      "submodule.recurse=false", "fetch.recurseSubmodules=false", "filter.lfs.smudge=", "filter.lfs.process=",
      "filter.lfs.required=false", "http.followRedirects=false", "http.sslVerify=true",
      "http.proxy=http://egress-proxy:3128", "transfer.fsckObjects=true", "core.fsmonitor=false",
    ]) {
      assert.ok(c.includes(need), need);
    }
  });

  it("environment disables prompts, system/global config and non-https protocols", () => {
    for (const need of [
      "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/false", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_ALLOW_PROTOCOL=https", "GIT_LFS_SKIP_SMUDGE=1",
    ]) {
      assert.ok(GIT_ENV.includes(need), need);
    }
    assert.ok(GIT_ENV.every((e) => /^[A-Z_]+=[\x20-\x7e]*$/.test(e)));
  });

  it("fetch is shallow, tagless, submodule-free and separates options from the URL and SHA", () => {
    const a = gitSteps.fetch("https://github.com/o/r", SHA, 1);
    assert.deepEqual(a, [
      "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", "https://github.com/o/r", SHA,
    ]);
    assert.equal(gitSteps.init()[2], "--template=");
    assert.ok(gitSteps.checkout(SHA).includes("--no-recurse-submodules"));
    assert.equal(gitSteps.checkout(SHA).at(-1), "--");
  });
});

describe("path policy", () => {
  it("rejects traversal, absolute, backslash, control, git-dir and over-long paths", () => {
    for (const p of [
      "", "/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "a/", "a\\b", "a\nb", "a\u0000b", "\u007f",
      ".git/config", "sub/.GIT/hooks/x", "GIT~1/x", "a".repeat(256), `${"a/".repeat(600)}b`,
    ]) {
      assert.notEqual(unsafePathReason(p), null, JSON.stringify(p));
    }
  });

  it("accepts ordinary and dotted names", () => {
    for (const p of ["README.md", "src/a/b.ts", ".github/workflows/ci.yml", ".gitignore", "a b/c d.txt", "dir/.hidden"]) {
      assert.equal(unsafePathReason(p), null, p);
    }
  });
});

describe("tree listing", () => {
  it("accepts regular files and counts them", () => {
    const r = checkTreeListing(file("a.txt", "5") + ent("100755", "blob", "7", "bin/run"), L);
    assert.deepEqual(r, { ok: true, value: { files: 2, totalBytes: 12, submodulesSkipped: 0 } });
  });

  it("rejects symbolic links, including ones pointing outside", () => {
    const r = checkTreeListing(file("a.txt") + ent("120000", "blob", "11", "zz-escape"), L);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.reason.includes("zz-escape"));
  });

  it("rejects unsafe paths without echoing them", () => {
    const r = checkTreeListing(file("../../etc/cron.d/x"), L);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.reason.includes("cron"));
    assert.equal(checkTreeListing(file(".git/hooks/pre-commit"), L).ok, false);
  });

  it("rejects case-colliding paths", () => {
    assert.equal(checkTreeListing(file("Readme.md") + file("README.md"), L).ok, false);
  });

  it("skips gitlinks (submodules) and counts them", () => {
    const r = checkTreeListing(file("a.txt") + ent("160000", "commit", "-", "vendor/lib"), L);
    assert.deepEqual(r, { ok: true, value: { files: 1, totalBytes: 10, submodulesSkipped: 1 } });
  });

  it("rejects unknown modes, a gitlink-shaped blob, and a gitlink path that is unsafe", () => {
    assert.equal(checkTreeListing(ent("100664", "blob", "1", "a"), L).ok, false);
    assert.equal(checkTreeListing(ent("160000", "blob", "1", "a"), L).ok, false);
    assert.equal(checkTreeListing(ent("160000", "commit", "-", "../x"), L).ok, false);
  });

  it("enforces file count and total size limits", () => {
    const few = checkAcquisitionLimits({ maxFiles: 2 });
    assert.equal(checkTreeListing(file("a") + file("b") + file("c"), few).ok, false);
    const small = checkAcquisitionLimits({ maxTotalBytes: 1024 });
    assert.equal(checkTreeListing(file("a", "600") + file("b", "600"), small).ok, false);
  });

  it("rejects malformed, empty and file-less listings", () => {
    assert.equal(checkTreeListing("", L).ok, false);
    assert.equal(checkTreeListing("garbage\0", L).ok, false);
    assert.equal(checkTreeListing(`100644 blob nothex 5\ta\0`, L).ok, false);
    assert.equal(checkTreeListing(ent("160000", "commit", "-", "only-submodule"), L).ok, false);
  });
});

describe("sanitize", () => {
  it("makes hostile text single-line printable ASCII and bounded", () => {
    const s = sanitize("ok\r\nINJECT \u001b[31m \u202e", 50);
    assert.ok(/^[\x20-\x7e]*$/.test(s));
    assert.ok(sanitize("x".repeat(1000)).length <= 301);
  });
});
