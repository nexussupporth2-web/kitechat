import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Server } from 'socket.io';
import crypto from 'crypto';
import { data, messageIndex, addMessage, save, type Message, type Post, type Share, type User } from './store.ts';
import { r2Enabled, signPut, signGet, head, remove } from './r2.ts';

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

/** Per-user limits. Change these numbers to tune what the free storage has to carry. */
/**
 * The browser compresses media before upload, so these caps apply to the COMPRESSED file.
 * `mediaOriginalBytes` is how large an original the browser will accept before compressing it.
 */
export const LIMITS = {
  story: { imageBytes: 1 * MB, videoBytes: 15 * MB, audioBytes: 5 * MB, maxMediaSec: 30, ttlMs: 24 * HOUR },
  reel: { videoBytes: 15 * MB, maxVideoSec: 30 },
  share: { bytes: 50 * MB, mediaOriginalBytes: 300 * MB, pendingPerSender: 5, ttlMs: 24 * HOUR },
  quotaBytes: 200 * MB
};

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const VIDEO_TYPES: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const AUDIO_TYPES: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'weba', 'audio/ogg': 'ogg' };

const storyMax = (mime: string) =>
  mime in IMAGE_TYPES ? LIMITS.story.imageBytes : mime in AUDIO_TYPES ? LIMITS.story.audioBytes : LIMITS.story.videoBytes;

interface Deps {
  io: Server;
  requireAuth: RequestHandler;
  areFriends: (a: string, b: string) => boolean;
  isOnline: (id: string) => boolean;
}

