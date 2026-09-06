import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

export function InstanceSetupPage({ token, onDone }: { token: string; onDone: (guildSlug: string) => void }) {
  const info = useQuery<{ guildName: string; guildSlug: string }>({
    queryKey: ['setup', token],
    queryFn: () => api.get(`/setup/${token}`),
    retry: false,
  });

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ guildSlug: string }>(`/setup/${token}`, { username, password });
      onDone(res.guildSlug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }

  if (info.isLoading) return <Centered>Loading…</Centered>;
  if (info.error) return <Centered>This setup link is invalid, expired, or already used.</Centered>;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-xl font-semibold">Set up your admin account for {info.data!.guildName}</h1>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Username</span>
          <input required value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Password</span>
          <input required minLength={8} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Confirm password</span>
          <input required minLength={8} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={busy} type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'Saving…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{children}</div>;
}
