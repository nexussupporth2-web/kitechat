import { useState } from 'react';
import { Radio } from 'lucide-react';
import { api, ApiError, setToken } from './api.ts';
import type { User } from './types.ts';

export default function Auth({ onAuthed }: { onAuthed: (user: User) => void }) {
  const [view, setView] = useState<'login' | 'register'>('login');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [appeal, setAppeal] = useState('');
  const [appealNote, setAppealNote] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBlocked(false);
    setAppealNote('');
    setBusy(true);
    try {
      const body = view === 'register' ? { userId, password, name } : { userId, password };
      const res = await api<{ token: string; user: User }>(view === 'register' ? '/api/register' : '/api/login', body);
      setToken(res.token);
      onAuthed(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      if (err instanceof ApiError && err.blocked) setBlocked(true);
    } finally {
      setBusy(false);
    }
  };

  const sendAppeal = async () => {
    setBusy(true);
    setAppealNote('');
    try {
      await api('/api/appeal', { userId, password, message: appeal });
      setAppealNote('Your appeal was sent. The admin will look at it.');
      setAppeal('');
    } catch (err) {
      setAppealNote(err instanceof ApiError ? err.message : 'Could not send the appeal');
    } finally {
      setBusy(false);
    }
  };

  const input =
    'w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500';
  const tab = (active: boolean) =>
    `flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${active ? 'bg-cyan-500 text-accent-ink shadow' : 'text-slate-400 hover:text-white'}`;

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl">
        <div className="flex items-center justify-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/25">
            <Radio className="w-6 h-6 text-accent-ink" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center text-white mb-2">KiteChat</h1>
        <p className="text-xs text-slate-400 text-center mb-8">Free messaging plus peer-to-peer WebRTC audio and video calls.</p>

        <div className="flex bg-slate-950 p-1 rounded-xl mb-6 border border-slate-800">
          <button type="button" onClick={() => { setView('login'); setError(''); }} className={tab(view === 'login')}>Sign In</button>
          <button type="button" onClick={() => { setView('register'); setError(''); }} className={tab(view === 'register')}>Register</button>
        </div>

        {error && (
          <div role="alert" className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs text-center">
            {error}
          </div>
        )}

        {blocked && (
          <div className="mb-4 space-y-2">
            <textarea className={`${input} resize-none`} rows={3} maxLength={500} value={appeal} onChange={e => setAppeal(e.target.value)} placeholder="Appeal: tell the admin why this was a mistake" />
            <button type="button" onClick={sendAppeal} disabled={busy || !appeal.trim()} className="w-full h-10 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-white text-sm font-medium">
              Send appeal
            </button>
            {appealNote && <p role="status" className="text-xs text-cyan-400 text-center">{appealNote}</p>}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          {view === 'register' && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Full Name</label>
              <input className={input} required maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Alex Mercer" autoComplete="name" />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">User ID (shareable)</label>
            <input
              className={`${input} font-mono uppercase tracking-wider`}
              required
              maxLength={20}
              value={userId}
              minLength={view === 'register' ? 3 : undefined}
              onChange={e => setUserId(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="e.g. ALEX123"
              autoComplete="username"
              autoCapitalize="characters"
            />
            {view === 'register' && <p className="text-[11px] text-slate-500 mt-1.5">3-20 characters: letters, numbers or underscore. Friends add you with this ID.</p>}
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Password</label>
            <input
              className={input}
              type="password"
              required
              minLength={view === 'register' ? 6 : undefined}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={view === 'register' ? 'new-password' : 'current-password'}
            />
            {view === 'register' && <p className="text-[11px] text-slate-500 mt-1.5">At least 6 characters.</p>}
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 disabled:opacity-60 text-accent-ink font-semibold text-sm shadow-lg shadow-cyan-500/25 transition-all mt-2"
          >
            {busy ? 'Please wait…' : view === 'register' ? 'Create Account' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
