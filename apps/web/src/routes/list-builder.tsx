import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { computeCapacity, validateSubmission, type EntryInput, type ListTier, type Slot } from '@glps/core';
import { api, ApiError } from '../api';
import { ItemPicker } from '../components/ItemPicker';
import { PriorityLadder } from '../components/PriorityLadder';
import { ALL_SLOTS, type BuilderState, type CatalogEntry, type CharacterInfo, type DraftEntry } from '../lib/builder-types';

interface Me {
  player: { displayName: string };
  characters: CharacterInfo[];
  submissionStatus: 'DRAFT' | 'SUBMITTED';
  phase: { name: string; status: string; submissionsCloseAt: string | null; open: boolean } | null;
  settings: { listSize: number; twohandConsumesOffhand: boolean; allowAltOffspecInOffList: boolean; requireFullList: boolean } | null;
}

interface SubmissionEntryRow {
  id: string;
  characterId: string;
  list: ListTier;
  rank: number;
  slot: string;
  itemId: number;
  spec: string;
  note: string | null;
  fulfilledAt: string | null;
}

interface SubmissionResponse {
  status: 'DRAFT' | 'SUBMITTED';
  entries: SubmissionEntryRow[];
}

const SLOT_LABEL: Record<Slot, string> = {
  HEAD: 'Head', NECK: 'Neck', SHOULDER: 'Shoulder', BACK: 'Back', CHEST: 'Chest', WRIST: 'Wrist',
  HANDS: 'Hands', WAIST: 'Waist', LEGS: 'Legs', FEET: 'Feet', FINGER_1: 'Ring 1', FINGER_2: 'Ring 2',
  TRINKET_1: 'Trinket 1', TRINKET_2: 'Trinket 2', MAIN_HAND: 'Main hand', OFF_HAND: 'Off hand', RANGED: 'Ranged',
};

function specFor(character: CharacterInfo, list: ListTier, useOffSpec: boolean): string {
  if (list === 'MAIN') return character.mainSpec;
  if (character.slotIndex === 1) return character.offSpec ?? character.mainSpec;
  return useOffSpec && character.offSpec ? character.offSpec : character.mainSpec;
}

/** The PUT payload needs `note` too; @glps/core's EntryInput doesn't carry it. */
type EntryInputWithNote = EntryInput & { note?: string };

function toEntryInputs(state: BuilderState): EntryInputWithNote[] {
  const out: EntryInputWithNote[] = [];
  (['MAIN', 'OFF'] as const).forEach((list) => {
    state[list].forEach((e, i) => {
      out.push({ characterId: e.characterId, list, rank: i + 1, slot: e.slot, itemId: e.itemId, spec: e.spec, note: e.note });
    });
  });
  return out;
}

