import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from './api.ts';
import { deletePost, loadFeed, type MediaConfig } from './media.ts';
import Profile from './Profile.tsx';
import type { FeedPost } from './types.ts';

/** Stories & Reels page: your profile block on top, then the reels from you and your friends. */
export default function Feed({ me }: { me: string }) {
  const [cfg, setCfg] = useState<MediaConfig | null>(null);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const c = await api<MediaConfig>('/api/media/config');
      setCfg(c);
      if (c.enabled) {
        const f = await loadFeed();
        setPosts(f.posts);
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

  const reels = posts.filter(p => p.kind === 'reel');

  const remove = async (p: FeedPost) => {
    if (!confirm('Delete this reel? This cannot be undone.')) return;
    try {
      await deletePost(p.id);
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

  return (
    <Profile userId={me} isMe>
      <section className="px-4 mt-8">
        {error && <div role="alert" className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">{error}</div>}
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Reels</h2>
        {reels.length === 0 ? (
          <p className="text-xs text-slate-500">No reels yet.</p>
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
    </Profile>
  );
}
