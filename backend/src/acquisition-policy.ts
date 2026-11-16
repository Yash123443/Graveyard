/**
 * acquisition-policy.ts — pure, side-effect-free policy for acquiring a public
 * GitHub repository at one exact commit. Foundation only.
 *
 * Nothing here starts a process, opens a socket or touches the filesystem. It
 * decides what is allowed and builds argument arrays; git-acquisition.ts uses
 * it. Nothing is wired into the server or worker, and live jobs stay disabled.
 *
 * Policy summary:
 *  - Source: canonical `https://github.com/<owner>/<repo>` from url.ts plus a
 *    full lowercase 40-hex commit SHA. Branches, tags, abbreviated SHAs and
 *    anything starting with "-" are rejected, so the identity is exact.
 *  - Network: an acquisition may only run when an EgressGuard attests a
 *    dedicated network plus an HTTP proxy that limits traffic to github.com.
 *    This module cannot check the proxy. It rejects attestations that name
 *    Docker's default networks, and git-acquisition.ts additionally requires
 *    the Docker network to be `Internal`. Without an attestation: fail closed.
 *  - Git: hooks, prompts, credential helpers, non-HTTPS protocols, submodule
 *    recursion, LFS smudge filters, redirects and real symlink creation are
 *    disabled by configuration; depth, output, time and disk are bounded.
 *  - Tree: the commit's tree is listed and checked BEFORE checkout. Symlinks,
 *    unsafe paths, case-colliding paths and oversized trees are rejected.
 *
 * @module acquisition-policy
 */

import { validateGithubUrl } from "./url.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Only a full lowercase SHA-1 hex id is an acceptable source identity. */
export const GIT_SHA_RE = /^[0-9a-f]{40}$/;

/** The only host the egress proxy may allow. Exact match, no wildcards. */
export const ALLOWED_EGRESS_HOSTS: readonly string[] = Object.freeze(["github.com"]);

export const ACQ_UID_GID = "65532:65532";
export const WORK_DIR = "/work";
export const HOME_DIR = "/tmp";
export const TMP_MB = 16;

/** Docker network names that never count as a controlled egress network. */
const FORBIDDEN_NETWORK_NAMES = new Set(["bridge", "host", "none", "default", "docker_gwbridge", "ingress"]);
const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** http://host:port, nothing else: no credentials, path, query or TLS scheme. */
const PROXY_URL_RE = /^http:\/\/([A-Za-z0-9][A-Za-z0-9.-]{0,252}):([0-9]{1,5})$/;

