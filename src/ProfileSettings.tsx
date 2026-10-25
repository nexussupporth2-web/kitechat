import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, Image as ImageIcon, Pencil, Smile, Trash2, X } from 'lucide-react';
import { api, uploadToStorage } from './api.ts';

interface Me {
  userId: string;
  name: string;
  avatar: string;
  handle: string | null;
  category: string;
  photoUrl: string | null;
  gender: string;
  birthday: string;
  showGender: boolean;
  showBirthday: boolean;
}

interface Props {
  userId: string;
  /** Called after anything changed, so the rest of the app can refresh the name and picture. */
  onChanged: (u: { userId: string; name: string; avatar: string; photoUrl: string | null }) => void;
}

const CATEGORIES = ['Digital Creator', 'Software Engineer', 'Musician', 'Artist', 'Photographer', 'Student', 'Entrepreneur', 'Teacher', 'Other'];
const GENDERS = ['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say'];
const AVATARS = ['😀', '😎', '🥳', '🤩', '😇', '🦊', '🐼', '🐯', '🦁', '🐸', '🦄', '🪁'];
const HANDLE_RE = /^(?![.])(?!.*\.\.)(?!.*[.]$)[a-z0-9._]{3,30}$/;

const inputCls = 'w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500';

/** Profile Settings: picture, name, @username and a few optional details. The pencil switches to edit mode. */
export default function ProfileSettings({ userId, onChanged }: Props) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ user: Me }>(`/api/profile/${encodeURIComponent(userId)}?lite=1`);
      setMe(r.user);
      setError('');
      return r.user;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your profile');
      return null;
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = async () => {
    const u = await load();
    if (u) onChanged({ userId: u.userId, name: u.name, avatar: u.avatar, photoUrl: u.photoUrl });
  };

  if (!me) {
    return <div className="flex-1 flex items-center justify-center text-sm text-slate-400 p-8 text-center">{error || 'Loading…'}</div>;
  }

  if (editing) {
    return (
      <Editor
        me={me}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          await changed();
          setEditing(false);
        }}
        onPhotoChanged={changed}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950">
      <div className="max-w-xl mx-auto pb-10">
        <div className="flex justify-end p-3">
          <button onClick={() => setEditing(true)} className="w-11 h-11 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center" aria-label="Edit profile" title="Edit profile">
            <Pencil className="w-5 h-5" />
          </button>
        </div>
        <div className="flex flex-col items-center px-4">
          <Ring me={me} />
          <h2 className="mt-5 text-xl font-semibold text-white text-center break-words max-w-full">{me.name}</h2>
          <p className="text-sm text-slate-400">@{me.handle ?? me.userId.toLowerCase()}</p>
          {me.category && <span className="mt-3 px-3 py-1 rounded-full bg-slate-800 text-xs text-slate-300">{me.category}</span>}
          {error && <p role="alert" className="mt-3 text-xs text-rose-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** Big gradient ring around the profile picture (or the first letter of the name). */
function Ring({ me, size = 'w-36 h-36', text = 'text-5xl' }: { me: Pick<Me, 'photoUrl' | 'avatar'>; size?: string; text?: string }) {
  return (
    <div className={`${size} rounded-full p-1.5 bg-gradient-to-tr from-amber-400 via-rose-400 to-indigo-400 shadow-lg shadow-rose-400/30`}>
      <div className="w-full h-full rounded-full bg-slate-950 p-1.5">
        {me.photoUrl ? (
          <img src={me.photoUrl} alt="" className="w-full h-full rounded-full object-cover" />
        ) : (
          <div className={`w-full h-full rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center ${text} font-bold`}>{me.avatar}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Editor({ me, onClose, onSaved, onPhotoChanged }: { me: Me; onClose: () => void; onSaved: () => Promise<void>; onPhotoChanged: () => Promise<void> }) {
  const [name, setName] = useState(me.name);
  const [handle, setHandle] = useState(me.handle ?? '');
  const [check, setCheck] = useState<{ state: 'idle' | 'checking' | 'ok' | 'bad'; reason?: string }>({ state: 'idle' });
  const [category, setCategory] = useState(me.category);
  const [gender, setGender] = useState(me.gender);
  const [showGender, setShowGender] = useState(me.showGender);
  const [birthday, setBirthday] = useState(me.birthday);
  const [showBirthday, setShowBirthday] = useState(me.showBirthday);
  const [sheet, setSheet] = useState(false);
  const [picking, setPicking] = useState<'avatars' | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Real-time username check (waits a moment after typing stops).
  useEffect(() => {
    const h = handle.trim().toLowerCase();
    if (h === (me.handle ?? '')) return setCheck({ state: h ? 'ok' : 'idle' });
    if (!h) return setCheck({ state: 'idle' });
    if (!HANDLE_RE.test(h)) return setCheck({ state: 'bad', reason: 'Use 3-30 lowercase letters, numbers, dots or underscores (no spaces).' });
    setCheck({ state: 'checking' });
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ ok: boolean; reason: string | null }>(`/api/handle-check?handle=${encodeURIComponent(h)}`);
        if (!stale) setCheck(r.ok ? { state: 'ok' } : { state: 'bad', reason: r.reason ?? 'Not available' });
      } catch {
        if (!stale) setCheck({ state: 'idle' });
      }
    }, 450);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [handle, me.handle]);

  const uploadPhoto = async (blob: Blob) => {
    setBusy(true);
    setError('');
    try {
      const s = await api<{ key: string; uploadUrl: string }>('/api/media/sign', { kind: 'avatar', mime: 'image/jpeg', size: blob.size });
      await uploadToStorage(s.uploadUrl, blob, 'image/jpeg');
      await api('/api/profile/photo', { key: s.key });
      await onPhotoChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the picture');
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = async () => {
    setSheet(false);
    setBusy(true);
    try {
      await api('/api/profile/photo', undefined, 'DELETE');
      await onPhotoChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the picture');
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setSheet(false);
    setCropFile(f);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/profile', {
        name: name.trim(),
        handle: handle.trim().toLowerCase(),
        category,
        gender,
        birthday,
        showGender,
        showBirthday
      }, 'PATCH');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      setBusy(false);
    }
  };

  const canSave = !busy && name.trim().length > 0 && check.state !== 'bad' && check.state !== 'checking';

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950">
      <div className="max-w-xl mx-auto pb-16">
        <div className="flex items-center justify-between p-3">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-xl text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
          <h2 className="text-base font-semibold text-white">Edit profile</h2>
          <button onClick={save} disabled={!canSave} className="px-4 py-2 rounded-xl text-sm font-semibold bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-accent-ink">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* 1. Profile picture */}
        <div className="flex flex-col items-center mt-2">
          <div className="relative">
            <Ring me={me} />
            <button onClick={() => setSheet(true)} disabled={busy} className="absolute bottom-1 right-1 w-11 h-11 rounded-full bg-cyan-500 text-accent-ink flex items-center justify-center border-4 border-slate-950" aria-label="Change photo">
              <Camera className="w-5 h-5" />
            </button>
          </div>
          <button onClick={() => setSheet(true)} disabled={busy} className="mt-3 text-sm text-cyan-400 font-medium">Change photo</button>
        </div>

        <div className="px-4 mt-6 space-y-5">
          {/* 2. Name and username */}
          <label className="block">
            <span className="flex justify-between text-xs text-slate-400 mb-1.5">
              <span>Display name</span>
              <span>{name.length}/30</span>
            </span>
            <input value={name} onChange={e => setName(e.target.value.slice(0, 30))} className={inputCls} placeholder="Your name" />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400 mb-1.5 block">Username</span>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-sm">@</span>
              <input
                value={handle}
                onChange={e => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 30))}
                className={`${inputCls} pl-8 pr-10 font-mono`}
                placeholder={me.userId.toLowerCase()}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {check.state === 'ok' && <Check className="w-5 h-5 text-emerald-500" aria-label="Available" />}
                {check.state === 'bad' && <X className="w-5 h-5 text-rose-400" aria-label="Not available" />}
                {check.state === 'checking' && <span className="text-[11px] text-slate-500">…</span>}
              </span>
            </div>
            <span className={`block mt-1.5 text-[11px] ${check.state === 'bad' ? 'text-rose-400' : check.state === 'ok' ? 'text-emerald-500' : 'text-slate-500'}`}>
              {check.state === 'bad' ? check.reason : check.state === 'ok' && handle !== (me.handle ?? '') ? 'Available' : 'Lowercase letters, numbers, dots and underscores. No spaces.'}
            </span>
          </label>

          {/* 3. Optional details */}
          <label className="block">
            <span className="text-xs text-slate-400 mb-1.5 block">Category</span>
            <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
              <option value="">Not set</option>
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>

          <div>
            <label className="block">
              <span className="text-xs text-slate-400 mb-1.5 block">Gender</span>
              <select value={gender} onChange={e => setGender(e.target.value)} className={inputCls}>
                <option value="">Not set</option>
                {GENDERS.map(g => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </label>
            <Toggle label="Visible on profile" on={showGender} onChange={setShowGender} hint={showGender ? 'Friends can see this' : 'Only me'} />
          </div>

          <div>
            <label className="block">
              <span className="text-xs text-slate-400 mb-1.5 block">Birthday</span>
              <input type="date" value={birthday} max={new Date().toISOString().slice(0, 10)} onChange={e => setBirthday(e.target.value)} className={inputCls} />
            </label>
            <Toggle label="Visible on profile" on={showBirthday} onChange={setShowBirthday} hint={showBirthday ? 'Friends can see this' : 'Only me'} />
          </div>

          {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
        </div>
      </div>

      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={pickFile} />
      <input ref={cameraRef} type="file" accept="image/*" capture="user" className="hidden" onChange={pickFile} />

      {sheet && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={() => setSheet(false)}>
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-3 pb-6" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-slate-700 mx-auto mb-3" />
            <SheetButton icon={<Camera className="w-5 h-5" />} label="Take photo" onClick={() => cameraRef.current?.click()} />
            <SheetButton icon={<ImageIcon className="w-5 h-5" />} label="Choose from gallery / files" onClick={() => galleryRef.current?.click()} />
            <SheetButton icon={<Smile className="w-5 h-5" />} label="Use avatar" onClick={() => { setSheet(false); setPicking('avatars'); }} />
            {me.photoUrl && <SheetButton icon={<Trash2 className="w-5 h-5" />} label="Remove current photo" danger onClick={removePhoto} />}
          </div>
        </div>
      )}

      {picking === 'avatars' && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={() => setPicking(null)}>
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-5 pb-8" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-white mb-4">Choose an avatar</h3>
            <div className="grid grid-cols-4 gap-3">
              {AVATARS.map(a => (
                <button
                  key={a}
                  onClick={async () => {
                    setPicking(null);
                    await uploadPhoto(await emojiToBlob(a));
                  }}
                  className="aspect-square rounded-2xl bg-slate-800 hover:bg-slate-700 text-4xl flex items-center justify-center"
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {cropFile && (
        <Cropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onDone={async blob => {
            setCropFile(null);
            await uploadPhoto(blob);
          }}
        />
      )}
    </div>
  );
}

function SheetButton({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl hover:bg-slate-800 text-sm font-medium ${danger ? 'text-rose-400' : 'text-white'}`}>
      {icon}
      {label}
    </button>
  );
}

function Toggle({ label, on, onChange, hint }: { label: string; on: boolean; onChange: (v: boolean) => void; hint: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="mt-2 w-full flex items-center justify-between gap-3 text-left" role="switch" aria-checked={on}>
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        <span className="block text-[11px] text-slate-500">{hint}</span>
      </span>
      <span className={`w-11 h-6 rounded-full p-0.5 transition-colors shrink-0 ${on ? 'bg-cyan-500' : 'bg-slate-700'}`}>
        <span className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Picture helpers

const OUT = 512;
const MAX_BYTES = 450 * 1024;

async function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  let best: Blob | null = null;
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) {
    const b = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', q));
    if (!b) continue;
    best = b;
    if (b.size <= MAX_BYTES) break;
  }
  if (!best) throw new Error('Could not prepare the picture');
  return best;
}

async function emojiToBlob(emoji: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = c.height = OUT;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, OUT, OUT);
  grad.addColorStop(0, '#ffd6e0');
  grad.addColorStop(1, '#c9d6ff');
  g.fillStyle = grad;
  g.fillRect(0, 0, OUT, OUT);
  g.font = `${OUT * 0.55}px system-ui, "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, OUT / 2, OUT / 2 + OUT * 0.04);
  return canvasToJpeg(c);
}

/** Circular crop: drag to move, slider to zoom. */
function Cropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (b: Blob) => void }) {
  const V = Math.min(300, window.innerWidth - 48);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [err, setErr] = useState('');
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setErr('This image format is not supported. Try a JPG, PNG or WebP photo.');
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const base = img ? V / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;

  const clamp = (x: number, y: number, s = scale) => {
    if (!img) return { x: 0, y: 0 };
    const mx = Math.max(0, (img.naturalWidth * s) / 2 - V / 2);
    const my = Math.max(0, (img.naturalHeight * s) / 2 - V / 2);
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  };

  const finish = async () => {
    if (!img) return;
    const c = document.createElement('canvas');
    c.width = c.height = OUT;
    const g = c.getContext('2d')!;
    const side = V / scale;
    const sx = img.naturalWidth / 2 - pos.x / scale - side / 2;
    const sy = img.naturalHeight / 2 - pos.y / scale - side / 2;
    g.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);
    try {
      onDone(await canvasToJpeg(c));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not prepare the picture');
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/90 flex flex-col items-center justify-center p-4 gap-5">
      <h3 className="text-white text-base font-semibold">Move and zoom</h3>
      {err ? (
        <p className="text-rose-300 text-sm text-center max-w-xs">{err}</p>
      ) : (
        <div
          className="relative overflow-hidden bg-black touch-none select-none rounded-2xl"
          style={{ width: V, height: V }}
          onPointerDown={e => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
          }}
          onPointerMove={e => {
            if (!drag.current) return;
            setPos(clamp(drag.current.px + e.clientX - drag.current.x, drag.current.py + e.clientY - drag.current.y));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              className="absolute max-w-none pointer-events-none"
              style={{
                width: img.naturalWidth * scale,
                height: img.naturalHeight * scale,
                left: V / 2 + pos.x - (img.naturalWidth * scale) / 2,
                top: V / 2 + pos.y - (img.naturalHeight * scale) / 2
              }}
            />
          )}
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at center, transparent 0, transparent calc(50% - 1px), rgba(0,0,0,0.62) 50%)' }} />
          <div className="absolute inset-0 pointer-events-none rounded-full border-2 border-white/80" />
        </div>
      )}
      {!err && (
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={e => {
            const z = Number(e.target.value);
            setZoom(z);
            setPos(p => clamp(p.x, p.y, base * z));
          }}
          className="w-64"
          aria-label="Zoom"
        />
      )}
      <div className="flex gap-3">
        <button onClick={onCancel} className="px-6 py-3 rounded-xl bg-slate-800 text-white text-sm font-medium">Cancel</button>
        {!err && (
          <button onClick={finish} disabled={!img} className="px-6 py-3 rounded-xl bg-cyan-500 text-accent-ink text-sm font-semibold disabled:opacity-50">
            Use photo
          </button>
        )}
      </div>
    </div>
  );
}
