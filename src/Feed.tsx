import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Film, Music, Plus, Trash2, X } from 'lucide-react';
import { api, formatBytes } from './api.ts';
import { deletePost, loadFeed, phaseLabel, publishPost, type MediaConfig, type Phase } from './media.ts';
import type { FeedPost } from './types.ts';

const isVideo = (p: FeedPost) => p.mime.startsWith('video/');
const isAudio = (p: FeedPost) => p.mime.startsWith('audio/');
const hoursLeft = (p: FeedPost) => (p.expiresAt ? Math.max(1, Math.ceil((p.expiresAt - Date.now()) / 3_600_000)) : null);

export default function Feed({ me }: { me: string }) {
  const [cfg, setCfg] = useState<MediaConfig | null>(null);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [used, setUsed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composeKind, setComposeKind] = useState<'story' | 'reel' | null>(null);
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<{ phase: Phase; p: number } | null>(null);
  const [viewer, setViewer] = useState<{ ownerId: string; index: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await api<MediaConfig>('/api/media/config');
      setCfg(c);
      if (c.enabled) {
        const f = await loadFeed();
        setPosts(f.posts);
        setUsed(f.usedBytes);
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stories = useMemo(() => posts.filter(p => p.kind === 'story').sort((a, b) => a.createdAt - b.createdAt), [posts]);
  const reels = useMemo(() => posts.filter(p => p.kind === 'reel'), [posts]);
  const storyOwners = useMemo(() => {
    const seen = new Map<string, FeedPost>();
    for (const s of stories) if (!seen.has(s.ownerId)) seen.set(s.ownerId, s);
    return [...seen.values()];
  }, [stories]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !composeKind || !cfg) return;
    setError('');
    setProgress({ phase: 'compressing', p: 0 });
    try {
      await publishPost(composeKind, file, caption, cfg, (phase, p) => setProgress({ phase, p }));
      setCaption('');
      setComposeKind(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setProgress(null);
    }
  };

  const remove = async (p: FeedPost) => {
    if (!confirm(`Delete this ${p.kind}? This cannot be undone.`)) return;
    try {
      await deletePost(p.id);
      setViewer(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
    }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Loading…</div>;

  if (cfg && !cfg.enabled) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-slate-400 text-sm max-w-md mx-auto">
        Stories and reels need cloud storage, which isn't set up on this server yet.
      </div>
    );
  }

  const viewerStories = viewer ? stories.filter(s => s.ownerId === viewer.ownerId) : [];
  const accept = composeKind === 'reel' ? 'video/*' : 'image/*,video/*,audio/*';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto p-4 space-y-6">
        {error && <div role="alert" className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">{error}</div>}

        <div className="flex items-center gap-2">
          <button onClick={() => setComposeKind('story')} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-accent-ink text-xs font-semibold">
            <Plus className="w-4 h-4" /> Story
          </button>
          <button onClick={() => setComposeKind('reel')} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-accent-ink text-xs font-semibold">
            <Film className="w-4 h-4" /> Reel
          </button>
          {cfg && (
            <span className="ml-auto text-[11px] text-slate-500">
              {formatBytes(used)} of {formatBytes(cfg.limits.quotaBytes)} used
            </span>
          )}
        </div>

        {composeKind && cfg && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">New {composeKind}</h3>
              <button onClick={() => setComposeKind(null)} className="text-slate-400 hover:text-white" aria-label="Cancel"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[11px] text-slate-400">
              {composeKind === 'story'
                ? `Photo, video or audio up to ${cfg.limits.story.maxMediaSec}s. Disappears after 24 hours.`
                : `Video up to ${cfg.limits.reel.maxVideoSec}s. Stays until you delete it.`}{' '}
              It is compressed on your device before uploading, so it stays small and looks good on phone and desktop.
            </p>
            <input
              value={caption}
              onChange={e => setCaption(e.target.value)}
              maxLength={300}
              placeholder="Caption (optional)"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500"
            />
            <input ref={fileRef} type="file" accept={accept} className="hidden" onChange={onFile} />
            {progress === null ? (
              <button onClick={() => fileRef.current?.click()} className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-white">
                Choose file and post
              </button>
            ) : (
              <div>
                <div className="text-xs text-slate-300 mb-1">{phaseLabel(progress.phase)}… {Math.round(progress.p * 100)}%</div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden"><div className="h-full bg-cyan-500" style={{ width: `${progress.p * 100}%` }} /></div>
              </div>
            )}
          </div>
        )}

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Stories</h2>
          {storyOwners.length === 0 ? (
            <p className="text-xs text-slate-500">No stories right now.</p>
          ) : (
            <div className="flex gap-4 overflow-x-auto pb-2">
              {storyOwners.map(s => (
                <button key={s.ownerId} onClick={() => setViewer({ ownerId: s.ownerId, index: 0 })} className="flex flex-col items-center gap-1.5 shrink-0">
                  <span className="w-16 h-16 rounded-full p-0.5 bg-gradient-to-br from-cyan-400 to-indigo-500">
                    <span className="w-full h-full rounded-full bg-slate-900 border-2 border-slate-950 flex items-center justify-center text-lg font-bold text-cyan-300">{s.ownerAvatar}</span>
                  </span>
                  <span className="text-[11px] text-slate-300 max-w-16 truncate">{s.ownerId === me ? 'Your story' : s.ownerName}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Reels</h2>
          {reels.length === 0 ? (
            <p className="text-xs text-slate-500">No reels yet. Post the first one.</p>
          ) : (
            <div className="space-y-5">
              {reels.map(r => (
                <article key={r.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-sm font-bold">{r.ownerAvatar}</span>
                      <span className="text-sm font-semibold text-white truncate">{r.ownerName}</span>
                    </div>
                    {r.ownerId === me && (
                      <button onClick={() => remove(r)} className="text-slate-400 hover:text-rose-400" aria-label="Delete reel"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </div>
                  <video src={r.url} controls playsInline preload="metadata" className="w-full max-h-[70vh] bg-black" />
                  {r.caption && <p className="px-3 py-2.5 text-sm text-slate-200">{r.caption}</p>}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {viewer && viewerStories[viewer.index] && (
        <StoryViewer
          stories={viewerStories}
          index={viewer.index}
          me={me}
          onIndex={i => setViewer({ ownerId: viewer.ownerId, index: i })}
          onClose={() => setViewer(null)}
          onDelete={remove}
        />
      )}
    </div>
  );
}

function StoryViewer({ stories, index, me, onIndex, onClose, onDelete }: {
  stories: FeedPost[];
  index: number;
  me: string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (p: FeedPost) => void;
}) {
  const story = stories[index];
  const next = useCallback(() => (index + 1 < stories.length ? onIndex(index + 1) : onClose()), [index, stories.length, onIndex, onClose]);

  useEffect(() => {
    if (isVideo(story) || isAudio(story)) return;
    const t = setTimeout(next, 5000);
    return () => clearTimeout(t);
  }, [story, next]);

  const left = hoursLeft(story);
  return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
      <div className="relative w-full max-w-md h-full max-h-[100dvh] bg-slate-950 flex items-center justify-center">
        <div className="absolute top-0 inset-x-0 p-3 z-10 bg-gradient-to-b from-black/70 to-transparent">
          <div className="flex gap-1 mb-3">
            {stories.map((_, i) => <span key={i} className={`h-0.5 flex-1 rounded-full ${i <= index ? 'bg-white' : 'bg-white/30'}`} />)}
          </div>
          <div className="flex items-center justify-between text-fixed-white text-sm">
            <span className="font-semibold">{story.ownerName}{left ? <span className="text-fixed-white/60 font-normal text-xs"> · {left}h left</span> : null}</span>
            <div className="flex items-center gap-3">
              {story.ownerId === me && <button onClick={() => onDelete(story)} aria-label="Delete story"><Trash2 className="w-5 h-5" /></button>}
              <button onClick={onClose} aria-label="Close"><X className="w-6 h-6" /></button>
            </div>
          </div>
        </div>

        {isVideo(story) ? (
          <video key={story.id} src={story.url} autoPlay playsInline controls onEnded={next} className="w-full h-full object-contain" />
        ) : isAudio(story) ? (
          <div className="flex flex-col items-center gap-6 px-8 w-full">
            <div className="w-24 h-24 rounded-full bg-cyan-500/15 text-cyan-400 flex items-center justify-center"><Music className="w-10 h-10" /></div>
            <audio key={story.id} src={story.url} autoPlay controls onEnded={next} className="w-full" />
          </div>
        ) : (
          <img key={story.id} src={story.url} alt="" className="w-full h-full object-contain" />
        )}

        {story.caption && <p className="absolute bottom-6 inset-x-4 text-center text-fixed-white text-sm bg-black/50 rounded-xl px-3 py-2">{story.caption}</p>}

        {index > 0 && (
          <button onClick={() => onIndex(index - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 text-fixed-white flex items-center justify-center" aria-label="Previous"><ChevronLeft className="w-5 h-5" /></button>
        )}
        <button onClick={next} className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 text-fixed-white flex items-center justify-center" aria-label="Next"><ChevronRight className="w-5 h-5" /></button>
      </div>
    </div>
  );
}
