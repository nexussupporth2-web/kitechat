// Group chats: making a group, and the group's members screen.
import { useState } from 'react';
import { Check, Crown, LogOut, Pencil, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { api, ApiError } from './api.ts';
import Avatar from './Avatar.tsx';
import type { Friend } from './types.ts';

export const MAX_GROUP = 20;

const inputCls = 'w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500';

function Box({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-slate-900 border border-slate-800 p-5 relative"
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-3 right-3 w-9 h-9 rounded-full hover:bg-slate-800 text-slate-400 flex items-center justify-center" aria-label="Close">
          <X className="w-5 h-5" />
        </button>
        {children}
      </div>
    </div>
  );
}

/** A list of friends with a tick box each. */
function FriendPicker({ friends, picked, setPicked, max }: { friends: Friend[]; picked: string[]; setPicked: (p: string[]) => void; max: number }) {
  if (friends.length === 0) return <p className="text-xs text-slate-500 py-4 text-center">No friends to add.</p>;
  return (
    <div className="space-y-1 max-h-72 overflow-y-auto">
      {friends.map(f => {
        const on = picked.includes(f.userId);
        const full = !on && picked.length >= max;
        return (
          <button
            key={f.userId}
            type="button"
            disabled={full}
            onClick={() => setPicked(on ? picked.filter(x => x !== f.userId) : [...picked, f.userId])}
            className={`w-full flex items-center gap-3 p-2 rounded-xl text-left ${on ? 'bg-cyan-500/10' : 'hover:bg-slate-800'} disabled:opacity-40`}
          >
            <Avatar avatar={f.avatar} photoUrl={f.photoUrl} className="w-9 h-9 text-sm" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white truncate">{f.name}</div>
              <div className="text-[10px] font-mono text-cyan-400 truncate">{f.userId}</div>
            </div>
            <span className={`w-5 h-5 rounded-md border flex items-center justify-center ${on ? 'bg-cyan-500 border-cyan-500 text-accent-ink' : 'border-slate-600'}`}>
              {on && <Check className="w-3.5 h-3.5" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** "New group": a name and the friends to put in it (up to 19 others). */
export function NewGroupBox({ friends, onClose, onCreated }: { friends: Friend[]; onClose: () => void; onCreated: (groupId: string) => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const r = await api<{ group: { userId: string } }>('/api/groups', { name, members: picked });
      onCreated(r.group.userId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not make the group. Please try again.');
      setBusy(false);
    }
  };
  return (
    <Box title="New group" onClose={onClose}>
      <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
        <Users className="w-5 h-5 text-cyan-400" /> New group
      </h3>
      <p className="text-xs text-slate-400 mb-4">Up to {MAX_GROUP} people. You can add or remove people later.</p>
      {error && <div role="alert" className="mb-3 p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">{error}</div>}
      <form onSubmit={create} className="space-y-4">
        <input required autoFocus maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="Group name" className={inputCls} />
        <div>
          <p className="text-xs text-slate-400 mb-2">
            Pick friends ({picked.length} of {MAX_GROUP - 1})
          </p>
          <FriendPicker friends={friends} picked={picked} setPicked={setPicked} max={MAX_GROUP - 1} />
        </div>
        <button type="submit" disabled={busy || !name.trim() || picked.length === 0} className="w-full h-11 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-accent-ink font-semibold rounded-xl text-sm">
          {busy ? 'Making the group…' : 'Make group'}
        </button>
      </form>
    </Box>
  );
}

/** The group's members: everyone can see them and leave; the person who made it can rename, add and remove. */
export function GroupInfoBox({ group, me, friends, onClose, onChanged, onLeft }: { group: Friend; me: string; friends: Friend[]; onClose: () => void; onChanged: () => void; onLeft: () => void }) {
  const members = group.members ?? [];
  const isOwner = group.ownerId === me;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: unknown, after?: () => void) => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await api(`/api/groups/${encodeURIComponent(group.userId)}/${path}`, body);
      after?.();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const canAdd = friends.filter(f => !f.isAdmin && !f.blockedByMe && !members.some(m => m.userId === f.userId));
  const room = MAX_GROUP - members.length;
  return (
    <Box title="Group info" onClose={onClose}>
      <div className="flex flex-col items-center text-center mb-4">
        <Avatar avatar="👥" className="w-16 h-16 text-3xl" />
        {renaming ? (
          <form
            className="mt-3 w-full flex gap-2"
            onSubmit={e => {
              e.preventDefault();
              void run('rename', { name }, () => setRenaming(false));
            }}
          >
            <input autoFocus maxLength={40} value={name} onChange={e => setName(e.target.value)} className={inputCls} />
            <button type="submit" disabled={busy || !name.trim()} className="px-4 rounded-xl bg-cyan-500 text-accent-ink text-sm font-semibold disabled:opacity-50">
              Save
            </button>
          </form>
        ) : (
          <h3 className="mt-3 text-lg font-bold text-white flex items-center gap-2">
            {group.name}
            {isOwner && (
              <button onClick={() => setRenaming(true)} className="w-8 h-8 rounded-full hover:bg-slate-800 text-slate-400 flex items-center justify-center" aria-label="Rename group">
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </h3>
        )}
        <p className="text-xs text-slate-400">
          {members.length} of {MAX_GROUP} people
        </p>
      </div>

      {error && <div role="alert" className="mb-3 p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">{error}</div>}

      {isOwner && !adding && room > 0 && (
        <button onClick={() => setAdding(true)} className="w-full mb-3 flex items-center gap-3 p-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-400 text-sm font-semibold">
          <UserPlus className="w-5 h-5" /> Add members
        </button>
      )}
      {adding && (
        <div className="mb-4 space-y-3 rounded-2xl border border-slate-800 p-3">
          <p className="text-xs text-slate-400">
            Pick friends to add ({picked.length} of {room})
          </p>
          <FriendPicker friends={canAdd} picked={picked} setPicked={setPicked} max={room} />
          <div className="flex gap-2">
            <button
              disabled={busy || picked.length === 0}
              onClick={() =>
                void run('add', { userIds: picked }, () => {
                  setAdding(false);
                  setPicked([]);
                })
              }
              className="flex-1 h-10 rounded-xl bg-cyan-500 text-accent-ink text-sm font-semibold disabled:opacity-50"
            >
              Add
            </button>
            <button onClick={() => setAdding(false)} className="flex-1 h-10 rounded-xl bg-slate-800 text-white text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1 mb-4">
        {members.map(m => (
          <div key={m.userId} className="flex items-center gap-3 p-2 rounded-xl">
            <Avatar avatar={m.avatar} photoUrl={m.photoUrl} className="w-9 h-9 text-sm" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white truncate flex items-center gap-1.5">
                {m.userId === me ? 'You' : m.name}
                {m.userId === group.ownerId && <Crown className="w-3.5 h-3.5 text-amber-400" aria-label="Made the group" />}
              </div>
              <div className="text-[10px] font-mono text-cyan-400 truncate">{m.userId}</div>
            </div>
            {isOwner && m.userId !== me && (
              <button
                onClick={() => window.confirm(`Remove ${m.name} from ${group.name}?`) && void run('remove', { userId: m.userId })}
                className="w-9 h-9 rounded-full hover:bg-slate-800 text-rose-400 flex items-center justify-center"
                aria-label={`Remove ${m.name}`}
              >
                <UserMinus className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={() => window.confirm(`Leave ${group.name}?`) && void run('leave', {}, onLeft)}
        className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-rose-500/15 text-rose-400 text-sm font-semibold"
      >
        <LogOut className="w-4 h-4" /> Leave group
      </button>
    </Box>
  );
}
