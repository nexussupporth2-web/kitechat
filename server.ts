import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import { data, messageIndex, addMessage, messagesFor, save, flush, initStore, type Message, type User } from './server/store.ts';
import { mediaRouter } from './server/media.ts';
import { networkRouter } from './server/network.ts';
import { blockedMessage } from './server/moderation.ts';
import { r2Enabled, signGet } from './server/r2.ts';
import { canPush, pushEnabled, sendPush, vapidPublicKey } from './server/push.ts';
import { hashPassword, verifyPassword, signToken, verifyToken } from './server/auth.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Same-origin by default. Set CORS_ORIGIN (comma separated) only if the client is hosted elsewhere.
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined
});

app.use(express.json({ limit: '10kb' }));

// ---------- helpers ----------

/** The admin account. Everyone is automatically friends with it, and it can send broadcasts. */
const ADMIN_ID = (process.env.ADMIN_ID || 'KITE_ADMIN').trim().toUpperCase();

const publicUser = (u: User) => ({ userId: u.userId, name: u.name, avatar: u.avatar, isAdmin: u.userId === ADMIN_ID });

/** userId -> set of connected socket ids (a user may have several tabs/devices). */
const online = new Map<string, Set<string>>();
const isOnline = (id: string) => (online.get(id)?.size ?? 0) > 0;
/** A short-lived link to the profile picture (or null when the user has none). */
const photoUrlOf = async (u: User): Promise<string | null> =>
  r2Enabled && u.photo ? await signGet(u.photo.key, { expiresIn: 3600 }).catch(() => null) : null;
const friendView = (u: User) => ({ ...publicUser(u), isOnline: isOnline(u.userId) });
/** Makes the admin a friend of every user (and the other way round). Safe to run again and again. */
function syncAdminFriends(): boolean {
  const admin = data.users[ADMIN_ID];
  if (!admin) return false;
  let changed = false;
  for (const u of Object.values(data.users)) {
    if (u.userId === admin.userId) continue;
    if (!u.friends.includes(admin.userId)) {
      u.friends.push(admin.userId);
      changed = true;
    }
    if (!admin.friends.includes(u.userId)) {
      admin.friends.push(u.userId);
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}
/**
 * Gives people every past admin broadcast they have not got yet, in the original order.
 * Runs when someone registers and when the server starts, so new users see the whole history.
 */
function syncBroadcasts(): boolean {
  const admin = data.users[ADMIN_ID];
  if (!admin) return false;
  const sent = data.messages.filter(m => m.senderId === ADMIN_ID && m.broadcast);
  const seen = new Map<string, Message>(); // one entry per broadcast
  for (const m of sent) {
    const key = m.broadcastId ?? m.message;
    if (!seen.has(key) || m.timestamp < seen.get(key)!.timestamp) seen.set(key, m);
  }
  const all = [...seen.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  let added = false;
  for (const u of Object.values(data.users)) {
    if (u.userId === ADMIN_ID) continue;
    const have = new Set(sent.filter(m => m.recipientId === u.userId).map(m => m.broadcastId ?? m.message));
    for (const [key, original] of all) {
      if (have.has(key)) continue;
      addMessage({
        id: crypto.randomUUID(),
        senderId: ADMIN_ID,
        recipientId: u.userId,
        message: original.message,
        timestamp: original.timestamp,
        status: 'sent',
        reactions: {},
        broadcast: true,
        broadcastId: original.broadcastId
      });
      added = true;
    }
  }
  if (added) save();
  return added;
}
const areFriends = (a: string, b: string) => !!data.users[a]?.friends.includes(b);

const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.reset < now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++b.count > max) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  const uid = verifyToken(h?.startsWith('Bearer ') ? h.slice(7) : '');
  const user = uid ? data.users[uid] : undefined;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.blocked) return res.status(403).json({ error: blockedMessage, blocked: true });
  res.locals.user = user;
  next();
}

