import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface Guild {
  id: string;
  slug: string;
  name: string;
  realm: string | null;
  region: string | null;
  gameVersion: string;
  status: string;
  createdAt: string;
}

const GAME_VERSIONS = ['classic-era', 'tbc', 'sod', 'cata', 'retail'] as const;

export function InstanceDashboardPage() {
  const queryClient = useQueryClient();
  const guilds = useQuery<{ guilds: Guild[] }>({ queryKey: ['instance-guilds'], queryFn: () => api.get('/instance/guilds') });

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [realm, setRealm] = useState('');
  const [region, setRegion] = useState('');
  const [gameVersion, setGameVersion] = useState<(typeof GAME_VERSIONS)[number]>('classic-era');
  const [error, setError] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createGuild = useMutation({
    mutationFn: () =>
      api.post<{ id: string; slug: string; setupUrl: string }>('/instance/guilds', {
        slug,
        name,
        realm: realm || undefined,
        region: region || undefined,
        gameVersion,
      }),
    onSuccess: (res) => {
      setSetupUrl(res.setupUrl);
      setSlug('');
      setName('');
      setRealm('');
      setRegion('');
      queryClient.invalidateQueries({ queryKey: ['instance-guilds'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create guild.'),
  });

  async function copySetupUrl() {
    if (!setupUrl) return;
    await navigator.clipboard.writeText(setupUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">Instance admin</h1>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 font-medium text-zinc-300">New guild</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            createGuild.mutate();
          }}
          className="grid grid-cols-2 gap-3"
        >
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Slug</span>
            <input required value={slug} onChange={(e) => setSlug(e.target.value)} className="input" placeholder="nightfall" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Nightfall" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Realm (optional)</span>
            <input value={realm} onChange={(e) => setRealm(e.target.value)} className="input" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Region (optional)</span>
            <input value={region} onChange={(e) => setRegion(e.target.value)} className="input" />
          </label>
          <label className="col-span-2 block text-sm">
            <span className="mb-1 block text-zinc-400">Game version</span>
            <select value={gameVersion} onChange={(e) => setGameVersion(e.target.value as (typeof GAME_VERSIONS)[number])} className="input">
              {GAME_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="col-span-2 text-sm text-red-400">{error}</p>}
          <button
            disabled={createGuild.isPending}
            type="submit"
            className="col-span-2 rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {createGuild.isPending ? 'Creating…' : 'Create guild'}
          </button>
        </form>

        {setupUrl && (
          <div className="mt-4 rounded border border-emerald-800 bg-emerald-950/40 p-3">
            <p className="mb-2 text-sm text-emerald-300">Guild created. Send this one-time setup link to its first admin:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-zinc-950 px-2 py-1 text-xs">{setupUrl}</code>
              <button onClick={copySetupUrl} className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium text-zinc-300">Guilds</h2>
        {guilds.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        <ul className="space-y-2">
          {guilds.data?.guilds.map((g) => (
            <li key={g.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-3">
              <div>
                <p className="font-medium">{g.name}</p>
                <p className="text-xs text-zinc-500">/g/{g.slug} — {g.gameVersion}</p>
              </div>
              <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs text-emerald-400">{g.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
