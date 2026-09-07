import type { ListTier, Slot } from '@glps/core';

export interface CatalogEntry {
  itemId: number;
  name: string;
  quality: number;
  slot: string;
  inventoryType: string;
  icon: string | null;
  source: string | null;
  classMask: number | null;
  // Set when this item isn't itself what drops — a tier token or quest
  // item produces it instead (§ token/quest-item acquisition design).
  acquiredViaItemId?: number | null;
  acquiredViaName?: string | null;
  acquiredViaIcon?: string | null;
}

export interface CharacterInfo {
  id: string;
  name: string;
  class: string;
  mainSpec: string;
  offSpec: string | null;
  isMainCharacter: boolean;
  slotIndex: 1 | 2;
}

/** One wish, before rank is derived from its position in the ladder array. */
export interface DraftEntry {
  key: string;
  characterId: string;
  slot: Slot;
  itemId: number;
  spec: string;
  note?: string;
  // "Already owned" — pinned to the top of the ladder as a contiguous
  // block; see ListBuilderPage's toggleOwned/reorder for the invariant.
  owned?: boolean;
  // The picker's full CatalogEntry, cached straight onto the entry when
  // added this session (never sent to the server — toEntryInputs drops
  // it). Entries loaded from a saved submission start without this; get
  // it filled in from a /me/items/lookup fallback (see ListBuilderPage's
  // catalogByItemId, which every read of an entry's item should go
  // through instead of this field directly).
  item?: CatalogEntry;
}

export type BuilderState = Record<ListTier, DraftEntry[]>;

export const ALL_SLOTS: Slot[] = [
  'HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET',
  'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2', 'MAIN_HAND', 'OFF_HAND', 'RANGED',
];

const SLOT_FAMILY: Record<string, string> = {
  FINGER_1: 'FINGER',
  FINGER_2: 'FINGER',
  TRINKET_1: 'TRINKET',
  TRINKET_2: 'TRINKET',
  MAIN_HAND: 'WEAPON',
};

/**
 * Narrows the item picker's suggestions to items plausible for `slot`, using
 * the catalog's `slot` family convention (§6: canonical Slot, or the
 * FINGER/TRINKET/WEAPON family). This is a UX convenience only — the
 * authoritative check is @glps/core's validateSubmission, which looks at
 * the item's actual inventoryType, so a wrong guess here never blocks a
 * valid pick.
 */
export function itemLooksValidForSlot(item: Pick<CatalogEntry, 'slot' | 'inventoryType'>, slot: Slot): boolean {
  if (slot === 'OFF_HAND') {
    return item.slot === 'OFF_HAND' || (item.slot === 'WEAPON' && item.inventoryType === 'ONEHAND');
  }
  const family = SLOT_FAMILY[slot] ?? slot;
  return item.slot === family;
}
