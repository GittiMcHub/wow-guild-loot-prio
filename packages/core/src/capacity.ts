import type { EntryInput, ListTier, Slot } from './types.js';

export interface CapacityDeduction {
  characterId: string;
  itemId: number;
  reason: 'TWOHAND_CONSUMES_OFFHAND';
}

export interface BlockedSlot {
  characterId: string;
  slot: Slot;
  reason: string;
}

export interface CapacitySettings {
  /** guild setting, default 17 */
  listSize: number;
  twohandConsumesOffhand: boolean;
}

export interface CapacityResult {
  listSize: number;
  /** listSize minus two-hand deductions */
  effective: number;
  deductions: CapacityDeduction[];
  blockedSlots: BlockedSlot[];
}

/**
 * Derived, never stored (§3.3). Called identically by the validator, the API
 * response, and the list-builder UI so the ladder length is always in sync.
 */
export function computeCapacity(
  entries: EntryInput[],
  list: ListTier,
  settings: CapacitySettings,
  itemInventoryType: (itemId: number) => string,
): CapacityResult {
  const listEntries = entries.filter((e) => e.list === list);
  const deductions: CapacityDeduction[] = [];
  const blockedSlots: BlockedSlot[] = [];

  if (settings.twohandConsumesOffhand) {
    const twoHandByCharacter = new Map<string, number>();
    for (const entry of listEntries) {
      if (entry.slot === 'MAIN_HAND' && itemInventoryType(entry.itemId) === 'TWOHAND') {
        twoHandByCharacter.set(entry.characterId, entry.itemId);
      }
    }
    for (const [characterId, itemId] of twoHandByCharacter) {
      deductions.push({ characterId, itemId, reason: 'TWOHAND_CONSUMES_OFFHAND' });
      blockedSlots.push({
        characterId,
        slot: 'OFF_HAND',
        reason: 'TWOHAND_CONSUMES_OFFHAND',
      });
    }
  }

  return {
    listSize: settings.listSize,
    effective: Math.max(0, settings.listSize - deductions.length),
    deductions,
    blockedSlots,
  };
}
