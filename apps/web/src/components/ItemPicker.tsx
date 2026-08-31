import { useMemo, useState } from 'react';
import type { Slot } from '@glps/core';
import type { CatalogEntry } from '../lib/builder-types';
import { itemLooksValidForSlot } from '../lib/builder-types';

const QUALITY_COLOR: Record<number, string> = {
  1: 'text-zinc-400',
  2: 'text-green-400',
  3: 'text-blue-400',
  4: 'text-purple-400',
  5: 'text-orange-400',
};

interface Props {
  slot: Slot;
  catalog: CatalogEntry[];
  onPick: (item: CatalogEntry) => void;
  onCancel: () => void;
}

/** Searchable by name and by item ID (§11.2). */
export function ItemPicker({ slot, catalog, onPick, onCancel }: Props) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchesQuery = (item: CatalogEntry) => !q || item.name.toLowerCase().includes(q) || String(item.itemId) === q;
    const candidates = catalog.filter(matchesQuery);
    const inFamily = candidates.filter((i) => itemLooksValidForSlot(i, slot));
    // Prefer items that plausibly fit the slot, but never hide the rest of the catalog.
    const rest = candidates.filter((i) => !itemLooksValidForSlot(i, slot));
    return [...inFamily, ...rest].slice(0, 30);
  }, [catalog, query, slot]);

  return (
    <div className="rounded border border-zinc-700 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or item ID…"
          className="input"
        />
        <button type="button" onClick={onCancel} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {results.map((item) => (
          <li key={item.itemId}>
            <button
              type="button"
              onClick={() => onPick(item)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-800"
            >
              <span className={QUALITY_COLOR[item.quality] ?? 'text-zinc-200'}>{item.name}</span>
              <span className="text-xs text-zinc-500">{item.source}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="px-2 py-1.5 text-sm text-zinc-500">No matching items.</li>}
      </ul>
    </div>
  );
}
