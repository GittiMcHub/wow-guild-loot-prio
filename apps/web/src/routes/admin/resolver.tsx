import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface CatalogHit {
  itemId: number;
  name: string;
  quality: number;
  slot: string;
  source: string | null;
}

interface ResolvedClaim {
  entryId: string;
  playerId: string;
  characterId: string;
  characterName: string;
  isMainCharacter: boolean;
  spec: string;
  list: 'MAIN' | 'OFF';
  rank: number;
  slot: string;
  itemId: number;
  bisCount: number;
  excludedReason?: 'OUTRANKED' | 'HIGHER_BIS_COUNT' | 'NOT_PRESENT' | 'FULFILLED' | 'WEAKER_CLAIM_SAME_PLAYER';
}

interface ResolveResult {
  itemId: number;
  ranked: ResolvedClaim[];
  winnerGroup: ResolvedClaim[];
  needsRoll: boolean;
  warnings: string[];
}

interface RollResult {
  id: string;
  results: Array<{ characterId: string; characterName: string; value: number }>;
}

const QUALITY_COLOR: Record<number, string> = { 1: 'text-zinc-400', 2: 'text-green-400', 3: 'text-blue-400', 4: 'text-purple-400', 5: 'text-orange-400' };

const EXCLUDED_LABEL: Record<NonNullable<ResolvedClaim['excludedReason']>, string> = {
  OUTRANKED: 'outranked',
  HIGHER_BIS_COUNT: 'sits out — higher BiS count',
  NOT_PRESENT: 'not present',
  FULFILLED: 'already fulfilled',
  WEAKER_CLAIM_SAME_PLAYER: "weaker of this player's claims",
};

