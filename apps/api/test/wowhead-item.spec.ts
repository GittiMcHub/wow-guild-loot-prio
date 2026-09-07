import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchItemFromWowhead, searchWowheadByName } from '../src/services/wowhead-item.js';

/**
 * Wowhead has no documented item API. The only currently-working feed is the
 * classic item page itself: fetching `https://<subdomain>.wowhead.com/item=<id>`
 * (the subdomain 301-redirects to `https://www.wowhead.com/<version>/item=<id>`,
 * which `fetch` follows automatically) returns an HTML page with a
 * `WH.Gatherer.addData(3, <dbVersion>, { "<itemId>": { ... }, ... })` script
 * tag embedding the tooltip data as a JSON object keyed by item ID.
 *
 * Verified for real against item 32235 "Cursed Vision of Sargeras" (TBC,
 * Illidan Stormrage / Black Temple) on 2026-08-31:
 *
 *   WH.Gatherer.addData(3, 5, {"32235":{"name_enus":"Cursed Vision of Sargeras",
 *   "quality":4,"icon":"inv_misc_bandana_03","screenshot":{},"jsonequip":{
 *   "agi":39,...,"slotbak":1,...},"attainable":0,"flags2":24580,...}, ...});
 *
 * Real field names (differ from the plan's placeholder guesses):
 *   - name is `name_enus`, not `name`
 *   - inventory-type code is `jsonequip.slotbak`, not a top-level `invType`
 *   - `icon` is a bare icon slug (e.g. "inv_misc_bandana_03"), not a URL
 *   - non-equippable items simply lack `jsonequip` entirely
 */
const GATHERER_PAGE_HTML = (itemId: number, fields: string) =>
  `<html><body><script>WH.Gatherer.addData(3, 5, {"${itemId}":{${fields}},"999":{"name_enus":"Other Item","quality":1,"icon":"inv_misc_bandana_01"}});</script></body></html>`;

const CURSED_VISION_FIELDS =
  '"name_enus":"Cursed Vision of Sargeras","quality":4,"icon":"inv_misc_bandana_03","screenshot":{},' +
  '"jsonequip":{"agi":39,"appearances":{"0":[45489,""]},"armor":385,"cooldown":600000,"dbcFlags":5898332,' +
  '"displayid":45489,"dura":70,"itemSquishEraId":0,"mleatkpwr":108,"mlecritstrkrtng":38,"mlehitrtng":21,' +
  '"nsockets":2,"reqlevel":70,"rgdatkpwr":108,"rgdcritstrkrtng":38,"rgdhitrtng":21,"sellprice":58105,' +
  '"slotbak":1,"socket1":1,"socket2":3,"socketbonus":2868,"sta":46},"attainable":0,"flags2":24580,' +
  '"displayName":"","qualityTier":0,"qualityTierTexture":""';

