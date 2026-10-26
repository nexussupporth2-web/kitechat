import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Server } from 'socket.io';
import crypto from 'crypto';
import { data, messageIndex, addMessage, save, type Message, type Post, type Product, type Share, type User } from './store.ts';
import { checkUpload, profilePublic } from './moderation.ts';
import { r2Enabled, signPut, signGet, head, remove } from './r2.ts';

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
/** Signed links are valid for one hour. The storage library wants SECONDS here (not milliseconds). */
const LINK_SECONDS = 60 * 60;

/** Per-user limits. Change these numbers to tune what the free storage has to carry. */
/**
 * The browser compresses media before upload, so these caps apply to the COMPRESSED file.
 * `mediaOriginalBytes` is how large an original the browser will accept before compressing it.
 */
export const LIMITS = {
  story: { imageBytes: 1 * MB, videoBytes: 15 * MB, audioBytes: 5 * MB, maxMediaSec: 30, ttlMs: 24 * HOUR },
  reel: { videoBytes: 15 * MB, maxVideoSec: 30 },
  share: { bytes: 50 * MB, mediaOriginalBytes: 300 * MB, pendingPerSender: 5, ttlMs: 24 * HOUR },
  wallpaperBytes: 1 * MB,
  avatarBytes: 500 * 1024,
  coverBytes: 800 * 1024,
  maxProducts: 20,
  /** How many of each a user can keep. Adding one more removes the oldest. */
  caps: { story: 2, reel: 10, albumImage: 10, albumVideo: 10 },
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
  /** Sends a closed-app notification for a new message/file to someone who is offline. */
  notifyOffline: (recipientId: string, senderId: string) => void;
}

/** Short reason shown on screen so a problem can be reported without digging through logs. */
const reason = (e: unknown) => String((e as any)?.name ?? 'Error') + ': ' + String((e as any)?.message ?? e).slice(0, 140);

