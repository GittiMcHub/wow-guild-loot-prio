import { describe, expect, it } from 'vitest';
import { zGameVersion } from '../src/common.js';

describe('zGameVersion', () => {
  it('accepts tbc', () => {
    expect(zGameVersion.parse('tbc')).toBe('tbc');
  });
});
