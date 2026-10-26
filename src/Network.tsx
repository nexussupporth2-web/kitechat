import { useCallback, useEffect, useRef, useState } from 'react';
import { Flag, MessageCircle, MoreHorizontal, Plus, Send, Trash2, X } from 'lucide-react';
import { api, ApiError } from './api.ts';
import Avatar from './Avatar.tsx';
import { phaseLabel, publishNetwork, type Phase } from './media.ts';
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
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

/** Kite Network: posts from everyone. Public posts are visible to all; friends-only posts only to friends. */
export default function Network({ me, onBlocked }: { me: User; onBlocked: () => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [emojis, setEmojis] = useState<string[]>(['❤️', '😂', '😮', '😢', '👏', '🔥', '🙏', '👍']);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
  const [moderating, setModerating] = useState(false);

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
    api<{ enabled: boolean; emojis: string[] }>('/api/network/config')
      .then(c => {
        setEnabled(c.enabled);
        setEmojis(c.emojis);
      })
      .catch(() => {});
  }, [load]);

  const patch = (id: string, f: (p: Post) => Post) => setPosts(list => list.map(p => (p.id === id ? f(p) : p)));

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950">
      <div className="max-w-xl mx-auto pb-16">
        <div className="flex items-center justify-between px-4 py-4">
          <h2 className="text-lg font-bold text-white">Kite 🪁 Network</h2>
          <div className="flex gap-2">
            {me.isAdmin && (
              <button onClick={() => setModerating(true)} className="px-3 py-2 rounded-xl bg-slate-800 text-xs text-slate-200">Moderation</button>
            )}
            <button onClick={() => setComposing(true)} disabled={!enabled} className="flex items-center gap-1 px-3 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-accent-ink text-xs font-semibold">
              <Plus className="w-4 h-4" /> Post
            </button>
          </div>
        </div>
        {!enabled && <p className="mx-4 mb-3 text-xs text-amber-300">Posting is off until the content check is set up on the server.</p>}
        <p className="mx-4 mb-3 text-[11px] text-slate-500">No adult content. Every photo and video is checked automatically. Rule breakers are warned once, then blocked.</p>
        {error && <p role="alert" className="mx-4 mb-3 text-xs text-rose-400">{error}</p>}

        {loading ? (
          <p className="text-center text-sm text-slate-500 py-12">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="text-center text-sm text-slate-500 py-12">No posts yet. Be the first to post.</p>
        ) : (
          <div className="space-y-4">
            {posts.map(p => (
              <PostCard
                key={p.id}
                post={p}
                emojis={emojis}
                me={me}
                onChange={f => patch(p.id, f)}
                onGone={() => setPosts(list => list.filter(x => x.id !== p.id))}
                onHiddenUser={uid => setPosts(list => list.filter(x => x.owner.userId !== uid))}
                fail={fail}
              />
            ))}
            {next && (
              <button onClick={() => load(next)} className="block mx-auto px-5 py-2 rounded-xl bg-slate-800 text-sm text-slate-200">Load more</button>
            )}
          </div>
        )}
      </div>

      {composing && (
        <Composer
          onClose={() => setComposing(false)}
          onBlocked={onBlocked}
          onDone={async () => {
            setComposing(false);
            await load();
          }}
        />
      )}
      {moderating && <Moderation onClose={() => setModerating(false)} onChanged={() => load()} />}
    </div>
  );
}

