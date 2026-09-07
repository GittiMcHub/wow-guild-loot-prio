import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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

interface Props {
  onPick: (item: CatalogEntry) => void;
  onCancel: () => void;
}

export function OpenItemPicker({ onPick, onCancel }: Props) {
  const [itemIdInput, setItemIdInput] = useState('');
  const [previewId, setPreviewId] = useState<number | null>(null);

  const preview = useQuery<FetchedItem>({
    queryKey: ['open-item-preview', previewId],
    queryFn: () => api.get<FetchedItem>(`/me/items/${previewId}/preview`),
    enabled: previewId !== null,
    retry: false,
  });

  return (
    <div className="rounded border border-zinc-700 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={itemIdInput}
          onChange={(e) => {
            setItemIdInput(e.target.value);
            setPreviewId(null);
          }}
          placeholder="Item ID…"
          className="input"
        />
        <button
          type="button"
          disabled={!/^\d+$/.test(itemIdInput)}
          onClick={() => setPreviewId(Number(itemIdInput))}
          className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
        >
          Preview
        </button>
        <button type="button" onClick={onCancel} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>
      {preview.isError && (
        <p className="text-sm text-red-400">
          {preview.error instanceof ApiError ? preview.error.message : 'Could not look up this item.'}
        </p>
      )}
      {preview.data && (
        <button
          type="button"
          onClick={() =>
            onPick({
              itemId: preview.data!.itemId,
              name: preview.data!.name,
              quality: preview.data!.quality,
              slot: preview.data!.slot,
              inventoryType: preview.data!.inventoryType,
              icon: preview.data!.icon,
              source: null,
              classMask: null,
            })
          }
          className="w-full rounded bg-emerald-700 px-3 py-2 text-left text-sm hover:bg-emerald-600"
        >
          {preview.data.name} — add to list
        </button>
      )}
    </div>
  );
}