const MAX_PATH = 1024;
const MAX_COMPONENT = 255;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface AcquisitionLimits {
  /** Fetch depth. Default 1. */
  depth: number;
  memoryMb: number;
  cpus: number;
  pids: number;
  /** Size of the /work tmpfs; this is the disk bound. tmpfs counts toward memory. */
  diskMb: number;
  /** Maximum number of files in the commit's tree. */
  maxFiles: number;
  /** Maximum sum of blob sizes in the commit's tree. */
  maxTotalBytes: number;
  /** Cap for `git ls-tree` output. Truncated output is rejected, never partially trusted. */
  maxTreeListBytes: number;
  /** Per-stream cap for every other git step. */
  maxOutputBytes: number;
  stepTimeoutMs: number;
  /** Wall-clock bound for the whole acquisition after the container is requested. */
  totalTimeoutMs: number;
  controlTimeoutMs: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_ACQUISITION_LIMITS: Readonly<AcquisitionLimits> = Object.freeze({
  depth: 1,
  memoryMb: 512,
  cpus: 1,
  pids: 128,
  diskMb: 256,
  maxFiles: 20_000,
  maxTotalBytes: 100 * MIB,
  maxTreeListBytes: 4 * MIB,
  maxOutputBytes: 64 * 1024,
  stepTimeoutMs: 120_000,
  totalTimeoutMs: 300_000,
  controlTimeoutMs: 15_000,
});

const LIMIT_RANGES: Record<keyof AcquisitionLimits, [number, number]> = {
  depth: [1, 50],
  memoryMb: [128, 2048],
  cpus: [0.1, 2],
  pids: [16, 512],
  diskMb: [16, 1024],
  maxFiles: [1, 200_000],
  maxTotalBytes: [1024, 512 * MIB],
  maxTreeListBytes: [64 * 1024, 32 * MIB],
  maxOutputBytes: [1024, 256 * 1024],
  stepTimeoutMs: [1_000, 600_000],
  totalTimeoutMs: [1_000, 1_800_000],
  controlTimeoutMs: [1_000, 60_000],
};

/** Merges overrides over the defaults and throws on any out-of-range or inconsistent value. */
export function checkAcquisitionLimits(partial?: Partial<AcquisitionLimits>): AcquisitionLimits {
  const l: AcquisitionLimits = { ...DEFAULT_ACQUISITION_LIMITS, ...(partial ?? {}) };
  for (const key of Object.keys(LIMIT_RANGES) as Array<keyof AcquisitionLimits>) {
    const [lo, hi] = LIMIT_RANGES[key];
    const v = l[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
      throw new Error(`limit ${key} must be a number between ${lo} and ${hi}`);
    }
  }
  for (const key of ["depth", "memoryMb", "pids", "diskMb", "maxFiles", "maxTotalBytes", "maxTreeListBytes", "maxOutputBytes"] as const) {
    if (!Number.isInteger(l[key])) throw new Error(`limit ${key} must be an integer`);
  }
  // tmpfs pages are charged to the container's memory.
  if (l.memoryMb < l.diskMb + 64) throw new Error("memoryMb must be at least diskMb + 64");
  // Objects and the checked-out tree both live on /work.
  if (l.maxTotalBytes * 2 > l.diskMb * MIB) throw new Error("maxTotalBytes must be at most half of diskMb");
  if (l.stepTimeoutMs > l.totalTimeoutMs) throw new Error("stepTimeoutMs must not exceed totalTimeoutMs");
  return l;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SourceIdentity {
  /** Canonical https://github.com/owner/repo (no .git). */
  repoUrl: string;
  /** Full lowercase 40-hex commit id. */
  commit: string;
}

/** Validates hostile input. Reasons never echo the submitted values. */
export function validateSource(repoUrl: unknown, commit: unknown): Validated<SourceIdentity> {
  const u = validateGithubUrl(repoUrl);
  if (!u.ok) return { ok: false, reason: u.reason };
  if (typeof commit !== "string" || !GIT_SHA_RE.test(commit)) {
    return { ok: false, reason: "commit must be a full 40-character lowercase hex SHA" };
  }
  return { ok: true, value: { repoUrl: u.url, commit } };
}

/** Validates only the repository URL (unpinned intake). Canonical https://github.com/owner/repo or a reason. */
export function validateRepoOnly(repoUrl: unknown): Validated<string> {
  const u = validateGithubUrl(repoUrl);
  return u.ok ? { ok: true, value: u.url } : { ok: false, reason: u.reason };
}

/**
 * Extracts the immutable commit id from the output of `git rev-parse --verify FETCH_HEAD^{commit}`.
 * The output must be exactly one lowercase 40-hex id with at most one trailing newline; anything
 * else (empty, extra lines, uppercase, SHA-256 ids, prefixes) is rejected rather than repaired.
 */
export function parseResolvedSha(stdout: string): string | null {
  const m = /^([0-9a-f]{40})\n?$/.exec(stdout);
  return m === null ? null : (m[1] as string);
}

// ---------------------------------------------------------------------------
// Egress attestation
// ---------------------------------------------------------------------------

/**
 * What an EgressGuard claims. `verified: true` is a CLAIM made by external
 * infrastructure that this process cannot check: that `network` is a
 * dedicated Docker network whose only reachable endpoint is `proxyUrl`, and
 * that the proxy permits CONNECT to `allowedHosts` (exactly github.com) only,
 * blocking private, link-local, metadata and loopback destinations.
 */
export type EgressAttestation =
  | {
      verified: true;
      network: string;
      proxyUrl: string;
      allowedHosts: readonly string[];
      /** Free text describing how the guard established the claim. */
      evidence: string;
    }
  | { verified: false; reason: string };

export interface EgressGuard {
  attest(signal?: AbortSignal): Promise<EgressAttestation>;
}

/** Production default: no proxy exists, so there is no network. Always fails closed. */
export class UnavailableEgressGuard implements EgressGuard {
  attest(): Promise<EgressAttestation> {
    return Promise.resolve({
      verified: false,
      reason: "no controlled egress proxy is configured; acquisition is disabled",
    });
  }
}

export interface ValidEgress {
  network: string;
  proxyUrl: string;
  evidence: string;
}

/**
 * Structural checks on an attestation. Does not and cannot prove the proxy enforces anything.
 * `allowedHosts` is what the attestation must list, exactly. It defaults to github.com so the git
 * acquisition behaves as before; the npm registry acquisition passes `["registry.npmjs.org"]`.
 */
export function validateEgressAttestation(
  a: unknown,
  expectedHosts: readonly string[] = ALLOWED_EGRESS_HOSTS,
): Validated<ValidEgress> {
  if (typeof a !== "object" || a === null) return { ok: false, reason: "egress attestation missing" };
  const r = a as Record<string, unknown>;
  if (r["verified"] !== true) {
    const raw = r["reason"];
    const why = typeof raw === "string" && raw.trim() !== "" ? raw : "egress not verified";
    return { ok: false, reason: sanitize(why) };
  }
  const network = r["network"];
  if (typeof network !== "string" || !NETWORK_NAME_RE.test(network) || FORBIDDEN_NETWORK_NAMES.has(network.toLowerCase())) {
    return { ok: false, reason: "egress network must be a dedicated user-defined network, not a default Docker network" };
  }
  const proxyUrl = r["proxyUrl"];
  if (typeof proxyUrl !== "string") return { ok: false, reason: "proxyUrl must be http://host:port" };
  const m = PROXY_URL_RE.exec(proxyUrl);
  if (m === null || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    return { ok: false, reason: "proxyUrl must be http://host:port without credentials or path" };
  }
  const hosts = r["allowedHosts"];
  if (
    !Array.isArray(hosts) ||
    hosts.length !== expectedHosts.length ||
    !hosts.every((h, i) => h === expectedHosts[i])
  ) {
    return { ok: false, reason: `egress allowlist must be exactly ${expectedHosts.join(", ")}` };
  }
  const evidence = r["evidence"];
  if (typeof evidence !== "string" || evidence.trim() === "") {
    return { ok: false, reason: "egress attestation carries no evidence" };
  }
  return { ok: true, value: { network, proxyUrl, evidence: sanitize(evidence) } };
}

// ---------------------------------------------------------------------------
// Git invocation
// ---------------------------------------------------------------------------

/** Container environment (`KEY=VALUE`). No host variable is ever forwarded. */
export const GIT_ENV: readonly string[] = Object.freeze([
  `HOME=${HOME_DIR}`,
  "GIT_TERMINAL_PROMPT=0",
  "GIT_ASKPASS=/bin/false",
  "SSH_ASKPASS=/bin/false",
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_ALLOW_PROTOCOL=https",
  "GIT_PROTOCOL_FROM_USER=0",
  "GIT_NO_REPLACE_OBJECTS=1",
  "GIT_LFS_SKIP_SMUDGE=1",
  "LC_ALL=C",
]);

/** `-c key=value` pairs placed before every git subcommand. */
export function gitHardeningArgs(proxyUrl: string): string[] {
  const cfg = [
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.symlinks=false",
    "core.protectNTFS=true",
    "core.protectHFS=true",
    "core.attributesFile=/dev/null",
    "core.excludesFile=/dev/null",
    "credential.helper=",
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.file.allow=never",
    "protocol.ext.allow=never",
    "protocol.git.allow=never",
    "protocol.ssh.allow=never",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "filter.lfs.smudge=",
    "filter.lfs.process=",
    "filter.lfs.required=false",
    `http.proxy=${proxyUrl}`,
    "http.followRedirects=false",
    "http.sslVerify=true",
    "transfer.fsckObjects=true",
    "gc.auto=0",
    "advice.detachedHead=false",
  ];
  const out: string[] = [];
  for (const c of cfg) out.push("-c", c);
  return out;
}

/** Git subcommand argument arrays (after the hardening arguments). Inputs must be validated first. */
export const gitSteps = {
  init: (): string[] => ["init", "--quiet", "--template="],
  fetch: (repoUrl: string, commit: string, depth: number): string[] => [
    "fetch", "--quiet", `--depth=${depth}`, "--no-tags", "--no-recurse-submodules", "--", repoUrl, commit,
  ],
  /**
   * Unpinned intake: shallow-fetches the remote's literal `HEAD` (never a caller-supplied ref).
   * The result is only FETCH_HEAD; the immutable id comes from `resolveFetchHead`.
   */
  fetchHead: (repoUrl: string, depth: number): string[] => [
    "fetch", "--quiet", `--depth=${depth}`, "--no-tags", "--no-recurse-submodules", "--", repoUrl, "HEAD",
  ],
  resolveFetchHead: (): string[] => ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
  verifyCommit: (commit: string): string[] => ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
  listTree: (commit: string): string[] => ["ls-tree", "-r", "-l", "-z", "--full-tree", commit],
  checkout: (commit: string): string[] => [
    "checkout", "--quiet", "--detach", "--force", "--no-recurse-submodules", commit, "--",
  ],
  head: (): string[] => ["rev-parse", "HEAD"],
};

// ---------------------------------------------------------------------------
// Tree policy
// ---------------------------------------------------------------------------

export interface TreeManifest {
  files: number;
  totalBytes: number;
  /** Gitlink entries (mode 160000). They are not fetched and not checked out as content. */
  submodulesSkipped: number;
}

const TREE_LINE_RE = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}) +(-|[0-9]{1,15})\t([\s\S]+)$/;