function PostCard({
  post,
  emojis,
  me,
  onChange,
  onGone,
  onHiddenUser,
  fail
}: {
  post: Post;
  emojis: string[];
  me: User;
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
    <article className="bg-slate-900 border border-slate-800 sm:rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 relative">
        <Avatar avatar={post.owner.avatar} photoUrl={post.owner.photoUrl} className="w-10 h-10 text-sm" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white truncate">{post.owner.name}</div>
          <div className="text-[11px] text-slate-400 truncate">
            {post.owner.businessName ? `${post.owner.businessName} · ` : ''}
            {ago(post.createdAt)} · {post.visibility === 'public' ? '🌐 Public' : '👥 Friends'}
          </div>
        </div>
        <button onClick={() => setMenu(!menu)} className="w-9 h-9 rounded-full hover:bg-slate-800 text-slate-300 flex items-center justify-center" aria-label="More">
          <MoreHorizontal className="w-5 h-5" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
            <div className="absolute right-3 top-12 z-40 w-56 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl py-1 overflow-hidden">
              {post.isOwner ? (
                <>
                  <button className={`${item} text-white`} onClick={() => doMenu('visibility')}>{post.visibility === 'public' ? 'Make friends only' : 'Make public'}</button>
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

      {post.url &&
        (post.mime.startsWith('video/') ? (
          <video src={post.url} controls playsInline preload="metadata" className="w-full max-h-[70dvh] bg-black" />
        ) : (
          <img src={post.url} alt="" loading="lazy" className="w-full max-h-[70dvh] object-contain bg-black" />
        ))}

      {post.caption && <p className="px-4 pt-3 text-sm text-slate-200 whitespace-pre-line break-words">{post.caption}</p>}

      <div className="px-4 py-3 relative">
        <div className="flex items-center gap-4">
          <button onClick={() => (post.mine ? react(null) : setPicker(!picker))} onContextMenu={e => { e.preventDefault(); setPicker(true); }} className="flex items-center gap-1.5 text-sm text-slate-200">
            <span className="text-xl leading-none">{post.mine ?? '🤍'}</span>
            <span>{post.mine ? 'Reacted' : 'Like'}</span>
          </button>
          {post.mine && (
            <button onClick={() => setPicker(!picker)} className="text-xs text-cyan-400">Change</button>
          )}
          <button onClick={toggleComments} className="flex items-center gap-1.5 text-sm text-slate-200 ml-auto">
            <MessageCircle className="w-5 h-5" /> {post.commentCount}
          </button>
        </div>
        {post.total > 0 && (
          <div className="mt-2 text-xs text-slate-400">
            {top.map(([e]) => e).join(' ')} {post.total}
          </div>
        )}
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
      </div>

      {showComments && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-800 pt-3">
          {comments.length === 0 && <p className="text-xs text-slate-500">No comments yet.</p>}
          {comments.map(c => (
            <div key={c.id} className="text-sm">
              <div className="flex items-start gap-2">
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
            </div>
          ))}
          <form onSubmit={sendComment} className="flex gap-2">
            <input value={text} onChange={e => setText(e.target.value.slice(0, 300))} placeholder="Add a comment…" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500" />
            <button type="submit" disabled={!text.trim()} className="w-10 h-10 rounded-xl bg-cyan-500 disabled:opacity-50 text-accent-ink flex items-center justify-center" aria-label="Send comment"><Send className="w-4 h-4" /></button>
          </form>
        </div>
      )}
      {note && <p role="status" className="px-4 pb-3 text-xs text-cyan-400">{note}</p>}
    </article>
  );
}

function Composer({ onClose, onDone, onBlocked }: { onClose: () => void; onDone: () => Promise<void>; onBlocked: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [vis, setVis] = useState<'public' | 'friends'>('friends');
  const [progress, setProgress] = useState<{ phase: Phase; p: number } | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const busy = progress !== null || checking;

  const submit = async () => {
    if (!file) return;
    setError('');
    setProgress({ phase: 'compressing', p: 0 });
    try {
      await publishNetwork(file, caption.trim(), vis, (phase, p) => {
        setProgress({ phase, p });
        if (phase === 'uploading' && p >= 1) setChecking(true);
      });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.blocked) {
        window.alert(e.message);
        return onBlocked();
      }
      setError(e instanceof Error ? e.message : 'Could not post');
    } finally {
      setProgress(null);
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-sm max-h-[92dvh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white">New post</h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <input ref={ref} type="file" accept="image/*,video/*" className="hidden" onChange={e => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
        <button onClick={() => ref.current?.click()} disabled={busy} className="w-full py-3 rounded-xl bg-slate-800 text-sm text-slate-200">{file ? `Selected: ${file.name}` : 'Choose a photo or video'}</button>
        <textarea value={caption} onChange={e => setCaption(e.target.value.slice(0, 300))} rows={3} placeholder="Write a caption…" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 resize-none" />
        <div className="grid grid-cols-2 gap-2">
          {(['friends', 'public'] as const).map(v => (
            <button key={v} onClick={() => setVis(v)} disabled={busy} className={`py-3 rounded-xl text-sm font-medium border ${vis === v ? 'border-cyan-500 bg-cyan-500/10 text-white' : 'border-slate-800 text-slate-400'}`}>
              {v === 'friends' ? '👥 Friends only' : '🌐 Public'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-500">Adult content is not allowed. Your file is checked automatically. The first time it is removed with a final warning. The next time your account is blocked.</p>
        {progress && (
          <div>
            <div className="text-xs text-slate-300 mb-1">{checking ? 'Checking…' : `${phaseLabel(progress.phase)}… ${Math.round(progress.p * 100)}%`}</div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden"><div className="h-full bg-cyan-500 transition-all" style={{ width: `${checking ? 100 : progress.p * 100}%` }} /></div>
          </div>
        )}
        {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
        <button onClick={submit} disabled={!file || busy} className="w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-accent-ink text-sm font-semibold">{busy ? 'Please wait…' : 'Post'}</button>
      </div>
    </div>
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
function Moderation({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
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
