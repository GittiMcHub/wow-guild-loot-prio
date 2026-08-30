import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('package barrel (index.ts)', () => {
  it('re-exports the public API', () => {
    expect(typeof core.resolveDrop).toBe('function');
    expect(typeof core.computeCapacity).toBe('function');
    expect(typeof core.validateSubmission).toBe('function');
    expect(typeof core.explainDecision).toBe('function');
    expect(typeof core.encodeImportString).toBe('function');
    expect(typeof core.decodeImportString).toBe('function');
  });

  it('exposes the 17 canonical slots (§2.2)', () => {
    expect(core.SLOTS).toHaveLength(17);
    expect(new Set(core.SLOTS).size).toBe(17);
    expect(core.SLOTS).toContain('MAIN_HAND');
    expect(core.SLOTS).toContain('RANGED');
  });
});