/** Returns a reason, or null if the repository-relative path is acceptable. */
export function unsafePathReason(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH) return "path length out of range";
  if (path.startsWith("/")) return "absolute path";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "control character or backslash in path";
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return "empty or dot path component";
    if (part.length > MAX_COMPONENT) return "path component too long";
    const lower = part.toLowerCase();
    if (lower === ".git" || lower === "git~1") return "path component names a git directory";
  }
  return null;
}

/**
 * Checks `git ls-tree -r -l -z` output against policy. Rejects (never repairs)
 * symlinks, unknown modes, unsafe or case-colliding paths and oversized trees.
 * Reasons never echo repository-controlled names.
 */
export function checkTreeListing(stdout: string, limits: AcquisitionLimits): Validated<TreeManifest> {
  const records = stdout.split("\0");
  if (records[records.length - 1] === "") records.pop();
  const seen = new Set<string>();
  let files = 0;
  let totalBytes = 0;
  let submodulesSkipped = 0;

  for (const rec of records) {
    const m = TREE_LINE_RE.exec(rec);
    if (m === null) return { ok: false, reason: "malformed tree listing" };
    const mode = m[1] as string;
    const type = m[2] as string;
    const size = m[4] as string;
    const path = m[5] as string;

    const bad = unsafePathReason(path);
    if (bad !== null) return { ok: false, reason: `unsafe path in tree: ${bad}` };
    const key = path.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: "tree contains paths that differ only by case" };
    seen.add(key);

    if (mode === "120000") return { ok: false, reason: "tree contains a symbolic link" };
    if (mode === "160000" && type === "commit") {
      submodulesSkipped += 1;
      continue;
    }
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || size === "-") {
      return { ok: false, reason: "tree contains an unsupported entry type" };
    }
    files += 1;
    totalBytes += Number(size);
    if (files > limits.maxFiles) return { ok: false, reason: "tree has too many files" };
    if (totalBytes > limits.maxTotalBytes) return { ok: false, reason: "tree is larger than the size limit" };
  }
  if (files === 0) return { ok: false, reason: "tree contains no files" };
  return { ok: true, value: { files, totalBytes, submodulesSkipped } };
}

// ---------------------------------------------------------------------------

/** Makes untrusted text safe for a one-line reason: printable ASCII only, bounded. */
export function sanitize(s: string, max = 300): string {
  const t = s.replace(/[^\x20-\x7e]/g, "?");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
