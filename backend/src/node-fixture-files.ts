/**
 * node-fixture-files.ts — contents of the CONTROLLED Node fixtures used by the opt-in real Docker
 * harness. Plain data: nothing here is executed by the backend. The files are written to a
 * backend-owned temporary directory (see fixture-workspace.ts) and mounted read-only into a
 * disposable container.
 *
 * Every fixture uses only node built-ins: no package.json dependencies, no scripts, no install,
 * no network. Build output goes to the caller-supplied /tmp directory; the tests rebuild into
 * /tmp themselves because each container starts with an empty /tmp.
 *
 * Kinds:
 *  - pass:       build succeeds, two tests pass.
 *  - fail-test:  build succeeds, one test fails.
 *  - fail-build: the build throws (exit 1); tests exist but must not run.
 *  - no-tests:   build succeeds, there are no tests (the test stage must be not-run).
 *
 * Unverified: none of this has been run by its author.
 *
 * @module node-fixture-files
 */

import { BUILD_MARKER } from "./node-fixture-runner.js";

export type FixtureKind = "pass" | "fail-test" | "fail-build" | "no-tests";
export const FIXTURE_KINDS: readonly FixtureKind[] = Object.freeze(["pass", "fail-test", "fail-build", "no-tests"]);

const PACKAGE_JSON = '{\n  "name": "graveyard-fixture",\n  "version": "0.0.0",\n  "private": true,\n  "type": "module"\n}\n';

const SOURCE = [
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "export function greet(name) {",
  '  return "hello " + name;',
  "}",
  "",
].join("\n");

const BUILD_CLI = [
  'import { build } from "./lib/build.mjs";',
  "",
  "const outDir = process.argv[2];",
  'if (typeof outDir !== "string" || !outDir.startsWith("/tmp/")) {',
  '  console.error("usage: build.mjs /tmp/<dir>");',
  "  process.exit(2);",
  "}",
  "const result = build(outDir);",
  `console.log("${BUILD_MARKER} files=" + result.files + " bytes=" + result.bytes);`,
  "",
].join("\n");

const BUILD_OK = [
  'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "export function build(outDir) {",
  '  const source = readFileSync(fileURLToPath(new URL("../src/index.mjs", import.meta.url)), "utf8");',
  "  mkdirSync(outDir, { recursive: true });",
  '  const output = "// built by the graveyard fixture build\\n" + source;',
  '  writeFileSync(join(outDir, "index.mjs"), output);',
  "  return { files: 1, bytes: Buffer.byteLength(output) };",
  "}",
  "",
].join("\n");

const BUILD_BROKEN = [
  "export function build() {",
  '  throw new Error("intentional build failure");',
  "}",
  "",
].join("\n");

function testFile(failing: boolean): string {
  return [
    'import { before, test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'import { build } from "../lib/build.mjs";',
    "",
    'const OUT = "/tmp/graveyard-test-out";',
    "let built;",
    "",
    "before(async () => {",
    "  build(OUT);",
    '  built = await import(pathToFileURL(join(OUT, "index.mjs")).href);',
    "});",
    "",
    'test("add sums two numbers", () => {',
    `  assert.equal(built.add(2, 2), ${failing ? "5" : "4"});`,
    "});",
    "",
    'test("greet builds a greeting", () => {',
    '  assert.equal(built.greet("graveyard"), "hello graveyard");',
    "});",
    "",
  ].join("\n");
}

/** Relative path => file content. Paths use "/" and only [A-Za-z0-9._-] segments. */
export function fixtureFiles(kind: FixtureKind): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": PACKAGE_JSON,
    "build.mjs": BUILD_CLI,
    "lib/build.mjs": kind === "fail-build" ? BUILD_BROKEN : BUILD_OK,
    "src/index.mjs": SOURCE,
  };
  if (kind !== "no-tests") files["test/index.test.mjs"] = testFile(kind === "fail-test");
  return files;
}
