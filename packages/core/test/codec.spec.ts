import { describe, expect, it } from 'vitest';
import { decodeImportString, encodeImportString } from '../src/codec.js';

describe('encodeImportString / decodeImportString (§9.2)', () => {
  it('round-trips an arbitrary JSON payload', () => {
    const payload = { schema: 1, phase: 'P3', loot: [{ itemId: 19019, character: 'Thrall', at: 1756512345 }] };
    const encoded = encodeImportString(payload);
    expect(encoded.startsWith('GLPS1:')).toBe(true);
    expect(decodeImportString(encoded)).toEqual(payload);
  });

  it('round-trips an empty object', () => {
    const encoded = encodeImportString({});
    expect(decodeImportString(encoded)).toEqual({});
  });

  it('rejects a string without the GLPS1: prefix', () => {
    expect(() => decodeImportString('not-a-glps-string')).toThrow();
  });

  it('produces a URL-safe string (no +, /, or = padding characters)', () => {
    const encoded = encodeImportString({ big: 'x'.repeat(500) });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