// ---------- REST ----------

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/register', rateLimit(10, 60_000), (req, res) => {
  const { userId, password, name } = req.body ?? {};
  if (typeof userId !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = userId.trim().toUpperCase();
  const cleanName = name.trim();
  if (!/^[A-Z0-9_]{3,20}$/.test(id)) {
    return res.status(400).json({ error: 'User ID must be 3-20 letters, numbers or underscores' });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 6-128 characters' });
  }
  if (cleanName.length < 1 || cleanName.length > 40) {
    return res.status(400).json({ error: 'Name must be 1-40 characters' });
  }
  if (data.users[id]) return res.status(409).json({ error: 'User ID already exists' });

  const user: User = {
    userId: id,
    name: cleanName,
    avatar: cleanName.charAt(0).toUpperCase(),
    passwordHash: hashPassword(password),
    friends: [],
    createdAt: Date.now()
  };
  data.users[id] = user;
  syncAdminFriends();
  syncBroadcasts();
  save();
  // The admin's list updates live when someone new joins.
  if (id !== ADMIN_ID && data.users[ADMIN_ID]) io.to(`user:${ADMIN_ID}`).emit('friend-added', friendView(user));
  res.json({ token: signToken(id), user: publicUser(user) });
});

app.post('/api/login', rateLimit(10, 60_000), async (req, res) => {
  const { userId, password } = req.body ?? {};
  if (typeof userId !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  const user = data.users[userId.trim().toUpperCase()];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid User ID or password' });
  }
  if (user.blocked) return res.status(403).json({ error: blockedMessage, blocked: true });
  res.json({ token: signToken(user.userId), user: { ...publicUser(user), photoUrl: await photoUrlOf(user) } });
});

/** A blocked person can ask the admin to look again. Needs their ID and password. */
app.post('/api/appeal', rateLimit(5, 60_000), (req, res) => {
  const { userId, password, message } = req.body ?? {};
  const user = typeof userId === 'string' ? data.users[userId.trim().toUpperCase()] : undefined;
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.passwordHash) || !user.blocked) {
    return res.status(400).json({ error: 'Could not send the appeal. Check your User ID and password.' });
  }
  const text = typeof message === 'string' ? message.trim().slice(0, 500) : '';
  if (!text) return res.status(400).json({ error: 'Write a short message first' });
  user.appeal = { at: Date.now(), message: text };
  save();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (_req, res) => {
  const me = res.locals.user as User;
  res.json({ user: { ...publicUser(me), photoUrl: await photoUrlOf(me) } });
});

app.get('/api/friends', requireAuth, async (_req, res) => {
  const me = res.locals.user as User;
  const list = me.friends.map(id => data.users[id]).filter(Boolean);
  res.json({ friends: await Promise.all(list.map(async u => ({ ...friendView(u), photoUrl: await photoUrlOf(u) }))) });
});

app.post('/api/friends', requireAuth, async (req, res) => {
  const me = res.locals.user as User;
  const friendId = typeof req.body?.friendId === 'string' ? req.body.friendId.trim().toUpperCase() : '';
  const target = data.users[friendId];
  if (!target) return res.status(404).json({ error: 'No user with that ID' });
  if (target.userId === me.userId) return res.status(400).json({ error: 'You cannot add yourself' });
  if (me.friends.includes(target.userId)) return res.status(400).json({ error: 'Already in your friends list' });

  me.friends.push(target.userId);
  if (!target.friends.includes(me.userId)) target.friends.push(me.userId);
  save();
  io.to(`user:${target.userId}`).emit('friend-added', friendView(me));
  res.json({ friend: { ...friendView(target), photoUrl: await photoUrlOf(target) } });
});

// ----- notifications for a closed app (Web Push) -----

