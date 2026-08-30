import { deflateSync, inflateSync } from 'node:zlib';

const PREFIX = 'GLPS1:';

/** `GLPS1:<base64url(deflate(json))>` — the string pasted into the addon's import box (§9.2). */
export function encodeImportString(payload: unknown): string {
  const deflated = deflateSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return PREFIX + deflated.toString('base64url');
}

export function decodeImportString(input: string): unknown {
  if (!input.startsWith(PREFIX)) {
    throw new Error(`Not a GLPS import string (expected prefix "${PREFIX}").`);
  }
  const deflated = Buffer.from(input.slice(PREFIX.length), 'base64url');
  const json = inflateSync(deflated).toString('utf8');
  return JSON.parse(json);
}
