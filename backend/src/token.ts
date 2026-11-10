/**
 * token.ts — cryptographic token utilities for GRAVEYARD job capability tokens.
 *
 * Design:
 *   - A raw capability token is 32 cryptographically random bytes (256 bits),
 *     encoded as a 64-character lowercase hex string.  It is returned to the
 *     caller exactly once in the POST /api/jobs response and is NEVER stored,
 *     logged, or returned again.
 *   - Only the SHA-256 hash of the raw token is persisted (as a 64-char hex
 *     string in the `token_hash` column).
 *   - Authentication checks re-hash the submitted token and compare the result
 *     to the stored hash using `timingSafeEqual` to prevent timing attacks.
 *
 * All functions use only Node.js built-in `node:crypto`; no third-party
 * dependencies are required.
 *
 * @module token
 */

import { randomBytes, createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

/**
 * Generates a cryptographically random 32-byte token and returns it as a
 * 64-character lowercase hex string.
 *
 * This value must be returned to the caller exactly once and never stored.
 */
export function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Returns the SHA-256 hex digest of `rawToken`.
 *
 * Store this value; never store `rawToken` itself.
 */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Compares `submittedToken` (from the Authorization header) to the stored hash
 * using a constant-time comparison to prevent timing side-channels.
 *
 * Both sides are SHA-256 hashed before comparison so the comparison is always
 * 32 bytes regardless of the token length, satisfying the `timingSafeEqual`
 * requirement that both buffers have the same byte length.
 *
 * @param submittedToken  The raw hex token sent by the client.
 * @param storedHash      The SHA-256 hex digest stored in the database.
 * @returns               `true` if the token matches; `false` otherwise.
 */
export function verifyToken(submittedToken: string, storedHash: string): boolean {
  // Hash the submission so the buffers are always exactly 32 bytes.
  const submittedHash = Buffer.from(hashToken(submittedToken), "hex");
  const expectedHash = Buffer.from(storedHash, "hex");

  // Lengths must match for timingSafeEqual; both are SHA-256 digests (32 bytes).
  if (submittedHash.length !== expectedHash.length) {
    return false;
  }

  return nodeTimingSafeEqual(submittedHash, expectedHash);
}
