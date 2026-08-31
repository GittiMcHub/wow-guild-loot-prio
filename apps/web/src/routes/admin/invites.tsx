import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface Invite {
  id: string;
  kind: 'TARGETED' | 'GENERIC';
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function AdminInvitesPage({ phaseId }: { phaseId: string }) {
  const queryClient = useQueryClient();
  const [lastCreatedUrl, setLastCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invites = useQuery<{ invites: Invite[] }>({
    queryKey: ['admin-invites', phaseId],
    queryFn: () => api.get<{ invites: Invite[] }>(`/phases/${phaseId}/invites`),
  });

  const createInvite = useMutation({
    mutationFn: () => api.post<{ invites: Array<{ id: string; url: string; label: string | null }> }>(`/phases/${phaseId}/invites`, { kind: 'GENERIC', maxUses: 1 }),
    onSuccess: (res) => {
      setError(null);
      setLastCreatedUrl(res.invites[0]!.url);
      queryClient.invalidateQueries({ queryKey: ['admin-invites', phaseId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create invite.'),
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => api.post<{ ok: boolean }>(`/invites/${inviteId}/revoke`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-invites', phaseId] }),
  });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Invites</h1>
      </header>

      <button
        onClick={() => createInvite.mutate()}
        disabled={createInvite.isPending}
        className="mb-4 rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
      >
        {createInvite.isPending ? 'Creating…' : 'New invite'}
      </button>
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {lastCreatedUrl && (
        <div className="mb-4 rounded border border-emerald-800 bg-emerald-950/40 p-3">
          <p className="mb-1 text-sm text-zinc-400">Send this link to the player — it's shown only once here:</p>
          <code className="block break-all text-emerald-400">{lastCreatedUrl}</code>
        </div>
      )}

      {invites.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      <ul className="space-y-2">
        {invites.data?.invites.map((inv) => (
          <li key={inv.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
            <div>
              <p>{inv.label ?? inv.kind}</p>
              <p className="text-xs text-zinc-500">
                {inv.usedCount}/{inv.maxUses} used
                {inv.revokedAt && ' — revoked'}
                {inv.expiresAt && ` — expires ${new Date(inv.expiresAt).toLocaleString()}`}
              </p>
            </div>
            {!inv.revokedAt && inv.usedCount < inv.maxUses && (
              <button
                onClick={() => revokeInvite.mutate(inv.id)}
                disabled={revokeInvite.isPending}
                className="rounded bg-zinc-800 px-3 py-1.5 text-xs hover:bg-red-900/60 disabled:opacity-50"
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {invites.data && invites.data.invites.length === 0 && <p className="text-sm text-zinc-500">No invites yet.</p>}
    </div>
  );
}
