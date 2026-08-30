import { describe, expect, it } from 'vitest';
import { computeCapacity } from '../src/capacity.js';
import type { EntryInput } from '../src/types.js';

const TWOHAND_ITEM = 1001;
const SHIELD_ITEM = 1002;
const inventoryType = (itemId: number) => (itemId === TWOHAND_ITEM ? 'TWOHAND' : 'ONEHAND');

function entry(overrides: Partial<EntryInput> & Pick<EntryInput, 'characterId' | 'list' | 'rank' | 'slot' | 'itemId'>): EntryInput {
  return { spec: 'FURY', ...overrides };
}

describe('computeCapacity (§2.2 / §3.3)', () => {
  it('full capacity with no two-handers', () => {
    const result = computeCapacity([], 'MAIN', { listSize: 17, twohandConsumesOffhand: true }, inventoryType);
    expect(result.effective).toBe(17);
    expect(result.deductions).toHaveLength(0);
  });

  it('a single character with a 2H drops capacity to 16 and blocks their off-hand row', () => {
    const entries = [
      entry({ characterId: 'c1', list: 'MAIN', rank: 1, slot: 'MAIN_HAND', itemId: TWOHAND_ITEM }),
    ];
    const result = computeCapacity(entries, 'MAIN', { listSize: 17, twohandConsumesOffhand: true }, inventoryType);
    expect(result.effective).toBe(16);
    expect(result.deductions).toEqual([{ characterId: 'c1', itemId: TWOHAND_ITEM, reason: 'TWOHAND_CONSUMES_OFFHAND' }]);
    expect(result.blockedSlots).toEqual([{ characterId: 'c1', slot: 'OFF_HAND', reason: 'TWOHAND_CONSUMES_OFFHAND' }]);
  });

  it('two reserved characters both listing a 2H in MAIN yields a cap of 15', () => {
    const entries = [
      entry({ characterId: 'c1', list: 'MAIN', rank: 1, slot: 'MAIN_HAND', itemId: TWOHAND_ITEM }),
      entry({ characterId: 'c2', list: 'MAIN', rank: 2, slot: 'MAIN_HAND', itemId: TWOHAND_ITEM }),
    ];
    const result = computeCapacity(entries, 'MAIN', { listSize: 17, twohandConsumesOffhand: true }, inventoryType);
    expect(result.effective).toBe(15);
  });

  it('the reduction is scoped to a single list — a 2H in MAIN does not shrink OFF', () => {
    const entries = [entry({ characterId: 'c1', list: 'MAIN', rank: 1, slot: 'MAIN_HAND', itemId: TWOHAND_ITEM })];
    const offResult = computeCapacity(entries, 'OFF', { listSize: 17, twohandConsumesOffhand: true }, inventoryType);
    expect(offResult.effective).toBe(17);
  });

  it('a shield in OFF_HAND does not deduct capacity', () => {
    const entries = [entry({ characterId: 'c1', list: 'MAIN', rank: 1, slot: 'OFF_HAND', itemId: SHIELD_ITEM })];
    const result = computeCapacity(entries, 'MAIN', { listSize: 17, twohandConsumesOffhand: true }, inventoryType);
    expect(result.effective).toBe(17);
    expect(result.deductions).toHaveLength(0);
  });

  it('twohandConsumesOffhand=false restores full capacity and blocks nothing', () => {
    const entries = [entry({ characterId: 'c1', list: 'MAIN', rank: 1, slot: 'MAIN_HAND', itemId: TWOHAND_ITEM })];
    const result = computeCapacity(entries, 'MAIN', { listSize: 17, twohandConsumesOffhand: false }, inventoryType);
    expect(result.effective).toBe(17);
    expect(result.deductions).toHaveLength(0);
    expect(result.blockedSlots).toHaveLength(0);
  });

  it('respects a non-default listSize setting', () => {
    const result = computeCapacity([], 'MAIN', { listSize: 10, twohandConsumesOffhand: true }, inventoryType);
    expect(result.effective).toBe(10);
  });
});
