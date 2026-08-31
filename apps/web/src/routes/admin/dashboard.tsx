import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';

interface GuildProfile {
  name: string;
  slug: string;
  status: string;
}

interface Phase {
  id: string;
  key: string;
  name: string;
  status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'ARCHIVED';
}

const STATUS_COLOR: Record<Phase['status'], string> = {
  DRAFT: 'bg-zinc-800 text-zinc-400',
  OPEN: 'bg-emerald-900/50 text-emerald-400',
  LOCKED: 'bg-amber-900/50 text-amber-400',
  ARCHIVED: 'bg-zinc-800 text-zinc-500',
};

export function AdminDashboardPage() {
  const guild = useQuery<GuildProfile>({ queryKey: ['admin-guild'], queryFn: () => api.get<GuildProfile>('/admin/guild') });
  const phases = useQuery<{ phases: Phase[] }>({ queryKey: ['admin-phases'], queryFn: () => api.get<{ phases: Phase[] }>('/phases') });

  if (guild.isLoading) return <Centered>Loading…</Centered>;
  if (guild.error) return <Centered>Your session has expired — log in again.</Centered>;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{guild.data!.name}</h1>
          <p className="text-sm text-zinc-400">/g/{guild.data!.slug}</p>
        </div>
        <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs text-emerald-400">{guild.data!.status}</span>
      </header>

      <h2 className="mb-2 font-medium text-zinc-300">Phases</h2>
      {phases.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      {phases.data && phases.data.phases.length === 0 && <p className="text-sm text-zinc-500">No phases yet.</p>}
      <ul className="space-y-2">
        {phases.data?.phases.map((phase) => (
          <li key={phase.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-3">
            <div>
              <p className="font-medium">{phase.name}</p>
              <p className="text-xs text-zinc-500">{phase.key}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-1 text-xs ${STATUS_COLOR[phase.status]}`}>{phase.status}</span>
              <Link to="/admin/phases/$phaseId/matrix" params={{ phaseId: phase.id }} className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
                Matrix
              </Link>
              <Link to="/admin/phases/$phaseId/resolve" params={{ phaseId: phase.id }} className="rounded bg-emerald-700 px-3 py-1.5 text-sm hover:bg-emerald-600">
                Resolve drop
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{children}</div>;
}
