import { describe, expect, it } from 'vitest';
import { explainDecision } from '../src/explain.js';
import { resolveDrop } from '../src/resolver.js';
import type { AwardRecord, ClaimInput, ResolveOptions, RollRecord } from '../src/types.js';

const ITEM = 19019;

function mkClaim(overrides: Partial<ClaimInput> & Pick<ClaimInput, 'entryId' | 'playerId' | 'characterId' | 'characterName' | 'list' | 'rank'>): ClaimInput {
  return { isMainCharacter: true, spec: 'FURY', slot: 'MAIN_HAND', itemId: ITEM, ...overrides };
}

const noBis: ResolveOptions = { equalDistributionMode: 'OFF', bisCountScope: 'PLAYER', bisCounts: {} };
const explainOpts = (o: Partial<ResolveOptions> = {}) => ({
  equalDistributionMode: o.equalDistributionMode ?? ('OFF' as const),
  bisCountScope: o.bisCountScope ?? ('PLAYER' as const),
  weightOff: 0,
});

describe('explainDecision (§3.2)', () => {
  it('SOLE_CLAIM', () => {
    const claims = [mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 2 })];
    const result = resolveDrop(ITEM, claims, new Set(['thrall']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'p1', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.winCondition).toBe('SOLE_CLAIM');
    expect(explanation.summary).toBe('Thrall — MAIN #2. Only listed claim.');
  });

  it('HIGHER_PRIORITY', () => {
    const claims = [
      mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 2 }),
      mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'grom', characterName: 'Grommash', list: 'MAIN', rank: 6 }),
    ];
    const result = resolveDrop(ITEM, claims, new Set(['thrall', 'grom']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'p1', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.winCondition).toBe('HIGHER_PRIORITY');
    expect(explanation.summary).toBe('Thrall — MAIN #2. Beats Grommash (MAIN #6).');
  });

  it('MAIN_OVER_OFF', () => {
    const claims = [
      mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 5 }),
      mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'cairne', characterName: 'Cairne', list: 'OFF', rank: 1 }),
    ];
    const result = resolveDrop(ITEM, claims, new Set(['thrall', 'cairne']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'p1', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.winCondition).toBe('MAIN_OVER_OFF');
    expect(explanation.summary).toBe('Thrall — MAIN #5. Beats Cairne (OFF #1): main list wins over off list.');
  });

  it('LOWER_BIS_COUNT — outright win with sat-out contenders named', () => {
    const claims = [
      mkClaim({ entryId: 'e1', playerId: 'thrall-p', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 2 }),
      mkClaim({ entryId: 'e2', playerId: 'grom-p', characterId: 'grom', characterName: 'Grommash', list: 'MAIN', rank: 2 }),
      mkClaim({ entryId: 'e3', playerId: 'cairne-p', characterId: 'cairne', characterName: 'Cairne', list: 'MAIN', rank: 2 }),
    ];
    const options: ResolveOptions = {
      equalDistributionMode: 'PHASE',
      bisCountScope: 'PLAYER',
      bisCounts: { 'thrall-p': 0, 'grom-p': 2, 'cairne-p': 1 },
    };
    const result = resolveDrop(ITEM, claims, new Set(['thrall', 'grom', 'cairne']), options);
    expect(result.needsRoll).toBe(false);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'thrall-p', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts({ equalDistributionMode: 'PHASE' }));
    expect(explanation.winCondition).toBe('LOWER_BIS_COUNT');
    expect(explanation.summary).toContain('Thrall — MAIN #2, 0 items so far.');
    expect(explanation.summary).toContain('Grommash (2 items)');
    expect(explanation.summary).toContain('Cairne (1 item)');
    expect(explanation.summary).toContain('sat out on loot spread.');
    const grom = explanation.contenders.find((c) => c.character === 'Grommash');
    expect(grom?.outcome).toBe('SAT_OUT_BIS_COUNT');
  });

  it('ROLL — a tie resolved by dice, with a BiS-excluded contender also named', () => {
    const claims = [
      mkClaim({ entryId: 'e1', playerId: 'thrall-p', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 2 }),
      mkClaim({ entryId: 'e2', playerId: 'cairne-p', characterId: 'cairne', characterName: 'Cairne', list: 'MAIN', rank: 2 }),
      mkClaim({ entryId: 'e3', playerId: 'grom-p', characterId: 'grom', characterName: 'Grommash', list: 'MAIN', rank: 2 }),
    ];
    const options: ResolveOptions = {
      equalDistributionMode: 'PHASE',
      bisCountScope: 'PLAYER',
      bisCounts: { 'thrall-p': 0, 'cairne-p': 0, 'grom-p': 2 },
    };
    const result = resolveDrop(ITEM, claims, new Set(['thrall', 'cairne', 'grom']), options);
    expect(result.needsRoll).toBe(true);
    expect(result.winnerGroup.map((c) => c.characterId).sort()).toEqual(['cairne', 'thrall']);

    const rolls: RollRecord[] = [
      { characterId: 'thrall', characterName: 'Thrall', value: 87 },
      { characterId: 'cairne', characterName: 'Cairne', value: 43 },
    ];
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'thrall-p', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, rolls, explainOpts({ equalDistributionMode: 'PHASE' }));
    expect(explanation.winCondition).toBe('ROLL');
    expect(explanation.summary).toContain('Thrall — MAIN #2, rolled 87.');
    expect(explanation.summary).toContain('Beat Cairne (MAIN #2, rolled 43).');
    expect(explanation.summary).toContain('Grommash sat out on loot spread');
    const cairne = explanation.contenders.find((c) => c.character === 'Cairne');
    expect(cairne?.outcome).toBe('LOST_ROLL');
    expect(cairne?.roll).toBe(43);
  });

  it('ADMIN_OVERRIDE names the priority result it overruled', () => {
    const claims = [mkClaim({ entryId: 'e1', playerId: 'cairne-p', characterId: 'cairne', characterName: 'Cairne', list: 'MAIN', rank: 1 })];
    const result = resolveDrop(ITEM, claims, new Set(['cairne']), noBis);
    const award: AwardRecord = {
      itemId: ITEM,
      characterId: 'thrall',
      characterName: 'Thrall',
      playerName: 'thrall-p',
      awardType: 'OVERRIDE',
      overrideReason: 'guild bank duplicate',
      decidedAt: 'now',
    };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.winCondition).toBe('ADMIN_OVERRIDE');
    expect(explanation.summary).toBe(
      'Thrall — awarded by loot master. Reason: guild bank duplicate. Priority result was Cairne (MAIN #1).',
    );
  });

  it('FREE_ROLL when nobody had it listed', () => {
    const result = resolveDrop(ITEM, [], new Set(['thrall']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'thrall-p', awardType: 'FREE_ROLL', decidedAt: 'now' };
    const rolls: RollRecord[] = [{ characterId: 'thrall', characterName: 'Thrall', value: 87 }];
    const explanation = explainDecision(result, award, rolls, explainOpts());
    expect(explanation.winCondition).toBe('FREE_ROLL');
    expect(explanation.summary).toBe('Thrall — open roll, 87. Nobody had this on a priority list.');
  });

  it('DISENCHANT and BANK produce no-claim summaries', () => {
    const result = resolveDrop(ITEM, [], new Set(['thrall']), noBis);
    const de = explainDecision(result, { itemId: ITEM, awardType: 'DISENCHANT', decidedAt: 'now' }, [], explainOpts());
    expect(de.winCondition).toBe('DISENCHANT');
    expect(de.winner).toBeNull();
    const bank = explainDecision(result, { itemId: ITEM, awardType: 'BANK', decidedAt: 'now' }, [], explainOpts());
    expect(bank.winCondition).toBe('BANK');
  });

  it('NOT_PRESENT and already-FULFILLED claims still appear in contenders, correctly labeled', () => {
    const claims = [
      mkClaim({ entryId: 'e1', playerId: 'thrall-p', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 2 }),
      mkClaim({ entryId: 'e2', playerId: 'absent-p', characterId: 'absent', characterName: 'Absentee', list: 'MAIN', rank: 6 }),
      mkClaim({ entryId: 'e3', playerId: 'done-p', characterId: 'done', characterName: 'AlreadyGot', list: 'MAIN', rank: 7, fulfilled: true }),
    ];
    // absent-char is deliberately left out of the present set.
    const result = resolveDrop(ITEM, claims, new Set(['thrall', 'done']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'thrall-p', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    const absentee = explanation.contenders.find((c) => c.character === 'Absentee');
    const gotIt = explanation.contenders.find((c) => c.character === 'AlreadyGot');
    expect(absentee?.outcome).toBe('NOT_PRESENT');
    expect(gotIt?.outcome).toBe('ALREADY_FULFILLED');
  });

  it('FREE_ROLL with no characterId/characterName/playerName falls back gracefully', () => {
    const result = resolveDrop(ITEM, [], new Set(['thrall']), noBis);
    const award: AwardRecord = { itemId: ITEM, awardType: 'FREE_ROLL', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.summary).toBe('Unknown — open roll. Nobody had this on a priority list.');
    expect(explanation.winner?.player).toBe('');
  });

  it('OVERRIDE naming the same character the resolver already had winning, with no reason given', () => {
    const claims = [mkClaim({ entryId: 'e1', playerId: 'thrall-p', characterId: 'thrall', characterName: 'Thrall', list: 'MAIN', rank: 1 })];
    const result = resolveDrop(ITEM, claims, new Set(['thrall']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', awardType: 'OVERRIDE', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.winCondition).toBe('ADMIN_OVERRIDE');
    expect(explanation.winner).toEqual({ character: 'Thrall', player: '', list: 'MAIN', rank: 1, bisCount: 0 });
    expect(explanation.summary).toBe('Thrall — awarded by loot master. Reason: unspecified. Priority result was Thrall (MAIN #1).');
  });

  it('OVERRIDE to a character with no claim at all and no characterName falls back to "Unknown"', () => {
    const claims = [mkClaim({ entryId: 'e1', playerId: 'cairne-p', characterId: 'cairne', characterName: 'Cairne', list: 'MAIN', rank: 1 })];
    const result = resolveDrop(ITEM, claims, new Set(['cairne', 'new-recruit']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'new-recruit', awardType: 'OVERRIDE', overrideReason: 'guild bank find', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.winner?.character).toBe('Unknown');
    expect(explanation.summary).toBe('Unknown — awarded by loot master. Reason: guild bank find. Priority result was Cairne (MAIN #1).');
  });

  it('FREE_ROLL without a recorded roll value omits the number', () => {
    const result = resolveDrop(ITEM, [], new Set(['thrall']), noBis);
    const award: AwardRecord = { itemId: ITEM, characterId: 'thrall', characterName: 'Thrall', playerName: 'thrall-p', awardType: 'FREE_ROLL', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.summary).toBe('Thrall — open roll. Nobody had this on a priority list.');
  });

  it('ADMIN_OVERRIDE when no priority claims existed at all', () => {
    const result = resolveDrop(ITEM, [], new Set(['thrall']), noBis);
    const award: AwardRecord = {
      itemId: ITEM,
      characterId: 'thrall',
      characterName: 'Thrall',
      playerName: 'thrall-p',
      awardType: 'OVERRIDE',
      overrideReason: 'nobody wanted it, gave it to a new recruit',
      decidedAt: 'now',
    };
    const explanation = explainDecision(result, award, [], explainOpts());
    expect(explanation.summary).toBe(
      'Thrall — awarded by loot master. Reason: nobody wanted it, gave it to a new recruit. No priority claims existed.',
    );
  });

  it('summary is always <= 240 chars', () => {
    const claims = Array.from({ length: 12 }, (_, i) =>
      mkClaim({
        entryId: `e${i}`,
        playerId: `p${i}`,
        characterId: `c${i}`,
        characterName: `ReallyLongCharacterNameNumber${i}`,
        list: 'MAIN',
        rank: 2,
      }),
    );
    const bisCounts = Object.fromEntries(claims.map((c, i) => [c.playerId, i === 0 ? 0 : i + 1]));
    const options: ResolveOptions = { equalDistributionMode: 'PHASE', bisCountScope: 'PLAYER', bisCounts };
    const present = new Set(claims.map((c) => c.characterId));
    const result = resolveDrop(ITEM, claims, present, options);
    const award: AwardRecord = { itemId: ITEM, characterId: 'c0', characterName: claims[0]!.characterName, playerName: 'p0', awardType: 'PRIORITY', decidedAt: 'now' };
    const explanation = explainDecision(result, award, [], explainOpts({ equalDistributionMode: 'PHASE' }));
    expect(explanation.summary.length).toBeLessThanOrEqual(240);
  });
});
