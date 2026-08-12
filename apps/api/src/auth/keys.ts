/**
 * API key issuance and verification.
 *
 * Key format: `mk_<prefix>_<secret>`
 *
 *   prefix   16 hex chars, stored in the clear and indexed. It is a *lookup
 *            handle*, not a secret: without it, verifying a presented key means
 *            fetching every principal and comparing hashes, which is both a
 *            table scan per request and a growing timing surface.
 *   secret   32 random bytes. Only its SHA-256 is persisted, so a database dump
 *            yields no working credentials.
 *
 * SHA-256 rather than scrypt/bcrypt is deliberate and worth stating, since the
 * usual advice is the opposite. Those are designed to make *low-entropy* human
 * passwords expensive to guess. This secret is 256 bits from a CSPRNG — there is
 * no dictionary and no feasible brute force — while a deliberately slow hash
 * would add its cost to every authenticated request, which for an agent
 * workload is every request.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const KEY_PREFIX_BYTES = 8; // → 16 hex chars
export const KEY_SECRET_BYTES = 32;
const KEY_NAMESPACE = 'mk';

export interface IssuedKey {
  /** Shown to the operator exactly once. */
  key: string;
  prefix: string;
  hash: string;
}

export function issueKey(): IssuedKey {
  const prefix = randomBytes(KEY_PREFIX_BYTES).toString('hex');
  const secret = randomBytes(KEY_SECRET_BYTES).toString('base64url');
  return {
    key: `${KEY_NAMESPACE}_${prefix}_${secret}`,
    prefix,
    hash: hashSecret(secret),
  };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface ParsedKey {
  prefix: string;
  secret: string;
}

/**
 * Split a presented key without throwing on malformed input.
 *
 * Returns null rather than a partial result: a caller that received `null` has
 * no prefix to look up and must deny, which is the correct handling of every
 * malformed key and avoids a branch where half a parse is treated as usable.
 */
export function parseKey(raw: string | undefined | null): ParsedKey | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Split on the FIRST two separators only. The secret is base64url, whose
  // alphabet includes `_`, so a naive `split('_')` produced four or more parts
  // for roughly three keys in four and rejected them as malformed — an
  // intermittent authentication failure that looks like anything but a parser.
  const firstSep = trimmed.indexOf('_');
  if (firstSep === -1) return null;
  const secondSep = trimmed.indexOf('_', firstSep + 1);
  if (secondSep === -1) return null;

  const namespace = trimmed.slice(0, firstSep);
  const prefix = trimmed.slice(firstSep + 1, secondSep);
  const secret = trimmed.slice(secondSep + 1);

  if (namespace !== KEY_NAMESPACE) return null;
  if (prefix.length !== KEY_PREFIX_BYTES * 2 || !/^[0-9a-f]+$/.test(prefix)) return null;
  if (secret.length === 0) return null;

  return { prefix, secret };
}

/**
 * Constant-time comparison of a presented secret against a stored hash.
 *
 * `timingSafeEqual` needs equal-length buffers and throws otherwise; both sides
 * are already fixed-width hex digests, but the length is checked first so a
 * corrupted stored hash denies instead of throwing a 500 that reveals the row
 * exists.
 */
export function verifySecret(presentedSecret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(presentedSecret), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (presented.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(presented, stored);
}
