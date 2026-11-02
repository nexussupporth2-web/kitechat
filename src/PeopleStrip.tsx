import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import Profile from './Profile.tsx';

interface Person {
  userId: string;
  name: string;
  avatar: string;
  handle: string | null;
  photoUrl: string | null;
  state: 'friends' | 'sent' | 'received' | 'none';
  hasStatus: boolean;
  isOnline?: boolean;
}

/** "Suggested for you": a row of cards you swipe sideways. Everyone on Kite is listed, with or without a picture, status or posts. */
export default function PeopleStrip({ onChanged }: { onChanged?: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ people: Person[] }>('/api/people');
      setPeople(r.people);
    } catch {
      setPeople([]);
    }
  }, []);
  useEffect(() => {
    void load();
    // Keep the green dots fresh while the strip is on screen.
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const follow = async (p: Person) => {
    setBusy(p.userId);
    setNote('');
    try {
      if (p.state === 'received') await api('/api/friends/respond', { userId: p.userId, accept: true });
      else await api('/api/friends/request', { userId: p.userId });
      await load();
      onChanged?.();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setBusy(null);
    }
  };

  if (!people || people.length === 0) return null;
  const label = (s: Person['state']) => (s === 'friends' ? 'Friends' : s === 'sent' ? 'Requested' : s === 'received' ? 'Accept' : 'Follow');

  return (
    <div className="mt-5">
      <div className="px-4 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">Suggested for you</h3>
        <span className="text-[11px] text-slate-500">Swipe to see everyone</span>
      </div>
      <div className="mt-3 flex gap-3 overflow-x-auto px-4 pb-2 snap-x">
        {people.map(p => (
          <div key={p.userId} className="snap-start shrink-0 w-36 rounded-2xl bg-slate-800/70 border border-slate-700/50 p-3 flex flex-col items-center">
            <button onClick={() => setViewing(p.userId)} className="flex flex-col items-center min-w-0 w-full" aria-label={`Open ${p.name}'s profile`}>
              <span className={`relative w-20 h-20 rounded-full p-1 ${p.hasStatus ? 'status-ring bg-gradient-to-tr from-amber-400 via-rose-400 to-indigo-400' : 'bg-slate-700'}`}>
                <span className="block w-full h-full rounded-full bg-slate-950 p-0.5">
                  {p.photoUrl ? (
                    <img src={p.photoUrl} alt="" className="w-full h-full rounded-full object-cover" />
                  ) : (
                    <span className="w-full h-full rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-2xl font-bold">{p.avatar || p.name.slice(0, 1)}</span>
                  )}
                </span>
                <span className={`absolute bottom-0.5 right-0.5 w-4 h-4 rounded-full border-2 border-slate-900 ${p.isOnline ? 'bg-emerald-500' : 'bg-slate-600'}`} title={p.isOnline ? 'Online' : 'Offline'} aria-label={p.isOnline ? 'Online' : 'Offline'} />
              </span>
              <span className="mt-2 text-sm font-semibold text-white truncate w-full text-center">{p.name}</span>
              <span className="text-[11px] text-slate-400 truncate w-full text-center">{p.handle ? `@${p.handle}` : p.userId}</span>
            </button>
            <button
              onClick={() => void follow(p)}
              disabled={busy === p.userId || p.state === 'friends' || p.state === 'sent'}
              className={`mt-3 w-full h-9 rounded-xl text-sm font-semibold ${p.state === 'none' || p.state === 'received' ? 'bg-cyan-500 hover:bg-cyan-400 text-accent-ink' : 'bg-slate-700 text-slate-300'} disabled:opacity-80`}
            >
              {busy === p.userId ? '…' : label(p.state)}
            </button>
          </div>
        ))}
      </div>
      {note && <p role="alert" className="px-4 text-xs text-rose-400">{note}</p>}
      {viewing && (
        <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col">
          <Profile
            key={viewing}
            userId={viewing}
            isMe={false}
            onBack={() => {
              setViewing(null);
              void load();
            }}
            onFriendsChanged={() => {
              void load();
              onChanged?.();
            }}
          />
        </div>
      )}
    </div>
  );
}
