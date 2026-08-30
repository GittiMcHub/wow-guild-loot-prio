import { describe, expect, it } from 'vitest';
import { SLOTS } from '@glps/core';
import { listCatalogs, loadCatalog, parseCatalogCsv, validateCatalog } from '../src/index.js';

describe('sample-p3 catalog (§12)', () => {
  it('lists the sample catalog', () => {
    const catalogs = listCatalogs();
    expect(catalogs).toContainEqual({ gameVersion: 'classic-era', phaseKey: 'sample-p3' });
  });

  it('loads and validates the sample catalog with at least 60 items', () => {
    const items = loadCatalog('classic-era', 'sample-p3');
    expect(items.length).toBeGreaterThanOrEqual(60);
  });

  it('has unique item ids', () => {
    const items = loadCatalog('classic-era', 'sample-p3');
    expect(new Set(items.map((i) => i.itemId)).size).toBe(items.length);
  });

  it('covers every slot family required by the 17 canonical slots', () => {
    const items = loadCatalog('classic-era', 'sample-p3');
    const slots = new Set(items.map((i) => i.slot));
    // 10 slots map 1:1 by name; FINGER_1/2 and TRINKET_1/2 share a family; the four
    // weapon slots (MAIN_HAND/OFF_HAND/RANGED) are covered by WEAPON/OFF_HAND/RANGED families.
    const directSlots = SLOTS.filter((s) => !['FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2', 'MAIN_HAND', 'OFF_HAND', 'RANGED'].includes(s));
    for (const slot of directSlots) expect(slots.has(slot)).toBe(true);
    expect(slots.has('FINGER')).toBe(true);
    expect(slots.has('TRINKET')).toBe(true);
    expect(slots.has('WEAPON')).toBe(true);
    expect(slots.has('OFF_HAND')).toBe(true);
    expect(slots.has('RANGED')).toBe(true);
  });

  it('includes both ONEHAND and TWOHAND main-hand weapons', () => {
    const items = loadCatalog('classic-era', 'sample-p3');
    const types = new Set(items.map((i) => i.inventoryType));
    expect(types.has('ONEHAND')).toBe(true);
    expect(types.has('TWOHAND')).toBe(true);
    expect(types.has('SHIELD')).toBe(true);
  });

  it('rejects a catalog with a duplicate itemId', () => {
    expect(() =>
      validateCatalog([
        { itemId: 1, name: 'A', quality: 3, slot: 'NECK', inventoryType: 'NECK' },
        { itemId: 1, name: 'B', quality: 3, slot: 'NECK', inventoryType: 'NECK' },
      ]),
    ).toThrow(/Duplicate itemId/);
  });
});

describe('parseCatalogCsv (§12 catalog:import)', () => {
  it('parses a well-formed CSV', () => {
    const csv = [
      'itemId,name,quality,slot,inventoryType,icon,source,classMask',
      '19019,"Thunderfury, Blessed Blade of the Windseeker",5,WEAPON,ONEHAND,,Ragnaros,',
    ].join('\n');
    const items = parseCatalogCsv(csv);
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('Thunderfury, Blessed Blade of the Windseeker');
    expect(items[0]!.quality).toBe(5);
  });

  it('returns an empty array for an empty file', () => {
    expect(parseCatalogCsv('')).toEqual([]);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseCatalogCsv('name,quality\nFoo,3')).toThrow(/missing required column/);
  });

  it('throws when a row fails schema validation', () => {
    const csv = ['itemId,name,quality,slot,inventoryType', 'notanumber,Foo,3,NECK,NECK'].join('\n');
    expect(() => parseCatalogCsv(csv)).toThrow(/invalid/);
  });
});