const cleanName = (n: unknown) =>
  (typeof n === 'string' ? n : 'file').replace(/[\\/\0\r\n"]/g, '_').trim().slice(0, 120) || 'file';

export function mediaRouter({ io, requireAuth, areFriends, isOnline }: Deps) {
  const router = Router();

  const needStorage = (_req: Request, res: Response, next: NextFunction) => {
    if (!r2Enabled) return res.status(503).json({ error: 'File storage is not set up on this server yet' });
    next();
  };

  const usedBytes = (userId: string) => data.posts.filter(p => p.ownerId === userId).reduce((s, p) => s + p.size, 0);

  const emitMessage = (msg: Message) => io.to(`user:${msg.senderId}`).to(`user:${msg.recipientId}`).emit('message-updated', msg);

  /** Delete a share's file and mark its chat message as gone. */
  async function closeShare(share: Share) {
    data.shares = data.shares.filter(s => s.id !== share.id);
    try {
      await remove(share.key);
    } catch (e) {
      console.error('Could not delete shared file', share.key, e);
    }
    const msg = messageIndex.get(share.messageId);
    if (msg?.file) {
      msg.file.gone = true;
      emitMessage(msg);
    }
    save();
  }

  async function deletePost(post: Post) {
    data.posts = data.posts.filter(p => p.id !== post.id);
    try {
      await remove(post.key);
    } catch (e) {
      console.error('Could not delete post file', post.key, e);
    }
    save();
  }

  // ---------- config ----------

  router.get('/media/config', requireAuth, (_req, res) => {
    res.json({ enabled: r2Enabled, limits: LIMITS });
  });

  // ---------- step 1: get a signed upload URL (validates type, size and quota) ----------

  router.post('/media/sign', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const { kind, mime, size, name, recipientId } = req.body ?? {};
    if (typeof mime !== 'string' || typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: 'Invalid file' });
    }

    let key: string;
    if (kind === 'story') {
      const ext = IMAGE_TYPES[mime] ?? VIDEO_TYPES[mime] ?? AUDIO_TYPES[mime];
      if (!ext) return res.status(400).json({ error: 'Statuses can be a photo, video or audio file' });
      if (size > storyMax(mime)) return res.status(400).json({ error: `Too large even after compression (limit ${storyMax(mime) / MB} MB)` });
      key = `stories/${me.userId}/${crypto.randomUUID()}.${ext}`;
    } else if (kind === 'reel') {
      if (!(mime in VIDEO_TYPES)) return res.status(400).json({ error: 'Reels must be an MP4, WebM or MOV video' });
      if (size > LIMITS.reel.videoBytes) return res.status(400).json({ error: `Too large even after compression (limit ${LIMITS.reel.videoBytes / MB} MB)` });
      key = `reels/${me.userId}/${crypto.randomUUID()}.${VIDEO_TYPES[mime]}`;
    } else if (kind === 'share') {
      if (typeof recipientId !== 'string' || !areFriends(me.userId, recipientId)) {
        return res.status(400).json({ error: 'You can only send files to friends' });
      }
      if (size > LIMITS.share.bytes) return res.status(400).json({ error: `Too large. Files can be up to ${LIMITS.share.bytes / MB} MB` });
      if (data.shares.filter(s => s.senderId === me.userId).length >= LIMITS.share.pendingPerSender) {
        return res.status(429).json({ error: 'You have too many files waiting to be downloaded' });
      }
      key = `shares/${me.userId}/${crypto.randomUUID()}`;
    } else {
      return res.status(400).json({ error: 'Invalid upload type' });
    }

    if ((kind === 'story' || kind === 'reel') && usedBytes(me.userId) + size > LIMITS.quotaBytes) {
      return res.status(413).json({ error: `Storage full. You can keep up to ${LIMITS.quotaBytes / MB} MB. Delete something first.` });
    }

    try {
      const uploadUrl = await signPut(key, mime, size);
      res.json({ key, uploadUrl, name: cleanName(name) });
    } catch (e) {
      console.error('signPut failed', e);
      res.status(500).json({ error: 'Could not prepare the upload' });
    }
  });

  // ---------- step 2a: publish a story / reel after the upload finished ----------

  router.post('/posts', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const { key, caption } = req.body ?? {};
    if (typeof key !== 'string') return res.status(400).json({ error: 'Invalid request' });
    const kind = key.startsWith(`stories/${me.userId}/`) ? 'story' : key.startsWith(`reels/${me.userId}/`) ? 'reel' : null;
    if (!kind) return res.status(400).json({ error: 'Invalid file' });
    if (data.posts.some(p => p.key === key)) return res.status(409).json({ error: 'Already published' });

    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      const max = kind === 'reel' ? LIMITS.reel.videoBytes : storyMax(info.type);
      if (info.size > max || usedBytes(me.userId) + info.size > LIMITS.quotaBytes) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'File is over your limit' });
      }
      const now = Date.now();
      const post: Post = {
        id: crypto.randomUUID(),
        ownerId: me.userId,
        kind,
        key,
        mime: info.type,
        size: info.size,
        caption: typeof caption === 'string' ? caption.trim().slice(0, 300) : '',
        createdAt: now,
        expiresAt: kind === 'story' ? now + LIMITS.story.ttlMs : null
      };
      data.posts.push(post);
      save();
      res.json({ post });
    } catch (e) {
      console.error('publish failed', e);
      res.status(500).json({ error: 'Could not publish' });
    }
  });

  router.get('/feed', requireAuth, needStorage, async (_req, res) => {
    const me = res.locals.user as User;
    const visible = new Set([me.userId, ...me.friends]);
    const now = Date.now();
    const posts = data.posts
      .filter(p => visible.has(p.ownerId) && (p.expiresAt === null || p.expiresAt > now))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
    try {
      const items = await Promise.all(
        posts.map(async p => ({
          id: p.id,
          kind: p.kind,
          mime: p.mime,
          size: p.size,
          caption: p.caption,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
          ownerId: p.ownerId,
          ownerName: data.users[p.ownerId]?.name ?? p.ownerId,
          ownerAvatar: data.users[p.ownerId]?.avatar ?? '?',
          url: await signGet(p.key, { expiresIn: HOUR })
        }))
      );
      res.json({ posts: items, usedBytes: usedBytes(me.userId), quotaBytes: LIMITS.quotaBytes });
    } catch (e) {
      console.error('feed failed', e);
      res.status(500).json({ error: 'Could not load the feed' });
    }
  });

  router.delete('/posts/:id', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const post = data.posts.find(p => p.id === req.params.id);
    if (!post || post.ownerId !== me.userId) return res.status(404).json({ error: 'Not found' });
    await deletePost(post);
    res.json({ ok: true });
  });

  // ---------- step 2b: send an uploaded file to a friend (temporary) ----------

  router.post('/shares', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const { key, recipientId, name } = req.body ?? {};
    if (typeof key !== 'string' || !key.startsWith(`shares/${me.userId}/`) || typeof recipientId !== 'string' || !areFriends(me.userId, recipientId)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    if (data.shares.some(s => s.key === key)) return res.status(409).json({ error: 'Already sent' });
    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      if (info.size > LIMITS.share.bytes) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'File is too large' });
      }
      const fileName = cleanName(name);
      const id = crypto.randomUUID();
      const msg: Message = {
        id: crypto.randomUUID(),
        senderId: me.userId,
        recipientId,
        message: fileName,
        timestamp: Date.now(),
        status: isOnline(recipientId) ? 'received' : 'sent',
        reactions: {},
        file: { id, name: fileName, size: info.size, gone: false }
      };
      data.shares.push({
        id,
        senderId: me.userId,
        recipientId,
        name: fileName,
        mime: info.type,
        size: info.size,
        key,
        messageId: msg.id,
        createdAt: msg.timestamp
      });
      addMessage(msg);
      io.to(`user:${recipientId}`).to(`user:${me.userId}`).emit('chat-message', msg);
      res.json({ message: msg });
    } catch (e) {
      console.error('share failed', e);
      res.status(500).json({ error: 'Could not send the file' });
    }
  });

  router.get('/shares/:id/url', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const share = data.shares.find(s => s.id === req.params.id);
    if (!share || share.recipientId !== me.userId) return res.status(404).json({ error: 'This file is no longer available' });
    try {
      res.json({ url: await signGet(share.key, { expiresIn: 600, downloadName: share.name }), name: share.name });
    } catch (e) {
      console.error('share url failed', e);
      res.status(500).json({ error: 'Could not prepare the download' });
    }
  });

  /** Called by the receiver once the download has started/finished (deletes the file), or by the sender to cancel. */
  router.post('/shares/:id/done', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const share = data.shares.find(s => s.id === req.params.id);
    if (!share || (share.recipientId !== me.userId && share.senderId !== me.userId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    await closeShare(share);
    res.json({ ok: true });
  });

  // ---------- expiry sweep ----------

  async function sweep() {
    if (!r2Enabled) return;
    const now = Date.now();
    for (const p of data.posts.filter(p => p.expiresAt !== null && p.expiresAt <= now)) await deletePost(p);
    for (const s of data.shares.filter(s => s.createdAt + LIMITS.share.ttlMs <= now)) await closeShare(s);
  }
  setInterval(() => void sweep().catch(e => console.error('sweep failed', e)), 10 * 60 * 1000).unref();
  void sweep().catch(e => console.error('sweep failed', e));

  return router;
}
