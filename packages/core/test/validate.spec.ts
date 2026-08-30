import { describe, expect, it } from 'vitest';
import { validateSubmission, type CatalogItem, type ReservedCharacter, type ValidationContext } from '../src/validate.js';
import type { EntryInput } from '../src/types.js';

const TWOHAND_ITEM = 5001;
const RING_ITEM = 5002;
const NECK_ITEM = 5003;

const catalog: Record<number, CatalogItem> = {
  [TWOHAND_ITEM]: { itemId: TWOHAND_ITEM, inventoryType: 'TWOHAND' },
  [RING_ITEM]: { itemId: RING_ITEM, inventoryType: 'FINGER' },
  [NECK_ITEM]: { itemId: NECK_ITEM, inventoryType: 'NECK' },
};

const charA: ReservedCharacter = { characterId: 'cA', slotIndex: 1, mainSpec: 'FURY', offSpec: 'PROT' };
const charB: ReservedCharacter = { characterId: 'cB', slotIndex: 2, mainSpec: 'ARMS', offSpec: 'PROT' };

function baseCtx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    settings: {
      listSize: 17,
      twohandConsumesOffhand: true,
      allowAltOffspecInOffList: true,
      requireFullList: false,
    },
    reservedCharacters: [charA, charB],
    lookupItem: (itemId) => catalog[itemId],
    submissionStatus: 'DRAFT',
    phaseOpen: true,
    ...overrides,
  };
}

function neckEntry(overrides: Partial<EntryInput>): EntryInput {
  return { characterId: 'cA', list: 'MAIN', rank: 1, slot: 'NECK', itemId: NECK_ITEM, spec: 'FURY', ...overrides };
}

