import { useCallback, useEffect, useState } from 'react';
import { Flag, MessageCircle, MoreHorizontal, Send, Trash2, X } from 'lucide-react';
import { api, ApiError } from './api.ts';
import Avatar from './Avatar.tsx';
import type { User } from './types.ts';

interface Post {
  id: string;
  owner: { userId: string; name: string; avatar: string; photoUrl: string | null; businessName: string };
  mime: string;
  url: string | null;
  caption: string;
  visibility: 'public' | 'friends';
  createdAt: number;
  counts: Record<string, number>;
  total: number;
  mine: string | null;
  commentCount: number;
  isOwner: boolean;
}

interface Comment {
  id: string;
  userId: string;
  name: string;
  text: string;
  at: number;
  canDelete: boolean;
}

const ago = (t: number) => {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  const d = Math.floor(s / 86400);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};

/**
 * Kite Network: every feed post from "Stories & Reels", in one vertical scroll.
 * Nobody posts here directly. Public posts are visible to all; friends-only posts only to friends.
 */
export default function Network({ me, onBlocked, onOpenProfile }: { me: User; onBlocked: () => void; onOpenProfile: (userId: string) => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [emojis, setEmojis] = useState<string[]>(['❤️', '😂', '😮', '😢', '👏', '🔥', '🙏', '👍']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fail = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof ApiError && e.blocked) return onBlocked();
      setError(e instanceof ApiError ? e.message : fallback);
    },
    [onBlocked]
  );

  const load = useCallback(
    async (before?: number) => {
      try {
        const r = await api<{ posts: Post[]; next: number | null }>(`/api/network${before ? `?before=${before}` : ''}`);
        setPosts(p => (before ? [...p, ...r.posts] : r.posts));
        setNext(r.next);
        setError('');
      } catch (e) {
        fail(e, 'Could not load the network');
      } finally {
        setLoading(false);
      }
    },
    [fail]
  );

  useEffect(() => {
    void load();
    api<{ emojis: string[] }>('/api/network/config')
      .then(c => setEmojis(c.emojis))
      .catch(() => {});
  }, [load]);

  const patch = (id: string, f: (p: Post) => Post) => setPosts(list => list.map(p => (p.id === id ? f(p) : p)));

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950">
      <div className="max-w-xl mx-auto pb-16">
        <h2 className="px-4 py-4 text-lg font-bold text-white">Kite 🪁 Network</h2>
        {error && <p role="alert" className="mx-4 mb-3 text-xs text-rose-400">{error}</p>}

        {loading ? (
          <p className="text-center text-sm text-slate-500 py-12">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="text-center text-sm text-slate-500 py-12 px-6">No posts yet. Posts added with “Stories &amp; Reels” show up here.</p>
        ) : (
          <div>
            {posts.map(p => (
              <PostCard
                key={p.id}
                post={p}
                emojis={emojis}
                me={me}
                onOpenProfile={onOpenProfile}
                onChange={f => patch(p.id, f)}
                onGone={() => setPosts(list => list.filter(x => x.id !== p.id))}
                onHiddenUser={uid => setPosts(list => list.filter(x => x.owner.userId !== uid))}
                fail={fail}
              />
            ))}
            {next && (
              <button onClick={() => load(next)} className="block mx-auto my-6 px-5 py-2 rounded-xl bg-slate-800 text-sm text-slate-200">Load more</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PostCard({
  post,
  emojis,
  me,
  onOpenProfile,
  onChange,
  onGone,
  onHiddenUser,
  fail
}: {
  post: Post;
  emojis: string[];
  me: User;
  onOpenProfile: (userId: string) => void;
  onChange: (f: (p: Post) => Post) => void;
  onGone: () => void;
  onHiddenUser: (uid: string) => void;
  fail: (e: unknown, fallback: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');

  const react = async (emoji: string | null) => {
    setPicker(false);
    const prev = post;
    onChange(p => {
      const counts = { ...p.counts };
      if (p.mine) counts[p.mine] = Math.max(0, (counts[p.mine] ?? 1) - 1);
      if (emoji) counts[emoji] = (counts[emoji] ?? 0) + 1;
      for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
      return { ...p, counts, mine: emoji, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    });
    try {
      await api(`/api/network/posts/${post.id}/react`, { emoji });
    } catch (e) {
      onChange(() => prev);
      fail(e, 'Could not save your reaction');
    }
  };

  const loadComments = async () => {
    try {
      const r = await api<{ comments: Comment[] }>(`/api/network/posts/${post.id}/comments`);
      setComments(r.comments);
    } catch (e) {
      fail(e, 'Could not load comments');
    }
  };

  const toggleComments = () => {
    const open = !showComments;
    setShowComments(open);
    if (open) void loadComments();
  };

  const sendComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setNote('');
    try {
      await api(`/api/network/posts/${post.id}/comments`, { text: t });
      setText('');
      onChange(p => ({ ...p, commentCount: p.commentCount + 1 }));
      await loadComments();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not post the comment');
    }
  };

  const delComment = async (id: string) => {
    try {
      await api(`/api/network/posts/${post.id}/comments/${id}`, undefined, 'DELETE');
      onChange(p => ({ ...p, commentCount: Math.max(0, p.commentCount - 1) }));
      await loadComments();
    } catch (err) {
      fail(err, 'Could not delete');
    }
  };

  const reportComment = async (id: string) => {
    try {
      await api('/api/network/report', { postId: post.id, commentId: id, reason: 'Comment reported' });
      setNote('Reported. Thank you.');
    } catch (err) {
      fail(err, 'Could not report');
    }
  };

  const doMenu = async (action: 'delete' | 'visibility' | 'report' | 'hide') => {
    setMenu(false);
    try {
      if (action === 'delete') {
        if (!window.confirm('Delete this post?')) return;
        await api(`/api/network/posts/${post.id}`, undefined, 'DELETE');
        onGone();
      } else if (action === 'visibility') {
        const v = post.visibility === 'public' ? 'friends' : 'public';
        await api(`/api/network/posts/${post.id}`, { visibility: v }, 'PATCH');
        onChange(p => ({ ...p, visibility: v }));
      } else if (action === 'report') {
        const reason = window.prompt('Why are you reporting this post? (optional)') ?? null;
        if (reason === null) return;
        await api('/api/network/report', { postId: post.id, reason });
        setNote('Reported. Thank you.');
      } else {
        if (!window.confirm(`Hide all posts from ${post.owner.name}?`)) return;
        await api(`/api/network/hide/${encodeURIComponent(post.owner.userId)}`, {});
        onHiddenUser(post.owner.userId);
      }
    } catch (e) {
      fail(e, 'That did not work');
    }
  };

  const top = Object.entries(post.counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const item = 'w-full text-left px-4 py-3 text-sm hover:bg-slate-800';

  return (
    <article className="border-b border-slate-800 pb-4 mb-2">
      {/* Header: picture, name and business, menu */}
      <div className="flex items-center gap-3 px-4 py-3 relative">
        <button onClick={() => onOpenProfile(post.owner.userId)} aria-label="Open profile"><Avatar avatar={post.owner.avatar} photoUrl={post.owner.photoUrl} className="w-11 h-11 text-base" /></button>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onOpenProfile(post.owner.userId)}>
          <div className="text-base font-bold text-white truncate">{post.owner.name}</div>
          <div className="text-xs text-slate-400 truncate">
            {post.owner.businessName || post.owner.userId} · {post.visibility === 'public' ? '🌐' : '👥'}
          </div>
        </div>
        <button onClick={() => setMenu(!menu)} className="w-10 h-10 rounded-full hover:bg-slate-800 text-slate-200 flex items-center justify-center" aria-label="More">
          <MoreHorizontal className="w-6 h-6" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
            <div className="absolute right-3 top-14 z-40 w-56 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl py-1 overflow-hidden">
              {post.isOwner ? (
                <>
                  <button className={`${item} text-rose-400`} onClick={() => doMenu('delete')}>Delete post</button>
                </>
              ) : (
                <>
                  <button className={`${item} text-white`} onClick={() => doMenu('report')}>Report post</button>
                  <button className={`${item} text-white`} onClick={() => doMenu('hide')}>Hide this user</button>
                  {me.isAdmin && <button className={`${item} text-rose-400`} onClick={() => doMenu('delete')}>Remove post (admin)</button>}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Picture or video, full width */}
      {post.url &&
        (post.mime.startsWith('video/') ? (
          <video src={post.url} controls playsInline preload="metadata" className="w-full max-h-[75dvh] bg-black" />
        ) : (
          <img src={post.url} alt="" loading="lazy" className="w-full max-h-[75dvh] object-contain bg-black" />
        ))}

      {/* Actions */}
      <div className="px-4 pt-3 relative">
        <div className="flex items-center gap-5">
          <button onClick={() => (post.mine ? react(null) : setPicker(!picker))} className="text-3xl leading-none" aria-label="React">
            {post.mine ?? '🤍'}
          </button>
          <button onClick={toggleComments} className="text-slate-100" aria-label="Comments">
            <MessageCircle className="w-7 h-7" />
          </button>
          {post.mine && (
            <button onClick={() => setPicker(!picker)} className="ml-auto text-xs text-cyan-400">Change reaction</button>
          )}
        </div>
        {picker && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setPicker(false)} />
            <div className="absolute left-3 bottom-12 z-40 flex gap-1 bg-slate-800 border border-slate-700 rounded-full px-2 py-1.5 shadow-2xl">
              {emojis.map(e => (
                <button key={e} onClick={() => react(e)} className={`w-9 h-9 text-xl rounded-full hover:bg-slate-700 ${post.mine === e ? 'bg-slate-700' : ''}`}>
                  {e}
                </button>
              ))}
            </div>
          </>
        )}
        {post.total > 0 && (
          <div className="mt-2 text-sm font-semibold text-white">
            {top.map(([e]) => e).join(' ')} {post.total} {post.total === 1 ? 'reaction' : 'reactions'}
          </div>
        )}
        {post.caption && (
          <p className="mt-1 text-sm text-slate-200 whitespace-pre-line break-words">
            <span className="font-bold text-white">{post.owner.name}</span> {post.caption}
          </p>
        )}
        {post.commentCount > 0 && !showComments && (
          <button onClick={toggleComments} className="mt-1 text-sm text-slate-400">View all {post.commentCount} comments</button>
        )}
        <div className="mt-1 text-xs text-slate-500">{ago(post.createdAt)}</div>
      </div>

      {showComments && (
        <div className="px-4 pt-3 space-y-3">
          {comments.length === 0 && <p className="text-xs text-slate-500">No comments yet.</p>}
          {comments.map(c => (
            <div key={c.id} className="flex items-start gap-2 text-sm">
              <div className="min-w-0 flex-1 break-words">
                <span className="font-semibold text-white">{c.name}</span> <span className="text-slate-300">{c.text}</span>
                <div className="text-[10px] text-slate-500">{ago(c.at)}</div>
              </div>
              {c.canDelete ? (
                <button onClick={() => delComment(c.id)} className="text-slate-500 hover:text-rose-400" aria-label="Delete comment"><Trash2 className="w-4 h-4" /></button>
              ) : (
                <button onClick={() => reportComment(c.id)} className="text-slate-500 hover:text-amber-300" aria-label="Report comment"><Flag className="w-4 h-4" /></button>
              )}
            </div>
          ))}
          <form onSubmit={sendComment} className="flex gap-2">
            <input value={text} onChange={e => setText(e.target.value.slice(0, 300))} placeholder="Add a comment…" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500" />
            <button type="submit" disabled={!text.trim()} className="w-10 h-10 rounded-xl bg-cyan-500 disabled:opacity-50 text-accent-ink flex items-center justify-center" aria-label="Send comment"><Send className="w-4 h-4" /></button>
          </form>
        </div>
      )}
      {note && <p role="status" className="px-4 pt-2 text-xs text-cyan-400">{note}</p>}
    </article>
  );
}

interface Report {
  id: string;
  postId: string;
  commentId: string | null;
  ownerId: string;
  ownerName: string;
  reporter: string;
  reason: string;
  caption: string;
  commentText: string | null;
  mime: string;
  url: string | null;
  at: number;
}
interface Blocked {
  userId: string;
  name: string;
  strikes: { at: number; where: string }[];
  appeal: { at: number; message: string } | null;
}

/** Admin only: reported posts and blocked accounts with their appeals. */
export function Moderation({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [blocked, setBlocked] = useState<Blocked[]>([]);
  const [note, setNote] = useState('Loading…');

  const load = useCallback(async () => {
    try {
      const r = await api<{ reports: Report[]; blocked: Blocked[] }>('/api/admin/moderation');
      setReports(r.reports);
      setBlocked(r.blocked);
      setNote('');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not load');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'That did not work');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white">Moderation</h3>
          <button onClick={onClose} className="text-slate-400" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        {note && <p className="text-xs text-slate-400">{note}</p>}

        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Blocked accounts ({blocked.length})</h4>
        {blocked.length === 0 && <p className="text-xs text-slate-500">None.</p>}
        {blocked.map(b => (
          <div key={b.userId} className="rounded-2xl bg-slate-800/60 p-3 text-sm">
            <div className="text-white font-semibold">{b.name} <span className="text-slate-400 font-normal">({b.userId})</span></div>
            <div className="text-[11px] text-slate-400">Strikes: {b.strikes.map(s => `${s.where}`).join(', ')}</div>
            {b.appeal && <p className="mt-2 text-xs text-slate-200 whitespace-pre-line">Appeal: {b.appeal.message}</p>}
            <button onClick={() => run(() => api('/api/admin/unblock', { userId: b.userId }))} className="mt-2 px-3 py-1.5 rounded-lg bg-cyan-500 text-accent-ink text-xs font-semibold">Unblock</button>
          </div>
        ))}

        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Reports ({reports.length})</h4>
        {reports.length === 0 && <p className="text-xs text-slate-500">None.</p>}
        {reports.map(r => (
          <div key={r.id} className="rounded-2xl bg-slate-800/60 p-3 text-sm space-y-2">
            <div className="text-xs text-slate-400">By {r.reporter}: {r.reason || 'no reason'}</div>
            <div className="text-white">Post by {r.ownerName}</div>
            {r.url && (r.mime.startsWith('video/') ? <video src={r.url} controls playsInline className="w-full max-h-48 bg-black rounded-xl" /> : <img src={r.url} alt="" className="w-full max-h-48 object-contain bg-black rounded-xl" />)}
            {r.caption && <p className="text-xs text-slate-300">{r.caption}</p>}
            {r.commentText && <p className="text-xs text-amber-300">Reported comment: {r.commentText}</p>}
            <div className="flex gap-2">
              <button onClick={() => run(() => api(`/api/network/posts/${r.postId}`, undefined, 'DELETE'))} className="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-300 text-xs font-semibold">Remove post</button>
              <button onClick={() => run(() => api(`/api/admin/reports/${r.id}/dismiss`, {}))} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs">Dismiss</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