app.get('/api/push/key', requireAuth, (_req, res) => {
  res.json({ key: vapidPublicKey });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const me = res.locals.user as User;
  const sub = req.body?.subscription;
  const ok =
    pushEnabled &&
    typeof sub?.endpoint === 'string' &&
    sub.endpoint.startsWith('https://') &&
    sub.endpoint.length < 1000 &&
    typeof sub?.keys?.p256dh === 'string' &&
    typeof sub?.keys?.auth === 'string';
  if (!ok) return res.status(400).json({ error: 'Invalid subscription' });
  const list = (me.pushSubs ?? []).filter(s => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  me.pushSubs = list.slice(-5); // at most 5 devices
  save();
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const me = res.locals.user as User;
  const endpoint = req.body?.endpoint;
  if (typeof endpoint === 'string' && me.pushSubs) {
    me.pushSubs = me.pushSubs.filter(s => s.endpoint !== endpoint);
    save();
  }
  res.json({ ok: true });
});

/** Admin only: send one message to everyone. It appears in each person's chat with the admin. */
app.post('/api/broadcast', requireAuth, rateLimit(20, 60_000), (req, res) => {
  const me = res.locals.user as User;
  if (me.userId !== ADMIN_ID) return res.status(403).json({ error: 'Only the admin can send broadcasts' });
  const text = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 2000) : '';
  if (!text) return res.status(400).json({ error: 'Write a message first' });
  syncAdminFriends();
  const broadcastId = crypto.randomUUID();
  let sent = 0;
  for (const u of Object.values(data.users)) {
    if (u.userId === me.userId) continue;
    const msg: Message = {
      id: crypto.randomUUID(),
      senderId: me.userId,
      recipientId: u.userId,
      message: text,
      timestamp: Date.now(),
      status: isOnline(u.userId) ? 'received' : 'sent',
      reactions: {},
      broadcast: true,
      broadcastId
    };
    addMessage(msg);
    io.to(`user:${u.userId}`).to(`user:${me.userId}`).emit('chat-message', msg);
    if (!isOnline(u.userId)) void sendPush(u, { kind: 'message', title: 'KiteChat', body: 'You have a message', tag: `msg-${me.userId}` });
    sent++;
  }
  res.json({ sent });
});

app.get('/api/messages', requireAuth, (_req, res) => {
  res.json({ messages: messagesFor((res.locals.user as User).userId) });
});

/** STUN by default; add a TURN server via env so calls work across strict NATs / mobile networks. */
app.get('/api/ice', requireAuth, (_req, res) => {
  const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers });
});

// ---------- sockets ----------

io.use((socket, next) => {
  const uid = verifyToken(socket.handshake.auth?.token);
  if (!uid || !data.users[uid] || data.users[uid].blocked) return next(new Error('unauthorized'));
  socket.data.userId = uid;
  next();
});

/** roomId -> the two people allowed in that call. */
const calls = new Map<string, { callerId: string; calleeId: string }>();
const userRoom = new Map<string, string>(); // userId -> roomId they are currently in
const ROOM_RE = /^CALL-[A-Za-z0-9-]{8,64}$/;

function leaveRoom(socket: Socket) {
  const roomId: string | undefined = socket.data.roomId;
  if (!roomId) return;
  const userId: string = socket.data.userId;
  socket.leave(roomId);
  delete socket.data.roomId;
  socket.to(roomId).emit('peer-left', { socketId: socket.id });
  const remaining = io.sockets.adapter.rooms.get(roomId);
  if (!remaining || remaining.size === 0) {
    calls.delete(roomId);
  }
  if (userRoom.get(userId) === roomId) userRoom.delete(userId);
}

/** A call to someone whose app is closed waits here (for a short time) until they open the app. */
const pendingCalls = new Map<string, { roomId: string; callerId: string; callerName: string; type: 'audio' | 'video'; until: number }>();
const PENDING_CALL_MS = 50_000;

/** Leaves a "Missed call" line in the chat when the person never got to see the call. */
function missedCall(callerId: string, calleeId: string) {
  const msg: Message = {
    id: crypto.randomUUID(),
    senderId: callerId,
    recipientId: calleeId,
    message: '📞 Missed call',
    timestamp: Date.now(),
    status: isOnline(calleeId) ? 'received' : 'sent',
    reactions: {}
  };
  addMessage(msg);
  io.to(`user:${calleeId}`).to(`user:${callerId}`).emit('chat-message', msg);
}

