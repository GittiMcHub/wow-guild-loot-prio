import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface PhaseSettingsOverride {
  listSize?: number;
  twohandConsumesOffhand?: boolean;
  allowAltOffspecInOffList?: boolean;
  requireFullList?: boolean;
  ownedItemsPriority?: 'TOP' | 'BOTTOM';
}

interface Phase {
  id: string;
  key: string;
  name: string;
  status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'ARCHIVED';
  itemPoolMode: 'PREDEFINED' | 'OPEN';
  settingsOverride: PhaseSettingsOverride | null;
}

type BoolMode = 'INHERIT' | 'ON' | 'OFF';

/** One row of the settings-override panel: a single select replaces the old
 * pair of ambiguous checkboxes ("enable override" + "value") — the select's
 * current option IS the state, nothing to cross-reference. */
function BoolSettingRow({ label, mode, onChange }: { label: string; mode: BoolMode; onChange: (mode: BoolMode) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-56 text-zinc-400">{label}</span>
      <select value={mode} onChange={(e) => onChange(e.target.value as BoolMode)} className="input max-w-[12rem]">
        <option value="INHERIT">Inherit guild default</option>
        <option value="ON">On</option>
        <option value="OFF">Off</option>
      </select>
    </label>
  );
}

interface PhaseItem {
  itemId: number;
  name: string;
  quality: number;
  slot: string;
  source: string | null;
  acquiredViaItemId: number | null;
  acquiredViaName: string | null;
  acquiredViaIcon: string | null;
}

interface FetchedItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: string;
  slot: string;
}

interface BasicWowheadItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
}

const INVENTORY_TYPES = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'TRINKET', 'ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD', 'RANGED', 'RELIC'];

