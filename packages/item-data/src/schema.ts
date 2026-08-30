import { z } from 'zod';
import { zInventoryType } from '@glps/contracts';

/** One row of packages/item-data/<gameVersion>/<phaseKey>.json (§12). */
export const zCatalogItem = z.object({
  itemId: z.number().int().positive(),
  name: z.string().min(1),
  quality: z.number().int().min(0).max(7),
  /** Canonical Slot enum value, or the 'FINGER' / 'TRINKET' / 'WEAPON' family (§6). */
  slot: z.string().min(1),
  inventoryType: zInventoryType,
  icon: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  classMask: z.number().int().nullable().optional(),
});
export type CatalogItem = z.infer<typeof zCatalogItem>;

export const zCatalogFile = z.array(zCatalogItem);

export function validateCatalog(raw: unknown): CatalogItem[] {
  const items = zCatalogFile.parse(raw);
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.itemId)) {
      throw new Error(`Duplicate itemId ${item.itemId} in catalog.`);
    }
    seen.add(item.itemId);
  }
  return items;
}
