import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import { data, messageIndex, addMessage, messagesFor, save, flush, initStore, type Message, type User } from './server/store.ts';
import { mediaRouter } from './server/media.ts';
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

const publicUser = (u: User) => ({ userId: u.userId, name: u.name, avatar: u.avatar });

/** userId -> set of connected socket ids (a user may have several tabs/devices). */
const online = new Map<string, Set<string>>();
const isOnline = (id: string) => (online.get(id)?.size ?? 0) > 0;
const friendView = (u: User) => ({ ...publicUser(u), isOnline: isOnline(u.userId) });
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
  save();
  res.json({ token: signToken(id), user: publicUser(user) });
});

app.post('/api/login', rateLimit(10, 60_000), (req, res) => {
  const { userId, password } = req.body ?? {};
  if (typeof userId !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  const user = data.users[userId.trim().toUpperCase()];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid User ID or password' });
  }
  res.json({ token: signToken(user.userId), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (_req, res) => {
  res.json({ user: publicUser(res.locals.user as User) });
});

app.get('/api/friends', requireAuth, (_req, res) => {
  const me = res.locals.user as User;
  res.json({ friends: me.friends.map(id => data.users[id]).filter(Boolean).map(friendView) });
});

app.post('/api/friends', requireAuth, (req, res) => {
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
  res.json({ friend: friendView(target) });
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
  if (!uid || !data.users[uid]) return next(new Error('unauthorized'));
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
      if (!areFriends(userId, recipientId)) return reply({ ok: false, error: 'Not a friend' });      if (!isOnline(recipientId)) return reply({ ok: false, error: `${data.users[recipientId].name} is offline` });
      if (userRoom.has(recipientId)) return reply({ ok: false, error: `${data.users[recipientId].name} is busy` });
      if (calls.has(roomId)) return reply({ ok: false, error: 'Invalid call' });

      calls.set(roomId, { callerId: userId, calleeId: recipientId });
      setTimeout(() => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room || room.size === 0) calls.delete(roomId);
      }, 120_000).unref();

      io.to(`user:${recipientId}`).emit('incoming-call', {
        roomId,
        callerId: userId,
        callerName: me.name,
        type: type === 'audio' ? 'audio' : 'video'
      });
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
      const peers = room ? Array.from(room) : [];
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
  app.use('/api', mediaRouter({ io, requireAuth, areFriends, isOnline }));

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
