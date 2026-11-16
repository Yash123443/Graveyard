/**
 * build-entry.ts — pure naming rules for the ONE file a verified repair may change. No I/O.
 * Written without a shell, compiler or test run (UNVERIFIED; see backend/DEVELOPMENT.md).
 *
 * Two repair classes exist and share these rules:
 *   root-build-mjs-only      legacy catalog and root-build.mjs flow: the target is always `build.mjs`.
 *   npm-scripts-build-entry  opt-in npm-scripts mode: the target is the root file named by a
 *                            `scripts.build` that is exactly `node FILE` or `node ./FILE`.
 *
 * A build entry name is one root-level file name: a letter or digit first, then letters, digits,
 * `_` or `-` (at most 40 characters), then `.mjs`, `.cjs` or `.js`. No directory, no extra dots,
 * no dotfile. Names containing `test` or `spec` (any case) are refused so that a repair can never
 * be a change to a test, and the in-container driver's test-file protection can never be confused
 * with the patched file.
 *
 * @module build-entry
 */

export const LEGACY_PATCH_CLASS = "root-build-mjs-only";
export const NPM_SCRIPTS_PATCH_CLASS = "npm-scripts-build-entry";

export const BUILD_ENTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\.(?:mjs|cjs|js)$/;
const BUILD_SCRIPT_RE = /^node (?:\.\/)?([A-Za-z0-9][A-Za-z0-9_-]{0,39}\.(?:mjs|cjs|js))$/;
const TEST_LIKE_NAME_RE = /test|spec/i;

/** True for a safe, simple, root-level build entry file name that is not test-like. */
export function isBuildEntryName(name: unknown): name is string {
  return typeof name === "string" && BUILD_ENTRY_NAME_RE.test(name) && !TEST_LIKE_NAME_RE.test(name);
}

// The NEW npm-scripts repair class also needs a test command that can show tests actually ran:
// exactly `node --test`, or `node --test FILE` for one root test-like file (`test.mjs`, `app.test.js`
// is refused because of its second dot). No flags, pipelines, `&&`, `echo`, directories or globs.
const REPAIR_TEST_SCRIPT_RE = /^node --test(?: ([A-Za-z0-9][A-Za-z0-9_-]{0,39}\.(?:mjs|cjs|js)))?$/;

/**
 * Accepts a `scripts.test` value of exactly `node --test` (`file: null`) or `node --test FILE` with a
 * safe, simple, root-level, test-like file name. Null for anything else, e.g. `echo ok`, `node build.js`,
 * `node --test --test-reporter=tap` or `node --test a.mjs b.mjs`.
 */
export function parseRepairTestScript(script: unknown): { file: string | null } | null {
  if (typeof script !== "string") return null;
  const m = REPAIR_TEST_SCRIPT_RE.exec(script);
  if (m === null) return null;
  const file = m[1];
  if (file === undefined) return { file: null };
  return TEST_LIKE_NAME_RE.test(file) ? { file } : null;
}

const COUNT_KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;

/**
 * True only for TAP counts that show a real passing run: every count a non-negative integer, at least
 * one test and one pass, no failed or cancelled test, and no count above the total.
 */
export function testCountsAcceptable(c: unknown): boolean {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  for (const k of COUNT_KEYS) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return false;
  }
  const n = (k: (typeof COUNT_KEYS)[number]): number => o[k] as number;
  return (
    n("tests") >= 1 &&
    n("pass") >= 1 &&
    n("fail") === 0 &&
    n("cancelled") === 0 &&
    n("pass") <= n("tests") &&
    n("skipped") <= n("tests") &&
    n("todo") <= n("tests")
  );
}

/**
 * The build entry named by a `scripts.build` value of exactly `node FILE` or `node ./FILE` (one
 * space, nothing else), or null for any other script.
 */
export function parseBuildEntryScript(script: unknown): string | null {
  if (typeof script !== "string") return null;
  const m = BUILD_SCRIPT_RE.exec(script);
  const name = m?.[1];
  return name !== undefined && isBuildEntryName(name) ? name : null;
}