export function ListBuilderPage({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const me = useQuery<Me>({ queryKey: ['me', token], queryFn: () => api.get<Me>('/me', token) });
  const submission = useQuery<SubmissionResponse>({
    queryKey: ['me-submission', token],
    queryFn: () => api.get<SubmissionResponse>('/me/submission', token),
    enabled: !!me.data,
  });
  const catalog = useQuery<{ items: CatalogEntry[] }>({
    queryKey: ['me-items', token],
    queryFn: () => api.get<{ items: CatalogEntry[] }>('/me/items', token),
    enabled: !!me.data,
  });

  const [tab, setTab] = useState<ListTier>('MAIN');
  const [state, setState] = useState<BuilderState | null>(null);
  const [addingFor, setAddingFor] = useState<{ slot: Slot; characterId: string; useOffSpec: boolean } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitConfirmText, setSubmitConfirmText] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstLoad = useRef(true);
  const [seededFrom, setSeededFrom] = useState<SubmissionResponse | undefined>(undefined);

  // Seed local state from the server exactly once per submission load — the
  // "adjusting state when a prop changes" pattern (setState during render,
  // not in an effect), so local edits never get clobbered by a refetch.
  if (submission.data && submission.data !== seededFrom) {
    setSeededFrom(submission.data);
    const next: BuilderState = { MAIN: [], OFF: [] };
    for (const e of [...submission.data.entries].sort((a, b) => a.rank - b.rank)) {
      next[e.list].push({ key: e.id, characterId: e.characterId, slot: e.slot as Slot, itemId: e.itemId, spec: e.spec, note: e.note ?? undefined });
    }
    setState(next);
  }

  const catalogByItemId = useMemo(() => new Map((catalog.data?.items ?? []).map((i) => [i.itemId, i])), [catalog.data]);
  const characterNameById = useMemo(() => new Map((me.data?.characters ?? []).map((c) => [c.id, c.name])), [me.data]);

  const lookupInventoryType = (itemId: number) => catalogByItemId.get(itemId)?.inventoryType ?? 'HEAD';
  const lookupItem = (itemId: number) => {
    const item = catalogByItemId.get(itemId);
    return item ? { itemId: item.itemId, inventoryType: item.inventoryType as never, classMask: item.classMask ?? undefined } : undefined;
  };

  const capacity = useMemo(() => {
    if (!state || !me.data?.settings) return null;
    const inputs = toEntryInputs(state);
    const settings = { listSize: me.data.settings.listSize, twohandConsumesOffhand: me.data.settings.twohandConsumesOffhand };
    return {
      MAIN: computeCapacity(inputs, 'MAIN', settings, lookupInventoryType),
      OFF: computeCapacity(inputs, 'OFF', settings, lookupInventoryType),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, me.data?.settings, catalogByItemId]);

  const validation = useMemo(() => {
    if (!state || !me.data?.settings || !me.data.characters.length) return null;
    return validateSubmission(toEntryInputs(state), {
      settings: me.data.settings,
      reservedCharacters: me.data.characters.map((c) => ({ characterId: c.id, slotIndex: c.slotIndex, mainSpec: c.mainSpec, offSpec: c.offSpec ?? undefined })),
      lookupItem,
      submissionStatus: 'DRAFT',
      phaseOpen: me.data.phase?.open ?? false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, me.data]);

  // Debounced autosave whenever the draft changes.
  useEffect(() => {
    if (!state) return;
    if (isFirstLoad.current) {
      isFirstLoad.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveStatus('saving');
    debounceRef.current = setTimeout(async () => {
      try {
        await api.put('/me/submission', { entries: toEntryInputs(state) }, token);
        setSaveStatus('saved');
        setSaveError(null);
      } catch (err) {
        setSaveStatus('error');
        setSaveError(err instanceof ApiError ? err.message : 'Failed to save.');
      }
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (me.isLoading || submission.isLoading) return <Centered>Loading…</Centered>;
  if (me.error) return <Centered>{me.error instanceof ApiError ? me.error.message : 'This link is no longer valid.'}</Centered>;

  if (me.data!.submissionStatus === 'SUBMITTED') {
    return <ReadOnlyView me={me.data!} entries={submission.data?.entries ?? []} catalogByItemId={catalogByItemId} characterNameById={characterNameById} />;
  }

  if (!state || !capacity || !me.data!.settings) return <Centered>Loading…</Centered>;

  const characters = me.data!.characters;
  const cap = capacity[tab];
  const blockedCharacterIds = new Set(cap.blockedSlots.map((b) => b.characterId));

  function tryAdd(character: CharacterInfo, slot: Slot, item: CatalogEntry, useOffSpec: boolean) {
    setRefusal(null);
    const spec = specFor(character, tab, useOffSpec);
    const newEntry: DraftEntry = { key: crypto.randomUUID(), characterId: character.id, slot, itemId: item.itemId, spec };
    const next: BuilderState = { ...state!, [tab]: [...state![tab], newEntry] };

    const settings = { listSize: me.data!.settings!.listSize, twohandConsumesOffhand: me.data!.settings!.twohandConsumesOffhand };
    const nextCapacity = computeCapacity(toEntryInputs(next), tab, settings, lookupInventoryType);
    if (next[tab].length > nextCapacity.effective) {
      setRefusal(`Adding this would need ${next[tab].length} ranks, but the ${tab === 'MAIN' ? 'main' : 'off'} list only has room for ${nextCapacity.effective}. Remove an entry first.`);
      return;
    }
    if (settings.twohandConsumesOffhand) {
      const hasTwoHand = state![tab].some((e) => e.characterId === character.id && e.slot === 'MAIN_HAND' && lookupInventoryType(e.itemId) === 'TWOHAND');
      const hasOffHand = state![tab].some((e) => e.characterId === character.id && e.slot === 'OFF_HAND');
      if (slot === 'OFF_HAND' && hasTwoHand) {
        setRefusal(`${character.name} already lists a two-handed weapon in this list — it uses both hands. Remove it first to add an off-hand wish.`);
        return;
      }
      if (slot === 'MAIN_HAND' && item.inventoryType === 'TWOHAND' && hasOffHand) {
        setRefusal(`${character.name} already has an off-hand wish in this list. A two-handed weapon uses both hands — remove the off-hand entry first.`);
        return;
      }
    }
    setState(next);
    setAddingFor(null);
  }

  function removeEntry(key: string) {
    setState((prev) => (prev ? { ...prev, [tab]: prev[tab].filter((e) => e.key !== key) } : prev));
  }

  function reorder(next: DraftEntry[]) {
    setState((prev) => (prev ? { ...prev, [tab]: next } : prev));
  }

  function updateNote(key: string, note: string) {
    setState((prev) => (prev ? { ...prev, [tab]: prev[tab].map((e) => (e.key === key ? { ...e, note } : e)) } : prev));
  }

  async function submit() {
    try {
      await api.post('/me/submission/submit', {}, token);
      await queryClient.invalidateQueries({ queryKey: ['me', token] });
      await queryClient.invalidateQueries({ queryKey: ['me-submission', token] });
      setShowSubmitModal(false);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Failed to submit.');
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{me.data!.player.displayName}</h1>
          <p className="text-sm text-zinc-400">{me.data!.phase?.name}</p>
        </div>
        <SaveIndicator status={saveStatus} error={saveError} />
      </header>

      <div className="mb-4 flex gap-2">
        {(['MAIN', 'OFF'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-4 py-2 text-sm font-medium ${tab === t ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
          >
            {t === 'MAIN' ? 'Main list' : 'Off list'}
          </button>
        ))}
      </div>

      <ValidationPanel validation={validation} refusal={refusal} />

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <h2 className="mb-2 font-medium text-zinc-300">Slots</h2>
          <div className="space-y-2">
            {ALL_SLOTS.map((slot) => (
              <SlotRow
                key={slot}
                slot={slot}
                tab={tab}
                characters={characters}
                entries={state[tab]}
                addingFor={addingFor}
                settings={me.data!.settings!}
                catalog={catalog.data?.items ?? []}
                onOpenAdd={(characterId) => setAddingFor({ slot, characterId, useOffSpec: false })}
                onToggleOffSpec={(v) => setAddingFor((prev) => (prev ? { ...prev, useOffSpec: v } : prev))}
                onCancelAdd={() => setAddingFor(null)}
                onPick={(character, item) => tryAdd(character, slot, item, addingFor?.useOffSpec ?? false)}
              />
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-2 font-medium text-zinc-300">Priority ladder</h2>
          <PriorityLadder
            entries={state[tab]}
            effectiveCapacity={cap.effective}
            blockedCharacterIds={blockedCharacterIds}
            catalogByItemId={catalogByItemId}
            characterNameById={characterNameById}
            onReorder={reorder}
            onRemove={removeEntry}
            onNoteChange={updateNote}
          />
        </div>
      </div>

      <div className="mt-8 flex justify-end">
        <button
          onClick={() => setShowSubmitModal(true)}
          className="rounded bg-emerald-600 px-6 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
          disabled={!validation?.valid}
        >
          Submit
        </button>
      </div>

      {showSubmitModal && (
        <SubmitModal
          confirmText={submitConfirmText}
          onConfirmTextChange={setSubmitConfirmText}
          onCancel={() => setShowSubmitModal(false)}
          onConfirm={submit}
        />
      )}
    </div>
  );
}

function SlotRow({
  slot,
  tab,
  characters,
  entries,
  addingFor,
  settings,
  catalog,
  onOpenAdd,
  onToggleOffSpec,
  onCancelAdd,
  onPick,
}: {
  slot: Slot;
  tab: ListTier;
  characters: CharacterInfo[];
  entries: DraftEntry[];
  addingFor: { slot: Slot; characterId: string; useOffSpec: boolean } | null;
  settings: { allowAltOffspecInOffList: boolean };
  catalog: CatalogEntry[];
  onOpenAdd: (characterId: string) => void;
  onToggleOffSpec: (v: boolean) => void;
  onCancelAdd: () => void;
  onPick: (character: CharacterInfo, item: CatalogEntry) => void;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{SLOT_LABEL[slot]}</p>
      <div className="space-y-1">
        {characters.map((character) => {
          const existing = entries.find((e) => e.characterId === character.id && e.slot === slot);
          const isAdding = addingFor?.slot === slot && addingFor.characterId === character.id;
          const showOffSpecToggle = tab === 'OFF' && character.slotIndex === 2 && settings.allowAltOffspecInOffList && character.offSpec;

          if (existing) {
            return (
              <p key={character.id} className="text-sm text-emerald-400">
                ✓ {character.name} — item {existing.itemId}{' '}
                <span className="text-zinc-500">(edit rank/remove in the ladder →)</span>
              </p>
            );
          }
          if (isAdding) {
            return (
              <div key={character.id} className="space-y-1">
                {showOffSpecToggle && (
                  <label className="flex items-center gap-1 text-xs text-zinc-400">
                    <input type="checkbox" checked={addingFor.useOffSpec} onChange={(e) => onToggleOffSpec(e.target.checked)} />
                    off spec instead of main spec
                  </label>
                )}
                <ItemPicker slot={slot} catalog={catalog} onCancel={onCancelAdd} onPick={(item) => onPick(character, item)} />
              </div>
            );
          }
          return (
            <button
              key={character.id}
              type="button"
              onClick={() => onOpenAdd(character.id)}
              className="text-sm text-zinc-400 hover:text-emerald-400"
            >
              + Add for {character.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ValidationPanel({
  validation,
  refusal,
}: {
  validation: ReturnType<typeof validateSubmission> | null;
  refusal: string | null;
}) {
  if (refusal) {
    return <div className="mb-4 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-300">{refusal}</div>;
  }
  if (!validation || (validation.errors.length === 0 && validation.warnings.length === 0)) return null;
  return (
    <div className="mb-4 space-y-1 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
      {validation.errors.map((e, i) => (
        <p key={`err-${i}`} className="text-red-400">
          ⚠ {e.message}
        </p>
      ))}
      {validation.warnings.map((w, i) => (
        <p key={`warn-${i}`} className="text-zinc-500">
          {w.message}
        </p>
      ))}
    </div>
  );
}

function SaveIndicator({ status, error }: { status: 'idle' | 'saving' | 'saved' | 'error'; error: string | null }) {
  if (status === 'idle') return null;
  if (status === 'saving') return <span className="text-xs text-zinc-500">Saving…</span>;
  if (status === 'error') return <span className="text-xs text-red-400">{error ?? 'Save failed'}</span>;
  return <span className="text-xs text-emerald-500">Saved {new Date().toLocaleTimeString()}</span>;
}

function SubmitModal({
  confirmText,
  onConfirmTextChange,
  onCancel,
  onConfirm,
}: {
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Submit confirmation" className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="text-lg font-semibold">Submit your lists?</h2>
        <p className="text-sm text-zinc-400">
          This is final. You will not be able to change your list. Contact the loot master if you need a correction.
        </p>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Type SUBMIT to confirm</span>
          <input value={confirmText} onChange={(e) => onConfirmTextChange(e.target.value)} className="input" />
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmText !== 'SUBMIT'}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyView({
  me,
  entries,
  catalogByItemId,
  characterNameById,
}: {
  me: Me;
  entries: SubmissionEntryRow[];
  catalogByItemId: Map<number, CatalogEntry>;
  characterNameById: Map<string, string>;
}) {
  const list = (tier: ListTier) => entries.filter((e) => e.list === tier).sort((a, b) => a.rank - b.rank);
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{me.player.displayName}</h1>
        <p className="text-sm text-zinc-400">{me.phase?.name} — Submitted (read-only)</p>
      </header>
      <div className="grid gap-6 sm:grid-cols-2">
        {(['MAIN', 'OFF'] as const).map((tier) => (
          <div key={tier} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 font-medium text-zinc-300">{tier === 'MAIN' ? 'Main list' : 'Off list'}</h2>
            {list(tier).length === 0 ? (
              <p className="text-sm text-zinc-500">No entries.</p>
            ) : (
              <ol className="space-y-1">
                {list(tier).map((e) => (
                  <li key={e.id} className="flex items-center justify-between rounded bg-zinc-950 px-3 py-2 text-sm">
                    <span className="font-mono text-emerald-400">#{e.rank}</span>
                    <span className="truncate px-2">{catalogByItemId.get(e.itemId)?.name ?? `Item ${e.itemId}`}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{characterNameById.get(e.characterId)}</span>
                    {e.fulfilledAt && <span className="shrink-0 text-xs text-amber-400">received</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{children}</div>;
}
