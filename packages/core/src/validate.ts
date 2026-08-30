import { computeCapacity } from './capacity.js';
import type { EntryInput, InventoryType, ListTier, Slot } from './types.js';

export type BlockingErrorCode =
  | 'RANK_GAP'
  | 'RANK_OUT_OF_RANGE'
  | 'TOO_MANY_ENTRIES'
  | 'OFFHAND_BLOCKED_BY_TWOHAND'
  | 'DUPLICATE_SLOT'
  | 'DUPLICATE_ITEM_IN_LIST'
  | 'SPEC_NOT_ALLOWED_IN_LIST'
  | 'ITEM_NOT_IN_PHASE'
  | 'ITEM_SLOT_MISMATCH'
  | 'CHARACTER_NOT_OWNED'
  | 'SUBMISSION_LOCKED'
  | 'PHASE_CLOSED'
  | 'LIST_NOT_FULL';

export type WarningCode =
  | 'TWOHAND_WITH_OFFHAND'
  | 'CLASS_CANNOT_USE_ITEM'
  | 'EMPTY_OFF_LIST'
  | 'SLOT_NOT_COVERED'
  | 'ITEM_ALSO_IN_OTHER_LIST';

export interface ValidationIssue {
  code: BlockingErrorCode | WarningCode;
  message: string;
  list?: ListTier;
  characterId?: string;
  slot?: Slot;
  rank?: number;
}

export interface ReservedCharacter {
  characterId: string;
  /** 1 or 2 */
  slotIndex: 1 | 2;
  classMask?: number;
  mainSpec: string;
  offSpec?: string;
}

export interface CatalogItem {
  itemId: number;
  inventoryType: InventoryType;
  classMask?: number;
}

export interface ValidationContext {
  settings: {
    listSize: number;
    twohandConsumesOffhand: boolean;
    allowAltOffspecInOffList: boolean;
    requireFullList: boolean;
  };
  reservedCharacters: ReservedCharacter[];
  /** undefined = not in the phase's enabled catalog */
  lookupItem: (itemId: number) => CatalogItem | undefined;
  submissionStatus: 'DRAFT' | 'SUBMITTED';
  /** phase.status === 'OPEN' and (no deadline or deadline not yet passed) */
  phaseOpen: boolean;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  valid: boolean;
}

const INVENTORY_SLOT_FAMILY: Record<InventoryType, Slot[]> = {
  HEAD: ['HEAD'],
  NECK: ['NECK'],
  SHOULDER: ['SHOULDER'],
  BACK: ['BACK'],
  CHEST: ['CHEST'],
  WRIST: ['WRIST'],
  HANDS: ['HANDS'],
  WAIST: ['WAIST'],
  LEGS: ['LEGS'],
  FEET: ['FEET'],
  FINGER: ['FINGER_1', 'FINGER_2'],
  TRINKET: ['TRINKET_1', 'TRINKET_2'],
  ONEHAND: ['MAIN_HAND', 'OFF_HAND'],
  TWOHAND: ['MAIN_HAND'],
  OFFHAND: ['OFF_HAND'],
  SHIELD: ['OFF_HAND'],
  RANGED: ['RANGED'],
  RELIC: ['RANGED'],
};

function specAllowedInList(
  entry: EntryInput,
  list: ListTier,
  character: ReservedCharacter,
  allowAltOffspecInOffList: boolean,
): boolean {
  if (list === 'MAIN') {
    return entry.spec === character.mainSpec;
  }
  // OFF list
  if (character.slotIndex === 1) {
    return entry.spec === character.offSpec;
  }
  // character.slotIndex === 2
  if (entry.spec === character.mainSpec) return true;
  if (allowAltOffspecInOffList && entry.spec === character.offSpec) return true;
  return false;
}

/**
 * Implemented once (§10), called by both the API and the web form so the UI
 * can show errors live. Pure: no DB, no env.
 */
