import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface InviteInfo {
  phase: { key: string; name: string; status: string };
  kind: 'TARGETED' | 'GENERIC';
  label: string | null;
}

const CLASSES = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];

export function InvitePage({ token }: { token: string }) {
  const { data, isLoading, error } = useQuery<InviteInfo>({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteInfo>(`/invites/${token}`),
  });

  const [displayName, setDisplayName] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [charClass, setCharClass] = useState(CLASSES[0]!);
  const [mainSpec, setMainSpec] = useState('');
  const [offSpec, setOffSpec] = useState('');
  const [result, setResult] = useState<{ playerToken: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (isLoading) return <Centered>Loading invite…</Centered>;
  if (error) {
    return (
      <Centered>
        <p className="text-red-400">
          {error instanceof ApiError ? error.message : 'This invite link is invalid, expired, or has already been used.'}
        </p>
      </Centered>
    );
  }

  if (result) {
    return (
      <Centered>
        <div className="max-w-md space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <h1 className="text-xl font-semibold">Save this link!</h1>
          <p className="text-sm text-zinc-400">
            This is the only time your personal link will be shown. Save it now — an admin can recover it later, but only by unlocking your
            submission.
          </p>
          <code className="block break-all rounded bg-black p-3 text-emerald-400">
            {window.location.origin}/b/{result.playerToken}
          </code>
        </div>
      </Centered>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    try {
      const res = await api.post<{ playerToken: string }>(`/invites/${token}/claim`, {
        displayName,
        characters: [{ name: characterName, class: charClass, mainSpec, offSpec, isMainCharacter: true, slotIndex: 1 }],
      });
      setResult(res);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <Centered>
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <div>
          <h1 className="text-xl font-semibold">{data!.phase.name}</h1>
          <p className="text-sm text-zinc-400">Join the raid — register your character to build your priority list.</p>
        </div>
        <Field label="Discord / display name">
          <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" />
        </Field>
        <Field label="Character name">
          <input required value={characterName} onChange={(e) => setCharacterName(e.target.value)} className="input" />
        </Field>
        <Field label="Class">
          <select value={charClass} onChange={(e) => setCharClass(e.target.value)} className="input">
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Main spec">
          <input required value={mainSpec} onChange={(e) => setMainSpec(e.target.value)} className="input" />
        </Field>
        <Field label="Off spec">
          <input value={offSpec} onChange={(e) => setOffSpec(e.target.value)} className="input" />
        </Field>
        {submitError && <p className="text-sm text-red-400">{submitError}</p>}
        <button type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500">
          Join
        </button>
      </form>
    </Centered>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
