import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { Slot } from '@glps/core';
import { ALL_SLOTS } from '../../lib/builder-types';
import { api } from '../../api';

interface MatrixRow {
  playerId: string;
  displayName: string;
  characterId: string;
  characterName: string;
  list: 'MAIN' | 'OFF';
  rank: number;
  slot: Slot;
  itemId: number;
  itemName: string;
  itemQuality: number;
  fulfilledAt: string | null;
}

type View = 'slot' | 'priority' | 'item';

const QUALITY_COLOR: Record<number, string> = { 1: 'text-zinc-400', 2: 'text-green-400', 3: 'text-blue-400', 4: 'text-purple-400', 5: 'text-orange-400' };

export function AdminMatrixPage({ phaseId }: { phaseId: string }) {
  const [view, setView] = useState<View>('slot');
  const [listFilter, setListFilter] = useState<'ALL' | 'MAIN' | 'OFF'>('ALL');
  const [search, setSearch] = useState('');

  const matrix = useQuery<{ view: View; rows?: MatrixRow[]; items?: Record<string, MatrixRow[]> }>({
    queryKey: ['admin-matrix', phaseId, view],
    queryFn: () => api.get(`/phases/${phaseId}/matrix?view=${view}`),
  });

  const rows = useMemo(() => {
    let r = matrix.data?.rows ?? [];
    if (listFilter !== 'ALL') r = r.filter((row) => row.list === listFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter((row) => row.displayName.toLowerCase().includes(q) || row.characterName.toLowerCase().includes(q));
    }
    return r;
  }, [matrix.data, listFilter, search]);

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Priority matrix</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['slot', 'priority', 'item'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1.5 text-sm ${view === v ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            >
              {v}
            </button>
          ))}
        </div>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search player or character…" className="input max-w-xs" />
        {(['ALL', 'MAIN', 'OFF'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setListFilter(l)}
            className={`rounded px-3 py-1.5 text-xs ${listFilter === l ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {matrix.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      {view === 'slot' && <SlotView rows={rows} />}
      {view === 'priority' && <PriorityView rows={rows} />}
      {view === 'item' && <ItemView itemsMap={matrix.data?.items ?? {}} listFilter={listFilter} search={search} />}
    </div>
  );
}

function Cell({ row }: { row: MatrixRow }) {
  return (
    <div className={`rounded px-1 py-0.5 text-xs ${row.list === 'MAIN' ? 'bg-emerald-950/60' : 'bg-zinc-800/60'}`}>
      <span className="font-mono text-emerald-400">#{row.rank}</span>{' '}
      <span className={QUALITY_COLOR[row.itemQuality] ?? ''}>{row.itemName}</span>
      {row.fulfilledAt && <span className="ml-1 text-amber-400">✓</span>}
    </div>
  );
}

function SlotView({ rows }: { rows: MatrixRow[] }) {
  const byPlayerChar = useMemo(() => {
    const map = new Map<string, { displayName: string; characterName: string; bySlot: Map<string, MatrixRow[]> }>();
    for (const row of rows) {
      const key = row.characterId;
      if (!map.has(key)) map.set(key, { displayName: row.displayName, characterName: row.characterName, bySlot: new Map() });
      const entry = map.get(key)!;
      const list = entry.bySlot.get(row.slot) ?? [];
      list.push(row);
      entry.bySlot.set(row.slot, list);
    }
    return map;
  }, [rows]);

  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-zinc-900">
          <tr>
            <th className="sticky left-0 z-10 bg-zinc-900 px-2 py-2 text-left">Player</th>
            {ALL_SLOTS.map((slot) => (
              <th key={slot} className="px-2 py-2 text-left text-xs text-zinc-500">
                {slot}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...byPlayerChar.entries()].map(([characterId, entry]) => (
            <tr key={characterId} className="border-t border-zinc-800">
              <td className="sticky left-0 z-10 bg-zinc-950 px-2 py-2">
                <p className="font-medium">{entry.displayName}</p>
                <p className="text-xs text-zinc-500">{entry.characterName}</p>
              </td>
              {ALL_SLOTS.map((slot) => (
                <td key={slot} className="space-y-1 px-2 py-2">
                  {(entry.bySlot.get(slot) ?? []).map((row) => (
                    <Cell key={`${row.list}-${row.rank}`} row={row} />
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {byPlayerChar.size === 0 && <p className="p-4 text-sm text-zinc-500">No submitted entries yet.</p>}
    </div>
  );
}

function PriorityView({ rows }: { rows: MatrixRow[] }) {
  const maxRank = Math.max(1, ...rows.map((r) => r.rank));
  const byPlayerCharList = useMemo(() => {
    const map = new Map<string, { displayName: string; characterName: string; list: 'MAIN' | 'OFF'; byRank: Map<number, MatrixRow> }>();
    for (const row of rows) {
      const key = `${row.characterId}-${row.list}`;
      if (!map.has(key)) map.set(key, { displayName: row.displayName, characterName: row.characterName, list: row.list, byRank: new Map() });
      map.get(key)!.byRank.set(row.rank, row);
    }
    return map;
  }, [rows]);

  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-zinc-900">
          <tr>
            <th className="sticky left-0 z-10 bg-zinc-900 px-2 py-2 text-left">Player</th>
            {Array.from({ length: maxRank }, (_, i) => i + 1).map((rank) => (
              <th key={rank} className="px-2 py-2 text-xs text-zinc-500">
                #{rank}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...byPlayerCharList.entries()].map(([key, entry]) => (
            <tr key={key} className="border-t border-zinc-800">
              <td className="sticky left-0 z-10 bg-zinc-950 px-2 py-2">
                <p className="font-medium">
                  {entry.displayName} <span className={`text-xs ${entry.list === 'MAIN' ? 'text-emerald-400' : 'text-zinc-500'}`}>{entry.list}</span>
                </p>
                <p className="text-xs text-zinc-500">{entry.characterName}</p>
              </td>
              {Array.from({ length: maxRank }, (_, i) => i + 1).map((rank) => {
                const row = entry.byRank.get(rank);
                return (
                  <td key={rank} className="px-2 py-2 text-xs">
                    {row && (
                      <span className={QUALITY_COLOR[row.itemQuality] ?? ''}>
                        {row.slot}: {row.itemName}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {byPlayerCharList.size === 0 && <p className="p-4 text-sm text-zinc-500">No submitted entries yet.</p>}
    </div>
  );
}

function ItemView({ itemsMap, listFilter, search }: { itemsMap: Record<string, MatrixRow[]>; listFilter: 'ALL' | 'MAIN' | 'OFF'; search: string }) {
  const entries = Object.entries(itemsMap)
    .map(([itemId, rows]) => {
      let filtered = listFilter === 'ALL' ? rows : rows.filter((r) => r.list === listFilter);
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        filtered = filtered.filter((r) => r.displayName.toLowerCase().includes(q) || r.characterName.toLowerCase().includes(q));
      }
      return [itemId, filtered] as const;
    })
    .filter(([, rows]) => rows.length > 0)
    .sort(([, a], [, b]) => (a[0]?.itemName ?? '').localeCompare(b[0]?.itemName ?? ''));

  return (
    <div className="space-y-3">
      {entries.map(([itemId, rows]) => {
        const sorted = [...rows].sort((a, b) => (a.list === b.list ? a.rank - b.rank : a.list === 'MAIN' ? -1 : 1));
        return (
          <div key={itemId} className="rounded border border-zinc-800 bg-zinc-900 p-3">
            <p className={`mb-2 font-medium ${QUALITY_COLOR[rows[0]!.itemQuality] ?? ''}`}>
              {rows[0]!.itemName} <span className="text-xs text-zinc-500">#{itemId}</span>
            </p>
            <ul className="space-y-1">
              {sorted.map((row) => (
                <li key={`${row.characterId}-${row.list}`} className="flex items-center justify-between text-sm">
                  <span>
                    {row.characterName} <span className="text-zinc-500">({row.displayName})</span>
                  </span>
                  <span className={row.list === 'MAIN' ? 'text-emerald-400' : 'text-zinc-500'}>
                    {row.list} #{row.rank}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {entries.length === 0 && <p className="text-sm text-zinc-500">No submitted entries yet.</p>}
    </div>
  );
}
