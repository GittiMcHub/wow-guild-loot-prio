import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { iconUrl } from './ItemLabel';
import type { CatalogEntry } from '../lib/builder-types';
import { api, ApiError } from '../api';

interface FetchedItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: string;
  slot: string;
}

interface SearchResult {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
}

const QUALITY_COLOR: Record<number, string> = {
  0: 'text-zinc-500',
  1: 'text-zinc-200',
  2: 'text-green-400',
  3: 'text-blue-400',
  4: 'text-purple-400',
  5: 'text-orange-400',
  6: 'text-red-400',
  7: 'text-yellow-300',
};

interface Props {
  token: string;
  onPick: (item: CatalogEntry) => void;
  onCancel: () => void;
}

function toCatalogEntry(item: FetchedItem): CatalogEntry {
  return {
    itemId: item.itemId,
    name: item.name,
    quality: item.quality,
    slot: item.slot,
    inventoryType: item.inventoryType,
    icon: item.icon,
    source: null,
    classMask: null,
  };
}

export function OpenItemPicker({ token, onPick, onCancel }: Props) {
  const [input, setInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [pickingId, setPickingId] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const isNumeric = /^\d+$/.test(input);

  useEffect(() => {
    const next = isNumeric || input.trim().length < 2 ? '' : input.trim();
    const t = setTimeout(() => setDebouncedQuery(next), next ? 400 : 0);
    return () => clearTimeout(t);
  }, [input, isNumeric]);

  const search = useQuery<{ items: SearchResult[] }>({
    queryKey: ['open-item-search', debouncedQuery],
    queryFn: () => api.get<{ items: SearchResult[] }>(`/me/items/search?q=${encodeURIComponent(debouncedQuery)}`, token),
    enabled: debouncedQuery.length >= 2,
  });

  const preview = useQuery<FetchedItem>({
    queryKey: ['open-item-preview', previewId],
    queryFn: () => api.get<FetchedItem>(`/me/items/${previewId}/preview`, token),
    enabled: previewId !== null,
    retry: false,
  });

  /** Search results are already a confirmed match from a real Wowhead lookup
   * (name, icon, quality all shown before the click) — fetch full details
   * (for slot/inventoryType) and add in one click, no separate confirm step. */
  async function pickFromSearch(result: SearchResult) {
    setPickError(null);
    setPickingId(result.itemId);
    try {
      const item = await api.get<FetchedItem>(`/me/items/${result.itemId}/preview`, token);
      onPick(toCatalogEntry(item));
    } catch (err) {
      setPickError(err instanceof ApiError ? err.message : 'Could not look up this item.');
    } finally {
      setPickingId(null);
    }
  }

  return (
    <div className="rounded border border-zinc-700 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setPreviewId(null);
            setPickError(null);
          }}
          placeholder="Item ID or name…"
          className="input"
        />
        {isNumeric && (
          <button
            type="button"
            disabled={!input}
            onClick={() => setPreviewId(Number(input))}
            className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
          >
            Preview
          </button>
        )}
        <button type="button" onClick={onCancel} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>

      {!isNumeric && debouncedQuery.length >= 2 && (
        <div className="space-y-1">
          {search.isLoading && <p className="text-sm text-zinc-500">Searching…</p>}
          {search.isError && (
            <p className="text-sm text-red-400">{search.error instanceof ApiError ? search.error.message : 'Could not search Wowhead.'}</p>
          )}
          {search.data && search.data.items.length === 0 && <p className="text-sm text-zinc-500">No matches.</p>}
          {search.data?.items.map((item) => (
            <button
              key={item.itemId}
              type="button"
              disabled={pickingId !== null}
              onClick={() => pickFromSearch(item)}
              className="flex w-full items-center gap-2 rounded bg-zinc-900 px-2 py-1.5 text-left text-sm hover:bg-zinc-800 disabled:opacity-60"
            >
              {iconUrl(item.icon) && <img src={iconUrl(item.icon)!} alt="" className="h-6 w-6 rounded" />}
              <span className={QUALITY_COLOR[item.quality] ?? 'text-zinc-200'}>{item.name}</span>
              <span className="ml-auto text-xs text-zinc-600">{pickingId === item.itemId ? 'Adding…' : `#${item.itemId}`}</span>
            </button>
          ))}
          {pickError && <p className="text-sm text-red-400">{pickError}</p>}
        </div>
      )}

      {preview.isError && (
        <p className="text-sm text-red-400">
          {preview.error instanceof ApiError ? preview.error.message : 'Could not look up this item.'}
        </p>
      )}
      {preview.data && (
        <button
          type="button"
          onClick={() => onPick(toCatalogEntry(preview.data!))}
          className="flex w-full items-center gap-2 rounded bg-emerald-700 px-3 py-2 text-left text-sm hover:bg-emerald-600"
        >
          {iconUrl(preview.data.icon) && <img src={iconUrl(preview.data.icon)!} alt="" className="h-6 w-6 rounded" />}
          <span className={QUALITY_COLOR[preview.data.quality] ?? ''}>{preview.data.name}</span>
          <span className="ml-auto">— add to list</span>
        </button>
      )}
    </div>
  );
}
