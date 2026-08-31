import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../src/services/phase-settings.js';

const guildDefault = { listSize: 17, twohandConsumesOffhand: true, allowAltOffspecInOffList: true, requireFullList: false };

describe('mergeSettings', () => {
  it('returns the guild default when override is null', () => {
    expect(mergeSettings(guildDefault, null)).toEqual(guildDefault);
  });

  it('applies a partial override on top of the guild default', () => {
    expect(mergeSettings(guildDefault, { listSize: 10 })).toEqual({ ...guildDefault, listSize: 10 });
  });

  it('applies a full override, replacing every field', () => {
    const override = { listSize: 5, twohandConsumesOffhand: false, allowAltOffspecInOffList: false, requireFullList: true };
    expect(mergeSettings(guildDefault, override)).toEqual(override);
  });
});
