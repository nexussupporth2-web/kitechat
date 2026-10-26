import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, MessageSquare, Play, Plus, Trash2, X } from 'lucide-react';
import { api } from './api.ts';
import { deletePost, phaseLabel, publishPost, type MediaConfig, type Phase } from './media.ts';

interface Item {
  id: string;
  mime: string;
  size: number;
  caption: string;
  createdAt: number;
  url: string;
}

interface ProfileData {
  user: {
    userId: string;
    name: string;
    avatar: string;
    isOnline: boolean;
    handle: string | null;
    category: string;
    photoUrl: string | null;
    gender: string;
    birthday: string;
  };
  stats: { album: number; reels: number; friends: number; status: number };
  caps: { image: number; video: number };
  items: Item[];
  statuses: Item[];
}

interface Props {
  userId: string;
  isMe: boolean;
  /** Shows a back arrow (used when this is opened over a chat). */
  onBack?: () => void;
  /** Shown for a friend's profile. */
  onMessage?: () => void;
  /** Extra content shown under the album (used by the Stories & Reels page). */
  children?: ReactNode;
}

const isVideo = (i: Item) => i.mime.startsWith('video/');

/** A profile with a photo/video album. The owner can add and delete; friends can look. */
export default function Profile({ userId, isMe, onBack, onMessage, children }: Props) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [cfg, setCfg] = useState<MediaConfig | null>(null);
  const [tab, setTab] = useState<'all' | 'videos' | 'images'>('all');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ phase: Phase; p: number } | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const [chooser, setChooser] = useState(false);
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const target = useRef<'album' | 'story'>('album');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api<ProfileData>(`/api/profile/${encodeURIComponent(userId)}`), api<MediaConfig>('/api/media/config')]);
      setData(p);
      setCfg(c);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the profile');
    }
  }, [userId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const addFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !cfg) return;
    setError('');
    setProgress({ phase: 'compressing', p: 0 });
    try {
      const kind = target.current;
      await publishPost(kind, file, '', cfg, (phase, p) => setProgress({ phase, p }));
      if (kind === 'album') setTab(file.type.startsWith('video/') ? 'videos' : 'images');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setProgress(null);
    }
  };

  const pick = (kind: 'album' | 'story') => {
    target.current = kind;
    setChooser(false);
    fileRef.current?.click();
  };

  const removeStatus = async (item: Item) => {
    if (!window.confirm('Delete this status?')) return;
    try {
      await deletePost(item.id);
      setStatusAt(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
    }
  };

  const remove = async (item: Item) => {
    if (!window.confirm('Delete this from your feed?')) return;
    try {
      await deletePost(item.id);
      setOpen(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
    }
  };

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-slate-400 p-8 text-center">
        {error || 'Loading profile…'}
      </div>
    );
  }

  const statuses = data.statuses ?? [];
  const hasStatus = statuses.length > 0;
  const items = data.items.filter(i => (tab === 'all' ? true : tab === 'videos' ? isVideo(i) : !isVideo(i)));
  const stats: [number, string][] = [
    [data.stats.album, 'Album'],
    [data.stats.friends, 'Friends']
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950">
      <div className="max-w-xl mx-auto pb-10">
        {onBack && (
          <div className="p-3">
            <button onClick={onBack} className="w-10 h-10 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-300" aria-label="Back">
              <ArrowLeft className="w-5 h-5" />
            </button>
          </div>
        )}

        <div className="flex flex-col items-center pt-4 px-4">
          <div className="relative">
            <div
              onClick={hasStatus ? () => setStatusAt(0) : undefined}
              role={hasStatus ? 'button' : undefined}
              aria-label={hasStatus ? 'View status' : undefined}
              className={`w-36 h-36 rounded-full p-1.5 ${hasStatus ? 'status-ring cursor-pointer bg-gradient-to-tr from-amber-400 via-rose-400 to-indigo-400' : 'bg-slate-800'}`}
            >
              <div className="w-full h-full rounded-full bg-slate-950 p-1.5">
                {data.user.photoUrl ? (
                  <img src={data.user.photoUrl} alt="" className="w-full h-full rounded-full object-cover" />
                ) : (
                  <div className="w-full h-full rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-5xl font-bold">{data.user.avatar}</div>
                )}
              </div>
            </div>
            <span
              className={`absolute bottom-2 right-2 w-8 h-8 rounded-full border-4 border-slate-950 ${data.user.isOnline ? 'bg-emerald-500' : 'bg-slate-600'}`}
              title={data.user.isOnline ? 'Online' : 'Offline'}
            />
          </div>
          <h2 className="mt-5 text-xl font-semibold text-white">@{data.user.handle ?? data.user.userId.toLowerCase()}</h2>
          <p className="text-sm text-slate-400">{data.user.name}</p>
          {(data.user.category || data.user.gender || data.user.birthday) && (
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {[data.user.category, data.user.gender, data.user.birthday && `🎂 ${data.user.birthday}`].filter(Boolean).map(t => (
                <span key={String(t)} className="px-3 py-1 rounded-full bg-slate-800 text-xs text-slate-300">{t}</span>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 mt-6">
          {isMe ? (
            <>
              <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" className="hidden" onChange={addFile} />
              <button
                onClick={() => setChooser(true)}
                disabled={progress !== null || !cfg?.enabled}
                className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Add photo or video
              </button>
            </>
          ) : (
            <button onClick={onMessage} className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold flex items-center justify-center gap-2">
              <MessageSquare className="w-4 h-4" /> Message
            </button>
          )}
          {progress && (
            <div className="mt-3">
              <div className="text-xs text-slate-300 mb-1">{phaseLabel(progress.phase)}… {Math.round(progress.p * 100)}%</div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full bg-cyan-500 transition-all" style={{ width: `${progress.p * 100}%` }} />
              </div>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-xs text-rose-400">{error}</p>}
          {isMe && <p className="mt-2 text-[11px] text-slate-500 text-center">Feed: up to {data.caps.image} photos and {data.caps.video} videos (30 s). Status: up to 2, disappears after 24 hours. Adding more replaces the oldest.</p>}
        </div>

        <div className="mx-4 mt-5 rounded-[2rem] bg-slate-800/70 flex items-center py-5">
          {stats.map(([n, label], i) => (
            <div key={label} className={`flex-1 text-center ${i > 0 ? 'border-l border-slate-600/50' : ''}`}>
              <div className="text-2xl font-semibold text-white">{n}</div>
              <div className="text-sm text-slate-400">{label}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-3 border-b border-slate-800">
          {(['all', 'videos', 'images'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`py-3 text-base font-medium border-b-2 -mb-px transition-colors ${tab === t ? 'text-white border-cyan-500' : 'text-slate-500 border-transparent'}`}
            >
              {t === 'all' ? 'All' : t === 'videos' ? 'Videos' : 'Images'}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <p className="text-center text-sm text-slate-500 py-12">{isMe ? `${tab === 'all' ? 'Nothing here' : `No ${tab}`} yet. Tap “Add photo or video”.` : `${tab === 'all' ? 'Nothing here' : `No ${tab}`} yet.`}</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 p-2">
            {items.map(item => (
              <button key={item.id} onClick={() => setOpen(item)} className="relative aspect-square rounded-xl overflow-hidden bg-slate-800">
                {isVideo(item) ? (
                  <>
                    <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline className="w-full h-full object-cover pointer-events-none" />
                    <span className="absolute bottom-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 text-fixed-white flex items-center justify-center">
                      <Play className="w-3 h-3" />
                    </span>
                  </>
                ) : (
                  <img src={item.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                )}
              </button>
            ))}
          </div>
        )}
        {children}
      </div>

      {chooser && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={() => setChooser(false)}>
          <div onClick={e => e.stopPropagation()} className="w-full max-w-sm bg-slate-900 rounded-t-3xl sm:rounded-3xl p-5 space-y-3">
            <h3 className="text-base font-semibold text-white text-center">Where should it go?</h3>
            <button onClick={() => pick('album')} className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold">
              To Feed
              <span className="block text-[11px] font-normal text-slate-400">Stays on your profile</span>
            </button>
            <button onClick={() => pick('story')} className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold">
              To Status
              <span className="block text-[11px] font-normal text-slate-400">Glowing ring on your photo, gone after 24 hours</span>
            </button>
            <button onClick={() => setChooser(false)} className="w-full py-2 text-sm text-slate-400">Cancel</button>
          </div>
        </div>
      )}

      {statusAt !== null && statuses[statusAt] && (
        <div className="fixed inset-0 z-50 bg-black flex items-center justify-center" onClick={() => (statusAt + 1 < statuses.length ? setStatusAt(statusAt + 1) : setStatusAt(null))}>
          <div className="absolute top-3 left-3 right-16 flex gap-1">
            {statuses.map((s, i) => (
              <div key={s.id} className={`h-1 flex-1 rounded-full ${i <= statusAt ? 'bg-white' : 'bg-white/30'}`} />
            ))}
          </div>
          <button onClick={e => { e.stopPropagation(); setStatusAt(null); }} className="absolute top-6 right-4 w-10 h-10 rounded-full bg-black/50 text-fixed-white flex items-center justify-center" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
          {isMe && (
            <button onClick={e => { e.stopPropagation(); void removeStatus(statuses[statusAt]); }} className="absolute top-6 left-4 w-10 h-10 rounded-full bg-black/50 text-fixed-white flex items-center justify-center" aria-label="Delete status">
              <Trash2 className="w-5 h-5" />
            </button>
          )}
          <div onClick={e => e.stopPropagation()} className="max-w-full max-h-full">
            {statuses[statusAt].mime.startsWith('video/') ? (
              <video key={statuses[statusAt].id} src={statuses[statusAt].url} controls autoPlay playsInline className="max-w-full max-h-[100dvh]" />
            ) : statuses[statusAt].mime.startsWith('audio/') ? (
              <audio key={statuses[statusAt].id} src={statuses[statusAt].url} controls autoPlay />
            ) : (
              <img src={statuses[statusAt].url} alt="" onClick={() => (statusAt + 1 < statuses.length ? setStatusAt(statusAt + 1) : setStatusAt(null))} className="max-w-full max-h-[100dvh] object-contain" />
            )}
          </div>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black flex items-center justify-center" onClick={() => setOpen(null)}>
          <button onClick={() => setOpen(null)} className="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/50 text-fixed-white flex items-center justify-center" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
          {isMe && (
            <button
              onClick={e => {
                e.stopPropagation();
                void remove(open);
              }}
              className="absolute top-4 left-4 w-10 h-10 rounded-full bg-black/50 text-fixed-white flex items-center justify-center"
              aria-label="Delete"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
          <div onClick={e => e.stopPropagation()} className="max-w-full max-h-full">
            {isVideo(open) ? (
              <video src={open.url} controls autoPlay playsInline className="max-w-full max-h-[100dvh]" />
            ) : (
              <img src={open.url} alt="" className="max-w-full max-h-[100dvh] object-contain" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
