import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { THEMES, applyTheme, currentTheme } from './theme.ts';
import { playMessageSound } from './notify.ts';
import { startRingtone } from './ringtone.ts';
import { CUSTOM_FONT_FAMILY, FONTS, applyFont, currentFont, customFontName, getSoundChoice, setCustomFont, setCustomSound, setSoundMode, type SoundKind } from './prefs.ts';
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

type Tab = 'colour' | 'wallpaper' | 'sound' | 'font';
const TABS: [Tab, string][] = [['colour', 'Colour theme'], ['wallpaper', 'Wallpapers'], ['sound', 'Notifications'], ['font', 'Fonts']];

/** One tone setting: default tone, your own uploaded sound, or the phone's own sound. */
function ToneRow({ kind, title }: { kind: SoundKind; title: string }) {
  const [choice, setChoice] = useState(() => getSoundChoice(kind));
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  const mode = choice.mode;
  const pick = (m: 'default' | 'system') => {
    setErr('');
    setSoundMode(kind, m);
    setChoice(getSoundChoice(kind));
  };
  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr('');
    try {
      await setCustomSound(kind, f);
      setChoice(getSoundChoice(kind));
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Could not use that sound');
    }
  };
  const preview = () => {
    stopRef.current?.();
    stopRef.current = null;
    if (kind === 'notif') return playMessageSound(true);
    const stop = startRingtone(1, false);
    stopRef.current = stop;
    setTimeout(() => {
      stop();
      if (stopRef.current === stop) stopRef.current = null;
    }, 4000);
  };
  const opt = (on: boolean) => `w-full text-left px-3 py-2.5 rounded-xl border text-sm ${on ? 'border-cyan-500 bg-cyan-500/10 text-white' : 'border-slate-800 text-slate-200 hover:bg-slate-800'}`;
  return (
    <div className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</p>
      <div className="mt-2 space-y-2">
        <button type="button" onClick={() => pick('default')} className={opt(mode === 'default')}>Default tone</button>
        <button type="button" onClick={() => ref.current?.click()} className={opt(mode === 'custom')}>
          Upload your own{mode === 'custom' && choice.name ? <span className="block text-[11px] text-slate-400 truncate">Using: {choice.name}</span> : null}
        </button>
        <button type="button" onClick={() => pick('system')} className={opt(mode === 'system')}>
          Use system default
          <span className="block text-[11px] text-slate-400">{kind === 'ring' ? 'No ringtone inside the app, only vibration.' : "No sound inside the app. Your phone's own sound is used when the app is closed."}</span>
        </button>
      </div>
      <input ref={ref} type="file" accept="audio/*" className="hidden" onChange={upload} />
      {mode !== 'system' && (
        <button type="button" onClick={preview} className="mt-2 px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-100">▶ Play to test</button>
      )}
      {err && <div role="alert" className="mt-2 text-xs text-rose-400">{err}</div>}
    </div>
  );
}

/** "Personalise": colour theme, wallpapers, notification tones and fonts. */
export default function ThemeSheet({ userId, filesEnabled, onChanged, onClose }: { userId: string; filesEnabled: boolean; onChanged: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('colour');
  const [font, setFont] = useState(currentFont);
  const [fontName, setFontName] = useState(customFontName);
  const fontRef = useRef<HTMLInputElement>(null);
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

  const pickFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    try {
      await setCustomFont(f);
      setFont('custom');
      setFontName(f.name);
    } catch (x) {
      setError(x instanceof Error ? x.message : 'Could not use that font');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-sm max-h-[92dvh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-5 pb-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-bold text-white">Personalise</h3>
          <button onClick={onClose} disabled={busy} className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`py-2 rounded-xl text-xs font-semibold border ${tab === id ? 'border-cyan-500 bg-cyan-500/10 text-white' : 'border-slate-800 text-slate-300 hover:bg-slate-800'}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'colour' && (<>
        <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">Colour theme</p>
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
        </>)}

        {tab === 'wallpaper' && (<>
        <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">Chat wallpaper</p>
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
        </>)}

        {tab === 'sound' && (<>
          <ToneRow kind="ring" title="Ring tone (calls)" />
          <ToneRow kind="notif" title="Notification tone (messages)" />
          <p className="mt-4 text-[11px] text-slate-500">Saved on this phone only. When the app is closed, your phone plays its own notification sound.</p>
        </>)}

        {tab === 'font' && (<>
          <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">Font</p>
          <p className="mt-1 text-[11px] text-slate-500">All four are free to use (open font licence). Saved on this phone. Needs internet the first time.</p>
          <div className="mt-3 space-y-2">
            {FONTS.map(f => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  applyFont(f.id);
                  setFont(f.id);
                }}
                aria-pressed={font === f.id}
                style={f.family ? { fontFamily: f.family } : undefined}
                className={`w-full text-left px-3 py-3 rounded-xl border ${font === f.id ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 hover:bg-slate-800'}`}
              >
                <span className="block text-base text-white">{f.name}</span>
                <span className="block text-sm text-slate-300">Hello, how are you today?</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => fontRef.current?.click()}
              style={font === 'custom' ? { fontFamily: CUSTOM_FONT_FAMILY } : undefined}
              className={`w-full text-left px-3 py-3 rounded-xl border ${font === 'custom' ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 hover:bg-slate-800'}`}
            >
              <span className="block text-base text-white">Upload your own</span>
              <span className="block text-[11px] text-slate-400 truncate">{font === 'custom' && fontName ? `Using: ${fontName}` : 'A font file ending in .ttf, .otf, .woff or .woff2'}</span>
            </button>
          </div>
          <input ref={fontRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden" onChange={pickFont} />
          {error && <div role="alert" className="mt-3 text-xs text-rose-400">{error}</div>}
        </>)}

        <button onClick={onClose} disabled={busy} className="mt-4 w-full py-3 rounded-xl bg-slate-800 text-white text-sm font-medium">Done</button>
      </div>
    </div>
  );
}