export function AdminResolverPage({ phaseId }: { phaseId: string }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState<CatalogHit | null>(null);
  const [roll, setRoll] = useState<RollResult | null>(null);
  const [lastAward, setLastAward] = useState<{ summary: string; winCondition: string } | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  const search = useQuery<{ items: CatalogHit[] }>({
    queryKey: ['admin-item-search', phaseId, query],
    queryFn: () => api.get(`/phases/${phaseId}/items?q=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
  });

  const resolveQuery = useQuery<ResolveResult>({
    queryKey: ['admin-resolve', phaseId, selectedItem?.itemId],
    queryFn: () => api.post<ResolveResult>(`/phases/${phaseId}/drops/resolve`, { itemId: selectedItem!.itemId }),
    enabled: !!selectedItem,
  });

  const rollMutation = useMutation({
    mutationFn: (characterIds: string[]) =>
      api.post<RollResult>(`/phases/${phaseId}/rolls`, { itemId: selectedItem!.itemId, characterIds, source: 'SERVER' }),
    onSuccess: (r) => setRoll(r),
  });

  const awardMutation = useMutation({
    mutationFn: (body: { characterId?: string; entryId?: string; awardType: string; rollId?: string; overrideReason?: string }) =>
      api.post<{ id: string; explanation: { summary: string; winCondition: string } }>(`/phases/${phaseId}/awards`, {
        itemId: selectedItem!.itemId,
        ...body,
      }),
    onSuccess: (res) => {
      setLastAward({ summary: res.explanation.summary, winCondition: res.explanation.winCondition });
      setRoll(null);
      setOverrideFor(null);
      queryClient.invalidateQueries({ queryKey: ['admin-resolve', phaseId, selectedItem?.itemId] });
    },
  });

  function pickItem(item: CatalogHit) {
    setSelectedItem(item);
    setQuery('');
    setRoll(null);
    setLastAward(null);
  }

  const result = resolveQuery.data;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Drop resolver</h1>
      </header>

      <div className="mb-4">
        <input
          value={selectedItem ? selectedItem.name : query}
          onChange={(e) => {
            setSelectedItem(null);
            setQuery(e.target.value);
          }}
          placeholder="Search item by name or paste item ID…"
          className="input"
        />
        {query && !selectedItem && (
          <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-900 p-2">
            {(search.data?.items ?? []).map((item) => (
              <li key={item.itemId}>
                <button onClick={() => pickItem(item)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-800">
                  <span className={QUALITY_COLOR[item.quality] ?? ''}>{item.name}</span>
                  <span className="text-xs text-zinc-500">{item.source}</span>
                </button>
              </li>
            ))}
            {search.data?.items.length === 0 && <li className="px-2 py-1.5 text-sm text-zinc-500">No matches.</li>}
          </ul>
        )}
      </div>

      {lastAward && (
        <div data-testid="award-result" className="mb-4 rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          <p className="font-medium">{lastAward.winCondition}</p>
          <p>{lastAward.summary}</p>
        </div>
      )}

      {selectedItem && result && (
        <div className="space-y-4">
          <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
            <p className={`font-medium ${QUALITY_COLOR[selectedItem.quality] ?? ''}`}>{selectedItem.name}</p>
            {result.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-400">
                ⚠ {w}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            {result.ranked.map((claim) => {
              const isWinner = result.winnerGroup.some((w) => w.entryId === claim.entryId);
              return (
                <div
                  key={claim.entryId}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded border p-3 ${
                    isWinner ? 'border-emerald-700 bg-emerald-950/30' : claim.excludedReason ? 'border-zinc-800 bg-zinc-900/50 opacity-60' : 'border-zinc-800 bg-zinc-900'
                  }`}
                >
                  <div>
                    <p className="font-medium">
                      {claim.characterName} <span className={claim.list === 'MAIN' ? 'text-emerald-400' : 'text-zinc-500'}>{claim.list} #{claim.rank}</span>
                    </p>
                    <p className="text-xs text-zinc-500">
                      BiS count: {claim.bisCount}
                      {claim.excludedReason && ` · ${EXCLUDED_LABEL[claim.excludedReason]}`}
                      {roll?.results.find((r) => r.characterId === claim.characterId) && ` · rolled ${roll.results.find((r) => r.characterId === claim.characterId)!.value}`}
                    </p>
                  </div>
                  {isWinner && !claim.excludedReason && !result.needsRoll && (
                    <button
                      onClick={() => awardMutation.mutate({ characterId: claim.characterId, entryId: claim.entryId, awardType: 'PRIORITY' })}
                      className="rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500"
                    >
                      Award
                    </button>
                  )}
                  {isWinner && result.needsRoll && roll?.results.some((r) => r.characterId === claim.characterId) && (
                    <button
                      onClick={() => awardMutation.mutate({ characterId: claim.characterId, entryId: claim.entryId, awardType: 'PRIORITY', rollId: roll.id })}
                      className="rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500"
                    >
                      Award (rolled {roll.results.find((r) => r.characterId === claim.characterId)!.value})
                    </button>
                  )}
                  {!isWinner && overrideFor !== claim.entryId && (
                    <button onClick={() => setOverrideFor(claim.entryId)} className="text-xs text-zinc-500 hover:text-zinc-300">
                      Award to this instead
                    </button>
                  )}
                  {overrideFor === claim.entryId && (
                    <div className="flex w-full items-center gap-2">
                      <input
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder="Reason (required)"
                        className="input flex-1"
                      />
                      <button
                        disabled={!overrideReason.trim()}
                        onClick={() =>
                          awardMutation.mutate({ characterId: claim.characterId, entryId: claim.entryId, awardType: 'OVERRIDE', overrideReason })
                        }
                        className="shrink-0 rounded bg-amber-700 px-3 py-1.5 text-sm hover:bg-amber-600 disabled:opacity-40"
                      >
                        Confirm override
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {result.ranked.length === 0 && <p className="text-sm text-zinc-500">No live claims for this item.</p>}
          </div>

          {result.needsRoll && !roll && (
            <button
              onClick={() => rollMutation.mutate(result.winnerGroup.map((w) => w.characterId))}
              className="w-full rounded bg-blue-700 px-4 py-2 font-medium hover:bg-blue-600"
            >
              Roll for the tied winners
            </button>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => awardMutation.mutate({ awardType: 'DISENCHANT' })}
              className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
            >
              Disenchant
            </button>
            <button onClick={() => awardMutation.mutate({ awardType: 'BANK' })} className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700">
              Bank
            </button>
          </div>

          {awardMutation.isError && (
            <p className="text-sm text-red-400">{awardMutation.error instanceof ApiError ? awardMutation.error.message : 'Failed to award.'}</p>
          )}
        </div>
      )}
    </div>
  );
}
