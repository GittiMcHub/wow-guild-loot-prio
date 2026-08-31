import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

const GAME_VERSIONS = ['classic-era', 'tbc', 'sod', 'cata', 'retail'] as const;

export function NewPhasePage() {
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [gameVersion, setGameVersion] = useState<(typeof GAME_VERSIONS)[number]>('tbc');
  const [error, setError] = useState<string | null>(null);

  const createPhase = useMutation({
    mutationFn: () => api.post<{ id: string }>('/phases', { key, name, gameVersion }),
    onSuccess: (res) => navigate({ to: '/admin/phases/$phaseId/items', params: { phaseId: res.id } }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create phase.'),
  });

  return (
    <div className="mx-auto max-w-md p-4 sm:p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          createPhase.mutate();
        }}
        className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6"
      >
        <h1 className="text-xl font-semibold">New phase</h1>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Key</span>
          <input required value={key} onChange={(e) => setKey(e.target.value)} placeholder="P4" className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Phase 4 — Naxxramas" className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Game version</span>
          <select value={gameVersion} onChange={(e) => setGameVersion(e.target.value as (typeof GAME_VERSIONS)[number])} className="input">
            {GAME_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={createPhase.isPending} type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {createPhase.isPending ? 'Creating…' : 'Create phase'}
        </button>
      </form>
    </div>
  );
}
