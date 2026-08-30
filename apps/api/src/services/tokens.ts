import { createHash, randomBytes } from 'node:crypto';

/**
 * Invite and player tokens (§7): 32 random bytes, base64url. Stored hashed
 * (sha256(token + pepper)); the plaintext is returned to the caller exactly
 * once, at creation/claim time, and never logged or persisted.
 */
export function generatePlaintextToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(plaintext: string, pepper: string): string {
  return createHash('sha256').update(plaintext + pepper).digest('hex');
}