const cleanName = (n: unknown) =>
  (typeof n === 'string' ? n : 'file').replace(/[\\/\0\r\n"]/g, '_').trim().slice(0, 120) || 'file';

export function mediaRouter({ io, requireAuth, areFriends, isOnline, notifyOffline }: Deps) {
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
    } else if (kind === 'album') {
      const ext = IMAGE_TYPES[mime] ?? VIDEO_TYPES[mime];
      if (!ext) return res.status(400).json({ error: 'Album items can be a photo or a video' });
      const max = mime in IMAGE_TYPES ? LIMITS.story.imageBytes : LIMITS.reel.videoBytes;
      if (size > max) return res.status(400).json({ error: `Too large even after compression (limit ${max / MB} MB)` });
      key = `album/${me.userId}/${crypto.randomUUID()}.${ext}`;
    } else if (kind === 'avatar') {
      const ext = IMAGE_TYPES[mime];
      if (!ext) return res.status(400).json({ error: 'Profile picture must be a JPG, PNG or WebP photo' });
      if (size > LIMITS.avatarBytes) return res.status(400).json({ error: 'Profile picture is too large even after compression' });
      key = `avatars/${me.userId}/${crypto.randomUUID()}.${ext}`;
    } else if (kind === 'network') {
      const ext = IMAGE_TYPES[mime] ?? VIDEO_TYPES[mime];
      if (!ext) return res.status(400).json({ error: 'Network posts can be a photo or a video' });
      const max = mime in IMAGE_TYPES ? LIMITS.story.imageBytes : LIMITS.reel.videoBytes;
      if (size > max) return res.status(400).json({ error: `Too large even after compression (limit ${max / MB} MB)` });
      key = `network/${me.userId}/${crypto.randomUUID()}.${ext}`;
    } else if (kind === 'cover' || kind === 'product') {
      const ext = IMAGE_TYPES[mime];
      const max = kind === 'cover' ? LIMITS.coverBytes : LIMITS.avatarBytes;
      if (!ext) return res.status(400).json({ error: 'Please use a JPG, PNG or WebP photo' });
      if (size > max) return res.status(400).json({ error: 'Photo is too large even after compression' });
      key = `${kind === 'cover' ? 'covers' : 'products'}/${me.userId}/${crypto.randomUUID()}.${ext}`;
    } else if (kind === 'wallpaper') {
      const ext = IMAGE_TYPES[mime];
      if (!ext) return res.status(400).json({ error: 'Wallpaper must be a JPG, PNG or WebP photo' });
      if (size > LIMITS.wallpaperBytes) return res.status(400).json({ error: 'Wallpaper is too large even after compression' });
      key = `wallpapers/${me.userId}/${crypto.randomUUID()}.${ext}`;
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

    if ((kind === 'story' || kind === 'reel' || kind === 'album' || kind === 'network') && usedBytes(me.userId) + size > LIMITS.quotaBytes) {
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
    const kind: Post['kind'] | null = key.startsWith(`stories/${me.userId}/`)
      ? 'story'
      : key.startsWith(`reels/${me.userId}/`)
        ? 'reel'
        : key.startsWith(`album/${me.userId}/`)
          ? 'album'
          : null;
    if (!kind) return res.status(400).json({ error: 'Invalid file' });
    if (data.posts.some(p => p.key === key)) return res.status(409).json({ error: 'Already published' });

    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      const max = kind === 'reel' ? LIMITS.reel.videoBytes : storyMax(info.type);
      if (info.size > max) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'File is over your limit' });
      }
      const v = await checkUpload(me, key, info.type, 'post');
      if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, blocked: v.blocked });
      // Keep only the newest few: when the limit is reached, the oldest one goes.
      const isImg = info.type in IMAGE_TYPES;
      const cap = kind === 'story' ? LIMITS.caps.story : kind === 'reel' ? LIMITS.caps.reel : isImg ? LIMITS.caps.albumImage : LIMITS.caps.albumVideo;
      const same = data.posts
        .filter(p => p.ownerId === me.userId && p.kind === kind && (kind !== 'album' || p.mime in IMAGE_TYPES === isImg))
        .sort((a, b) => a.createdAt - b.createdAt);
      while (same.length >= cap) await deletePost(same.shift()!);
      if (usedBytes(me.userId) + info.size > LIMITS.quotaBytes) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: `Storage full. You can keep up to ${LIMITS.quotaBytes / MB} MB. Delete something first.` });
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
      .filter(p => (p.kind === 'story' || p.kind === 'reel') && visible.has(p.ownerId) && (p.expiresAt === null || p.expiresAt > now))
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
          url: await signGet(p.key, { expiresIn: LINK_SECONDS })
        }))
      );
      res.json({ posts: items, usedBytes: usedBytes(me.userId), quotaBytes: LIMITS.quotaBytes });
    } catch (e) {
      console.error('feed failed', e);
      res.status(500).json({ error: `Could not load the feed (${reason(e)})` });
    }
  });

  // ---------- profile + album (owner and friends can see it) ----------

  router.get('/profile/:userId', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    const owner = data.users[String(req.params.userId)];
    if (!owner || (owner.userId !== me.userId && !areFriends(me.userId, owner.userId) && !profilePublic(owner))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const mine = data.posts.filter(p => p.ownerId === owner.userId);
    const album = mine.filter(p => p.kind === 'album').sort((a, b) => b.createdAt - a.createdAt);
    const self = owner.userId === me.userId;
    const nowTs = Date.now();
    const live = mine.filter(p => p.kind === 'story' && (p.expiresAt === null || p.expiresAt > nowTs)).sort((a, b) => a.createdAt - b.createdAt);
    let photoUrl: string | null = null;
    if (r2Enabled && owner.photo) photoUrl = await signGet(owner.photo.key, { expiresIn: LINK_SECONDS }).catch(() => null);
    const urlOf = async (key?: string) => (r2Enabled && key ? await signGet(key, { expiresIn: LINK_SECONDS }).catch(() => null) : null);
    const business = {
      phone: self || owner.showPhone ? (owner.phone ?? '') : '',
      showPhone: !!owner.showPhone,
      businessName: owner.businessName ?? '',
      bizCategory: owner.bizCategory ?? '',
      description: owner.bizDescription ?? '',
      address: owner.bizAddress ?? '',
      mapLink: owner.mapLink ?? '',
      hours: owner.bizHours ?? null,
      email: owner.email ?? '',
      website: owner.website ?? '',
      about: owner.about ?? '',
      socials: owner.socials ?? {},
      coverUrl: await urlOf(owner.cover?.key),
      products: await Promise.all((owner.products ?? []).map(async p => ({ id: p.id, name: p.name, price: p.price, description: p.description, photoUrl: await urlOf(p.photo?.key) })))
    };
    const base = {
      business,
      isFriend: self || areFriends(me.userId, owner.userId),
      user: {
        profileType: owner.profileType ?? 'private',
        publicActive: profilePublic(owner),
        userId: owner.userId,
        name: owner.name,
        avatar: owner.avatar,
        isOnline: isOnline(owner.userId),
        handle: owner.handle ?? null,
        category: owner.category ?? '',
        photoUrl,
        // Gender and birthday are shown to friends only if the owner allows it.
        gender: self || owner.showGender ? (owner.gender ?? '') : '',
        birthday: self || owner.showBirthday ? (owner.birthday ?? '') : '',
        showGender: !!owner.showGender,
        showBirthday: !!owner.showBirthday
      },
      stats: { album: album.length, reels: mine.filter(p => p.kind === 'reel').length, friends: owner.friends.length, status: live.length },
      caps: { image: LIMITS.caps.albumImage, video: LIMITS.caps.albumVideo }
    };
    if (req.query.lite || !r2Enabled) return res.json({ ...base, items: [], statuses: [] });
    try {
      const items = await Promise.all(
        album.map(async p => ({ id: p.id, mime: p.mime, size: p.size, caption: p.caption, createdAt: p.createdAt, url: await signGet(p.key, { expiresIn: LINK_SECONDS }) }))
      );
      const statuses = await Promise.all(
        live.map(async p => ({ id: p.id, mime: p.mime, size: p.size, caption: p.caption, createdAt: p.createdAt, url: await signGet(p.key, { expiresIn: LINK_SECONDS }) }))
      );
      res.json({ ...base, items, statuses });
    } catch (e) {
      console.error('profile failed', e);
      res.status(500).json({ error: `Could not load the profile (${reason(e)})` });
    }
  });

  // ---------- editing my own profile ----------

  const BIZ_CATEGORIES = ['Retail / Shop', 'Restaurant / Cafe', 'Grocery', 'Fashion & Clothing', 'Electronics', 'Beauty & Salon', 'Health & Pharmacy', 'Services', 'Education', 'Real Estate', 'Automobile', 'Other'];
  const SOCIALS = ['instagram', 'facebook', 'youtube', 'x', 'linkedin', 'whatsapp'];
  const CATEGORIES = ['Digital Creator', 'Software Engineer', 'Musician', 'Artist', 'Photographer', 'Student', 'Entrepreneur', 'Teacher', 'Other'];
  const GENDERS = ['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say'];
  const HANDLE_RE = /^(?![.])(?!.*\.\.)(?!.*[.]$)[a-z0-9._]{3,30}$/;

  const handleProblem = (handle: string, meId: string): string | null => {
    if (!HANDLE_RE.test(handle)) return 'Use 3-30 lowercase letters, numbers, dots or underscores (no spaces).';
    for (const u of Object.values(data.users)) {
      if (u.userId === meId) continue;
      if (u.handle === handle || u.userId.toLowerCase() === handle) return 'That username is already taken.';
    }
    return null;
  };

  router.get('/handle-check', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const handle = String(req.query.handle ?? '').trim().toLowerCase();
    const problem = handleProblem(handle, me.userId);
    res.json({ ok: !problem, reason: problem });
  });

  /** Friends reload their list so the new name / picture shows up at once. */
  const profileChanged = (u: User) => {
    for (const id of u.friends) io.to(`user:${id}`).emit('profile-updated', { userId: u.userId });
  };

  router.patch('/profile', requireAuth, (req, res) => {
    const me = res.locals.user as User;
    const b = req.body ?? {};
    const bad = (error: string) => res.status(400).json({ error });

    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 1 || name.length > 30) return bad('Name must be 1-30 characters');
      if (name !== me.name) {
        me.name = name;
        me.avatar = Array.from(name)[0]?.toUpperCase() ?? '?';
      }
    }
    if (b.handle !== undefined) {
      const handle = String(b.handle).trim().toLowerCase();
      if (handle === '') delete me.handle;
      else {
        const problem = handleProblem(handle, me.userId);
        if (problem) return bad(problem);
        me.handle = handle;
      }
    }
    if (b.category !== undefined) {
      if (b.category !== '' && !CATEGORIES.includes(b.category)) return bad('Invalid category');
      if (b.category === '') delete me.category;
      else me.category = b.category;
    }
    if (b.gender !== undefined) {
      if (b.gender !== '' && !GENDERS.includes(b.gender)) return bad('Invalid gender');
      if (b.gender === '') delete me.gender;
      else me.gender = b.gender;
    }
    if (b.birthday !== undefined) {
      if (b.birthday === '') delete me.birthday;
      else {
        const t = Date.parse(String(b.birthday));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.birthday)) || Number.isNaN(t) || t > Date.now() || t < Date.parse('1900-01-01')) return bad('Invalid birthday');
        me.birthday = String(b.birthday);
      }
    }
    // ----- business details -----
    const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const cleanUrl = (v: unknown): string | null => {
      const s = String(v ?? '').trim();
      if (!s) return '';
      try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
        return u.toString().slice(0, 300);
      } catch {
        return null;
      }
    };
    if (b.phone !== undefined) {
      const phone = String(b.phone).replace(/[\s-]/g, '');
      if (!/^\+?[0-9]{8,15}$/.test(phone)) return bad('Enter a valid phone number (digits only, with country code if outside India)');
      me.phone = phone;
    }
    if (typeof b.showPhone === 'boolean') me.showPhone = b.showPhone;
    if (b.businessName !== undefined) {
      const v = text(b.businessName, 60);
      if (!v) return bad('Business name is required');
      me.businessName = v;
    }
    if (b.bizCategory !== undefined) {
      if (!BIZ_CATEGORIES.includes(b.bizCategory)) return bad('Choose a business category');
      me.bizCategory = b.bizCategory;
    }
    const optional = (field: 'bizDescription' | 'bizAddress' | 'about', v: unknown, max: number) => {
      const t = text(v, max);
      if (t) me[field] = t;
      else delete me[field];
    };
    if (b.bizDescription !== undefined) optional('bizDescription', b.bizDescription, 500);
    if (b.bizAddress !== undefined) optional('bizAddress', b.bizAddress, 200);
    if (b.about !== undefined) optional('about', b.about, 140);
    for (const [field, label] of [['mapLink', 'Google location'], ['website', 'Website']] as const) {
      if (b[field] === undefined) continue;
      const u = cleanUrl(b[field]);
      if (u === null) return bad(`${label} must be a valid link`);
      if (u) me[field] = u;
      else delete me[field];
    }
    if (b.email !== undefined) {
      const e = text(b.email, 120);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return bad('Enter a valid email address');
      if (e) me.email = e;
      else delete me.email;
    }
    if (b.bizHours === null) delete me.bizHours;
    else if (b.bizHours !== undefined) {
      const h = b.bizHours;
      const ok = Array.isArray(h) && h.length === 7 && h.every(d => d && typeof d.closed === 'boolean' && /^\d{2}:\d{2}$/.test(d.open) && /^\d{2}:\d{2}$/.test(d.close));
      if (!ok) return bad('Invalid business hours');
      me.bizHours = h.map((d: { open: string; close: string; closed: boolean }) => ({ open: d.open, close: d.close, closed: d.closed }));
    }
    if (b.socials !== undefined && b.socials && typeof b.socials === 'object') {
      const out: Record<string, string> = {};
      for (const k of SOCIALS) {
        const u = cleanUrl((b.socials as Record<string, unknown>)[k]);
        if (u === null) return bad(`${k} link must be a valid link`);
        if (u) out[k] = u;
      }
      me.socials = out;
    }
    if (b.profileType !== undefined) {
      if (b.profileType !== 'private' && b.profileType !== 'public') return bad('Invalid profile type');
      me.profileType = b.profileType;
    }
    if (typeof b.showGender === 'boolean') me.showGender = b.showGender;
    if (typeof b.showBirthday === 'boolean') me.showBirthday = b.showBirthday;
    save();
    profileChanged(me);
    res.json({ user: { userId: me.userId, name: me.name, avatar: me.avatar } });
  });

  router.post('/profile/photo', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const { key } = req.body ?? {};
    if (typeof key !== 'string' || !key.startsWith(`avatars/${me.userId}/`)) return res.status(400).json({ error: 'Invalid request' });
    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      if (info.size > LIMITS.avatarBytes || !(info.type in IMAGE_TYPES)) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'Picture is too large' });
      }
      const v = await checkUpload(me, key, info.type, 'profile photo');
      if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, blocked: v.blocked });
      const old = me.photo?.key;
      me.photo = { key, at: Date.now() };
      save();
      if (old && old !== key) await remove(old).catch(() => {});
      profileChanged(me);
      res.json({ ok: true });
    } catch (e) {
      console.error('photo failed', e);
      res.status(500).json({ error: 'Could not save the picture' });
    }
  });

  router.delete('/profile/photo', requireAuth, async (_req, res) => {
    const me = res.locals.user as User;
    const old = me.photo?.key;
    delete me.photo;
    save();
    if (old && r2Enabled) await remove(old).catch(() => {});
    profileChanged(me);
    res.json({ ok: true });
  });

  // ---------- business: cover photo and product catalogue ----------

  router.post('/profile/cover', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const { key } = req.body ?? {};
    if (typeof key !== 'string' || !key.startsWith(`covers/${me.userId}/`)) return res.status(400).json({ error: 'Invalid request' });
    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      if (info.size > LIMITS.coverBytes || !(info.type in IMAGE_TYPES)) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'Cover photo is too large' });
      }
      const v = await checkUpload(me, key, info.type, 'cover photo');
      if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, blocked: v.blocked });
      const old = me.cover?.key;
      me.cover = { key, at: Date.now() };
      save();
      if (old && old !== key) await remove(old).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      console.error('cover failed', e);
      res.status(500).json({ error: 'Could not save the cover photo' });
    }
  });

  router.delete('/profile/cover', requireAuth, async (_req, res) => {
    const me = res.locals.user as User;
    const old = me.cover?.key;
    delete me.cover;
    save();
    if (old && r2Enabled) await remove(old).catch(() => {});
    res.json({ ok: true });
  });

  router.post('/products', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    const { name, price, description, key } = req.body ?? {};
    const n = String(name ?? '').trim().slice(0, 60);
    if (!n) return res.status(400).json({ error: 'Product name is required' });
    if ((me.products ?? []).length >= LIMITS.maxProducts) return res.status(400).json({ error: `You can list up to ${LIMITS.maxProducts} products` });
    const product: Product = { id: crypto.randomUUID(), name: n, price: String(price ?? '').trim().slice(0, 30), description: String(description ?? '').trim().slice(0, 300) };
    if (key !== undefined && key !== null) {
      if (typeof key !== 'string' || !key.startsWith(`products/${me.userId}/`) || !r2Enabled) return res.status(400).json({ error: 'Invalid photo' });
      const info = await head(key).catch(() => null);
      if (!info || info.size > LIMITS.avatarBytes || !(info.type in IMAGE_TYPES)) return res.status(400).json({ error: 'Product photo not found or too large' });
      const v = await checkUpload(me, key, info.type, 'product photo');
      if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, blocked: v.blocked });
      product.photo = { key };
    }
    me.products = [...(me.products ?? []), product];
    save();
    res.json({ ok: true });
  });

  router.delete('/products/:id', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    const p = (me.products ?? []).find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    me.products = (me.products ?? []).filter(x => x.id !== p.id);
    save();
    if (p.photo && r2Enabled) await remove(p.photo.key).catch(() => {});
    res.json({ ok: true });
  });

  router.delete('/posts/:id', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const post = data.posts.find(p => p.id === req.params.id);
    if (!post || post.ownerId !== me.userId) return res.status(404).json({ error: 'Not found' });
    await deletePost(post);
    res.json({ ok: true });
  });

  // ---------- chat wallpaper ----------
  // Every user can pick one wallpaper. In a chat, the picture is the one that was changed most recently
  // by either person, so both phones always show the same image. No pick = the kite default.

  const notifyWallpaper = (me: User) => {
    for (const id of [me.userId, ...me.friends]) io.to(`user:${id}`).emit('wallpaper-updated', { userId: me.userId });
  };

  router.get('/wallpaper/:friendId', requireAuth, async (req, res) => {
    const me = res.locals.user as User;
    const friend = data.users[String(req.params.friendId)];
    if (!friend || (friend.userId !== me.userId && !areFriends(me.userId, friend.userId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const best = [me, friend]
      .filter(u => u.wallpaper)
      .sort((a, b) => b.wallpaper!.at - a.wallpaper!.at)[0];
    if (!best || !r2Enabled) return res.json({ url: null, by: null, at: 0 });
    try {
      res.json({ url: await signGet(best.wallpaper!.key, { expiresIn: LINK_SECONDS }), by: best.userId, at: best.wallpaper!.at });
    } catch (e) {
      console.error('wallpaper url failed', e);
      res.json({ url: null, by: null, at: 0 });
    }
  });

  router.post('/wallpaper', requireAuth, needStorage, async (req, res) => {
    const me = res.locals.user as User;
    const { key } = req.body ?? {};
    if (typeof key !== 'string' || !key.startsWith(`wallpapers/${me.userId}/`)) return res.status(400).json({ error: 'Invalid request' });
    try {
      const info = await head(key);
      if (!info) return res.status(400).json({ error: 'Upload not found. Please try again.' });
      if (info.size > LIMITS.wallpaperBytes || !(info.type in IMAGE_TYPES)) {
        await remove(key).catch(() => {});
        return res.status(413).json({ error: 'Wallpaper is too large' });
      }
      const old = me.wallpaper?.key;
      me.wallpaper = { key, at: Date.now() };
      save();
      if (old && old !== key) await remove(old).catch(() => {});
      notifyWallpaper(me);
      res.json({ ok: true });
    } catch (e) {
      console.error('wallpaper failed', e);
      res.status(500).json({ error: 'Could not set the wallpaper' });
    }
  });

  router.delete('/wallpaper', requireAuth, async (_req, res) => {
    const me = res.locals.user as User;
    const old = me.wallpaper?.key;
    delete me.wallpaper;
    save();
    if (old && r2Enabled) await remove(old).catch(() => {});
    notifyWallpaper(me);
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
      notifyOffline(recipientId, me.userId);
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