// Mirrors SLOT_BY_INVENTORY_TYPE in apps/api/src/services/wowhead-item.ts: the catalog
// collapses all one/two-hand, offhand and shield inventory types into a single WEAPON
// slot; everything else maps to itself. A manual inventory-type correction must apply
// the same collapse, not copy the inventory type into slot verbatim.
const WEAPON_INVENTORY_TYPES = new Set(['ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD']);
function slotForInventoryType(inventoryType: string): string {
  return WEAPON_INVENTORY_TYPES.has(inventoryType) ? 'WEAPON' : inventoryType;
}

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
  const [tokenIdInput, setTokenIdInput] = useState('');
  const [acquiredVia, setAcquiredVia] = useState<BasicWowheadItem | null>(null);
  const [tokenFetchError, setTokenFetchError] = useState<string | null>(null);

  const [listSizeMode, setListSizeMode] = useState<'INHERIT' | 'CUSTOM'>('INHERIT');
  const [listSizeValue, setListSizeValue] = useState(20);
  const [twohandMode, setTwohandMode] = useState<BoolMode>('INHERIT');
  const [altOffspecMode, setAltOffspecMode] = useState<BoolMode>('INHERIT');
  const [requireFullListMode, setRequireFullListMode] = useState<BoolMode>('INHERIT');
  const [ownedItemsPriorityMode, setOwnedItemsPriorityMode] = useState<'INHERIT' | 'TOP' | 'BOTTOM'>('INHERIT');
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(false);

  const phase = useQuery<Phase>({ queryKey: ['admin-phase', phaseId], queryFn: () => api.get<Phase>(`/phases/${phaseId}`) });
  const items = useQuery<{ items: PhaseItem[] }>({ queryKey: ['admin-phase-items', phaseId], queryFn: () => api.get(`/phases/${phaseId}/items`) });

  useEffect(() => {
    if (settingsDraftLoaded || !phase.data) return;
    const override = phase.data.settingsOverride;
    const boolMode = (v: boolean | undefined): BoolMode => (v === undefined ? 'INHERIT' : v ? 'ON' : 'OFF');
    // One-time draft seed from server data on first load, not a sync loop — safe to batch.
    /* eslint-disable react-hooks/set-state-in-effect */
    setListSizeMode(override?.listSize !== undefined ? 'CUSTOM' : 'INHERIT');
    setListSizeValue(override?.listSize ?? 20);
    setTwohandMode(boolMode(override?.twohandConsumesOffhand));
    setAltOffspecMode(boolMode(override?.allowAltOffspecInOffList));
    setRequireFullListMode(boolMode(override?.requireFullList));
    setOwnedItemsPriorityMode(override?.ownedItemsPriority ?? 'INHERIT');
    setSettingsDraftLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
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
    if (listSizeMode === 'CUSTOM') draft.listSize = listSizeValue;
    if (twohandMode !== 'INHERIT') draft.twohandConsumesOffhand = twohandMode === 'ON';
    if (altOffspecMode !== 'INHERIT') draft.allowAltOffspecInOffList = altOffspecMode === 'ON';
    if (requireFullListMode !== 'INHERIT') draft.requireFullList = requireFullListMode === 'ON';
    if (ownedItemsPriorityMode !== 'INHERIT') draft.ownedItemsPriority = ownedItemsPriorityMode;
    settingsMutation.mutate(Object.keys(draft).length === 0 ? null : draft);
  };

  const fetchMutation = useMutation({
    mutationFn: (itemId: number) => api.post<FetchedItem>(`/phases/${phaseId}/items/fetch`, { itemId }),
    onSuccess: (item) => {
      setFetchError(null);
      setPreview(item);
      setAcquiredVia(null);
      setTokenIdInput('');
      setTokenFetchError(null);
    },
    onError: (err) => {
      setFetchError(err instanceof ApiError ? err.message : 'Fetch failed.');
      setPreview({ itemId: Number(itemIdInput), name: '', quality: 4, icon: null, inventoryType: 'HEAD', slot: 'HEAD' });
    },
  });

  const attachMutation = useMutation({
    mutationFn: (item: FetchedItem) =>
      api.post('/phases/' + phaseId + '/items', {
        ...item,
        acquiredVia: acquiredVia ? { itemId: acquiredVia.itemId, name: acquiredVia.name, icon: acquiredVia.icon } : null,
      }),
    onSuccess: () => {
      setAttachError(null);
      setPreview(null);
      setItemIdInput('');
      setAcquiredVia(null);
      setTokenIdInput('');
      queryClient.invalidateQueries({ queryKey: ['admin-phase-items', phaseId] });
    },
    onError: (err) => {
      setAttachError(err instanceof ApiError ? err.message : 'Attach failed.');
    },
  });

  const tokenFetchMutation = useMutation({
    mutationFn: (tokenItemId: number) => api.post<BasicWowheadItem>(`/phases/${phaseId}/tokens/fetch`, { itemId: tokenItemId }),
    onSuccess: (item) => {
      setTokenFetchError(null);
      setAcquiredVia(item);
    },
    onError: (err) => {
      setTokenFetchError(err instanceof ApiError ? err.message : 'Fetch failed.');
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
        <p className="mb-3 text-sm text-zinc-500">Override the guild's default settings for this phase only. "Inherit guild default" leaves that setting alone.</p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="w-56 text-zinc-400">List size</span>
            <select value={listSizeMode} onChange={(e) => setListSizeMode(e.target.value as 'INHERIT' | 'CUSTOM')} className="input max-w-[12rem]">
              <option value="INHERIT">Inherit guild default</option>
              <option value="CUSTOM">Custom</option>
            </select>
            {listSizeMode === 'CUSTOM' && (
              <input
                type="number"
                min={1}
                max={40}
                value={listSizeValue}
                onChange={(e) => setListSizeValue(Number(e.target.value))}
                className="input max-w-[6rem]"
              />
            )}
          </label>
          <BoolSettingRow label="Twohand consumes offhand" mode={twohandMode} onChange={setTwohandMode} />
          <BoolSettingRow label="Allow alt offspec in off-list" mode={altOffspecMode} onChange={setAltOffspecMode} />
          <BoolSettingRow label="Require full list" mode={requireFullListMode} onChange={setRequireFullListMode} />
          <label className="flex items-center gap-2 text-sm">
            <span className="w-56 text-zinc-400">Already-owned items consume priority from the</span>
            <select
              value={ownedItemsPriorityMode}
              onChange={(e) => setOwnedItemsPriorityMode(e.target.value as 'INHERIT' | 'TOP' | 'BOTTOM')}
              className="input max-w-[12rem]"
            >
              <option value="INHERIT">Inherit guild default</option>
              <option value="TOP">Top</option>
              <option value="BOTTOM">Bottom</option>
            </select>
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
              <select value={preview.inventoryType} onChange={(e) => setPreview({ ...preview, inventoryType: e.target.value, slot: slotForInventoryType(e.target.value) })} className="input">
                {INVENTORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <div className="rounded border border-zinc-800 p-2">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Acquired via (optional)</p>
              <p className="mb-2 text-xs text-zinc-500">
                Set this if the item above doesn't itself drop — e.g. a tier token or quest item produces it instead.
              </p>
              {acquiredVia ? (
                <div className="flex items-center gap-2 text-sm">
                  {acquiredVia.icon && <img src={`https://wow.zamimg.com/images/wow/icons/medium/${acquiredVia.icon}.jpg`} alt="" className="h-5 w-5 rounded" />}
                  <span className="text-amber-400">
                    {acquiredVia.name} <span className="text-xs text-zinc-500">#{acquiredVia.itemId}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAcquiredVia(null);
                      setTokenIdInput('');
                    }}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={tokenIdInput}
                    onChange={(e) => setTokenIdInput(e.target.value)}
                    placeholder="Token/quest item ID"
                    className="input max-w-[10rem]"
                  />
                  <button
                    type="button"
                    onClick={() => tokenFetchMutation.mutate(Number(tokenIdInput))}
                    disabled={!/^\d+$/.test(tokenIdInput) || tokenFetchMutation.isPending}
                    className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {tokenFetchMutation.isPending ? 'Fetching…' : 'Fetch'}
                  </button>
                </div>
              )}
              {tokenFetchError && <p className="mt-2 text-sm text-red-400">{tokenFetchError}</p>}
            </div>

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
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={QUALITY_COLOR[item.quality] ?? ''}>
                {item.name} <span className="text-xs text-zinc-500">#{item.itemId}</span>
              </span>
              {item.acquiredViaItemId && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-950/40 px-1.5 py-0.5 text-xs text-amber-400">
                  🎟 via {item.acquiredViaName ?? `Item ${item.acquiredViaItemId}`} (#{item.acquiredViaItemId})
                </span>
              )}
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