io.on('connection', socket => {
  const userId: string = socket.data.userId;
  const me = data.users[userId];
  socket.join(`user:${userId}`);

  const set = online.get(userId) ?? new Set<string>();
  set.add(socket.id);
  online.set(userId, set);
  if (set.size === 1) {
    for (const f of me.friends) io.to(`user:${f}`).emit('presence-update', { userId, isOnline: true });
  }

  // Anything sent to me while I was offline is now delivered.
  const delivered = new Map<string, string[]>();
  for (const m of data.messages) {
    if (m.recipientId === userId && m.status === 'sent') {
      m.status = 'received';
      delivered.set(m.senderId, [...(delivered.get(m.senderId) ?? []), m.id]);
    }
  }
  if (delivered.size) {
    for (const [senderId, ids] of delivered) {
      io.to(`user:${senderId}`).emit('message-status-update', { messageIds: ids, status: 'received' });
    }
    save();
  }

  // A call that came in while my app was closed: ring now (after the page has finished starting).
  const waiting = pendingCalls.get(userId);
  if (waiting) {
    pendingCalls.delete(userId);
    if (waiting.until > Date.now() && calls.has(waiting.roomId) && !userRoom.has(userId)) {
      const { until: _until, ...invite } = waiting;
      setTimeout(() => socket.connected && socket.emit('incoming-call', invite), 1500);
    }
  }

  socket.on('chat-message', ({ recipientId, message }: { recipientId?: string; message?: string }) => {
    if (typeof recipientId !== 'string' || typeof message !== 'string') return;
    const text = message.trim().slice(0, 2000);
    if (!text || !areFriends(userId, recipientId)) return;
    const msg: Message = {
      id: crypto.randomUUID(),
      senderId: userId,
      recipientId,
      message: text,
      timestamp: Date.now(),
      status: isOnline(recipientId) ? 'received' : 'sent',
      reactions: {}
    };
    addMessage(msg);
    io.to(`user:${recipientId}`).to(`user:${userId}`).emit('chat-message', msg);
    if (!isOnline(recipientId)) void sendPush(data.users[recipientId], { kind: 'message', title: 'KiteChat', body: 'You have a message', tag: `msg-${userId}` });
  });

  socket.on('mark-messages-read', ({ friendId }: { friendId?: string }) => {
    if (typeof friendId !== 'string') return;
    const ids: string[] = [];
    for (const m of data.messages) {
      if (m.senderId === friendId && m.recipientId === userId && m.status !== 'read') {
        m.status = 'read';
        ids.push(m.id);
      }
    }
    if (ids.length) {
      save();
      io.to(`user:${friendId}`).emit('message-status-update', { messageIds: ids, status: 'read' });
    }
  });

  socket.on('typing', ({ recipientId, isTyping }: { recipientId?: string; isTyping?: boolean }) => {
    if (typeof recipientId !== 'string' || !areFriends(userId, recipientId)) return;
    io.to(`user:${recipientId}`).emit('typing', { senderId: userId, isTyping: !!isTyping });
  });

  socket.on('message-reaction', ({ messageId, reaction }: { messageId?: string; reaction?: string }) => {
    if (typeof messageId !== 'string' || typeof reaction !== 'string') return;
    const msg = messageIndex.get(messageId);
    if (!msg || (msg.senderId !== userId && msg.recipientId !== userId)) return;
    if (reaction === '') delete msg.reactions[userId];
    else msg.reactions[userId] = reaction.slice(0, 8);
    save();
    io.to(`user:${msg.senderId}`).to(`user:${msg.recipientId}`).emit('message-reaction-update', {
      messageId,
      reactions: msg.reactions
    });
  });

  // ----- calls -----

  socket.on(
    'call-invite',
    (
      { recipientId, roomId, type }: { recipientId?: string; roomId?: string; type?: string },
      ack?: (r: { ok: boolean; error?: string }) => void
    ) => {
      const reply = (r: { ok: boolean; error?: string }) => typeof ack === 'function' && ack(r);
      if (typeof recipientId !== 'string' || typeof roomId !== 'string' || !ROOM_RE.test(roomId)) {
        return reply({ ok: false, error: 'Invalid call' });
      }
      if (!areFriends(userId, recipientId)) return reply({ ok: false, error: 'Not a friend' });
      const calleeOnline = isOnline(recipientId);
      if (!calleeOnline && !canPush(data.users[recipientId])) {
        return reply({ ok: false, error: `${data.users[recipientId].name} is offline and has not turned on notifications yet` });
      }
      if (userRoom.has(recipientId)) return reply({ ok: false, error: `${data.users[recipientId].name} is busy` });
      if (calls.has(roomId)) return reply({ ok: false, error: 'Invalid call' });

      calls.set(roomId, { callerId: userId, calleeId: recipientId });
      setTimeout(() => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room || room.size === 0) calls.delete(roomId);
      }, 120_000).unref();

      const invite = {
        roomId,
        callerId: userId,
        callerName: me.name,
        type: (type === 'audio' ? 'audio' : 'video') as 'audio' | 'video'
      };
      if (calleeOnline) {
        io.to(`user:${recipientId}`).emit('incoming-call', invite);
      } else {
        // Their app is closed: send a notification and keep the call waiting for a moment.
        pendingCalls.set(recipientId, { ...invite, until: Date.now() + PENDING_CALL_MS });
        void sendPush(data.users[recipientId], { kind: 'call', title: 'KiteChat', body: 'You have an incoming call', tag: 'incoming-call' });
        setTimeout(() => {
          const p = pendingCalls.get(recipientId);
          if (p && p.roomId === roomId) {
            pendingCalls.delete(recipientId);
            missedCall(userId, recipientId);
          }
        }, PENDING_CALL_MS).unref();
      }
      reply({ ok: true });
    }
  );

  socket.on('call-decline', ({ roomId }: { roomId?: string }) => {
    const call = typeof roomId === 'string' ? calls.get(roomId) : undefined;
    if (!call || call.calleeId !== userId) return;
    io.to(`user:${call.callerId}`).emit('call-declined', { roomId, name: me.name });
    // Other tabs of this user should stop ringing too.
    io.to(`user:${userId}`).emit('call-cancelled', { roomId });
  });

  socket.on('call-cancel', ({ roomId }: { roomId?: string }) => {
    const call = typeof roomId === 'string' ? calls.get(roomId) : undefined;
    if (!call || call.callerId !== userId) return;
    io.to(`user:${call.calleeId}`).emit('call-cancelled', { roomId });
    const p = pendingCalls.get(call.calleeId);
    if (p && p.roomId === roomId) {
      pendingCalls.delete(call.calleeId);
      missedCall(userId, call.calleeId);
    }
  });

  socket.on(
    'join-room',
    ({ roomId }: { roomId?: string }, ack?: (r: { ok: boolean; error?: string; peers?: string[] }) => void) => {
      const reply = (r: { ok: boolean; error?: string; peers?: string[] }) => typeof ack === 'function' && ack(r);
      const call = typeof roomId === 'string' ? calls.get(roomId) : undefined;
      if (!roomId || !call || (call.callerId !== userId && call.calleeId !== userId)) {
        return reply({ ok: false, error: 'Call is no longer available' });
      }
      leaveRoom(socket);
      const room = io.sockets.adapter.rooms.get(roomId);
      if (room && room.size >= 2) return reply({ ok: false, error: 'Call is full' });
      const peers = room ? (Array.from(room) as string[]) : [];
      socket.join(roomId);
      socket.data.roomId = roomId;
      userRoom.set(userId, roomId);
      // The caller's own invite is consumed once the callee joins.
      reply({ ok: true, peers });
    }
  );

  socket.on('leave-room', () => leaveRoom(socket));

  /** Relays offers / answers / ICE candidates, only between sockets in the same call room. */
  socket.on('signal', ({ to, data: payload }: { to?: string; data?: unknown }) => {
    const roomId: string | undefined = socket.data.roomId;
    if (!roomId || typeof to !== 'string') return;
    const target = io.sockets.sockets.get(to);
    if (!target || target.data.roomId !== roomId) return;
    target.emit('signal', { from: socket.id, data: payload });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    const s = online.get(userId);
    s?.delete(socket.id);
    if (s && s.size === 0) {
      online.delete(userId);
      for (const f of me.friends) io.to(`user:${f}`).emit('presence-update', { userId, isOnline: false });
    }
  });
});

// ---------- static / dev server ----------

async function start() {
  await initStore();
  syncBroadcasts(); // everyone also gets the older broadcasts they missed
  syncAdminFriends(); // everyone who joined before gets the admin as a friend too
  app.use('/api', networkRouter({ requireAuth, areFriends, isAdmin: (u: User) => u.userId === ADMIN_ID }));
  app.use('/api', mediaRouter({
      io,
      requireAuth,
      areFriends,
      isOnline,
      notifyOffline: (recipientId, senderId) => {
        if (!isOnline(recipientId)) void sendPush(data.users[recipientId], { kind: 'message', title: 'KiteChat', body: 'You have a message', tag: `msg-${senderId}` });
      }
    }));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(__dirname, 'dist');
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`KiteChat listening on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`);
    if (!process.env.AUTH_SECRET) {
      console.log('AUTH_SECRET not set: using a secret stored with the data file.');
    }
    if (isProd && !process.env.R2_BUCKET) {
      console.log('R2 is not configured: data is saved to a local file and will be lost on redeploy. Media is disabled.');
    }
  });
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void flush().finally(() => process.exit(0));
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
