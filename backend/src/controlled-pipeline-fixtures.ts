/**
 * controlled-pipeline-fixtures.ts — contents of the CONTROLLED, TRUSTED `build.mjs` and `test.mjs`
 * files used by the integrated fixture pipeline (controlled-pipeline.ts) in its opt-in real Docker
 * harness. Plain data: nothing here is executed by the backend process. The files are written to a
 * backend-owned temporary directory (fixture-workspace.ts), validated and copied by the pipeline,
 * and run only inside a disposable container.
 *
 * package.json and package-lock.json are NOT generated here. A passing install needs a registry
 * lockfile with real integrity values and a matching offline cache, which the operator supplies
 * (see manual-controlled-pipeline-check.ts). The generated scripts only expect the dependency
 * `is-number` (7.x, no install scripts, no dependencies of its own) to be installed.
 *
 * Kinds:
 *  - pass:       build imports is-number and writes /work/out/index.mjs; two tests pass.
 *  - fail-build: build throws (exit 1); a test file exists but must not run.
 *  - fail-test:  build succeeds; one test fails.
 *  - no-tests:   build succeeds; no test.mjs (the test stage must be not-run).
 *
 * Unverified: none of this has been run by its author.
 *
 * @module controlled-pipeline-fixtures
 */

export type PipelineFixtureKind = "pass" | "fail-build" | "fail-test" | "no-tests";
export const PIPELINE_FIXTURE_KINDS: readonly PipelineFixtureKind[] = Object.freeze([
  "pass", "fail-build", "fail-test", "no-tests",
]);
export const PIPELINE_BUILD_MARKER = "GRAVEYARD_PIPELINE_BUILD_OK";

const BUILD_OK = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import isNumber from "is-number";',
  "",
  "const out = process.argv[2];",
  'if (typeof out !== "string" || !out.startsWith("/work/")) {',
  '  console.error("usage: build.mjs /work/<dir>");',
  "  process.exit(2);",
  "}",
  'if (isNumber("5") !== true) throw new Error("is-number is not working");',
  "mkdirSync(out, { recursive: true });",
  'writeFileSync(join(out, "index.mjs"), "export const built = true;\\n");',
  `console.log("${PIPELINE_BUILD_MARKER}");`,
  "",
].join("\n");

const BUILD_BROKEN = [
  'import isNumber from "is-number";',
  'if (isNumber("5")) throw new Error("intentional build failure");',
  "",
].join("\n");

function testFile(failing: boolean): string {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { existsSync } from "node:fs";',
    'import isNumber from "is-number";',
    "",
    'test("is-number accepts numbers", () => {',
    "  assert.equal(isNumber(5), true);",
    "});",
    "",
    'test("is-number result matches expectation", () => {',
    `  assert.equal(isNumber("abc"), ${failing ? "true" : "false"});`,
    "});",
    "",
    'test("the build output exists", () => {',
    '  assert.equal(existsSync("/work/out/index.mjs"), true);',
    "});",
    "",
  ].join("\n");
}

/** Relative file name => content. Only `build.mjs` and (except no-tests) `test.mjs`. */
export function pipelineFixtureScripts(kind: PipelineFixtureKind): Record<string, string> {
  const files: Record<string, string> = { "build.mjs": kind === "fail-build" ? BUILD_BROKEN : BUILD_OK };
  if (kind !== "no-tests") files["test.mjs"] = testFile(kind === "fail-test");
  return files;
}