describe('fetchItemFromWowhead', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a well-formed response into FetchedItemData', async () => {
    const html = GATHERER_PAGE_HTML(32235, CURSED_VISION_FIELDS);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => html,
      }),
    );

    const item = await fetchItemFromWowhead(32235, 'tbc');
    expect(item.itemId).toBe(32235);
    expect(item.name).toBe('Cursed Vision of Sargeras');
    expect(item.quality).toBe(4);
    expect(item.icon).toBe('inv_misc_bandana_03');
    expect(item.inventoryType).toBe('HEAD');
    expect(item.slot).toBe('HEAD');
  });

  it('throws WOWHEAD_FETCH_FAILED on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchItemFromWowhead(32235, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('throws WOWHEAD_FETCH_FAILED on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));
    await expect(fetchItemFromWowhead(32235, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('throws WOWHEAD_FETCH_FAILED when the item has no equip data (not equippable loot)', async () => {
    // e.g. a consumable or reagent: no `jsonequip` block at all, so no invType to map.
    const html = GATHERER_PAGE_HTML(6948, '"name_enus":"Hearthstone","quality":1,"icon":"inv_misc_rune_01"');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    await expect(fetchItemFromWowhead(6948, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('throws WOWHEAD_FETCH_FAILED on an unmapped inventory-type code', async () => {
    // slotbak 4 = shirt, explicitly not in the mapping table (not raidable loot).
    const fields =
      '"name_enus":"Brown Shirt","quality":1,"icon":"inv_shirt_brownshirt_01","jsonequip":{"slotbak":4}';
    const html = GATHERER_PAGE_HTML(4327, fields);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    await expect(fetchItemFromWowhead(4327, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('throws WOWHEAD_FETCH_FAILED when the item id is not present in the response', async () => {
    const html = GATHERER_PAGE_HTML(32235, CURSED_VISION_FIELDS);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    await expect(fetchItemFromWowhead(123456789, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('throws WOWHEAD_FETCH_FAILED when the page has no Gatherer data at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<html>Page Not Found</html>' }));
    await expect(fetchItemFromWowhead(32235, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('maps gameVersion to the correct Wowhead subdomain', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        return Promise.reject(new Error('stop here, just checking the URL'));
      }),
    );
    await fetchItemFromWowhead(1, 'classic-era').catch(() => {});
    expect(calls[0]).toContain('classic.wowhead.com');
    calls.length = 0;
    await fetchItemFromWowhead(1, 'tbc').catch(() => {});
    expect(calls[0]).toContain('tbc.wowhead.com');
  });
});

/**
 * Wowhead's search page (`/search?q=<name>`) embeds matching results with
 * the exact same `WH.Gatherer.addData(3, <dbVersion>, {...})` envelope as a
 * single item page — confirmed live against `/classic/search?q=thunderfury`
 * on 2026-09-07, which returned an addData(3,...) call keyed by item 19019
 * alongside an unrelated addData(6,...) spell call (the item's proc) that
 * must be ignored. Non-equippable results (no jsonequip) are skipped rather
 * than erroring, since a name search legitimately turns up reagents etc.
 */
describe('searchWowheadByName', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SEARCH_PAGE_HTML = `<html><body><script>
    WH.Gatherer.addData(3, 5, {
      "19019":{"name_enus":"Thunderfury, Blessed Blade of the Windseeker","quality":5,"icon":"inv_sword_39","jsonequip":{"slotbak":13}},
      "19020":{"name_enus":"Thunderfury Off-hand","quality":4,"icon":"inv_sword_04","jsonequip":{"slotbak":13}},
      "6948":{"name_enus":"Hearthstone","quality":1,"icon":"inv_misc_rune_01"}
    });
    WH.Gatherer.addData(6, 5, {"27648":{"name_enus":"Thunderfury (proc)","icon":"spell_nature_cyclone"}});
  </script></body></html>`;

  it('returns every equippable item from the search results, skipping non-equippable ones', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SEARCH_PAGE_HTML }));
    const results = await searchWowheadByName('thunderfury', 'classic-era');
    expect(results).toEqual([
      { itemId: 19019, name: 'Thunderfury, Blessed Blade of the Windseeker', quality: 5, icon: 'inv_sword_39', inventoryType: 'ONEHAND', slot: 'WEAPON' },
      { itemId: 19020, name: 'Thunderfury Off-hand', quality: 4, icon: 'inv_sword_04', inventoryType: 'ONEHAND', slot: 'WEAPON' },
    ]);
  });

  it('returns an empty array when nothing matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<html>No results</html>' }));
    expect(await searchWowheadByName('zzznonexistent', 'classic-era')).toEqual([]);
  });

  it('caps results at 10', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => `"${1000 + i}":{"name_enus":"Item ${i}","quality":1,"icon":"icon","jsonequip":{"slotbak":1}}`).join(',');
    const html = `<html><script>WH.Gatherer.addData(3, 5, {${entries}});</script></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const results = await searchWowheadByName('item', 'classic-era');
    expect(results.length).toBe(10);
  });

  it('throws WOWHEAD_FETCH_FAILED on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(searchWowheadByName('thunderfury', 'classic-era')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('URL-encodes the query and maps gameVersion to the correct subdomain', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        return Promise.resolve({ ok: true, text: async () => '<html></html>' });
      }),
    );
    await searchWowheadByName('a & b', 'tbc');
    expect(calls[0]).toContain('tbc.wowhead.com');
    expect(calls[0]).toContain(encodeURIComponent('a & b'));
  });
});
