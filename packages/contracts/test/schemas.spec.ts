import { describe, expect, it } from 'vitest';
import {
  zAddonExport,
  zClaimInviteRequest,
  zEntryInput,
  zErrorBody,
  zImportPayload,
  zPutSubmissionRequest,
} from '../src/index.js';

describe('contracts schemas', () => {
  it('accepts a valid invite claim payload', () => {
    const result = zClaimInviteRequest.safeParse({
      displayName: 'Thrall',
      characters: [{ name: 'Thrall', class: 'SHAMAN', mainSpec: 'ENHANCEMENT', offSpec: 'RESTORATION', isMainCharacter: true, slotIndex: 1 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a claim with three characters', () => {
    const chars = Array.from({ length: 3 }, (_, i) => ({
      name: `Char${i}`,
      class: 'WARRIOR',
      mainSpec: 'FURY',
      isMainCharacter: i === 0,
      slotIndex: (i === 0 ? 1 : 2) as 1 | 2,
    }));
    const result = zClaimInviteRequest.safeParse({ displayName: 'X', characters: chars });
    expect(result.success).toBe(false);
  });

  it('validates a submission entry', () => {
    const result = zEntryInput.safeParse({
      characterId: '11111111-1111-1111-1111-111111111111',
      list: 'MAIN',
      rank: 1,
      slot: 'NECK',
      itemId: 19019,
      spec: 'FURY',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a submission with an invalid slot', () => {
    const result = zPutSubmissionRequest.safeParse({
      entries: [
        {
          characterId: '11111111-1111-1111-1111-111111111111',
          list: 'MAIN',
          rank: 1,
          slot: 'JETPACK',
          itemId: 1,
          spec: 'FURY',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('validates the error body contract', () => {
    const result = zErrorBody.safeParse({ error: { code: 'SUBMISSION_LOCKED', message: 'locked' } });
    expect(result.success).toBe(true);
  });

  it('validates a minimal addon import payload', () => {
    const result = zImportPayload.safeParse({
      schema: 1,
      phase: 'P3',
      loot: [{ itemId: 19019, character: 'Thrall', at: 1756512345, awardType: 'PRIORITY' }],
    });
    expect(result.success).toBe(true);
  });

  it('validates the addon export tree shape', () => {
    const result = zAddonExport.safeParse({
      schema: 1,
      guild: 'nightfall',
      guildId: '11111111-1111-1111-1111-111111111111',
      phase: 'P3',
      generatedAt: 1756512000,
      checksum: 'sha256:ab12',
      players: {
        Thrall: { class: 'SHAMAN', mainSpec: 'ENHANCEMENT', offSpec: 'RESTORATION', isMain: true, player: 'thrall#1234', alts: ['Thrallalt'] },
      },
      items: {
        '19019': [{ c: 'Thrall', t: 'MAIN', r: 1, s: 'MAIN_HAND', p: 'thrall#1234' }],
      },
      awarded: [],
      bisCounts: { 'thrall#1234': 2 },
      config: { equalDistribution: 'PHASE', bisCountScope: 'PLAYER', weightOff: 0 },
    });
    expect(result.success).toBe(true);
  });
});
