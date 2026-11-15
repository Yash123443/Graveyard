/**
 * operator-fixture-helpers.ts — SYNTHETIC multi-package lockfile v3 fixtures for tests. Not a test
 * file (it defines no tests; `node --test` runs it and finds nothing). Names, versions and tarball
 * bytes are invented. The integrity value of each package is the real SHA-512 of its synthetic
 * tarball bytes, so a cache built from these bytes is internally consistent. No package here exists
 * on the registry and nothing here shows that real npm accepts these files.
 */

import { createHash } from "node:crypto";
import type { ExportedFile } from "../npm-acquire-driver.js";
import {
  contentPathFor,
  indexPathFor,
  tarballKey,
  type ExpectedTarball,
} from "../npm-registry-cache.js";

// Loose JSON documents on purpose: the tests mutate them into invalid shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface OperatorDoc {
  pkg: Json;
  lock: Json;
}

export const tarballBytesFor = (name: string, version: string): Buffer => Buffer.from(`synthetic tarball ${name}@${version}\n`);
export const integrityOf = (bytes: Uint8Array | string): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function lockEntry(name: string, version: string, extra: Json = {}): Json {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: integrityOf(tarballBytesFor(name, version)),
    ...extra,
  };
}

/** root -> alpha@1.0.0 -> beta@2.1.0 -> gamma@0.3.4. Three flat, unscoped, production packages. */
export function operatorDoc(): OperatorDoc {
  const name = "op-fixture";
  const version = "1.0.0";
  const deps = { alpha: "^1.0.0" };
  return {
    pkg: { name, version, private: true, dependencies: { ...deps } },
    lock: {
      name,
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name, version, dependencies: { ...deps } },
        "node_modules/alpha": lockEntry("alpha", "1.0.0", { dependencies: { beta: "^2.0.0" } }),
        "node_modules/beta": lockEntry("beta", "2.1.0", { dependencies: { gamma: "^0.3.0" } }),
        "node_modules/gamma": lockEntry("gamma", "0.3.4"),
      },
    },
  };
}

/** The doc's exact texts, as the operator would pass them. */
export function textsOf(d: OperatorDoc): { packageJson: string; packageLock: string } {
  return { packageJson: `${JSON.stringify(d.pkg, null, 2)}\n`, packageLock: `${JSON.stringify(d.lock, null, 2)}\n` };
}

/** Adds `count` extra packages (pkg-1 .. pkg-n) that the root depends on directly. */
export function withExtraRootPackages(d: OperatorDoc, count: number): OperatorDoc {
  for (let i = 1; i <= count; i += 1) {
    const n = `pkg-${i}`;
    d.pkg["dependencies"][n] = "^1.0.0";
    d.lock["packages"][""]["dependencies"][n] = "^1.0.0";
    d.lock["packages"][`node_modules/${n}`] = lockEntry(n, "1.0.0");
  }
  return d;
}

export const EXPECTED_DEFAULT: ExpectedTarball[] = [
  { name: "alpha", version: "1.0.0", integrity: integrityOf(tarballBytesFor("alpha", "1.0.0")) },
  { name: "beta", version: "2.1.0", integrity: integrityOf(tarballBytesFor("beta", "2.1.0")) },
  { name: "gamma", version: "0.3.4", integrity: integrityOf(tarballBytesFor("gamma", "0.3.4")) },
];

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** Exported cache files (content + index per package) as the driver would print them, built from synthetic bytes. */
export function cacheFilesFor(expected: readonly ExpectedTarball[], bytesOf = tarballBytesFor): ExportedFile[] {
  const out: ExportedFile[] = [];
  for (const p of expected) {
    const bytes = bytesOf(p.name, p.version);
    const key = tarballKey(p);
    const json = JSON.stringify({ key, integrity: integrityOf(bytes), time: 1700000000000, size: bytes.length, metadata: { url: "https://registry.npmjs.org/x" } });
    const idx = Buffer.from(`\n${sha1(json)}\t${json}`);
    // The path for the content is derived from the bytes actually exported, not from the expectation.
    const cp = contentPathFor(integrityOf(bytes)) as string;
    out.push({ path: cp, size: bytes.length, data: bytes.toString("base64") });
    out.push({ path: indexPathFor(key), size: idx.length, data: idx.toString("base64") });
  }
  return out;
}
