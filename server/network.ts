import { Router, type RequestHandler } from 'express';
import crypto from 'crypto';
import { data, save, type Post, type User } from './store.ts';
import { r2Enabled, signGet, head, remove } from './r2.ts';
import { checkUpload, listBlocked, moderationEnabled } from './moderation.ts';

const HOUR = 60 * 60 * 1000;
const LINK_SECONDS = 60 * 60;
/** New accounts wait this long before they can post publicly (cuts down on spam accounts). */
const MIN_ACCOUNT_AGE = 24 * HOUR;
export const EMOJIS = ['❤️', '😂', '😮', '😢', '👏', '🔥', '🙏', '👍'];
const BLOCKED_WORDS = ['porn', 'xxx', 'nude', 'nudes', 'onlyfans', 'sex video', 'blowjob', 'hardcore'];
const MAX_POST_BYTES = 15 * 1024 * 1024;

interface Deps {
  requireAuth: RequestHandler;
  areFriends: (a: string, b: string) => boolean;
  isAdmin: (u: User) => boolean;
}

export function networkRouter({ requireAuth, areFriends, isAdmin }: Deps) {
  const router = Router();

  const canSee = (me: User, p: Post) =>
    p.kind === 'network' &&
    (data.users[p.ownerId]?.blocked ? p.ownerId === me.userId || isAdmin(me) : true) &&
    (p.ownerId === me.userId || isAdmin(me) || (!me.hidden?.includes(p.ownerId) && (p.visibility === 'public' || areFriends(me.userId, p.ownerId))));

  const urlOf = async (key?: string) => (r2Enabled && key ? await signGet(key, { expiresIn: LINK_SECONDS }).catch(() => null) : null);

  async function dropPost(p: Post) {
    data.posts = data.posts.filter(x => x.id !== p.id);
    data.reports = data.reports.filter(r => r.postId !== p.id);
    await remove(p.key).catch(() => {});
    save();
  }

  // simple per-user limiter for comments / reactions
  const hits = new Map<string, number[]>();
  const tooFast = (userId: string, max = 20) => {
    const now = Date.now();
    const list = (hits.get(userId) ?? []).filter(t => now - t < 60_000);
    list.push(now);
    hits.set(userId, list);
    return list.length > max;
  };

  const view = async (me: User, p: Post, photoCache: Map<string, string | null>) => {
    const owner = data.users[p.ownerId];
    if (owner && !photoCache.has(owner.userId)) photoCache.set(owner.userId, await urlOf(owner.photo?.key));
    const counts: Record<string, number> = {};
    for (const e of Object.values(p.likes ?? {})) counts[e] = (counts[e] ?? 0) + 1;
    return {
      id: p.id,
      owner: {
        userId: p.ownerId,
        name: owner?.name ?? 'Deleted user',
        avatar: owner?.avatar ?? '?',
        photoUrl: owner ? (photoCache.get(owner.userId) ?? null) : null,
        businessName: owner?.businessName ?? ''
      },
      mime: p.mime,
      url: await urlOf(p.key),
      caption: p.caption,
      visibility: p.visibility ?? 'friends',
      createdAt: p.createdAt,
      counts,
      total: Object.keys(p.likes ?? {}).length,
      mine: p.likes?.[me.userId] ?? null,
      commentCount: (p.comments ?? []).length,
      isOwner: p.ownerId === me.userId
    };
  };

  router.get('/network/config', requireAuth, (_req, res) => {
    res.json({ enabled: r2Enabled && moderationEnabled, emojis: EMOJIS });
  });

  // ---------- posting ----------

  router.post('/network/posts', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    if (!r2Enabled) return res.status(503).json({ error: 'File storage is not set up on this server yet' });
    if (!moderationEnabled) return res.status(503).json({ error: 'Posting is switched off until the content check is set up' });
    const { key, caption, visibility } = req.body ?? {};
    if (typeof key !== 'string' || !key.startsWith(`network/${me.userId}/`)) return res.status(400).json({ error: 'Invalid file' });
    const vis: 'public' | 'friends' = visibility === 'public' ? 'public' : 'friends';
    if (vis === 'public' && !isAdmin(me) && Date.now() - me.createdAt < MIN_ACCOUNT_AGE) {
      await remove(key).catch(() => {});
      return res.status(403).json({ error: 'New accounts can post publicly after 24 hours. You can post to friends only now.' });
    }
    if (data.posts.some(p => p.key === key)) return res.status(409).json({ error: 'Already published' });
    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      if (info.size > MAX_POST_BYTES || !(info.type.startsWith('image/') || info.type.startsWith('video/'))) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'File is too large' });
      }
      const used = data.posts.filter(p => p.ownerId === me.userId).reduce((s, p) => s + p.size, 0);
      if (used + info.size > 200 * 1024 * 1024) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'Storage full. Delete something first.' });
      }
      const v = await checkUpload(me, key, info.type, 'network post');
      if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, blocked: v.blocked });
      data.posts.push({
        id: crypto.randomUUID(),
        ownerId: me.userId,
        kind: 'network',
        key,
        mime: info.type,
        size: info.size,
        caption: typeof caption === 'string' ? caption.trim().slice(0, 300) : '',
        createdAt: Date.now(),
        expiresAt: null,
        visibility: vis,
        likes: {},
        comments: []
      });
      save();
      res.json({ ok: true });
    } catch (e) {
      console.error('network post failed', e);
      res.status(500).json({ error: 'Could not publish the post' });
    }
  });

  // ---------- reading ----------

  router.get('/network', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    const before = Number(req.query.before) || Infinity;
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    const list = data.posts
      .filter(p => p.kind === 'network' && p.createdAt < before && canSee(me, p))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit + 1);
    const more = list.length > limit;
    const page = list.slice(0, limit);
    const cache = new Map<string, string | null>();
    const posts = [];
    for (const p of page) posts.push(await view(me, p, cache));
    res.json({ posts, next: more ? page[page.length - 1].createdAt : null });
  });

  // ---------- reactions ----------

  router.post('/network/posts/:id/react', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const p = data.posts.find(x => x.id === req.params.id);
    if (!p || !canSee(me, p)) return res.status(404).json({ error: 'Not found' });
    if (tooFast(me.userId, 60)) return res.status(429).json({ error: 'Slow down a little' });
    const emoji = req.body?.emoji;
    p.likes = p.likes ?? {};
    if (emoji === null) delete p.likes[me.userId];
    else if (typeof emoji === 'string' && EMOJIS.includes(emoji)) p.likes[me.userId] = emoji;
    else return res.status(400).json({ error: 'Invalid reaction' });
    save();
    res.json({ ok: true });
  });

  // ---------- comments ----------

  router.get('/network/posts/:id/comments', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const p = data.posts.find(x => x.id === req.params.id);
    if (!p || !canSee(me, p)) return res.status(404).json({ error: 'Not found' });
    res.json({
      comments: (p.comments ?? []).slice(-200).map(c => ({
        id: c.id,
        userId: c.userId,
        name: data.users[c.userId]?.name ?? 'Deleted user',
        text: c.text,
        at: c.at,
        canDelete: c.userId === me.userId || p.ownerId === me.userId || isAdmin(me)
      }))
    });
  });

  router.post('/network/posts/:id/comments', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const p = data.posts.find(x => x.id === req.params.id);
    if (!p || !canSee(me, p)) return res.status(404).json({ error: 'Not found' });
    if (tooFast(me.userId, 12)) return res.status(429).json({ error: 'You are commenting too fast. Wait a moment.' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 300) : '';
    if (!text) return res.status(400).json({ error: 'Write a comment first' });
    const low = text.toLowerCase();
    if (BLOCKED_WORDS.some(w => low.includes(w))) return res.status(400).json({ error: 'This comment is not allowed on Kite.' });
    p.comments = p.comments ?? [];
    p.comments.push({ id: crypto.randomUUID(), userId: me.userId, text, at: Date.now() });
    save();
    res.json({ ok: true });
  });

  router.delete('/network/posts/:id/comments/:cid', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const p = data.posts.find(x => x.id === req.params.id);
    const c = p?.comments?.find(x => x.id === req.params.cid);
    if (!p || !c || !canSee(me, p)) return res.status(404).json({ error: 'Not found' });
    if (c.userId !== me.userId && p.ownerId !== me.userId && !isAdmin(me)) return res.status(403).json({ error: 'Not allowed' });
    p.comments = (p.comments ?? []).filter(x => x.id !== c.id);
    data.reports = data.reports.filter(r => r.commentId !== c.id);
    save();
    res.json({ ok: true });
  });

  // ---------- owner controls ----------

  router.patch('/network/posts/:id', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const p = data.posts.find(x => x.id === req.params.id);
    if (!p || p.kind !== 'network' || p.ownerId !== me.userId) return res.status(404).json({ error: 'Not found' });
    if (req.body?.visibility === 'public') {
      if (!isAdmin(me) && Date.now() - me.createdAt < MIN_ACCOUNT_AGE) return res.status(403).json({ error: 'New accounts can post publicly after 24 hours.' });
      p.visibility = 'public';
    } else if (req.body?.visibility === 'friends') p.visibility = 'friends';
    else return res.status(400).json({ error: 'Invalid setting' });
    save();
    res.json({ ok: true });
  });

  router.delete('/network/posts/:id', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    const p = data.posts.find(x => x.id === req.params.id);
    if (!p || p.kind !== 'network' || (p.ownerId !== me.userId && !isAdmin(me))) return res.status(404).json({ error: 'Not found' });
    await dropPost(p);
    res.json({ ok: true });
  });

  // ---------- hide a person / report ----------

  router.post('/network/hide/:userId', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const id = String(req.params.userId);
    if (id === me.userId || !data.users[id]) return res.status(400).json({ error: 'Invalid request' });
    me.hidden = [...new Set([...(me.hidden ?? []), id])];
    save();
    res.json({ ok: true });
  });

  router.delete('/network/hide/:userId', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    me.hidden = (me.hidden ?? []).filter(x => x !== req.params.userId);
    save();
    res.json({ ok: true });
  });

  router.post('/network/report', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const { postId, commentId, reason } = req.body ?? {};
    const p = data.posts.find(x => x.id === postId);
    if (!p || !canSee(me, p)) return res.status(404).json({ error: 'Not found' });
    if (commentId !== undefined && !p.comments?.some(c => c.id === commentId)) return res.status(404).json({ error: 'Not found' });
    if (data.reports.some(r => r.reporterId === me.userId && r.postId === postId && r.commentId === commentId)) return res.json({ ok: true });
    data.reports.push({
      id: crypto.randomUUID(),
      postId: p.id,
      commentId: typeof commentId === 'string' ? commentId : undefined,
      reporterId: me.userId,
      reason: typeof reason === 'string' ? reason.trim().slice(0, 200) : '',
      at: Date.now()
    });
    save();
    res.json({ ok: true });
  });

  // ---------- admin ----------

  const adminOnly: RequestHandler = (req, res, next) => {
    if (!isAdmin(res.locals.user as User)) return res.status(403).json({ error: 'Admin only' });
    next();
  };

  router.get('/admin/moderation', requireAuth, adminOnly, async (_req, res) => {
    const reports = [];
    for (const r of [...data.reports].sort((a, b) => b.at - a.at).slice(0, 50)) {
      const p = data.posts.find(x => x.id === r.postId);
      if (!p) continue;
      const c = r.commentId ? p.comments?.find(x => x.id === r.commentId) : undefined;
      reports.push({
        id: r.id,
        postId: p.id,
        commentId: r.commentId ?? null,
        ownerId: p.ownerId,
        ownerName: data.users[p.ownerId]?.name ?? '?',
        reporter: data.users[r.reporterId]?.name ?? r.reporterId,
        reason: r.reason,
        caption: p.caption,
        commentText: c?.text ?? null,
        mime: p.mime,
        url: await urlOf(p.key),
        at: r.at
      });
    }
    res.json({ reports, blocked: listBlocked() });
  });

  router.post('/admin/reports/:id/dismiss', requireAuth, adminOnly, (req, res) => {
    data.reports = data.reports.filter(r => r.id !== req.params.id);
    save();
    res.json({ ok: true });
  });

  router.post('/admin/unblock', requireAuth, adminOnly, (req, res) => {
    const u = data.users[String(req.body?.userId ?? '')];
    if (!u) return res.status(404).json({ error: 'Not found' });
    u.blocked = false;
    delete u.appeal;
    u.strikes = (u.strikes ?? []).slice(0, 1); // back to the final-warning stage
    save();
    res.json({ ok: true });
  });

  return router;
}
