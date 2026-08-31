import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface InviteInfo {
  phase: { key: string; name: string; status: string };
  kind: 'TARGETED' | 'GENERIC';
  label: string | null;
}

const CLASSES = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];

interface CharacterDraft {
  name: string;
  class: string;
  mainSpec: string;
  offSpec: string;
}

export function InvitePage({ token }: { token: string }) {
  const { data, isLoading, error } = useQuery<InviteInfo>({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteInfo>(`/invites/${token}`),
  });

  const [displayName, setDisplayName] = useState('');
  const [chars, setChars] = useState<CharacterDraft[]>([{ name: '', class: CLASSES[0]!, mainSpec: '', offSpec: '' }]);
  const [primaryIndex, setPrimaryIndex] = useState(0);
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
        characters: chars.map((c, i) => ({
          name: c.name,
          class: c.class,
          mainSpec: c.mainSpec,
          offSpec: c.offSpec,
          isMainCharacter: i === primaryIndex,
          slotIndex: i + 1,
        })),
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
        {chars.map((char, i) => (
          <fieldset key={i} className="space-y-3 rounded border border-zinc-800 p-3">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium text-zinc-300">Character {i + 1}</legend>
              {chars.length > 1 && (
                <label className="flex items-center gap-1 text-xs text-zinc-400">
                  <input type="radio" checked={primaryIndex === i} onChange={() => setPrimaryIndex(i)} />
                  Primary
                </label>
              )}
            </div>
            <Field label="Character name">
              <input
                required
                value={char.name}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)))}
                className="input"
              />
            </Field>
            <Field label="Class">
              <select
                value={char.class}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, class: e.target.value } : c)))}
                className="input"
              >
                {CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Main spec">
              <input
                required
                value={char.mainSpec}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, mainSpec: e.target.value } : c)))}
                className="input"
              />
            </Field>
            <Field label="Off spec">
              <input
                value={char.offSpec}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, offSpec: e.target.value } : c)))}
                className="input"
              />
            </Field>
            {chars.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setChars((cs) => cs.filter((_, j) => j !== i));
                  if (primaryIndex >= i) setPrimaryIndex(0);
                }}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            )}
          </fieldset>
        ))}
        {chars.length < 2 && (
          <button
            type="button"
            onClick={() => setChars((cs) => [...cs, { name: '', class: CLASSES[0]!, mainSpec: '', offSpec: '' }])}
            className="text-sm text-emerald-400 hover:text-emerald-300"
          >
            + Add a second character
          </button>
        )}
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
