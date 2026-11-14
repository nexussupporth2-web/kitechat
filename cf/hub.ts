// KiteChat on Cloudflare, phase 2: accounts, friends, chat, System Broadcast and pins.
// One Durable Object ("the hub") holds everything and talks to phones over hibernating WebSockets.
// Calls, files, profiles and Kite Network come in later phases.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DurableObject } from 'cloudflare:workers';
import { data, messageIndex, initStore, save, addMessage as storeAdd, messagesFor as storeMessagesFor, olderMessages, searchMessages, isGroupId, type User, type Message, type Group } from './store.ts';
import { ENV, BUCKET, setEnv } from './runtime.ts';
import { initR2, r2Enabled, signGet, signPut, head, remove } from './r2.ts';
import { initModeration, blockedMessage, moderationEnabled } from './moderation.ts';
import { makeVapid, sendWebPush, type Vapid } from './push.ts';
import { mediaRouter } from './media.ts';
import { networkRouter } from './network.ts';
import { friendsRouter } from './friends.ts';

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (message: string, status: number, extra: object = {}) => json({ error: message, ...extra }, status);
const uuid = () => crypto.randomUUID();

const BLOCKED_MSG = blockedMessage;
/** Adult-content blocks keep their message; a block by the admin after reports gets a plain one. */
const blockedMsgFor = (u: User) => ((u.strikes?.length ?? 0) >= 2 ? BLOCKED_MSG : 'Your account has been blocked by the admin. You can send an appeal.');
const TOKEN_TTL = 30 * 24 * 3600 * 1000;

