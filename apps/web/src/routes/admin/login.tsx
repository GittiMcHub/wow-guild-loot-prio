import { useState } from 'react';
import { api, ApiError } from '../../api';

export function AdminLoginPage({ guildSlug, onLoggedIn }: { guildSlug: string; onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post(`/g/${guildSlug}/auth/login`, { username, password });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-xl font-semibold">Loot master login — {guildSlug}</h1>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Username</span>
          <input required value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Password</span>
          <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={busy} type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
