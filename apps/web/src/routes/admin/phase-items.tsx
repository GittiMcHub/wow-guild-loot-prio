import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface Phase {
  id: string;
  key: string;
  name: string;
  status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'ARCHIVED';
}

interface PhaseItem {
  itemId: number;
  name: string;
  quality: number;
  slot: string;
  source: string | null;
}

interface FetchedItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: string;
  slot: string;
}

const INVENTORY_TYPES = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'TRINKET', 'ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD', 'RANGED', 'RELIC'];

const NEXT_STATUS: Record<Phase['status'], Array<{ to: Phase['status']; label: string }>> = {
  DRAFT: [{ to: 'OPEN', label: 'Open' }],
  OPEN: [{ to: 'LOCKED', label: 'Lock' }],
  LOCKED: [{ to: 'ARCHIVED', label: 'Archive' }, { to: 'OPEN', label: 'Reopen' }],
  ARCHIVED: [],
};

const QUALITY_COLOR: Record<number, string> = { 1: 'text-zinc-400', 2: 'text-green-400', 3: 'text-blue-400', 4: 'text-purple-400', 5: 'text-orange-400' };

export function AdminPhaseItemsPage({ phaseId }: { phaseId: string }) {
  const queryClient = useQueryClient();
  const [itemIdInput, setItemIdInput] = useState('');
  const [preview, setPreview] = useState<FetchedItem | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const phase = useQuery<Phase>({ queryKey: ['admin-phase', phaseId], queryFn: () => api.get<Phase>(`/phases/${phaseId}`) });
  const items = useQuery<{ items: PhaseItem[] }>({ queryKey: ['admin-phase-items', phaseId], queryFn: () => api.get(`/phases/${phaseId}/items`) });

  const statusMutation = useMutation({
    mutationFn: (status: Phase['status']) => api.patch(`/phases/${phaseId}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });

  const fetchMutation = useMutation({
    mutationFn: (itemId: number) => api.post<FetchedItem>(`/phases/${phaseId}/items/fetch`, { itemId }),
    onSuccess: (item) => {
      setFetchError(null);
      setPreview(item);
    },
    onError: (err) => {
      setFetchError(err instanceof ApiError ? err.message : 'Fetch failed.');
      setPreview({ itemId: Number(itemIdInput), name: '', quality: 4, icon: null, inventoryType: 'HEAD', slot: 'HEAD' });
    },
  });

  const attachMutation = useMutation({
    mutationFn: (item: FetchedItem) => api.post('/phases/' + phaseId + '/items', item),
    onSuccess: () => {
      setPreview(null);
      setItemIdInput('');
      queryClient.invalidateQueries({ queryKey: ['admin-phase-items', phaseId] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (itemId: number) => api.del(`/phases/${phaseId}/items/${itemId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase-items', phaseId] }),
  });

  if (phase.isLoading) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  if (!phase.data) return <p className="p-6 text-sm text-red-400">Phase not found.</p>;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{phase.data.name}</h1>
          <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400">{phase.data.status}</span>
        </div>
        <div className="mt-2 flex gap-2">
          {NEXT_STATUS[phase.data.status].map((t) => (
            <button
              key={t.to}
              onClick={() => statusMutation.mutate(t.to)}
              disabled={statusMutation.isPending}
              className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="mb-4 rounded border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 font-medium text-zinc-300">Add item</h2>
        <div className="flex gap-2">
          <input
            value={itemIdInput}
            onChange={(e) => setItemIdInput(e.target.value)}
            placeholder="Item ID"
            className="input max-w-[10rem]"
          />
          <button
            onClick={() => fetchMutation.mutate(Number(itemIdInput))}
            disabled={!itemIdInput || fetchMutation.isPending}
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
          >
            {fetchMutation.isPending ? 'Fetching…' : 'Fetch from Wowhead'}
          </button>
        </div>
        {fetchError && <p className="mt-2 text-sm text-amber-400">{fetchError} — enter details manually below.</p>}

        {preview && (
          <div className="mt-3 space-y-2 rounded border border-zinc-800 p-3">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">Name</span>
              <input value={preview.name} onChange={(e) => setPreview({ ...preview, name: e.target.value })} className="input" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">Quality (0-7)</span>
              <input type="number" min={0} max={7} value={preview.quality} onChange={(e) => setPreview({ ...preview, quality: Number(e.target.value) })} className="input" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">Inventory type</span>
              <select value={preview.inventoryType} onChange={(e) => setPreview({ ...preview, inventoryType: e.target.value, slot: e.target.value })} className="input">
                {INVENTORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => attachMutation.mutate(preview)}
              disabled={!preview.name || attachMutation.isPending}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500 disabled:opacity-50"
            >
              Confirm & add
            </button>
          </div>
        )}
      </div>

      <h2 className="mb-2 font-medium text-zinc-300">Items in this phase</h2>
      <ul className="space-y-1">
        {items.data?.items.map((item) => (
          <li key={item.itemId} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
            <span className={QUALITY_COLOR[item.quality] ?? ''}>
              {item.name} <span className="text-xs text-zinc-500">#{item.itemId}</span>
            </span>
            <button onClick={() => removeMutation.mutate(item.itemId)} className="text-xs text-red-400 hover:text-red-300">
              Remove
            </button>
          </li>
        ))}
      </ul>
      {items.data && items.data.items.length === 0 && <p className="text-sm text-zinc-500">No items yet.</p>}
    </div>
  );
}