async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `p1:${b64(salt)}:${await pbkdf2(password, salt)}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [tag, salt, hash] = stored.split(':');
  if (tag !== 'p1' || !salt || !hash) return false; // old Render-style hashes are handled at the final move
  const got = await pbkdf2(password, unb64(salt));
  if (got.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}
async function signToken(secret: string, uid: string) {
  const payload = b64(enc.encode(JSON.stringify({ uid, exp: Date.now() + TOKEN_TTL })));
  return `${payload}.${await hmac(secret, payload)}`;
}
/** The person a sign-in token belongs to, or null. Tokens made before a password change no longer work. */
async function tokenUser(secret: string, token: unknown): Promise<User | undefined> {
  if (typeof token !== 'string') return undefined;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || (await hmac(secret, payload)) !== sig) return undefined;
  try {
    const { uid, exp } = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (typeof uid !== 'string' || typeof exp !== 'number' || exp <= Date.now()) return undefined;
    const user = data.users[uid];
    if (!user) return undefined;
    if (user.sessionsFrom && exp - TOKEN_TTL < user.sessionsFrom) return undefined;
    return user;
  } catch {
    return undefined;
  }
}

/** Languages people can translate into (code -> name). */
const LANGS: Record<string, string> = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', th: 'Thai', vi: 'Vietnamese'
};

/** Who the notification server is told sent the pushes. */
const PUSH_SUBJECT = 'https://kitechat-test.nexussupport-h2.workers.dev';

export class Hub extends DurableObject {
  vapid: Vapid | null = null;
  buckets = new Map<string, { count: number; reset: number }>();
  routers: any[] = [];
  sweepers: (() => Promise<void>)[] = [];

  get users() {
    return data.users;
  }
  get messages() {
    return data.messages;
  }
  get index() {
    return messageIndex;
  }

  constructor(ctx: any, env: any) {
    super(ctx, env);
    setEnv(env);
    initR2();
    initModeration();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      await initStore(ctx.storage);
      // Notification keys: made once, then kept.
      this.vapid = ((await ctx.storage.get('x:vapid')) as Vapid | undefined) ?? null;
      if (!this.vapid) {
        this.vapid = await makeVapid();
        await ctx.storage.put('x:vapid', this.vapid);
      }
      this.syncAdminFriends();
      this.syncBroadcasts();
      // Pictures, files, profiles and Kite Network (the same code that runs on Render).
      const io = {
        to: (room: string) => {
          const rooms = [room];
          const o: any = {
            to: (r: string) => (rooms.push(r), o),
            emit: (event: string, payload: unknown) => this.emitTo(rooms.map(r => r.replace(/^user:/, '')), event, payload)
          };
          return o;
        }
      };
      const requireAuth = async (req: any, res: any, next: any) => {
        const h: string = req.headers.authorization || '';
        const user = await tokenUser(this.secret, h.startsWith('Bearer ') ? h.slice(7) : '');
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        if (user.blocked) return res.status(403).json({ error: blockedMsgFor(user), blocked: true });
        res.locals.user = user;
        next();
      };
      // Files, profiles and friends-only posts also stop between two people when one has blocked the other.
      const areFriends = (a: string, b: string) => this.canTalk(a, b);
      const net = networkRouter({ io, requireAuth, areFriends, isAdmin: (u: User) => u.userId === this.adminId });
      const media = mediaRouter({
        io,
        requireAuth,
        areFriends,
        isOnline: (id: string) => this.isOnline(id),
        notifyOffline: (recipientId: string, senderId: string) => {
          if (!this.isOnline(recipientId)) this.pushTo(recipientId, { kind: 'message', title: this.users[senderId]?.name ?? 'KiteChat', body: 'Sent you a file', tag: 'msg-' + senderId });
        },
        canChat: (a: string, to: string) => this.canChat(a, to)
      });
      const friends = friendsRouter({
        io,
        requireAuth,
        friendView: (u: User) => this.friendView(u),
        photoUrl: (u: User) => this.photoUrlOf(u),
        blocked: (a: string, b: string) => this.blocked(a, b)
      });
      this.routers = [net, friends, media];
      if (media.sweep) this.sweepers.push(media.sweep);
      // Photos and voice notes in chats are deleted after 30 days.
      this.sweepers.push(async () => {
        const now = Date.now();
        for (const m of this.messages) {
          if (m.media && !m.media.gone && m.media.expiresAt <= now) await this.dropMedia(m);
        }
      });
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 10 * 60_000);
    });
  }

  /** Sends a closed-app notification to every phone this person has allowed notifications on. */
  pushTo(userId: string, message: { kind: 'message' | 'call'; title: string; body: string; tag: string }, urgent = false) {
    const u = this.users[userId];
    const v = this.vapid;
    if (!u?.pushSubs?.length || !v) return;
    this.ctx.waitUntil(
      (async () => {
        const dead = new Set<string>();
        await Promise.all(
          (u.pushSubs ?? []).map(async s => {
            const r = await sendWebPush(s, message, v, PUSH_SUBJECT, { ttl: urgent ? 45 : 86400, urgent });
            if (r === 'gone') dead.add(s.endpoint);
          })
        );
        if (dead.size) {
          u.pushSubs = (u.pushSubs ?? []).filter(s => !dead.has(s.endpoint));
          this.saveUser(u);
        }
      })()
    );
  }

  /** Every 10 minutes: remove expired stories and shared files. */
  async alarm() {
    for (const f of this.sweepers) await f().catch(e => console.error('sweep failed', e));
    await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
  }

  // ---------- small helpers ----------

  get adminId(): string {
    return (ENV.ADMIN_ID || 'KITE_ADMIN').trim().toUpperCase();
  }
  get secret(): string {
    return (this.env as any).AUTH_SECRET;
  }
  saveUser(_u: User) {
    save();
  }
  addMessage(m: Message) {
    storeAdd(m);
  }
  saveMsg(_m: Message) {
    save();
  }
  messagesFor(userId: string): Message[] {
    return storeMessagesFor(userId);
  }
  publicUser(u: User) {
    return { userId: u.userId, name: u.name, avatar: u.avatar, isAdmin: u.userId === this.adminId };
  }
  socketsOf(userId: string): WebSocket[] {
    return this.ctx.getWebSockets('u:' + userId);
  }
  isOnline(userId: string, except?: WebSocket) {
    return this.socketsOf(userId).some(w => w !== except && w.readyState === WebSocket.OPEN);
  }
  async photoUrlOf(u: User): Promise<string | null> {
    return r2Enabled && u.photo ? await signGet(u.photo.key, { expiresIn: 3600 }).catch(() => null) : null;
  }
  friendView(u: User) {
    return { ...this.publicUser(u), isOnline: this.isOnline(u.userId), ...(u.style?.share ? { style: { color: u.style.color, font: u.style.font, accent: u.style.accent } } : {}) };
  }
  areFriends(a: string, b: string) {
    return !!this.users[a]?.friends.includes(b);
  }
  // ---------- groups ----------
  groupOf(id: string): Group | undefined {
    return data.groups.find(g => g.id === id);
  }
  /** Since when `uid` may see this group's messages, or undefined when they are not in it. */
  memberSince(groupId: string, uid: string): number | undefined {
    const g = this.groupOf(groupId);
    if (!g || !g.members.includes(uid)) return undefined;
    return g.joined[uid] ?? 0;
  }
  /** May `uid` see this message? */
  canSee(m: Message, uid: string) {
    if (isGroupId(m.recipientId)) {
      const since = this.memberSince(m.recipientId, uid);
      return since !== undefined && m.timestamp >= since;
    }
    return m.senderId === uid || m.recipientId === uid;
  }
  /** Everyone who sees this message. */
  audience(m: Message): string[] {
    if (isGroupId(m.recipientId)) return this.groupOf(m.recipientId)?.members ?? [];
    return [m.senderId, m.recipientId];
  }
  /** May `uid` send to `to` now (a friend, neither blocked, or a group they are in)? */
  canChat(uid: string, to: string) {
    if (isGroupId(to)) return this.memberSince(to, uid) !== undefined;
    return this.canTalk(uid, to);
  }
  async groupView(g: Group, viewer: User) {
    return {
      userId: g.id,
      name: g.name,
      avatar: '👥',
      photoUrl: null,
      isOnline: false,
      isGroup: true,
      ownerId: g.ownerId,
      lastRead: viewer.groupRead?.[g.id] ?? 0,
      members: await Promise.all(
        g.members.map(async id => {
          const u = this.users[id];
          return { userId: id, name: u?.name ?? id, avatar: u?.avatar ?? '🙂', photoUrl: u ? await this.photoUrlOf(u) : null };
        })
      )
    };
  }
  /** Send a new message to everyone in its chat, with a closed-app notification for those away. */
  deliver(msg: Message, sender: User) {
    if (isGroupId(msg.recipientId)) {
      const g = this.groupOf(msg.recipientId);
      if (!g) return;
      this.emitTo(g.members, 'chat-message', msg);
      for (const id of g.members) {
        if (id !== sender.userId && !this.isOnline(id)) this.pushTo(id, { kind: 'message', title: g.name, body: `${sender.name}: new message`, tag: 'msg-' + g.id });
      }
      return;
    }
    this.emitTo([msg.recipientId, sender.userId], 'chat-message', msg);
    if (!this.isOnline(msg.recipientId)) this.pushTo(msg.recipientId, { kind: 'message', title: sender.name, body: 'New message', tag: 'msg-' + sender.userId });
  }
  /** Delete a chat photo / voice note file and mark it gone. */
  async dropMedia(m: Message) {
    if (!m.media || m.media.gone) return;
    m.media.gone = true;
    this.saveMsg(m);
    if (r2Enabled) await remove(m.media.key).catch(() => {});
    this.emitTo(this.audience(m), 'message-updated', m);
  }
  /** Remove a whole group (when the last person leaves), with its messages and files. */
  async deleteGroup(g: Group) {
    data.groups = data.groups.filter(x => x.id !== g.id);
    const mine = this.messages.filter(m => m.recipientId === g.id);
    for (const m of mine) if (m.media && !m.media.gone && r2Enabled) await remove(m.media.key).catch(() => {});
    data.messages = this.messages.filter(m => m.recipientId !== g.id);
    for (const m of mine) this.index.delete(m.id);
    save();
  }

  /** An ID someone used until recently stays theirs for 30 days. */
  idReserved(id: string, exceptUserId?: string) {
    const now = Date.now();
    return Object.values(this.users).some(u => u.userId !== exceptUserId && u.formerIds?.some(f => f.id === id && f.until > now));
  }

  /** Move a person to a new User ID: their friends, chats, posts, likes, comments and files all follow. */
  renameUser(oldId: string, newId: string) {
    const swap = (x: string) => (x === oldId ? newId : x);
    const swapList = (l?: string[]) => (l ? l.map(swap) : l);
    const swapKeys = <T,>(o?: Record<string, T>) => {
      if (!o || !(oldId in o)) return o;
      const out: Record<string, T> = {};
      for (const [k, v] of Object.entries(o)) out[swap(k)] = v;
      return out;
    };
    const me = this.users[oldId];
    delete this.users[oldId];
    me.userId = newId;
    this.users[newId] = me;
    for (const u of Object.values(this.users)) {
      u.friends = swapList(u.friends) ?? [];
      u.hidden = swapList(u.hidden);
      u.pinnedChats = swapList(u.pinnedChats);
      u.reqIn = swapList(u.reqIn);
      u.reqOut = swapList(u.reqOut);
      u.blockList = swapList(u.blockList);
      if (u.reportedBy) u.reportedBy = u.reportedBy.map(r => ({ ...r, by: swap(r.by) }));
    }
    for (const m of data.messages) {
      m.senderId = swap(m.senderId);
      m.recipientId = swap(m.recipientId);
      m.reactions = swapKeys(m.reactions) ?? {};
      if (m.replyTo) m.replyTo.senderId = swap(m.replyTo.senderId);
      m.hiddenFor = swapList(m.hiddenFor);
    }
    for (const p of data.posts) {
      p.ownerId = swap(p.ownerId);
      p.likes = swapKeys(p.likes);
      if (p.comments) for (const c of p.comments) c.userId = swap(c.userId);
      if (p.sharedWith) p.sharedWith = p.sharedWith.map(x => ({ ...x, userId: swap(x.userId), by: swap(x.by) }));
    }
    for (const sh of data.shares) {
      sh.senderId = swap(sh.senderId);
      sh.recipientId = swap(sh.recipientId);
    }
    for (const r of data.reports) r.reporterId = swap(r.reporterId);
    for (const g of data.groups) {
      g.ownerId = swap(g.ownerId);
      g.members = g.members.map(swap);
      g.joined = swapKeys(g.joined) ?? {};
    }
    for (const c of this.calls.values()) {
      c.callerId = swap(c.callerId);
      c.calleeId = swap(c.calleeId);
    }
    save();
  }

  /** "Last seen" time of `u` as `viewerId` may see it (hidden if switched off or if `u` blocked the viewer). */
  lastSeenFor(u: User, viewerId: string): number | null {
    if (u.showLastSeen === false || this.blocked(u.userId, viewerId)) return null;
    return u.lastSeen ?? null;
  }

  /** Did `a` block `b`? */
  blocked(a: string, b: string) {
    return !!this.users[a]?.blockList?.includes(b);
  }
  /** Friends, and neither one has blocked the other. */
  canTalk(a: string, b: string) {
    return this.areFriends(a, b) && !this.blocked(a, b) && !this.blocked(b, a);
  }
  /** Friends who may see this person's online dot (not the people they blocked). */
  presenceTargets(u: User) {
    return u.friends.filter(f => !this.blocked(u.userId, f));
  }
  /** Send an event to every open connection of these people. */
  emitTo(ids: string[], event: string, data: unknown) {
    const frame = JSON.stringify({ e: event, d: data });
    for (const id of new Set(ids)) {
      for (const w of this.socketsOf(id)) {
        try {
          w.send(frame);
        } catch {
          /* closed */
        }
      }
    }
  }
  // ---------- calls ----------

  calls = new Map<string, { callerId: string; calleeId: string; type?: 'audio' | 'video' }>();
  iceCache: { at: number; servers: any[] } | null = null;

  /** Free STUN, plus Cloudflare's relay (TURN) when its keys are set, so calls also work on mobile data. */
  async iceServers(): Promise<any[]> {
    const stun = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
    if (!ENV.TURN_KEY_ID || !ENV.TURN_API_TOKEN) return [stun];
    if (this.iceCache && Date.now() - this.iceCache.at < 30 * 60 * 1000) return this.iceCache.servers;
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${ENV.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ENV.TURN_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 })
      });
      if (!r.ok) return [stun];
      const j: any = await r.json();
      const relay = Array.isArray(j.iceServers) ? j.iceServers : [];
      const servers = [stun, ...relay];
      this.iceCache = { at: Date.now(), servers };
      return servers;
    } catch {
      return [stun];
    }
  }

  attOf(ws: WebSocket): { uid: string; cid: string; roomId?: string; call?: { callerId: string; calleeId: string; type?: 'audio' | 'video' } } {
    return (ws.deserializeAttachment() as any) ?? {};
  }
  roomMembers(roomId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter(w => w.readyState === WebSocket.OPEN && this.attOf(w).roomId === roomId);
  }
  /** The call's two people. Rebuilt from the open connections if the hub was asleep in between. */
  callOf(roomId: string) {
    let c = this.calls.get(roomId);
    if (!c) {
      for (const w of this.ctx.getWebSockets()) {
        const a = this.attOf(w);
        if (a.roomId === roomId && a.call) {
          c = a.call;
          this.calls.set(roomId, c);
          break;
        }
      }
    }
    return c;
  }
  userInRoom(userId: string): boolean {
    return this.socketsOf(userId).some(w => w.readyState === WebSocket.OPEN && !!this.attOf(w).roomId);
  }
  leaveRoom(ws: WebSocket, except?: boolean) {
    const a = this.attOf(ws);
    if (!a.roomId) return;
    const roomId = a.roomId;
    const { roomId: _r, call: _c, ...rest } = a;
    try {
      ws.serializeAttachment(rest);
    } catch {
      /* closed */
    }
    const frame = JSON.stringify({ e: 'peer-left', d: { socketId: a.cid } });
    const others = this.roomMembers(roomId).filter(w => w !== ws);
    for (const w of others) {
      try {
        w.send(frame);
      } catch {
        /* closed */
      }
    }
    if (others.length === 0 && !except) this.calls.delete(roomId);
  }

  rateLimit(req: Request, path: string, max: number, windowMs: number): boolean {
    const key = `${path}:${req.headers.get('cf-connecting-ip') || ''}`;
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.reset < now) {
      this.buckets.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    return ++b.count <= max;
  }

  syncAdminFriends() {
    const admin = this.users[this.adminId];
    if (!admin) return;
    for (const u of Object.values(this.users)) {
      if (u.userId === admin.userId) continue;
      if (!u.friends.includes(admin.userId)) {
        u.friends.push(admin.userId);
        this.saveUser(u);
      }
      if (!admin.friends.includes(u.userId)) {
        admin.friends.push(u.userId);
        this.saveUser(admin);
      }
    }
  }
  /** New people get every earlier admin broadcast too, in the original order. */
  syncBroadcasts() {
    const admin = this.users[this.adminId];
    if (!admin) return;
    const sent = this.messages.filter(m => m.senderId === admin.userId && m.broadcast);
    const seen = new Map<string, Message>();
    for (const m of sent) {
      const key = m.broadcastId ?? m.message;
      if (!seen.has(key) || m.timestamp < seen.get(key)!.timestamp) seen.set(key, m);
    }
    const all = [...seen.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const u of Object.values(this.users)) {
      if (u.userId === admin.userId) continue;
      const have = new Set(sent.filter(m => m.recipientId === u.userId).map(m => m.broadcastId ?? m.message));
      for (const [key, original] of all) {
        if (have.has(key)) continue;
        const newId = uuid();
        this.addMessage({
          id: newId,
          senderId: admin.userId,
          recipientId: u.userId,
          message: original.message,
          timestamp: original.timestamp,
          status: 'sent',
          reactions: {},
          broadcast: true,
          broadcastId: original.broadcastId,
          ...(original.bcKey && original.file
            ? { bcKey: original.bcKey, bcMime: original.bcMime, file: { ...original.file, id: `bc:${newId}` } }
            : {})
        });
      }
    }
  }

  async auth(req: Request): Promise<User | Response> {
    const h = req.headers.get('authorization') || '';
    const user = await tokenUser(this.secret, h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!user) return err('Unauthorized', 401);
    if (user.blocked) return err(blockedMsgFor(user), 403, { blocked: true });
    return user;
  }

  // ---------- HTTP ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!this.secret) return err('AUTH_SECRET is not set on the server', 500);

    if (path === '/ws') return this.openSocket(req, url);

    const body: any = req.method === 'POST' || req.method === 'PATCH' ? await req.json().catch(() => ({})) : {};

    // --- a quick health check of file storage (shows only yes/no answers, never secrets) ---
    if (req.method === 'GET' && path === '/api/diag') {
      // Only the signed-in admin may see this.
      const who = await this.auth(req);
      if (who instanceof Response) return who;
      if (who.userId !== this.adminId) return err('Admin only', 403);
      const out: Record<string, unknown> = {
        r2Enabled,
        hasBucket: !!BUCKET,
        hasAccountId: !!ENV.R2_ACCOUNT_ID,
        hasAccessKey: !!ENV.R2_ACCESS_KEY_ID,
        hasSecretKey: !!ENV.R2_SECRET_ACCESS_KEY,
        bucketName: ENV.R2_BUCKET || null,
        moderationOn: moderationEnabled,
        relayOn: !!(ENV.TURN_KEY_ID && ENV.TURN_API_TOKEN),
        adminIdSet: !!ENV.ADMIN_ID,
        adminIdLength: (ENV.ADMIN_ID || '').length,
        adminAccountExists: !!this.users[this.adminId],
        adminIdStartsWith: this.adminId.slice(0, 3),
        accountIdLength: (ENV.R2_ACCOUNT_ID || '').length,
        accessKeyLength: (ENV.R2_ACCESS_KEY_ID || '').length,
        secretKeyLength: (ENV.R2_SECRET_ACCESS_KEY || '').length
      };
      if (r2Enabled) {
        try {
          // 404 = the signature was accepted (the file just does not exist). 403 = wrong keys.
          const g = await fetch(await signGet('diag/none.txt', { expiresIn: 60 }), { method: 'GET' });
          out.signedReadStatus = g.status;
          if (g.status !== 404) out.signedReadReply = (await g.text()).slice(0, 300);
          // Upload a tiny file with a signed link, exactly like a phone would, then remove it.
          const put = await fetch(await signPut('diag/test.txt', 'text/plain', 2, 60), {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: 'ok'
          });
          out.signedUploadStatus = put.status;
          if (put.status >= 400) out.signedUploadReply = (await put.text()).slice(0, 300);
          await BUCKET.delete('diag/test.txt');
        } catch (e) {
          out.problem = String((e as any)?.message ?? e).slice(0, 200);
        }
      }
      return json(out);
    }

    // --- no login needed ---
    if (req.method === 'POST' && path === '/api/register') {
      if (!this.rateLimit(req, path, 10, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const { userId, password, name } = body;
      if (typeof userId !== 'string' || typeof password !== 'string' || typeof name !== 'string') return err('Missing required fields', 400);
      const id = userId.trim().toUpperCase();
      const cleanName = name.trim();
      if (!/^[A-Z0-9_]{3,20}$/.test(id)) return err('User ID must be 3-20 letters, numbers or underscores', 400);
      if (password.length < 6 || password.length > 128) return err('Password must be 6-128 characters', 400);
      if (cleanName.length < 1 || cleanName.length > 40) return err('Name must be 1-40 characters', 400);
      if (this.users[id] || this.idReserved(id)) return err('User ID already exists', 409);
      const user: User = {
        userId: id,
        name: cleanName,
        avatar: cleanName.charAt(0).toUpperCase(),
        passwordHash: await hashPassword(password),
        friends: [],
        createdAt: Date.now()
      };
      this.users[id] = user;
      this.saveUser(user);
      this.syncAdminFriends();
      this.syncBroadcasts();
      if (id !== this.adminId && this.users[this.adminId]) this.emitTo([this.adminId], 'friend-added', this.friendView(user));
      return json({ token: await signToken(this.secret, id), user: this.publicUser(user) });
    }

    if (req.method === 'POST' && path === '/api/login') {
      if (!this.rateLimit(req, path, 10, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const { userId, password } = body;
      if (typeof userId !== 'string' || typeof password !== 'string') return err('Missing credentials', 400);
      const user = this.users[userId.trim().toUpperCase()];
      if (!user || !(await verifyPassword(password, user.passwordHash))) return err('Invalid User ID or password', 401);
      if (user.blocked) return err(blockedMsgFor(user), 403, { blocked: true });
      return json({
        token: await signToken(this.secret, user.userId),
        user: { ...this.publicUser(user), photoUrl: await this.photoUrlOf(user), showLastSeen: user.showLastSeen !== false, mustChangePassword: !!user.mustChangePassword }
      });
    }

    // Forgot password: anyone can ask; the admin sees the request and sets a temporary password.
    if (req.method === 'POST' && path === '/api/password-reset-request') {
      if (!this.rateLimit(req, path, 5, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const id = typeof body.userId === 'string' ? body.userId.trim().toUpperCase() : '';
      const u = this.users[id];
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 200) : '';
      // The answer is the same whether or not the ID exists, so nobody can test which IDs are real.
      if (u && u.userId !== this.adminId) {
        u.resetRequest = { at: Date.now(), message };
        this.saveUser(u);
      }
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === '/api/appeal') {
      if (!this.rateLimit(req, path, 5, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const { userId, password, message } = body;
      const user = typeof userId === 'string' ? this.users[userId.trim().toUpperCase()] : undefined;
      if (!user || typeof password !== 'string' || !(await verifyPassword(password, user.passwordHash)) || !user.blocked) {
        return err('Could not send the appeal. Check your User ID and password.', 400);
      }
      const text = typeof message === 'string' ? message.trim().slice(0, 500) : '';
      if (!text) return err('Write a short message first', 400);
      user.appeal = { at: Date.now(), message: text };
      this.saveUser(user);
      return json({ ok: true });
    }

    // --- login needed ---
    const a = await this.auth(req);
    if (a instanceof Response) return a;
    const me = a;

    if (req.method === 'GET' && path === '/api/me') {
      return json({ user: { ...this.publicUser(me), photoUrl: await this.photoUrlOf(me), showLastSeen: me.showLastSeen !== false, mustChangePassword: !!me.mustChangePassword } });
    }

    if (req.method === 'POST' && path === '/api/account/last-seen') {
      me.showLastSeen = body.show !== false;
      this.saveUser(me);
      return json({ ok: true });
    }

    if (req.method === 'GET' && path === '/api/friends') {
      const list = me.friends.map(id => this.users[id]).filter(Boolean);
      return json({
        friends: await Promise.all(
          list.map(async u =>
            u.userId === this.adminId && me.userId !== this.adminId
              ? { ...this.friendView(u), name: 'System Broadcast', avatar: '📢', photoUrl: null }
              : {
                  ...this.friendView(u),
                  // Someone who blocked me always looks offline to me.
                  isOnline: this.blocked(u.userId, me.userId) ? false : this.isOnline(u.userId),
                  lastSeen: this.lastSeenFor(u, me.userId),
                  photoUrl: await this.photoUrlOf(u),
                  pinOrder: (me.pinnedChats ?? []).indexOf(u.userId),
                  blockedByMe: this.blocked(me.userId, u.userId)
                }
          )
        )
      });
    }

    // ----- groups (up to 20 people; the person who made it manages it) -----
    const MAX_GROUP = 20;
    const cleanGroupName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 40) : '');
    if (req.method === 'GET' && path === '/api/groups') {
      const mine = data.groups.filter(g => g.members.includes(me.userId));
      return json({ groups: await Promise.all(mine.map(g => this.groupView(g, me))) });
    }
    if (req.method === 'POST' && path === '/api/groups') {
      if (!this.rateLimit(req, path, 10, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const name = cleanGroupName(body.name);
      if (!name) return err('Give the group a name', 400);
      const picked = Array.isArray(body.members) ? [...new Set(body.members.filter((x: unknown) => typeof x === 'string'))] as string[] : [];
      const others = picked.filter(id => id !== me.userId && this.canTalk(me.userId, id));
      if (others.length === 0) return err('Pick at least one friend', 400);
      if (others.length + 1 > MAX_GROUP) return err(`A group can have up to ${MAX_GROUP} people`, 400);
      const now = Date.now();
      const members = [me.userId, ...others];
      const g: Group = {
        id: 'grp_' + uuid().replace(/-/g, '').slice(0, 12),
        name,
        ownerId: me.userId,
        members,
        joined: Object.fromEntries(members.map(id => [id, now])),
        createdAt: now
      };
      data.groups.push(g);
      save();
      this.emitTo(members, 'group-updated', { groupId: g.id });
      return json({ group: await this.groupView(g, me) });
    }
    const gm = path.match(/^\/api\/groups\/(grp_[a-z0-9]+)\/(rename|add|remove|leave)$/);
    if (req.method === 'POST' && gm) {
      const g = this.groupOf(gm[1]);
      if (!g || !g.members.includes(me.userId)) return err('Group not found', 404);
      const action = gm[2];
      const before = [...g.members];
      if (action === 'leave') {
        g.members = g.members.filter(id => id !== me.userId);
        delete g.joined[me.userId];
        if (g.members.length === 0) {
          await this.deleteGroup(g);
          return json({ ok: true });
        }
        // The person who joined earliest takes over.
        if (g.ownerId === me.userId) g.ownerId = [...g.members].sort((a, b) => (g.joined[a] ?? 0) - (g.joined[b] ?? 0))[0];
      } else {
        if (g.ownerId !== me.userId) return err('Only the person who made the group can do this', 403);
        if (action === 'rename') {
          const name = cleanGroupName(body.name);
          if (!name) return err('Give the group a name', 400);
          g.name = name;
        } else if (action === 'add') {
          const ids = Array.isArray(body.userIds) ? (body.userIds.filter((x: unknown) => typeof x === 'string') as string[]) : [];
          const add = [...new Set(ids)].filter(id => !g.members.includes(id) && this.canTalk(me.userId, id));
          if (add.length === 0) return err('Pick at least one friend', 400);
          if (g.members.length + add.length > MAX_GROUP) return err(`A group can have up to ${MAX_GROUP} people`, 400);
          const now = Date.now();
          for (const id of add) {
            g.members.push(id);
            g.joined[id] = now;
          }
        } else if (action === 'remove') {
          const id = typeof body.userId === 'string' ? body.userId : '';
          if (!g.members.includes(id) || id === me.userId) return err('Invalid request', 400);
          g.members = g.members.filter(x => x !== id);
          delete g.joined[id];
        }
      }
      save();
      this.emitTo([...new Set([...before, ...g.members])], 'group-updated', { groupId: g.id });
      return json({ ok: true });
    }

    // ----- photos and voice notes inside chats -----
    if (req.method === 'POST' && path === '/api/chatmedia') {
      if (!r2Enabled) return err('File storage is not set up on this server yet', 503);
      const { key, recipientId, kind } = body;
      if (typeof key !== 'string' || typeof recipientId !== 'string' || (kind !== 'photo' && kind !== 'voice')) return err('Invalid request', 400);
      if (!key.startsWith(`chat/${me.userId}/`) || !this.canChat(me.userId, recipientId)) return err('Invalid request', 400);
      if (this.messages.some(m => m.media?.key === key)) return err('Already sent', 409);
      const info = await head(key).catch(() => null);
      if (!info) return err('Upload not found. Please try again.', 400);
      const okType = kind === 'photo' ? info.type.startsWith('image/') : info.type.startsWith('audio/');
      const max = kind === 'photo' ? 1024 * 1024 : 5 * 1024 * 1024;
      if (!okType || info.size > max) {
        await remove(key).catch(() => {});
        return err('That file cannot be sent', 400);
      }
      const dur = Number(body.dur);
      const now = Date.now();
      const msg: Message = {
        id: uuid(),
        senderId: me.userId,
        recipientId,
        message: kind === 'photo' ? '📷 Photo' : '🎤 Voice note',
        timestamp: now,
        status: !isGroupId(recipientId) && this.isOnline(recipientId) ? 'received' : 'sent',
        reactions: {},
        media: {
          kind,
          key,
          mime: info.type,
          size: info.size,
          ...(kind === 'voice' && Number.isFinite(dur) && dur > 0 ? { dur: Math.min(Math.round(dur), 600) } : {}),
          expiresAt: now + 30 * 24 * 3600 * 1000
        }
      };
      this.addMessage(msg);
      this.deliver(msg, me);
      return json({ message: msg });
    }
    const cm = path.match(/^\/api\/chatmedia\/([^/]+)$/);
    if (req.method === 'GET' && cm) {
      const m = this.index.get(decodeURIComponent(cm[1]));
      if (!m?.media || !this.canSee(m, me.userId)) return err('Not found', 404);
      if (m.media.gone || !r2Enabled) return err('This has expired', 410);
      return json({ url: await signGet(m.media.key, { expiresIn: 3600 }) });
    }

    // ----- change password / change User ID -----
    if (req.method === 'POST' && path === '/api/account/password') {
      if (!this.rateLimit(req, path, 10, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const current = typeof body.current === 'string' ? body.current : '';
      const next = typeof body.next === 'string' ? body.next : '';
      if (!(await verifyPassword(current, me.passwordHash))) return err('Your current password is not right', 400);
      if (next.length < 6 || next.length > 128) return err('New password must be 6-128 characters', 400);
      if (next === current) return err('The new password is the same as the old one', 400);
      me.passwordHash = await hashPassword(next);
      delete me.mustChangePassword;
      // Every other phone or computer signed in to this account is signed out.
      me.sessionsFrom = Date.now();
      this.saveUser(me);
      // Open connections are dropped shortly: this phone reconnects with its new sign-in, the others are signed out.
      const open = this.socketsOf(me.userId);
      setTimeout(() => {
        for (const w of open) {
          try {
            w.close(4000, 'password changed');
          } catch {
            /* closed */
          }
        }
      }, 3000);
      return json({ token: await signToken(this.secret, me.userId) });
    }

    if (req.method === 'POST' && path === '/api/account/user-id') {
      if (!this.rateLimit(req, path, 10, 60_000)) return err('Too many attempts, try again in a minute', 429);
      if (me.userId === this.adminId) return err('The admin User ID cannot be changed', 400);
      const password = typeof body.password === 'string' ? body.password : '';
      const id = typeof body.newId === 'string' ? body.newId.trim().toUpperCase() : '';
      if (!(await verifyPassword(password, me.passwordHash))) return err('Your password is not right', 400);
      if (!/^[A-Z0-9_]{3,20}$/.test(id)) return err('User ID must be 3-20 letters, numbers or underscores', 400);
      if (id === me.userId) return err('That is already your User ID', 400);
      const DAY = 24 * 3600 * 1000;
      if (me.idChangedAt && Date.now() - me.idChangedAt < 30 * DAY) {
        const when = new Date(me.idChangedAt + 30 * DAY).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        return err(`You can change your User ID again on ${when}`, 400);
      }
      if (this.users[id] || this.idReserved(id, me.userId)) return err('That User ID is taken. Try another.', 409);
      const oldId = me.userId;
      const oldSockets = this.socketsOf(oldId);
      this.renameUser(oldId, id);
      const now = Date.now();
      me.formerIds = [...(me.formerIds ?? []).filter(f => f.until > now && f.id !== id), { id: oldId, until: now + 30 * DAY }];
      me.idChangedAt = now;
      // Old sign-ins (with the old ID) stop working; this phone gets a new one below.
      me.sessionsFrom = now;
      this.saveUser(me);
      // Friends' apps swap the old ID for the new one.
      this.emitTo(this.presenceTargets(me), 'friend-id-changed', { oldId, newId: id });
      // Other phones still connected with the old ID are signed out shortly (this phone reconnects by itself).
      setTimeout(() => {
        for (const w of oldSockets) {
          try {
            w.close(4000, 'id changed');
          } catch {
            /* closed */
          }
        }
      }, 5000);
      return json({ token: await signToken(this.secret, id), user: { ...this.publicUser(me), photoUrl: await this.photoUrlOf(me) } });
    }

    // ----- block / unblock a person, report a person -----
    if (req.method === 'POST' && path === '/api/block') {
      const id = typeof body.userId === 'string' ? body.userId.trim().toUpperCase() : '';
      const other = this.users[id];
      if (!other || id === me.userId || id === this.adminId) return err('Invalid request', 400);
      const list = (me.blockList ?? []).filter(x => x !== id);
      if (body.blocked) list.push(id);
      me.blockList = list.slice(-500);
      this.saveUser(me);
      // Their screen stops showing me as online (or shows it again after unblocking).
      if (other.friends.includes(me.userId)) {
        this.emitTo([id], 'presence-update', { userId: me.userId, isOnline: body.blocked ? false : this.isOnline(me.userId) });
      }
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === '/api/report-user') {
      const id = typeof body.userId === 'string' ? body.userId.trim().toUpperCase() : '';
      const other = this.users[id];
      if (!other || id === me.userId || id === this.adminId) return err('Invalid request', 400);
      if (!this.rateLimit(req, path, 10, 60_000)) return err('Too many reports. Wait a moment.', 429);
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
      const list = (other.reportedBy ?? []).filter(r => r.by !== me.userId);
      list.push({ by: me.userId, reason, at: Date.now() });
      other.reportedBy = list.slice(-50);
      this.saveUser(other);
      return json({ ok: true });
    }

    if (req.method === 'GET' && path === '/api/admin/reported-users') {
      if (me.userId !== this.adminId) return err('Admin only', 403);
      const people = Object.values(this.users)
        .filter(u => u.reportedBy?.length)
        .map(u => ({
          userId: u.userId,
          name: u.name,
          blocked: !!u.blocked,
          reports: (u.reportedBy ?? []).map(r => ({ by: this.users[r.by]?.name ?? r.by, reason: r.reason, at: r.at }))
        }))
        .sort((a, b) => b.reports.length - a.reports.length);
      return json({ people });
    }

    if (req.method === 'GET' && path === '/api/admin/reset-requests') {
      if (me.userId !== this.adminId) return err('Admin only', 403);
      const people = Object.values(this.users)
        .filter(u => u.resetRequest)
        .map(u => ({ userId: u.userId, name: u.name, at: u.resetRequest!.at, message: u.resetRequest!.message }))
        .sort((a, b) => b.at - a.at);
      return json({ people });
    }

    if (req.method === 'POST' && path === '/api/admin/reset-requests/action') {
      if (me.userId !== this.adminId) return err('Admin only', 403);
      const u = this.users[typeof body.userId === 'string' ? body.userId : ''];
      if (!u || u.userId === this.adminId) return err('Account not found', 404);
      if (body.action === 'dismiss') {
        delete u.resetRequest;
        this.saveUser(u);
        return json({ ok: true });
      }
      if (body.action !== 'reset') return err('Invalid request', 400);
      // Easy to read out on the phone: no 0/O or 1/I/L.
      const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      const temp = Array.from(rnd, b => letters[b % letters.length]).join('');
      u.passwordHash = await hashPassword(temp);
      u.mustChangePassword = true;
      u.sessionsFrom = Date.now();
      delete u.resetRequest;
      this.saveUser(u);
      return json({ tempPassword: temp });
    }

    if (req.method === 'POST' && path === '/api/admin/reported-users/action') {
      if (me.userId !== this.adminId) return err('Admin only', 403);
      const u = this.users[typeof body.userId === 'string' ? body.userId : ''];
      if (!u || u.userId === this.adminId) return err('Account not found', 404);
      if (body.action === 'block') {
        u.blocked = true;
        delete u.reportedBy;
        this.saveUser(u);
        // Close their open connections so they are signed out at once.
        for (const w of this.socketsOf(u.userId)) {
          try {
            w.close(4401, 'blocked');
          } catch {
            /* closed */
          }
        }
      } else if (body.action === 'dismiss') {
        delete u.reportedBy;
        this.saveUser(u);
      } else return err('Invalid request', 400);
      return json({ ok: true });
    }

    // The old "add instantly" door now only sends a friend request (the other person has to accept).
    let routePath = path;
    if (req.method === 'POST' && path === '/api/friends') {
      body.userId = body.friendId;
      routePath = '/api/friends/request';
    }

    if (req.method === 'GET' && path === '/api/messages') return json({ messages: this.messagesFor(me.userId) });
    if (req.method === 'GET' && path === '/api/messages/older') {
      const friendId = url.searchParams.get('friendId') || '';
      const before = Number(url.searchParams.get('before')) || Date.now();
      // With "after": everything in between (to fill the gap up to a search result).
      const after = Number(url.searchParams.get('after'));
      let since = 0;
      if (isGroupId(friendId)) {
        const s = this.memberSince(friendId, me.userId);
        if (s === undefined) return json({ messages: [] });
        since = s;
      }
      return json({ messages: after ? olderMessages(me.userId, friendId, before, 3000, after, since) : olderMessages(me.userId, friendId, before, 100, -Infinity, since) });
    }
    if (req.method === 'GET' && path === '/api/messages/search') {
      const friendId = url.searchParams.get('friendId') || '';
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      if (q.length < 2) return json({ hits: [] });
      let since = 0;
      if (isGroupId(friendId)) {
        const s = this.memberSince(friendId, me.userId);
        if (s === undefined) return json({ hits: [] });
        since = s;
      }
      return json({ hits: searchMessages(me.userId, friendId, q, 200, since) });
    }

    if (req.method === 'GET' && path === '/api/push/key') return json({ key: this.vapid?.pub ?? null });
    if (req.method === 'POST' && path === '/api/translate') {
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      const to = typeof body?.to === 'string' ? body.to : '';
      const name = LANGS[to];
      if (!text || !name) return err('Invalid request', 400);
      if (!this.rateLimit(req, '/api/translate', 90, 60_000)) return err('Too many translations. Wait a moment.', 429);
      let out = '';
      const ai = (this.env as any).AI;
      if (ai) {
        try {
          const r = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: `You are a translator. Translate the user's message into ${name}. Keep symbols such as * _ ~ \` unchanged. If it is already in ${name}, return it as it is. Reply with the translation only, no notes, no quotes.` },
              { role: 'user', content: text }
            ],
            max_tokens: 900
          });
          out = String(r?.response ?? '').trim();
        } catch (e) {
          console.error('translate (AI) failed', e);
        }
      }
      if (!out) {
        try {
          const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 450))}&langpair=${encodeURIComponent('Autodetect|' + to)}`);
          const j: any = await r.json();
          out = String(j?.responseData?.translatedText ?? '').trim();
        } catch (e) {
          console.error('translate (fallback) failed', e);
        }
      }
      if (!out) return err('Could not translate right now', 503);
      return json({ text: out });
    }
    if (req.method === 'POST' && path === '/api/style') {
      const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined);
      const font = typeof body?.font === 'string' && ['nunito', 'lora', 'caveat', 'poppins'].includes(body.font) ? body.font : undefined;
      me.style = { color: hex(body?.color), font, accent: hex(body?.accent), share: body?.share !== false };
      this.saveUser(me);
      this.emitTo(me.friends, 'profile-updated', { userId: me.userId });
      return json({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/push/subscribe') {
      const sub = body?.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
        return err('Invalid subscription', 400);
      }
      const list = (me.pushSubs ?? []).filter(s => s.endpoint !== sub.endpoint);
      list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      me.pushSubs = list.slice(-5);
      this.saveUser(me);
      return json({ ok: true });
    }
    if (path.startsWith('/api/push/')) return json({ ok: true });

    if (req.method === 'GET' && path === '/api/ice') {
      return json({ iceServers: await this.iceServers() });
    }

    if (req.method === 'POST' && path === '/api/broadcast') {
      if (me.userId !== this.adminId) return err('Only the admin can send broadcasts', 403);
      if (!this.rateLimit(req, path, 20, 60_000)) return err('Too many attempts, try again in a minute', 429);
      const text = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';
      // Optional attachment, uploaded first with kind "broadcast". Everyone gets the same file; it is kept in storage.
      let attach: { key: string; name: string; size: number; mime: string } | null = null;
      const f = body.file;
      if (f) {
        if (!r2Enabled || typeof f.key !== 'string' || !f.key.startsWith('broadcast/')) return err('Invalid attachment', 400);
        const info = await head(f.key).catch(() => null);
        if (!info) return err('Attachment not found. Please try again.', 400);
        attach = {
          key: f.key,
          name: String(f.name ?? 'file').replace(/[\\/\0\r\n"]/g, '_').trim().slice(0, 120) || 'file',
          size: info.size,
          mime: info.type
        };
      }
      if (!text && !attach) return err('Write a message or attach a file first', 400);
      this.syncAdminFriends();
      const broadcastId = uuid();
      let sent = 0;
      for (const u of Object.values(this.users)) {
        if (u.userId === me.userId) continue;
        const id = uuid();
        const msg: Message = {
          id,
          senderId: me.userId,
          recipientId: u.userId,
          message: text,
          timestamp: Date.now(),
          status: this.isOnline(u.userId) ? 'received' : 'sent',
          reactions: {},
          broadcast: true,
          broadcastId,
          ...(attach
            ? { file: { id: `bc:${id}`, name: attach.name, size: attach.size, gone: false, permanent: true }, bcKey: attach.key, bcMime: attach.mime }
            : {})
        };
        this.addMessage(msg);
        this.emitTo([u.userId, me.userId], 'chat-message', msg);
        if (!this.isOnline(u.userId)) this.pushTo(u.userId, { kind: 'message', title: 'System Broadcast', body: 'New update from Kite', tag: 'msg-' + me.userId });
        sent++;
      }
      return json({ sent });
    }

    const bcf = path.match(/^\/api\/broadcast\/file\/([^/]+)$/);
    if (req.method === 'GET' && bcf) {
      const m = this.index.get(decodeURIComponent(bcf[1]));
      if (!m || !m.bcKey || !m.file || (m.senderId !== me.userId && m.recipientId !== me.userId)) return err('Not found', 404);
      try {
        return json({ url: await signGet(m.bcKey, { expiresIn: 600, downloadName: m.file.name }), name: m.file.name });
      } catch {
        return err('Could not prepare the download', 500);
      }
    }

    if (req.method === 'POST' && path === '/api/chats/pin') {
      const { friendId, pinned } = body;
      if (typeof friendId !== 'string' || !this.areFriends(me.userId, friendId) || friendId === this.adminId) return err('Invalid chat', 400);
      const list = (me.pinnedChats ?? []).filter(id => id !== friendId);
      if (pinned) {
        if (list.length >= 3) return err('You can pin up to 3 chats. Unpin one first.', 400);
        list.push(friendId);
      }
      me.pinnedChats = list;
      this.saveUser(me);
      return json({ ok: true });
    }

    const pin = path.match(/^\/api\/messages\/([^/]+)\/pin$/);
    if (req.method === 'POST' && pin) {
      const m = this.index.get(decodeURIComponent(pin[1]));
      if (!m || !this.canSee(m, me.userId)) return err('Not found', 404);
      const want = !!body.pinned;
      if (want && !m.pinned) {
        const same = (x: Message) =>
          isGroupId(m.recipientId)
            ? x.recipientId === m.recipientId
            : (x.senderId === m.senderId && x.recipientId === m.recipientId) || (x.senderId === m.recipientId && x.recipientId === m.senderId);
        if (this.messages.filter(x => x.pinned && same(x)).length >= 3) return err('You can pin up to 3 messages in a chat. Unpin one first.', 400);
      }
      if (want) m.pinned = true;
      else delete m.pinned;
      this.saveMsg(m);
      this.emitTo(this.audience(m), 'message-updated', m);
      return json({ ok: true });
    }

    // Pictures, files, profiles, stories, reels, Kite Network, moderation.
    const rest = routePath.replace(/^\/api/, '');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const ctx = { headers: req.headers, body, query, ip: req.headers.get('cf-connecting-ip') || '' };
    for (const r of this.routers) {
      const out = r.handle(req.method, rest, ctx);
      if (out) return out;
    }
    return err('Not found', 404);
  }

  // ---------- live connection ----------

  async openSocket(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') return err('Expected a WebSocket', 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const user = await tokenUser(this.secret, url.searchParams.get('token'));
    if (!user || user.blocked) {
      server.accept();
      server.close(4401, 'unauthorized');
      return new Response(null, { status: 101, webSocket: client } as any);
    }
    this.ctx.acceptWebSocket(server, ['u:' + user.userId]);
    server.serializeAttachment({ uid: user.userId, cid: uuid() });
    this.onConnect(server, user);
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  onConnect(ws: WebSocket, user: User) {
    const { cid } = ws.deserializeAttachment() as { cid: string };
    ws.send(JSON.stringify({ e: '$id', d: cid }));
    // First connection of this person: tell their friends they are online.
    if (this.socketsOf(user.userId).length === 1) {
      this.emitTo(this.presenceTargets(user), 'presence-update', { userId: user.userId, isOnline: true });
    }
    // Anything sent while they were away is now delivered.
    const delivered = new Map<string, string[]>();
    for (const m of this.messages) {
      if (m.recipientId === user.userId && m.status === 'sent' && !m.hiddenFor?.includes(user.userId)) {
        m.status = 'received';
        this.saveMsg(m);
        delivered.set(m.senderId, [...(delivered.get(m.senderId) ?? []), m.id]);
      }
    }
    for (const [senderId, ids] of delivered) this.emitTo([senderId], 'message-status-update', { messageIds: ids, status: 'received' });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return;
    let f: { e?: string; d?: any; i?: number };
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as { uid: string } | null;
    const me = att && this.users[att.uid];
    if (!me || me.blocked || typeof f.e !== 'string') return;
    const d = f.d ?? {};
    const reply = (r: unknown) => typeof f.i === 'number' && ws.send(JSON.stringify({ a: f.i, d: r }));

    switch (f.e) {
      case 'chat-message': {
        const { recipientId, message } = d;
        if (typeof recipientId !== 'string' || typeof message !== 'string') return;
        const text = message.trim().slice(0, 2000);
        // ----- a message to a group -----
        if (isGroupId(recipientId)) {
          if (!text || this.memberSince(recipientId, me.userId) === undefined) return;
          const gmsg: Message = { id: uuid(), senderId: me.userId, recipientId, message: text, timestamp: Date.now(), status: 'sent', reactions: {} };
          if (d.forwarded === true) gmsg.forwarded = true;
          const o = typeof d.replyTo === 'string' ? this.index.get(d.replyTo) : undefined;
          if (o && !o.deleted && o.recipientId === recipientId) {
            gmsg.replyTo = { id: o.id, senderId: o.senderId, text: (o.media ? (o.media.kind === 'photo' ? 'Photo' : 'Voice note') : o.message).slice(0, 120) };
          }
          this.addMessage(gmsg);
          this.deliver(gmsg, me);
          return;
        }
        if (!text || !this.areFriends(me.userId, recipientId)) return;
        // I blocked them: nothing is sent (the app asks me to unblock first).
        if (this.blocked(me.userId, recipientId)) return;
        // They blocked me: the message stays on my side only (one dot), like WhatsApp.
        const heldBack = this.blocked(recipientId, me.userId);
        const msg: Message = {
          id: uuid(),
          senderId: me.userId,
          recipientId,
          message: text,
          timestamp: Date.now(),
          status: !heldBack && this.isOnline(recipientId) ? 'received' : 'sent',
          reactions: {}
        };
        if (heldBack) msg.hiddenFor = [recipientId];
        if (d.forwarded === true) msg.forwarded = true;
        // An answer to an earlier message in this same chat: keep a short copy of what it answered.
        const orig = typeof d.replyTo === 'string' ? this.index.get(d.replyTo) : undefined;
        if (orig && !orig.deleted && ((orig.senderId === me.userId && orig.recipientId === recipientId) || (orig.senderId === recipientId && orig.recipientId === me.userId))) {
          msg.replyTo = { id: orig.id, senderId: orig.senderId, text: (orig.file ? `File: ${orig.file.name}` : orig.message).slice(0, 120) };
        }
        this.addMessage(msg);
        if (heldBack) {
          this.emitTo([me.userId], 'chat-message', msg);
          return;
        }
        this.emitTo([recipientId, me.userId], 'chat-message', msg);
        if (!this.isOnline(recipientId)) this.pushTo(recipientId, { kind: 'message', title: me.name, body: 'New message', tag: 'msg-' + me.userId });
        return;
      }
      case 'mark-messages-read': {
        const { friendId } = d;
        if (typeof friendId !== 'string') return;
        // Groups: just remember when I last read it.
        if (isGroupId(friendId)) {
          if (this.memberSince(friendId, me.userId) === undefined) return;
          me.groupRead = { ...(me.groupRead ?? {}), [friendId]: Date.now() };
          this.saveUser(me);
          return;
        }
        const ids: string[] = [];
        for (const m of this.messages) {
          if (m.senderId === friendId && m.recipientId === me.userId && m.status !== 'read' && !m.hiddenFor?.includes(me.userId)) {
            m.status = 'read';
            this.saveMsg(m);
            ids.push(m.id);
          }
        }
        if (ids.length) this.emitTo([friendId], 'message-status-update', { messageIds: ids, status: 'read' });
        return;
      }
      case 'typing': {
        const { recipientId, isTyping } = d;
        if (typeof recipientId !== 'string' || isGroupId(recipientId) || !this.canTalk(me.userId, recipientId)) return;
        this.emitTo([recipientId], 'typing', { senderId: me.userId, isTyping: !!isTyping });
        return;
      }
      case 'edit-message': {
        const { messageId, message } = d;
        if (typeof messageId !== 'string' || typeof message !== 'string') return;
        const msg = this.index.get(messageId);
        const text = message.trim().slice(0, 2000);
        if (!msg || !text || msg.senderId !== me.userId || msg.file || msg.media || msg.broadcast || msg.deleted) return;
        if (text === msg.message) return;
        msg.message = text;
        msg.edited = true;
        this.saveMsg(msg);
        this.emitTo(this.audience(msg), 'message-edited', { messageId, message: text });
        return;
      }
      case 'delete-message': {
        const { messageId, scope } = d;
        if (typeof messageId !== 'string') return;
        const msg = this.index.get(messageId);
        if (!msg || !this.canSee(msg, me.userId)) return;
        if (scope === 'all') {
          if (msg.senderId !== me.userId || msg.broadcast || msg.file) return;
          if (msg.media) void this.dropMedia(msg);
          msg.deleted = true;
          msg.message = '';
          msg.pinned = false;
          msg.reactions = {};
          this.saveMsg(msg);
          this.emitTo(this.audience(msg), 'message-deleted', { messageId, scope: 'all' });
        } else {
          msg.hiddenFor = [...new Set([...(msg.hiddenFor ?? []), me.userId])];
          this.saveMsg(msg);
          this.emitTo([me.userId], 'message-deleted', { messageId, scope: 'me', userId: me.userId });
        }
        return;
      }
      case 'message-reaction': {
        const { messageId, reaction } = d;
        if (typeof messageId !== 'string' || typeof reaction !== 'string') return;
        const msg = this.index.get(messageId);
        if (!msg || !this.canSee(msg, me.userId)) return;
        if (!msg.broadcast && !isGroupId(msg.recipientId) && !this.canTalk(msg.senderId, msg.recipientId)) return;
        if (reaction === '') delete msg.reactions[me.userId];
        else msg.reactions[me.userId] = reaction.slice(0, 8);
        this.saveMsg(msg);
        this.emitTo(this.audience(msg), 'message-reaction-update', { messageId, reactions: msg.reactions });
        return;
      }
      case 'call-invite': {
        const { recipientId, roomId, type } = d;
        if (typeof recipientId !== 'string' || typeof roomId !== 'string' || !/^CALL-[A-Za-z0-9-]{8,64}$/.test(roomId)) {
          return reply({ ok: false, error: 'Invalid call' });
        }
        if (!this.areFriends(me.userId, recipientId)) return reply({ ok: false, error: 'Not a friend' });
        if (recipientId === this.adminId) return reply({ ok: false, error: 'Calls are not available in System Broadcast' });
        const callee = this.users[recipientId];
        if (this.blocked(me.userId, recipientId)) return reply({ ok: false, error: `Unblock ${callee.name} to call` });
        if (this.blocked(recipientId, me.userId)) return reply({ ok: false, error: `${callee.name} is not available` });
        const offline = !this.isOnline(recipientId);
        if (offline && !callee.pushSubs?.length) {
          return reply({ ok: false, error: `${callee.name} is offline and has not allowed notifications, so cannot be called now` });
        }
        if (this.userInRoom(recipientId)) return reply({ ok: false, error: `${callee.name} is busy` });
        if (this.callOf(roomId)) return reply({ ok: false, error: 'Invalid call' });
        const callType = type === 'audio' ? 'audio' : 'video';
        this.calls.set(roomId, { callerId: me.userId, calleeId: recipientId, type: callType });
        // The callee's app is closed: wake the phone. The call rings when they open the notification.
        if (offline) {
          this.pushTo(recipientId, { kind: 'call', title: `${me.name} is calling`, body: callType === 'audio' ? 'Incoming voice call. Tap to answer.' : 'Incoming video call. Tap to answer.', tag: 'call-' + roomId }, true);
        }
        this.emitTo([recipientId], 'incoming-call', {
          roomId,
          callerId: me.userId,
          callerName: me.name,
          type: type === 'audio' ? 'audio' : 'video'
        });
        return reply({ ok: true });
      }
      case 'check-calls': {
        // Someone opened the app (maybe from a call notification): ring for any call still waiting for them.
        for (const w of this.ctx.getWebSockets()) {
          const a = this.attOf(w);
          if (!a.roomId || !a.call || a.call.calleeId !== me.userId) continue;
          if (this.roomMembers(a.roomId).length !== 1) continue;
          this.emitTo([me.userId], 'incoming-call', {
            roomId: a.roomId,
            callerId: a.call.callerId,
            callerName: this.users[a.call.callerId]?.name ?? 'Someone',
            type: a.call.type === 'audio' ? 'audio' : 'video'
          });
        }
        return;
      }
      case 'call-decline': {
        const call = typeof d.roomId === 'string' ? this.callOf(d.roomId) : undefined;
        if (!call || call.calleeId !== me.userId) return;
        this.emitTo([call.callerId], 'call-declined', { roomId: d.roomId, name: me.name });
        this.emitTo([me.userId], 'call-cancelled', { roomId: d.roomId });
        return;
      }
      case 'call-cancel': {
        const call = typeof d.roomId === 'string' ? this.callOf(d.roomId) : undefined;
        if (!call || call.callerId !== me.userId) return;
        this.emitTo([call.calleeId], 'call-cancelled', { roomId: d.roomId });
        return;
      }
      case 'join-room': {
        const { roomId } = d;
        const call = typeof roomId === 'string' ? this.callOf(roomId) : undefined;
        if (!call || (call.callerId !== me.userId && call.calleeId !== me.userId)) {
          return reply({ ok: false, error: 'Call is no longer available' });
        }
        this.leaveRoom(ws, true);
        const members = this.roomMembers(roomId);
        if (members.length >= 2) return reply({ ok: false, error: 'Call is full' });
        const peers = members.map(w => this.attOf(w).cid);
        ws.serializeAttachment({ ...this.attOf(ws), roomId, call });
        return reply({ ok: true, peers });
      }
      case 'leave-room':
        this.leaveRoom(ws);
        return;
      case 'signal': {
        const a = this.attOf(ws);
        if (!a.roomId || typeof d.to !== 'string') return;
        const target = this.roomMembers(a.roomId).find(w => this.attOf(w).cid === d.to);
        if (!target) return;
        try {
          target.send(JSON.stringify({ e: 'signal', d: { from: a.cid, data: d.data } }));
        } catch {
          /* closed */
        }
        return;
      }
      default:
        return;
    }
  }

  webSocketClose(ws: WebSocket) {
    this.gone(ws);
  }
  webSocketError(ws: WebSocket) {
    this.gone(ws);
  }
  gone(ws: WebSocket) {
    this.leaveRoom(ws);
    const att = ws.deserializeAttachment() as { uid: string } | null;
    const me = att && this.users[att.uid];
    if (!me) return;
    if (!this.isOnline(me.userId, ws)) {
      me.lastSeen = Date.now();
      this.saveUser(me);
      this.emitTo(this.presenceTargets(me), 'presence-update', { userId: me.userId, isOnline: false, lastSeen: me.showLastSeen === false ? null : me.lastSeen });
    }
  }
}
