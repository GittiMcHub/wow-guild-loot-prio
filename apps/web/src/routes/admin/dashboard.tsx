import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';

interface GuildProfile {
  name: string;
  slug: string;
  status: string;
}

export function AdminDashboardPage() {
  const { data, isLoading, error } = useQuery<GuildProfile>({
    queryKey: ['admin-guild'],
    queryFn: () => api.get<GuildProfile>('/admin/guild'),
  });

  if (isLoading) return <Centered>Loading…</Centered>;
  if (error) return <Centered>Your session has expired — log in again.</Centered>;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{data!.name}</h1>
          <p className="text-sm text-zinc-400">/g/{data!.slug}</p>
        </div>
        <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs text-emerald-400">{data!.status}</span>
      </header>
      <p className="text-sm text-zinc-500">
        The full admin console (matrix, drop resolver, standings, audit — §11.3) isn't wired up in this scaffold. The API
        routes it depends on (<code>/phases/:id/matrix</code>, <code>/phases/:id/drops/resolve</code>,{' '}
        <code>/phases/:id/rolls</code>, <code>/phases/:id/awards</code>) are implemented and tested — see{' '}
        <code>apps/api/test/flow.spec.ts</code>.
      </p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{children}</div>;
}
