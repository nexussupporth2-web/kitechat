// KiteChat on Cloudflare, phase 2: accounts, friends, chat, System Broadcast and pins.
// One Durable Object ("the hub") holds everything and talks to phones over hibernating WebSockets.
// Calls, files, profiles and Kite Network come in later phases.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DurableObject } from 'cloudflare:workers';
import type { User, Message } from '../server/store.ts';

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (message: string, status: number, extra: object = {}) => json({ error: message, ...extra }, status);
const uuid = () => crypto.randomUUID();

const BLOCKED_MSG = 'Your account has been blocked for sharing adult content.';
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
async function verifyToken(secret: string, token: unknown): Promise<string | null> {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || (await hmac(secret, payload)) !== sig) return null;
  try {
    const { uid, exp } = JSON.parse(new TextDecoder().decode(unb64(payload)));
    return typeof uid === 'string' && typeof exp === 'number' && exp > Date.now() ? uid : null;
  } catch {
    return null;
  }
}

export class Hub extends DurableObject {
  users: Record<string, User> = {};
  messages: Message[] = [];
  index = new Map<string, Message>();
  buckets = new Map<string, { count: number; reset: number }>();

  constructor(ctx: any, env: any) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const all: Map<string, any> = await ctx.storage.list();
      for (const [k, v] of all) {
        if (k.startsWith('u:')) this.users[k.slice(2)] = v;
        else if (k.startsWith('m:')) this.messages.push(v);
      }
      this.messages.sort((a, b) => a.timestamp - b.timestamp);
      for (const m of this.messages) this.index.set(m.id, m);
      this.syncAdminFriends();
      this.syncBroadcasts();
    });
  }

  // ---------- small helpers ----------

  get adminId(): string {
    return ((this.env as any).ADMIN_ID || 'KITE_ADMIN').trim().toUpperCase();
  }
  get secret(): string {
    return (this.env as any).AUTH_SECRET;
  }
  saveUser(u: User) {
    void this.ctx.storage.put('u:' + u.userId, u);
  }
  addMessage(m: Message) {
    this.messages.push(m);
    this.index.set(m.id, m);
    this.saveMsg(m);
  }
  saveMsg(m: Message) {
    void this.ctx.storage.put('m:' + m.id, m);
  }
  messagesFor(userId: string, limit = 1000): Message[] {
    const out: Message[] = [];
    for (let i = this.messages.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.messages[i];
      if (m.senderId === userId || m.recipientId === userId) out.push(m);
    }
    return out.reverse().sort((a, b) => a.timestamp - b.timestamp);
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
  friendView(u: User) {
    return { ...this.publicUser(u), isOnline: this.isOnline(u.userId) };
  }
  areFriends(a: string, b: string) {
    return !!this.users[a]?.friends.includes(b);
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
        this.addMessage({
          id: uuid(),
          senderId: admin.userId,
          recipientId: u.userId,
          message: original.message,
          timestamp: original.timestamp,
          status: 'sent',
          reactions: {},
          broadcast: true,
          broadcastId: original.broadcastId
        });
      }
    }
  }

  async auth(req: Request): Promise<User | Response> {
    const h = req.headers.get('authorization') || '';
    const uid = await verifyToken(this.secret, h.startsWith('Bearer ') ? h.slice(7) : '');
    const user = uid ? this.users[uid] : undefined;
    if (!user) return err('Unauthorized', 401);
    if (user.blocked) return err(BLOCKED_MSG, 403, { blocked: true });
    return user;
  }

  // ---------- HTTP ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!this.secret) return err('AUTH_SECRET is not set on the server', 500);

    if (path === '/ws') return this.openSocket(req, url);

    const body: any = req.method === 'POST' || req.method === 'PATCH' ? await req.json().catch(() => ({})) : {};

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
      if (this.users[id]) return err('User ID already exists', 409);
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
      if (user.blocked) return err(BLOCKED_MSG, 403, { blocked: true });
      return json({ token: await signToken(this.secret, user.userId), user: { ...this.publicUser(user), photoUrl: null } });
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

    if (req.method === 'GET' && path === '/api/me') return json({ user: { ...this.publicUser(me), photoUrl: null } });

    if (req.method === 'GET' && path === '/api/friends') {
      const list = me.friends.map(id => this.users[id]).filter(Boolean);
      return json({
        friends: list.map(u =>
          u.userId === this.adminId && me.userId !== this.adminId
            ? { ...this.friendView(u), name: 'System Broadcast', avatar: '📢', photoUrl: null }
            : { ...this.friendView(u), photoUrl: null, pinOrder: (me.pinnedChats ?? []).indexOf(u.userId) }
        )
      });
    }

    if (req.method === 'POST' && path === '/api/friends') {
      const friendId = typeof body.friendId === 'string' ? body.friendId.trim().toUpperCase() : '';
      const target = this.users[friendId];
      if (!target) return err('No user with that ID', 404);
      if (target.userId === me.userId) return err('You cannot add yourself', 400);
      if (me.friends.includes(target.userId)) return err('Already in your friends list', 400);
      me.friends.push(target.userId);
      if (!target.friends.includes(me.userId)) target.friends.push(me.userId);
      this.saveUser(me);
      this.saveUser(target);
      this.emitTo([target.userId], 'friend-added', this.friendView(me));
      return json({ friend: { ...this.friendView(target), photoUrl: null } });
    }

    if (req.method === 'GET' && path === '/api/messages') return json({ messages: this.messagesFor(me.userId) });

    if (req.method === 'GET' && path === '/api/push/key') return json({ key: null }); // notifications: a later phase
    if (path.startsWith('/api/push/')) return json({ ok: true });

    if (req.method === 'GET' && path === '/api/ice') {
      return json({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] });
    }

    if (req.method === 'POST' && path === '/api/broadcast') {
      if (me.userId !== this.adminId) return err('Only the admin can send broadcasts', 403);
      if (!this.rateLimit(req, path, 20, 60_000)) return err('Too many attempts, try again in a minute', 429);
      if (body.file) return err('Attachments in broadcasts come in a later phase of the Cloudflare version', 400);
      const text = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';
      if (!text) return err('Write a message or attach a file first', 400);
      this.syncAdminFriends();
      const broadcastId = uuid();
      let sent = 0;
      for (const u of Object.values(this.users)) {
        if (u.userId === me.userId) continue;
        const msg: Message = {
          id: uuid(),
          senderId: me.userId,
          recipientId: u.userId,
          message: text,
          timestamp: Date.now(),
          status: this.isOnline(u.userId) ? 'received' : 'sent',
          reactions: {},
          broadcast: true,
          broadcastId
        };
        this.addMessage(msg);
        this.emitTo([u.userId, me.userId], 'chat-message', msg);
        sent++;
      }
      return json({ sent });
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
      if (!m || (m.senderId !== me.userId && m.recipientId !== me.userId)) return err('Not found', 404);
      const want = !!body.pinned;
      if (want && !m.pinned) {
        const same = (x: Message) =>
          (x.senderId === m.senderId && x.recipientId === m.recipientId) || (x.senderId === m.recipientId && x.recipientId === m.senderId);
        if (this.messages.filter(x => x.pinned && same(x)).length >= 3) return err('You can pin up to 3 messages in a chat. Unpin one first.', 400);
      }
      if (want) m.pinned = true;
      else delete m.pinned;
      this.saveMsg(m);
      this.emitTo([m.senderId, m.recipientId], 'message-updated', m);
      return json({ ok: true });
    }

    return err('This part is not available in the Cloudflare test copy yet', 501);
  }

  // ---------- live connection ----------

  async openSocket(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') return err('Expected a WebSocket', 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const uid = await verifyToken(this.secret, url.searchParams.get('token'));
    const user = uid ? this.users[uid] : undefined;
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
      this.emitTo(user.friends, 'presence-update', { userId: user.userId, isOnline: true });
    }
    // Anything sent while they were away is now delivered.
    const delivered = new Map<string, string[]>();
    for (const m of this.messages) {
      if (m.recipientId === user.userId && m.status === 'sent') {
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
        if (!text || !this.areFriends(me.userId, recipientId)) return;
        const msg: Message = {
          id: uuid(),
          senderId: me.userId,
          recipientId,
          message: text,
          timestamp: Date.now(),
          status: this.isOnline(recipientId) ? 'received' : 'sent',
          reactions: {}
        };
        this.addMessage(msg);
        this.emitTo([recipientId, me.userId], 'chat-message', msg);
        return;
      }
      case 'mark-messages-read': {
        const { friendId } = d;
        if (typeof friendId !== 'string') return;
        const ids: string[] = [];
        for (const m of this.messages) {
          if (m.senderId === friendId && m.recipientId === me.userId && m.status !== 'read') {
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
        if (typeof recipientId !== 'string' || !this.areFriends(me.userId, recipientId)) return;
        this.emitTo([recipientId], 'typing', { senderId: me.userId, isTyping: !!isTyping });
        return;
      }
      case 'message-reaction': {
        const { messageId, reaction } = d;
        if (typeof messageId !== 'string' || typeof reaction !== 'string') return;
        const msg = this.index.get(messageId);
        if (!msg || (msg.senderId !== me.userId && msg.recipientId !== me.userId)) return;
        if (reaction === '') delete msg.reactions[me.userId];
        else msg.reactions[me.userId] = reaction.slice(0, 8);
        this.saveMsg(msg);
        this.emitTo([msg.senderId, msg.recipientId], 'message-reaction-update', { messageId, reactions: msg.reactions });
        return;
      }
      case 'call-invite':
      case 'join-room':
        return reply({ ok: false, error: 'Calls are not available in the Cloudflare test copy yet' });
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
    const att = ws.deserializeAttachment() as { uid: string } | null;
    const me = att && this.users[att.uid];
    if (!me) return;
    if (!this.isOnline(me.userId, ws)) this.emitTo(me.friends, 'presence-update', { userId: me.userId, isOnline: false });
  }
}
