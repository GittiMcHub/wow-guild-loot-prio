import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface PhaseSettingsOverride {
  listSize?: number;
  twohandConsumesOffhand?: boolean;
  allowAltOffspecInOffList?: boolean;
  requireFullList?: boolean;
}

interface Phase {
  id: string;
  key: string;
  name: string;
  status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'ARCHIVED';
  itemPoolMode: 'PREDEFINED' | 'OPEN';
  settingsOverride: PhaseSettingsOverride | null;
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
  const [attachError, setAttachError] = useState<string | null>(null);

  const [listSizeEnabled, setListSizeEnabled] = useState(false);
  const [listSizeValue, setListSizeValue] = useState(20);
  const [twohandEnabled, setTwohandEnabled] = useState(false);
  const [twohandValue, setTwohandValue] = useState(false);
  const [altOffspecEnabled, setAltOffspecEnabled] = useState(false);
  const [altOffspecValue, setAltOffspecValue] = useState(false);
  const [requireFullListEnabled, setRequireFullListEnabled] = useState(false);
  const [requireFullListValue, setRequireFullListValue] = useState(false);
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(false);

  const phase = useQuery<Phase>({ queryKey: ['admin-phase', phaseId], queryFn: () => api.get<Phase>(`/phases/${phaseId}`) });
  const items = useQuery<{ items: PhaseItem[] }>({ queryKey: ['admin-phase-items', phaseId], queryFn: () => api.get(`/phases/${phaseId}/items`) });

  useEffect(() => {
    if (settingsDraftLoaded || !phase.data) return;
    const override = phase.data.settingsOverride;
    setListSizeEnabled(override?.listSize !== undefined);
    setListSizeValue(override?.listSize ?? 20);
    setTwohandEnabled(override?.twohandConsumesOffhand !== undefined);
    setTwohandValue(override?.twohandConsumesOffhand ?? false);
    setAltOffspecEnabled(override?.allowAltOffspecInOffList !== undefined);
    setAltOffspecValue(override?.allowAltOffspecInOffList ?? false);
    setRequireFullListEnabled(override?.requireFullList !== undefined);
    setRequireFullListValue(override?.requireFullList ?? false);
    setSettingsDraftLoaded(true);
  }, [phase.data, settingsDraftLoaded]);

  const statusMutation = useMutation({
    mutationFn: (status: Phase['status']) => api.patch(`/phases/${phaseId}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });

  const poolModeMutation = useMutation({
    mutationFn: (itemPoolMode: 'PREDEFINED' | 'OPEN') => api.patch(`/phases/${phaseId}`, { itemPoolMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });

  const settingsMutation = useMutation({
    mutationFn: (settingsOverride: Phase['settingsOverride']) => api.patch(`/phases/${phaseId}`, { settingsOverride }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });

  const saveSettings = () => {
    const draft: PhaseSettingsOverride = {};
    if (listSizeEnabled) draft.listSize = listSizeValue;
    if (twohandEnabled) draft.twohandConsumesOffhand = twohandValue;
    if (altOffspecEnabled) draft.allowAltOffspecInOffList = altOffspecValue;
    if (requireFullListEnabled) draft.requireFullList = requireFullListValue;
    settingsMutation.mutate(Object.keys(draft).length === 0 ? null : draft);
  };

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
      setAttachError(null);
      setPreview(null);
      setItemIdInput('');
      queryClient.invalidateQueries({ queryKey: ['admin-phase-items', phaseId] });
    },
    onError: (err) => {
      setAttachError(err instanceof ApiError ? err.message : 'Attach failed.');
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
        <h2 className="mb-2 font-medium text-zinc-300">Item pool</h2>
        <div className="flex gap-2">
          {(['PREDEFINED', 'OPEN'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => poolModeMutation.mutate(mode)}
              className={`rounded px-3 py-1.5 text-sm ${phase.data.itemPoolMode === mode ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            >
              {mode === 'PREDEFINED' ? 'Predefined catalog' : 'Open (players enter item IDs)'}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 font-medium text-zinc-300">Settings override</h2>
        <p className="mb-3 text-sm text-zinc-500">Override the guild's default settings for this phase only. Unchecked fields inherit the guild default.</p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={listSizeEnabled} onChange={(e) => setListSizeEnabled(e.target.checked)} />
            <span className="w-40 text-zinc-400">List size</span>
            <input
              type="number"
              min={1}
              max={40}
              value={listSizeValue}
              onChange={(e) => setListSizeValue(Number(e.target.value))}
              disabled={!listSizeEnabled}
              className="input max-w-[6rem] disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={twohandEnabled} onChange={(e) => setTwohandEnabled(e.target.checked)} />
            <span className="w-40 text-zinc-400">Twohand consumes offhand</span>
            <input type="checkbox" checked={twohandValue} onChange={(e) => setTwohandValue(e.target.checked)} disabled={!twohandEnabled} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={altOffspecEnabled} onChange={(e) => setAltOffspecEnabled(e.target.checked)} />
            <span className="w-40 text-zinc-400">Allow alt offspec in off-list</span>
            <input type="checkbox" checked={altOffspecValue} onChange={(e) => setAltOffspecValue(e.target.checked)} disabled={!altOffspecEnabled} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requireFullListEnabled} onChange={(e) => setRequireFullListEnabled(e.target.checked)} />
            <span className="w-40 text-zinc-400">Require full list</span>
            <input type="checkbox" checked={requireFullListValue} onChange={(e) => setRequireFullListValue(e.target.checked)} disabled={!requireFullListEnabled} />
          </label>
        </div>
        <button
          onClick={saveSettings}
          disabled={settingsMutation.isPending}
          className="mt-3 rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {settingsMutation.isPending ? 'Saving…' : 'Save settings'}
        </button>
        {settingsMutation.isSuccess && <p className="mt-2 text-sm text-emerald-400">Saved.</p>}
        {settingsMutation.isError && <p className="mt-2 text-sm text-red-400">Failed to save settings.</p>}
      </div>

      {phase.data.itemPoolMode === 'OPEN' && (
        <p className="mb-4 text-sm text-zinc-500">
          This phase is in Open mode — players enter item IDs directly on their own priority list. There's no catalog to curate here.
        </p>
      )}

      {phase.data.itemPoolMode === 'PREDEFINED' && (
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
            disabled={!/^\d+$/.test(itemIdInput) || fetchMutation.isPending}
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
          >
            {fetchMutation.isPending ? 'Fetching…' : 'Fetch from Wowhead'}
          </button>
        </div>
        {fetchError && <p className="mt-2 text-sm text-amber-400">{fetchError} — enter details manually below.</p>}
        {attachError && <p className="mt-2 text-sm text-red-400">{attachError}</p>}

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
      )}

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