export function validateSubmission(
  entries: EntryInput[],
  ctx: ValidationContext,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (ctx.submissionStatus === 'SUBMITTED') {
    errors.push({ code: 'SUBMISSION_LOCKED', message: 'This submission is already locked.' });
  }
  if (!ctx.phaseOpen) {
    errors.push({ code: 'PHASE_CLOSED', message: 'This phase is not open for submissions.' });
  }

  const charactersById = new Map(ctx.reservedCharacters.map((c) => [c.characterId, c]));

  for (const entry of entries) {
    if (!charactersById.has(entry.characterId)) {
      errors.push({
        code: 'CHARACTER_NOT_OWNED',
        message: `Character ${entry.characterId} is not one of your reserved characters.`,
        characterId: entry.characterId,
        list: entry.list,
      });
    }
  }

  for (const list of ['MAIN', 'OFF'] as const) {
    const listEntries = entries.filter((e) => e.list === list);

    const capacity = computeCapacity(entries, list, ctx.settings, (itemId) => {
      return ctx.lookupItem(itemId)?.inventoryType ?? 'HEAD';
    });

    if (listEntries.length > capacity.effective) {
      errors.push({
        code: 'TOO_MANY_ENTRIES',
        message: `${listEntries.length} of ${capacity.effective} — ${
          capacity.deductions.length > 0
            ? capacity.deductions.length > 1
              ? `${capacity.deductions.length} two-handed weapons each consume an off-hand slot.`
              : `1 two-handed weapon consumes an off-hand slot.`
            : `capacity is ${capacity.effective}.`
        }`,
        list,
      });
    }

    if (ctx.settings.twohandConsumesOffhand) {
      for (const blocked of capacity.blockedSlots) {
        const offender = listEntries.find(
          (e) => e.characterId === blocked.characterId && e.slot === 'OFF_HAND',
        );
        if (offender) {
          errors.push({
            code: 'OFFHAND_BLOCKED_BY_TWOHAND',
            message: 'A two-handed weapon uses both hands — this character cannot also list an off-hand item in the same list.',
            list,
            characterId: blocked.characterId,
            slot: 'OFF_HAND',
          });
        }
      }
    } else {
      const mainHandTwoHandChars = new Set(
        listEntries
          .filter((e) => e.slot === 'MAIN_HAND' && ctx.lookupItem(e.itemId)?.inventoryType === 'TWOHAND')
          .map((e) => e.characterId),
      );
      for (const entry of listEntries) {
        if (entry.slot === 'OFF_HAND' && mainHandTwoHandChars.has(entry.characterId)) {
          warnings.push({
            code: 'TWOHAND_WITH_OFFHAND',
            message: 'This character also lists a two-handed weapon; only one can be worn at a time.',
            list,
            characterId: entry.characterId,
            slot: 'OFF_HAND',
          });
        }
      }
    }

    // Ranks contiguous 1..N, unique.
    const ranks = listEntries.map((e) => e.rank).sort((a, b) => a - b);
    const seenRanks = new Set<number>();
    for (const rank of ranks) {
      if (rank < 1 || rank > capacity.effective) {
        errors.push({
          code: 'RANK_OUT_OF_RANGE',
          message: `Rank ${rank} is outside 1..${capacity.effective}.`,
          list,
          rank,
        });
      }
      if (seenRanks.has(rank)) {
        errors.push({ code: 'RANK_GAP', message: `Rank ${rank} is used more than once.`, list, rank });
      }
      seenRanks.add(rank);
    }
    for (let i = 1; i <= ranks.length; i++) {
      if (!seenRanks.has(i)) {
        errors.push({ code: 'RANK_GAP', message: `Ranks must be contiguous starting at 1; ${i} is missing.`, list, rank: i });
        break;
      }
    }

    // Uniqueness: (characterId, slot) and (characterId, itemId) within the list.
    const slotSeen = new Set<string>();
    const itemSeen = new Set<string>();
    for (const entry of listEntries) {
      const slotKey = `${entry.characterId}::${entry.slot}`;
      if (slotSeen.has(slotKey)) {
        errors.push({
          code: 'DUPLICATE_SLOT',
          message: `${entry.slot} is claimed twice by the same character in this list.`,
          list,
          characterId: entry.characterId,
          slot: entry.slot,
        });
      }
      slotSeen.add(slotKey);

      const itemKey = `${entry.characterId}::${entry.itemId}`;
      if (itemSeen.has(itemKey)) {
        errors.push({
          code: 'DUPLICATE_ITEM_IN_LIST',
          message: `Item ${entry.itemId} is listed twice for the same character in this list.`,
          list,
          characterId: entry.characterId,
        });
      }
      itemSeen.add(itemKey);

      const character = charactersById.get(entry.characterId);
      if (character && !specAllowedInList(entry, list, character, ctx.settings.allowAltOffspecInOffList)) {
        errors.push({
          code: 'SPEC_NOT_ALLOWED_IN_LIST',
          message: `Spec ${entry.spec} is not allowed to submit to the ${list} list for this character.`,
          list,
          characterId: entry.characterId,
        });
      }

      const catalogItem = ctx.lookupItem(entry.itemId);
      if (!catalogItem) {
        errors.push({
          code: 'ITEM_NOT_IN_PHASE',
          message: `Item ${entry.itemId} is not enabled for this phase.`,
          list,
          characterId: entry.characterId,
        });
      } else {
        const compatibleSlots = INVENTORY_SLOT_FAMILY[catalogItem.inventoryType];
        if (!compatibleSlots.includes(entry.slot)) {
          errors.push({
            code: 'ITEM_SLOT_MISMATCH',
            message: `Item ${entry.itemId} (${catalogItem.inventoryType}) cannot be placed in ${entry.slot}.`,
            list,
            characterId: entry.characterId,
            slot: entry.slot,
          });
        }
        if (
          character?.classMask !== undefined &&
          catalogItem.classMask !== undefined &&
          (character.classMask & catalogItem.classMask) === 0
        ) {
          warnings.push({
            code: 'CLASS_CANNOT_USE_ITEM',
            message: `This character's class cannot use item ${entry.itemId}.`,
            list,
            characterId: entry.characterId,
          });
        }
      }
    }

    if (ctx.settings.requireFullList && listEntries.length < capacity.effective) {
      errors.push({
        code: 'LIST_NOT_FULL',
        message: `${listEntries.length} of ${capacity.effective} ranks filled — this guild requires a full list.`,
        list,
      });
    }
  }

  if (entries.filter((e) => e.list === 'OFF').length === 0) {
    warnings.push({ code: 'EMPTY_OFF_LIST', message: 'The off list is empty.', list: 'OFF' });
  }

  const itemsByList = new Map<ListTier, Set<number>>([
    ['MAIN', new Set(entries.filter((e) => e.list === 'MAIN').map((e) => e.itemId))],
    ['OFF', new Set(entries.filter((e) => e.list === 'OFF').map((e) => e.itemId))],
  ]);
  for (const entry of entries) {
    const otherList: ListTier = entry.list === 'MAIN' ? 'OFF' : 'MAIN';
    if (itemsByList.get(otherList)!.has(entry.itemId)) {
      warnings.push({
        code: 'ITEM_ALSO_IN_OTHER_LIST',
        message: `Item ${entry.itemId} also appears in the ${otherList} list.`,
        list: entry.list,
        characterId: entry.characterId,
      });
    }
  }

  const coveredSlots = new Set(entries.map((e) => e.slot));
  for (const slot of [
    'HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET',
    'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2', 'MAIN_HAND', 'OFF_HAND', 'RANGED',
  ] as const) {
    if (!coveredSlots.has(slot)) {
      warnings.push({ code: 'SLOT_NOT_COVERED', message: `No entry covers ${slot}.`, slot });
    }
  }

  return { errors, warnings, valid: errors.length === 0 };
}
