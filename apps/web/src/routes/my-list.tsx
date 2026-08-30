import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface Me {
  player: { displayName: string };
  characters: Array<{ id: string; name: string; class: string; mainSpec: string; offSpec: string | null }>;
  submissionStatus: 'DRAFT' | 'SUBMITTED';
  phase: { name: string } | null;
}

interface SubmissionEntry {
  id: string;
  list: 'MAIN' | 'OFF';
  rank: number;
  slot: string;
  itemId: number;
}

interface SubmissionDetail {
  status: 'DRAFT' | 'SUBMITTED';
  entries: SubmissionEntry[];
  capacity: { main: { effective: number }; off: { effective: number } };
}

export function MyListPage({ token }: { token: string }) {
  const me = useQuery<Me>({ queryKey: ['me', token], queryFn: () => api.get<Me>('/me', token) });
  const submission = useQuery<SubmissionDetail>({
    queryKey: ['me-submission', token],
    queryFn: () => api.get<SubmissionDetail>('/me/submission', token),
    enabled: !!me.data,
  });

  if (me.isLoading) return <Centered>Loading…</Centered>;
  if (me.error) {
    return <Centered>{me.error instanceof ApiError ? me.error.message : 'This link is no longer valid.'}</Centered>;
  }

  const list = (tier: 'MAIN' | 'OFF') =>
    (submission.data?.entries ?? []).filter((e) => e.list === tier).sort((a, b) => a.rank - b.rank);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{me.data!.player.displayName}</h1>
        <p className="text-sm text-zinc-400">
          {me.data!.phase?.name} — {me.data!.submissionStatus === 'SUBMITTED' ? 'Submitted (read-only)' : 'Draft'}
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        <ListColumn title="Main list" entries={list('MAIN')} />
        <ListColumn title="Off list" entries={list('OFF')} />
      </div>

      {me.data!.submissionStatus === 'DRAFT' && (
        <p className="mt-6 text-sm text-zinc-500">
          The full drag-and-drop list builder (§11.2) isn't wired up in this scaffold yet — use{' '}
          <code>PUT /api/me/submission</code> directly to populate a draft.
        </p>
      )}
    </div>
  );
}

function ListColumn({ title, entries }: { title: string; entries: SubmissionEntry[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 font-medium text-zinc-300">{title}</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-500">No entries yet.</p>
      ) : (
        <ol className="space-y-1">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between rounded bg-zinc-950 px-3 py-2 text-sm">
              <span className="font-mono text-emerald-400">#{e.rank}</span>
              <span className="text-zinc-400">{e.slot}</span>
              <span>Item {e.itemId}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{children}</div>;
}
