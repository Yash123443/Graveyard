/**
 * url.ts — strict GitHub repository URL validation for GRAVEYARD.
 *
 * Validation rules (all must pass; rejection on any violation):
 *
 *   1. Input is a string, non-empty, max 1024 characters.
 *   2. Input must start literally with "https://github.com/" — no other
 *      protocol, no port, no credentials embedded in the URL.
 *   3. Path is validated on the RAW input string BEFORE any URL normalisation
 *      to catch percent-encoding tricks and backslash confusion.
 *   4. After stripping an optional trailing ".git" suffix, the path must
 *      consist of exactly two non-empty segments: owner and repo.
 *   5. Owner must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (no dots — GitHub
 *      enforces this for user/org names).  Repo must match
 *      /^[A-Za-z0-9_.-]+$/ (dots are allowed, e.g. user.github.io), but the
 *      segment must not be the exact strings "." or "..".
 *   6. Input must not contain: whitespace, percent signs (%), backslashes (\),
 *      "@" (credentials), "?" (query), "#" (fragment), or a colon after the
 *      scheme colon (would indicate a port or embedded password).
 *   7. The only permitted suffix after owner/repo is ".git" (optional) or
 *      nothing — no extra path segments.
 *
 * Exact dot-segment rejection (".." and ".") is enforced at step 11 on the
 * parsed repo segment.  Path-traversal sequences such as "/../" or "/owner/.."
 * are caught by the segment count check (step 9) or the exact-name check
 * (step 11) without requiring a raw substring scan, allowing normal dotted
 * repository names like "user.github.io" and "my.project".
 *
 * Normalisation: if the valid URL ends with ".git", it is stripped before
 * storage so that `https://github.com/owner/repo.git` and
 * `https://github.com/owner/repo` refer to the same canonical URL.
 *
 * @module url
 */

/** Maximum byte length accepted for a raw URL input string. */
const MAX_URL_LENGTH = 1024;

/**
 * Allowed characters for the owner segment.
 * GitHub owner names are alphanumeric with hyphens; no dots.
 * Must start with alphanumeric to avoid leading-hyphen names.
 */
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Allowed characters for the repository segment.
 * Dots are permitted (e.g. user.github.io, my.project).
 * The exact strings "." and ".." are rejected separately.
 */
const SAFE_REPO = /^[A-Za-z0-9_.-]+$/;

/** Literal prefix that every accepted URL must start with (no port). */
const REQUIRED_PREFIX = "https://github.com/";

/** Characters that are never valid anywhere in the raw input. */
const FORBIDDEN_CHARS = /[%\\@?#\s]/;

/** Colon must appear only as part of "https:" — reject any additional colons. */
const EXTRA_COLON = /https:.*:/;

export type UrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Validates and canonicalises a raw GitHub repository URL.
 *
 * Returns `{ ok: true, url }` on success with the canonical URL
 * (trailing `.git` stripped).
 *
 * Returns `{ ok: false, reason }` on any validation failure.
 * The reason string never echoes the submitted input.
 */
export function validateGithubUrl(raw: unknown): UrlValidationResult {
  // 1. Type guard
  if (typeof raw !== "string") {
    return { ok: false, reason: "repoUrl must be a string" };
  }

  // 2. Length cap
  if (raw.length === 0) {
    return { ok: false, reason: "repoUrl must not be empty" };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `repoUrl exceeds maximum length of ${MAX_URL_LENGTH} characters` };
  }

  // 3. Forbidden characters — checked on the RAW string before any parsing.
  if (FORBIDDEN_CHARS.test(raw)) {
    return { ok: false, reason: "repoUrl contains forbidden characters (whitespace, %, @, ?, #, or backslash)" };
  }

  // 4. No extra colons beyond the scheme colon.
  if (EXTRA_COLON.test(raw)) {
    return { ok: false, reason: "repoUrl must not contain a port number or embedded credentials" };
  }

  // 5. Must begin exactly with the required prefix.
  if (!raw.startsWith(REQUIRED_PREFIX)) {
    return { ok: false, reason: "repoUrl must be a GitHub HTTPS URL (https://github.com/owner/repo)" };
  }

  // 6. Extract path portion after prefix.
  const afterPrefix = raw.slice(REQUIRED_PREFIX.length);

  // Strip a trailing ".git" suffix before segment parsing.
  const withoutGit = afterPrefix.endsWith(".git")
    ? afterPrefix.slice(0, -4)
    : afterPrefix;

  // 7. No trailing slash.
  if (withoutGit.endsWith("/")) {
    return { ok: false, reason: "repoUrl must not have a trailing slash" };
  }

  // 8. Split into exactly two segments.
  const segments = withoutGit.split("/");
  if (segments.length !== 2) {
    return {
      ok: false,
      reason: "repoUrl path must contain exactly two segments (owner/repo); no extra path allowed",
    };
  }

  const [owner, repo] = segments as [string, string];

  // 9. Validate owner — no dots (GitHub organisation/user names don't allow dots).
  if (owner.length === 0 || !SAFE_OWNER.test(owner)) {
    return {
      ok: false,
      reason: "repoUrl owner segment must start with alphanumeric and contain only letters, digits, hyphens, or underscores",
    };
  }

  // 10. Validate repo — dots allowed, but not the exact strings "." or "..".
  //     Traversal sequences like "/../" are caught by the segment count check
  //     (step 8) or this exact-name check, without a raw substring scan.
  if (repo.length === 0 || repo === "." || repo === ".." || !SAFE_REPO.test(repo)) {
    return {
      ok: false,
      reason: "repoUrl repository segment must be non-empty, not a dot segment, and contain only letters, digits, hyphens, underscores, or dots",
    };
  }

  // 11. Canonical URL (always without .git).
  const canonicalUrl = `${REQUIRED_PREFIX}${owner}/${repo}`;
  return { ok: true, url: canonicalUrl };
}
