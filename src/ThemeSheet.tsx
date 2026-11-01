import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { THEMES, applyTheme, currentTheme } from './theme.ts';
import {
  DEFAULT_WALLPAPER,
  PRESET_WALLPAPERS,
  loadChatWallpaper,
  loadWallOpacity,
  resetMyWallpaper,
  saveWallOpacity,
  setMyWallpaper,
  setPresetWallpaper,
  wallpaperBackground
} from './wallpaper.ts';

/** "Colours and Wallpapers": the colour themes, the chat wallpaper and how strong the picture looks. */
export default function ThemeSheet({ userId, filesEnabled, onChanged, onClose }: { userId: string; filesEnabled: boolean; onChanged: () => void; onClose: () => void }) {
  const [theme, setTheme] = useState(currentTheme);
  const [wallUrl, setWallUrl] = useState(DEFAULT_WALLPAPER);
  const [opacity, setOpacity] = useState(loadWallOpacity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setWallUrl(await loadChatWallpaper(userId));
  }, [userId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the wallpaper');
    } finally {
      setBusy(false);
    }
  };

  const pickOwn = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!filesEnabled) return setError('Your own picture needs file storage, which is not set up yet. Choose a ready-made wallpaper.');
    void run(() => setMyWallpaper(f));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-sm max-h-[92dvh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-5 pb-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-bold text-white">Colours and Wallpapers</h3>
          <button onClick={onClose} disabled={busy} className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Colour theme</p>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                applyTheme(t.id);
                setTheme(t.id);
              }}
              aria-pressed={theme === t.id}
              className={`rounded-2xl border p-2.5 flex flex-col items-center gap-2 ${theme === t.id ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 hover:bg-slate-800'}`}
            >
              <span className="relative w-12 h-12 rounded-full border border-white/20" style={{ background: `linear-gradient(135deg, ${t.bg} 50%, ${t.accent} 50%)` }}>
                {theme === t.id && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Check className="w-5 h-5 text-fixed-white drop-shadow" />
                  </span>
                )}
              </span>
              <span className="text-xs text-slate-200">{t.name}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Saved on this phone. Light or dark still follows your phone setting.</p>

        <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">Chat wallpaper</p>
        <p className="mt-1 text-[11px] text-slate-500">Your friends see your wallpaper in their chat with you. The most recent change by either of you is used.</p>
        <div className="mt-3 h-36 rounded-2xl border border-slate-800 chat-wallpaper bg-slate-950" style={{ backgroundImage: wallpaperBackground(wallUrl, opacity) }} />
        <label className="block mt-3">
          <span className="flex justify-between text-xs text-slate-300 mb-1">
            <span>Picture strength</span>
            <span>{opacity}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacity}
            onChange={e => {
              const v = Number(e.target.value);
              setOpacity(v);
              saveWallOpacity(v);
            }}
            className="w-full"
            aria-label="Wallpaper strength"
          />
          <span className="flex justify-between text-[10px] text-slate-500">
            <span>0% plain</span>
            <span>100% full picture</span>
          </span>
        </label>
        <p className="mt-1 text-[11px] text-slate-500">The strength slider only changes your own phone.</p>

        {error && <div role="alert" className="mt-3 text-xs text-rose-400">{error}</div>}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickOwn} />

        <p className="mt-4 text-xs font-semibold text-slate-300 mb-2">Ready-made wallpapers</p>
        <div className="grid grid-cols-4 gap-2">
          {[{ id: 'kites', name: 'Kites', url: DEFAULT_WALLPAPER }, ...PRESET_WALLPAPERS].map(w => (
            <button
              key={w.id}
              type="button"
              disabled={busy}
              onClick={() => void run(() => (w.id === 'kites' ? resetMyWallpaper() : setPresetWallpaper(w.id)))}
              className="flex flex-col items-center gap-1 disabled:opacity-60"
              aria-label={`${w.name} wallpaper`}
            >
              <span className={`block w-full aspect-[3/4] rounded-xl border bg-cover bg-center ${wallUrl === w.url ? 'border-cyan-500 ring-2 ring-cyan-500/60' : 'border-slate-700'}`} style={{ backgroundImage: `url("${w.url}")` }} />
              <span className="text-[10px] text-slate-300 text-center leading-tight">{w.name}</span>
            </button>
          ))}
        </div>

        <p className="mt-4 text-xs font-semibold text-slate-300 mb-2">Your own picture</p>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className="w-full py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-accent-ink text-sm font-semibold">
          {busy ? 'Please wait…' : 'Choose your own photo'}
        </button>

        <button onClick={onClose} disabled={busy} className="mt-4 w-full py-3 rounded-xl bg-slate-800 text-white text-sm font-medium">Done</button>
      </div>
    </div>
  );
}
