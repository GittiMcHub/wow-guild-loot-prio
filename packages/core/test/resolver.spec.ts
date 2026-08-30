import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveDrop } from '../src/resolver.js';
import type { ClaimInput, ResolveOptions } from '../src/types.js';

const ITEM = 19019;

function mkClaim(overrides: Partial<ClaimInput> & Pick<ClaimInput, 'entryId' | 'playerId' | 'characterId' | 'characterName' | 'list' | 'rank'>): ClaimInput {
  return {
    isMainCharacter: true,
    spec: 'SOME_SPEC',
    slot: 'MAIN_HAND',
    itemId: ITEM,
    ...overrides,
  };
}

const noBis: ResolveOptions = { equalDistributionMode: 'OFF', bisCountScope: 'PLAYER', bisCounts: {} };
function phaseOptions(bisCounts: Record<string, number>): ResolveOptions {
  return { equalDistributionMode: 'PHASE', bisCountScope: 'PLAYER', bisCounts };
}

const ALL_PRESENT = (ids: string[]) => new Set(ids);

describe('resolveDrop — required test matrix (§3)', () => {
  it('1. Single MAIN claim → outright winner, no roll', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 1 });
    const result = resolveDrop(ITEM, [a], ALL_PRESENT(['c1']), noBis);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup).toHaveLength(1);
    expect(result.winnerGroup[0]!.characterId).toBe('c1');
  });

  it('2. MAIN r1 vs MAIN r2 → r1 wins, no roll', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 1 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'MAIN', rank: 2 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup.map((c) => c.characterId)).toEqual(['c1']);
  });

  it('3. MAIN r2 vs MAIN r2 → roll between both', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 2 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'MAIN', rank: 2 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.needsRoll).toBe(true);
    expect(result.winnerGroup.map((c) => c.characterId).sort()).toEqual(['c1', 'c2']);
  });

  it('4. MAIN r17 vs OFF r1 → MAIN wins, no roll', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 17 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'OFF', rank: 1 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup[0]!.characterId).toBe('c1');
  });

  it('5. OFF r1 vs OFF r1 → roll', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'OFF', rank: 1 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'OFF', rank: 1 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.needsRoll).toBe(true);
  });

  it('6. No claims at all → empty result, warning NO_CLAIMS', () => {
    const result = resolveDrop(ITEM, [], ALL_PRESENT(['c1']), noBis);
    expect(result.winnerGroup).toHaveLength(0);
    expect(result.needsRoll).toBe(false);
    expect(result.warnings).toContain('NO_CLAIMS');
  });

  it('7. Same player, MAIN r5 on Char A + OFF r1 on Char B → one claim only (MAIN r5)', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 5 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p1', characterId: 'cB', characterName: 'B', list: 'OFF', rank: 1 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['cA', 'cB']), noBis);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup).toHaveLength(1);
    expect(result.winnerGroup[0]!.list).toBe('MAIN');
    expect(result.winnerGroup[0]!.rank).toBe(5);
    const weaker = result.ranked.find((c) => c.entryId === 'e2');
    expect(weaker?.excludedReason).toBe('WEAKER_CLAIM_SAME_PLAYER');
  });

  it('8. Same player has MAIN r3 and MAIN r9 for same item on two chars → one claim only (r3)', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 3 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p1', characterId: 'cB', characterName: 'B', list: 'MAIN', rank: 9 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['cA', 'cB']), noBis);
    expect(result.winnerGroup).toHaveLength(1);
    expect(result.winnerGroup[0]!.rank).toBe(3);
  });

  it('9. Claimant not in presentCharacterIds → excluded', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 1 });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'MAIN', rank: 2 });
    // Only c1 is present; the roster is non-empty so absence is meaningful (not the empty-roster convention).
    const result = resolveDrop(ITEM, [a, b], new Set(['c1']), noBis);
    expect(result.winnerGroup.map((c) => c.characterId)).toEqual(['c1']);
    const excluded = result.ranked.find((c) => c.entryId === 'e2');
    expect(excluded?.excludedReason).toBe('NOT_PRESENT');
  });

  it('10. Winning entry already fulfilled → excluded; next claim promoted', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 1, fulfilled: true });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'MAIN', rank: 2 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.winnerGroup.map((c) => c.characterId)).toEqual(['c2']);
    const excluded = result.ranked.find((c) => c.entryId === 'e1');
    expect(excluded?.excludedReason).toBe('FULFILLED');
  });

  it('11. Worked example from §2.4 matches documented outcomes exactly', () => {
    const item1 = 1;
    const item2 = 2;
    const item3 = 3;
    const claims: ClaimInput[] = [
      mkClaim({ entryId: 'a-1', playerId: 'A', characterId: 'A-char', characterName: 'A', list: 'MAIN', rank: 1, itemId: item1 }),
      mkClaim({ entryId: 'a-2', playerId: 'A', characterId: 'A-char', characterName: 'A', list: 'MAIN', rank: 2, itemId: item2 }),
      mkClaim({ entryId: 'b-1', playerId: 'B', characterId: 'B-char', characterName: 'B', list: 'MAIN', rank: 1, itemId: item3 }),
      mkClaim({ entryId: 'b-2', playerId: 'B', characterId: 'B-char', characterName: 'B', list: 'MAIN', rank: 2, itemId: item2 }),
      mkClaim({ entryId: 'c-1', playerId: 'C', characterId: 'C-char', characterName: 'C', list: 'OFF', rank: 1, itemId: item1 }),
    ];
    const present = ALL_PRESENT(['A-char', 'B-char', 'C-char']);

    const r1 = resolveDrop(item1, claims, present, noBis);
    expect(r1.needsRoll).toBe(false);
    expect(r1.winnerGroup.map((c) => c.characterId)).toEqual(['A-char']);

    const r2 = resolveDrop(item2, claims, present, noBis);
    expect(r2.needsRoll).toBe(true);
    expect(r2.winnerGroup.map((c) => c.characterId).sort()).toEqual(['A-char', 'B-char']);

    const r3 = resolveDrop(item3, claims, present, noBis);
    expect(r3.needsRoll).toBe(false);
    expect(r3.winnerGroup.map((c) => c.characterId)).toEqual(['B-char']);

    // "If Player C has Item1 @ OFF rank 1, C only wins Item1 when no MAIN claim exists for it."
    const withoutA = claims.filter((c) => c.characterId !== 'A-char');
    const r1NoMain = resolveDrop(item1, withoutA, present, noBis);
    expect(r1NoMain.winnerGroup.map((c) => c.characterId)).toEqual(['C-char']);
  });

  it('12. 3-way tie → winnerGroup size 3', () => {
    const claims = ['c1', 'c2', 'c3'].map((c, i) =>
      mkClaim({ entryId: `e${i}`, playerId: `p${i}`, characterId: c, characterName: c, list: 'MAIN', rank: 2 }),
    );
    const result = resolveDrop(ITEM, claims, ALL_PRESENT(['c1', 'c2', 'c3']), noBis);
    expect(result.winnerGroup).toHaveLength(3);
    expect(result.needsRoll).toBe(true);
  });

  it('13. MAIN r5 (alt character) vs OFF r1 (main character) → MAIN r5 wins outright, no roll', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 5, isMainCharacter: false });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'OFF', rank: 1, isMainCharacter: true });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup[0]!.characterId).toBe('c1');
  });

  it('14. Same tier + same rank, one on a main char and one on an alt → roll (main/alt never breaks a tie)', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 3, isMainCharacter: true });
    const b = mkClaim({ entryId: 'e2', playerId: 'p2', characterId: 'c2', characterName: 'B', list: 'MAIN', rank: 3, isMainCharacter: false });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['c1', 'c2']), noBis);
    expect(result.needsRoll).toBe(true);
    expect(result.winnerGroup).toHaveLength(2);
  });

  it('15. Property: shuffling isMainCharacter/spec/characterId never changes ranked order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            rank: fc.integer({ min: 1, max: 17 }),
            list: fc.constantFrom<'MAIN' | 'OFF'>('MAIN', 'OFF'),
            isMainCharacter: fc.boolean(),
            spec: fc.constantFrom('FURY', 'PROT', 'RESTO', 'ENH'),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (specs) => {
          const claims = specs.map((s, i) =>
            mkClaim({
              entryId: `e${i}`,
              playerId: `p${i}`,
              characterId: `c${i}`,
              characterName: `Char${i}`,
              list: s.list,
              rank: s.rank,
              isMainCharacter: s.isMainCharacter,
              spec: s.spec,
            }),
          );
          const present = ALL_PRESENT(claims.map((c) => c.characterId));
          const baseline = resolveDrop(ITEM, claims, present, noBis).ranked.map((c) => c.playerId);

          // Shuffle only the fields declared display-only / irrelevant; identity (playerId) stays fixed.
          const shuffled = claims.map((c) => ({
            ...c,
            isMainCharacter: !c.isMainCharacter,
            spec: c.spec === 'FURY' ? 'PROT' : 'FURY',
          }));
          const shuffledOrder = resolveDrop(ITEM, shuffled, present, noBis).ranked.map((c) => c.playerId);
          expect(shuffledOrder).toEqual(baseline);
        },
      ),
    );
  });

  it('16. Empty roster → all present + warning NO_ROSTER_SET', () => {
    const a = mkClaim({ entryId: 'e1', playerId: 'p1', characterId: 'c1', characterName: 'A', list: 'MAIN', rank: 1 });
    const result = resolveDrop(ITEM, [a], new Set(), noBis);
    expect(result.warnings).toContain('NO_ROSTER_SET');
    expect(result.winnerGroup.map((c) => c.characterId)).toEqual(['c1']);
  });

  it('17. 3-way MAIN r2 tie, BiS counts 2/1/1, mode PHASE → winnerGroup = the two with count 1', () => {
    const a = mkClaim({ entryId: 'eA', playerId: 'A', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 2 });
    const b = mkClaim({ entryId: 'eB', playerId: 'B', characterId: 'cB', characterName: 'B', list: 'MAIN', rank: 2 });
    const c = mkClaim({ entryId: 'eC', playerId: 'C', characterId: 'cC', characterName: 'C', list: 'MAIN', rank: 2 });
    const options = phaseOptions({ A: 2, B: 1, C: 1 });
    const result = resolveDrop(ITEM, [a, b, c], ALL_PRESENT(['cA', 'cB', 'cC']), options);
    expect(result.winnerGroup.map((x) => x.playerId).sort()).toEqual(['B', 'C']);
    expect(result.needsRoll).toBe(true);
    const excludedA = result.ranked.find((x) => x.playerId === 'A');
    expect(excludedA?.excludedReason).toBe('HIGHER_BIS_COUNT');
  });

  it('18. Same as 17 but mode OFF → all three roll', () => {
    const a = mkClaim({ entryId: 'eA', playerId: 'A', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 2 });
    const b = mkClaim({ entryId: 'eB', playerId: 'B', characterId: 'cB', characterName: 'B', list: 'MAIN', rank: 2 });
    const c = mkClaim({ entryId: 'eC', playerId: 'C', characterId: 'cC', characterName: 'C', list: 'MAIN', rank: 2 });
    const options: ResolveOptions = { equalDistributionMode: 'OFF', bisCountScope: 'PLAYER', bisCounts: { A: 2, B: 1, C: 1 } };
    const result = resolveDrop(ITEM, [a, b, c], ALL_PRESENT(['cA', 'cB', 'cC']), options);
    expect(result.winnerGroup).toHaveLength(3);
  });

  it('19. 3-way MAIN r2 tie, counts 2/1/0 → count-0 claim wins outright, needsRoll=false', () => {
    const a = mkClaim({ entryId: 'eA', playerId: 'A', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 2 });
    const b = mkClaim({ entryId: 'eB', playerId: 'B', characterId: 'cB', characterName: 'B', list: 'MAIN', rank: 2 });
    const c = mkClaim({ entryId: 'eC', playerId: 'C', characterId: 'cC', characterName: 'C', list: 'MAIN', rank: 2 });
    const options = phaseOptions({ A: 2, B: 1, C: 0 });
    const result = resolveDrop(ITEM, [a, b, c], ALL_PRESENT(['cA', 'cB', 'cC']), options);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup.map((x) => x.playerId)).toEqual(['C']);
  });

  it('20. MAIN r2 (count 5) vs OFF r1 (count 0) → MAIN r2 wins — BiS count must not cross tiers', () => {
    const a = mkClaim({ entryId: 'eA', playerId: 'A', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 2 });
    const b = mkClaim({ entryId: 'eB', playerId: 'B', characterId: 'cB', characterName: 'B', list: 'OFF', rank: 1 });
    const options = phaseOptions({ A: 5, B: 0 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['cA', 'cB']), options);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup.map((x) => x.playerId)).toEqual(['A']);
  });

  it('21. MAIN r2 (count 5) vs MAIN r3 (count 0) → r2 wins — BiS count must not cross ranks', () => {
    const a = mkClaim({ entryId: 'eA', playerId: 'A', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 2 });
    const b = mkClaim({ entryId: 'eB', playerId: 'B', characterId: 'cB', characterName: 'B', list: 'MAIN', rank: 3 });
    const options = phaseOptions({ A: 5, B: 0 });
    const result = resolveDrop(ITEM, [a, b], ALL_PRESENT(['cA', 'cB']), options);
    expect(result.needsRoll).toBe(false);
    expect(result.winnerGroup.map((x) => x.playerId)).toEqual(['A']);
  });

  it('22. bisCounts missing a player key → treated as 0, no crash', () => {
    const a = mkClaim({ entryId: 'eA', playerId: 'A', characterId: 'cA', characterName: 'A', list: 'MAIN', rank: 2 });
    const options = phaseOptions({});
    expect(() => resolveDrop(ITEM, [a], ALL_PRESENT(['cA']), options)).not.toThrow();
    const result = resolveDrop(ITEM, [a], ALL_PRESENT(['cA']), options);
    expect(result.winnerGroup[0]!.bisCount).toBe(0);
  });

  it('23. bisCountScope=PLAYER: player who won 2 items on their alt, now claiming on their main, has count 2', () => {
    // The caller (bis-count service) is responsible for keying bisCounts by playerId when
    // scope=PLAYER, summing across both reserved characters. The resolver just looks it up.
    const claimOnMain = mkClaim({ entryId: 'eA', playerId: 'P', characterId: 'main-char', characterName: 'Main', list: 'MAIN', rank: 2 });
    const options = phaseOptions({ P: 2 });
    const result = resolveDrop(ITEM, [claimOnMain], ALL_PRESENT(['main-char']), options);
    expect(result.winnerGroup[0]!.bisCount).toBe(2);
  });

  it('bisCountScope=CHARACTER looks counts up by characterId instead of playerId', () => {
    const claim = mkClaim({ entryId: 'eA', playerId: 'P', characterId: 'alt-char', characterName: 'Alt', list: 'MAIN', rank: 2 });
    const options: ResolveOptions = {
      equalDistributionMode: 'PHASE',
      bisCountScope: 'CHARACTER',
      bisCounts: { P: 99, 'alt-char': 3 },
    };
    const result = resolveDrop(ITEM, [claim], ALL_PRESENT(['alt-char']), options);
    expect(result.winnerGroup[0]!.bisCount).toBe(3);
  });

  it('collapses to the strongest claim regardless of input order (later entry beats an earlier weaker one)', () => {
    // Same player, weaker claim listed first in the input array — the collapse must still
    // pick the stronger (lower rank) claim rather than "whichever came first".
    const weakerFirst = mkClaim({ entryId: 'e-weak', playerId: 'p1', characterId: 'cWeak', characterName: 'Weak', list: 'MAIN', rank: 9 });
    const strongerSecond = mkClaim({ entryId: 'e-strong', playerId: 'p1', characterId: 'cStrong', characterName: 'Strong', list: 'MAIN', rank: 3 });
    const result = resolveDrop(ITEM, [weakerFirst, strongerSecond], ALL_PRESENT(['cWeak', 'cStrong']), noBis);
    expect(result.winnerGroup).toHaveLength(1);
    expect(result.winnerGroup[0]!.rank).toBe(3);
  });
});