describe('validateSubmission (§10)', () => {
  it('accepts a minimal valid entry', () => {
    const result = validateSubmission([neckEntry({})], baseCtx());
    expect(result.valid).toBe(true);
  });

  it('SUBMISSION_LOCKED when already submitted', () => {
    const result = validateSubmission([], baseCtx({ submissionStatus: 'SUBMITTED' }));
    expect(result.errors.map((e) => e.code)).toContain('SUBMISSION_LOCKED');
  });

  it('PHASE_CLOSED when the phase is not open', () => {
    const result = validateSubmission([], baseCtx({ phaseOpen: false }));
    expect(result.errors.map((e) => e.code)).toContain('PHASE_CLOSED');
  });

  it('CHARACTER_NOT_OWNED for a foreign character id', () => {
    const result = validateSubmission([neckEntry({ characterId: 'someone-elses-char' })], baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('CHARACTER_NOT_OWNED');
  });

  it('RANK_GAP when ranks are not contiguous from 1', () => {
    const entries = [neckEntry({ rank: 1 }), neckEntry({ characterId: 'cB', spec: 'ARMS', slot: 'FINGER_1', itemId: RING_ITEM, rank: 3 })];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('RANK_GAP');
  });

  it('RANK_GAP when a rank is duplicated', () => {
    const entries = [
      neckEntry({ rank: 1 }),
      neckEntry({ characterId: 'cB', spec: 'ARMS', slot: 'FINGER_1', itemId: RING_ITEM, rank: 1 }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('RANK_GAP');
  });

  it('RANK_OUT_OF_RANGE beyond effective capacity', () => {
    const result = validateSubmission([neckEntry({ rank: 18 })], baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('RANK_OUT_OF_RANGE');
  });

  it('TOO_MANY_ENTRIES states the reduced cap when a 2H is present', () => {
    const entries = [
      neckEntry({ characterId: 'cA', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 1, spec: 'FURY' }),
    ];
    // Force an over-cap by claiming 2 entries against an effective cap of 16 is impossible with
    // just 2 entries, so instead assert the deduction is correctly reflected via RANK_OUT_OF_RANGE
    // at the boundary rank (16 is fine, 17 is not once a 2H is listed).
    const boundaryOk = validateSubmission(
      [...entries, neckEntry({ characterId: 'cB', spec: 'ARMS', slot: 'FINGER_1', itemId: RING_ITEM, rank: 16 })],
      baseCtx(),
    );
    expect(boundaryOk.errors.map((e) => e.code)).not.toContain('RANK_OUT_OF_RANGE');

    const overCap = validateSubmission(
      [...entries, neckEntry({ characterId: 'cB', spec: 'ARMS', slot: 'FINGER_1', itemId: RING_ITEM, rank: 17 })],
      baseCtx(),
    );
    expect(overCap.errors.map((e) => e.code)).toContain('RANK_OUT_OF_RANGE');
  });

  it('OFFHAND_BLOCKED_BY_TWOHAND is a blocking error when twohandConsumesOffhand=true', () => {
    const entries = [
      neckEntry({ characterId: 'cA', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 1, spec: 'FURY' }),
      neckEntry({ characterId: 'cA', slot: 'OFF_HAND', itemId: RING_ITEM, rank: 2, spec: 'FURY' }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('OFFHAND_BLOCKED_BY_TWOHAND');
  });

  it('degrades to a non-blocking TWOHAND_WITH_OFFHAND warning when the setting is off', () => {
    const entries = [
      neckEntry({ characterId: 'cA', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 1, spec: 'FURY' }),
      neckEntry({ characterId: 'cA', slot: 'OFF_HAND', itemId: RING_ITEM, rank: 2, spec: 'FURY' }),
    ];
    const result = validateSubmission(entries, baseCtx({ settings: { listSize: 17, twohandConsumesOffhand: false, allowAltOffspecInOffList: true, requireFullList: false } }));
    expect(result.errors.map((e) => e.code)).not.toContain('OFFHAND_BLOCKED_BY_TWOHAND');
    expect(result.warnings.map((w) => w.code)).toContain('TWOHAND_WITH_OFFHAND');
  });

  it('a 2H in MAIN and a shield in OFF for the same character across different lists is fine (scoped to one list)', () => {
    const entries = [
      neckEntry({ characterId: 'cA', list: 'MAIN', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 1, spec: 'FURY' }),
      neckEntry({ characterId: 'cA', list: 'OFF', slot: 'OFF_HAND', itemId: RING_ITEM, rank: 1, spec: 'PROT' }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).not.toContain('OFFHAND_BLOCKED_BY_TWOHAND');
  });

  it('DUPLICATE_SLOT when the same character claims a slot twice in one list', () => {
    const entries = [
      neckEntry({ rank: 1 }),
      neckEntry({ rank: 2 }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('DUPLICATE_SLOT');
  });

  it('the same slot across two different characters is allowed (split-main rule, D-5)', () => {
    const entries = [
      neckEntry({ characterId: 'cA', rank: 1 }),
      neckEntry({ characterId: 'cB', spec: 'ARMS', rank: 2 }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).not.toContain('DUPLICATE_SLOT');
  });

  it('DUPLICATE_ITEM_IN_LIST when the same character lists the same item twice', () => {
    const entries = [
      neckEntry({ slot: 'NECK', itemId: NECK_ITEM, rank: 1 }),
      neckEntry({ slot: 'FINGER_1', itemId: NECK_ITEM, rank: 2 }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('DUPLICATE_ITEM_IN_LIST');
  });

  it('SPEC_NOT_ALLOWED_IN_LIST rejects an off-spec entry on MAIN', () => {
    const entries = [neckEntry({ spec: 'PROT', list: 'MAIN' })];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('SPEC_NOT_ALLOWED_IN_LIST');
  });

  it('OFF list accepts char#1 off spec', () => {
    const entries = [neckEntry({ spec: 'PROT', list: 'OFF' })];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).not.toContain('SPEC_NOT_ALLOWED_IN_LIST');
  });

  it('OFF list accepts char#2 main spec', () => {
    const entries = [neckEntry({ characterId: 'cB', spec: 'ARMS', list: 'OFF' })];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).not.toContain('SPEC_NOT_ALLOWED_IN_LIST');
  });

  it('OFF list rejects char#2 off spec when ALLOW_ALT_OFFSPEC_IN_OFF_LIST=false', () => {
    const entries = [neckEntry({ characterId: 'cB', spec: 'PROT', list: 'OFF' })];
    const result = validateSubmission(
      entries,
      baseCtx({ settings: { listSize: 17, twohandConsumesOffhand: true, allowAltOffspecInOffList: false, requireFullList: false } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('SPEC_NOT_ALLOWED_IN_LIST');
  });

  it('ITEM_NOT_IN_PHASE for an unknown item id', () => {
    const entries = [neckEntry({ itemId: 999999 })];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('ITEM_NOT_IN_PHASE');
  });

  it('an unknown item in MAIN_HAND is treated as not two-handed for capacity purposes', () => {
    const result = validateSubmission(
      [neckEntry({ slot: 'MAIN_HAND', itemId: 424242, rank: 1 })],
      baseCtx(),
    );
    expect(result.errors.map((e) => e.code)).toContain('ITEM_NOT_IN_PHASE');
    expect(result.errors.map((e) => e.code)).not.toContain('TOO_MANY_ENTRIES');
  });

  it('ITEM_SLOT_MISMATCH when the item cannot go in the declared slot', () => {
    const entries = [neckEntry({ slot: 'FINGER_1', itemId: NECK_ITEM })];
    const result = validateSubmission(entries, baseCtx());
    expect(result.errors.map((e) => e.code)).toContain('ITEM_SLOT_MISMATCH');
  });

  it('LIST_NOT_FULL when REQUIRE_FULL_LIST=true and the list is short', () => {
    const result = validateSubmission(
      [neckEntry({ rank: 1 })],
      baseCtx({ settings: { listSize: 17, twohandConsumesOffhand: true, allowAltOffspecInOffList: true, requireFullList: true } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('LIST_NOT_FULL');
  });

  it('EMPTY_OFF_LIST warning when nothing is in the OFF list', () => {
    const result = validateSubmission([neckEntry({})], baseCtx());
    expect(result.warnings.map((w) => w.code)).toContain('EMPTY_OFF_LIST');
  });

  it('TOO_MANY_ENTRIES states plain capacity when there are no two-hand deductions', () => {
    const entries = [
      ...['NECK', 'HEAD'].map((slot, i) => neckEntry({ slot: slot as EntryInput['slot'], itemId: NECK_ITEM, rank: i + 1 })),
    ];
    const result = validateSubmission(entries, baseCtx({ settings: { listSize: 1, twohandConsumesOffhand: true, allowAltOffspecInOffList: true, requireFullList: false } }));
    const tooMany = result.errors.find((e) => e.code === 'TOO_MANY_ENTRIES');
    expect(tooMany?.message).toContain('capacity is 1.');
  });

  it('TOO_MANY_ENTRIES uses the singular "weapon" with exactly one two-handed deduction', () => {
    const entries = [
      neckEntry({ characterId: 'cA', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 1, spec: 'FURY' }),
      neckEntry({ characterId: 'cB', spec: 'ARMS', slot: 'NECK', itemId: NECK_ITEM, rank: 2 }),
    ];
    const result = validateSubmission(entries, baseCtx({ settings: { listSize: 1, twohandConsumesOffhand: true, allowAltOffspecInOffList: true, requireFullList: false } }));
    const tooMany = result.errors.find((e) => e.code === 'TOO_MANY_ENTRIES');
    expect(tooMany?.message).toContain('1 two-handed weapon consumes an off-hand slot.');
  });

  it('TOO_MANY_ENTRIES pluralizes "weapons" with two two-handed deductions', () => {
    const entries = [
      neckEntry({ characterId: 'cA', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 1, spec: 'FURY' }),
      neckEntry({ characterId: 'cB', spec: 'ARMS', slot: 'MAIN_HAND', itemId: TWOHAND_ITEM, rank: 2 }),
      neckEntry({ characterId: 'cA', slot: 'NECK', itemId: NECK_ITEM, rank: 3 }),
    ];
    const result = validateSubmission(entries, baseCtx({ settings: { listSize: 3, twohandConsumesOffhand: true, allowAltOffspecInOffList: true, requireFullList: false } }));
    const tooMany = result.errors.find((e) => e.code === 'TOO_MANY_ENTRIES');
    expect(tooMany?.message).toContain('2 two-handed weapons each consume an off-hand slot.');
  });

  it('CLASS_CANNOT_USE_ITEM warning when the class mask does not intersect the item mask', () => {
    const restrictedCatalog: Record<number, CatalogItem> = {
      [NECK_ITEM]: { itemId: NECK_ITEM, inventoryType: 'NECK', classMask: 0b0001 },
    };
    const result = validateSubmission(
      [neckEntry({})],
      baseCtx({
        reservedCharacters: [{ ...charA, classMask: 0b0010 }, charB],
        lookupItem: (itemId) => restrictedCatalog[itemId],
      }),
    );
    expect(result.warnings.map((w) => w.code)).toContain('CLASS_CANNOT_USE_ITEM');
  });

  it('ITEM_ALSO_IN_OTHER_LIST informational warning', () => {
    const entries = [
      neckEntry({ list: 'MAIN', rank: 1 }),
      neckEntry({ characterId: 'cB', spec: 'PROT', list: 'OFF', rank: 1 }),
    ];
    const result = validateSubmission(entries, baseCtx());
    expect(result.warnings.map((w) => w.code)).toContain('ITEM_ALSO_IN_OTHER_LIST');
  });
});
