import { Router, type RequestHandler } from './express-shim.ts';
import { data, save, type User } from './store.ts';

interface Deps {
  io: { to(room: string): any };
  requireAuth: RequestHandler;
  friendView: (u: User) => object;
  photoUrl: (u: User) => Promise<string | null>;
}

/** Friend requests: ask, accept, decline, cancel. Both people become friends only after the other one accepts. */
export function friendsRouter({ io, requireAuth, friendView, photoUrl }: Deps) {
  const router = Router();

  const hits = new Map<string, number[]>();
  const tooFast = (userId: string, max = 15) => {
    const now = Date.now();
    const list = (hits.get(userId) ?? []).filter(t => now - t < 60_000);
    list.push(now);
    hits.set(userId, list);
    return list.length > max;
  };

  const card = async (u: User) => ({ userId: u.userId, name: u.name, avatar: u.avatar, photoUrl: await photoUrl(u) });
  const without = (list: string[] | undefined, id: string) => (list ?? []).filter(x => x !== id);
  /** Forget requests from people who no longer exist or are already friends. */
  const tidy = (u: User) => {
    u.reqIn = (u.reqIn ?? []).filter(id => data.users[id] && !u.friends.includes(id));
    u.reqOut = (u.reqOut ?? []).filter(id => data.users[id] && !u.friends.includes(id));
  };

  async function makeFriends(me: User, other: User) {
    if (!me.friends.includes(other.userId)) me.friends.push(other.userId);
    if (!other.friends.includes(me.userId)) other.friends.push(me.userId);
    me.reqIn = without(me.reqIn, other.userId);
    me.reqOut = without(me.reqOut, other.userId);
    other.reqIn = without(other.reqIn, me.userId);
    other.reqOut = without(other.reqOut, me.userId);
    save();
    io.to(`user:${other.userId}`).emit('friend-added', { ...friendView(me), photoUrl: await photoUrl(me) });
    return { ...friendView(other), photoUrl: await photoUrl(other) };
  }

  router.get('/friends/requests', requireAuth, async (_req: any, res: any) => {
    const me = res.locals.user as User;
    tidy(me);
    const incoming = await Promise.all((me.reqIn ?? []).map(id => card(data.users[id])));
    res.json({ incoming, outgoing: me.reqOut ?? [] });
  });

  router.post('/friends/request', requireAuth, async (req: any, res: any) => {
    const me = res.locals.user as User;
    const id = typeof req.body?.userId === 'string' ? req.body.userId.trim().toUpperCase() : '';
    const target = data.users[id];
    if (!target || target.blocked) return res.status(404).json({ error: 'No user with that ID' });
    if (target.userId === me.userId) return res.status(400).json({ error: 'You cannot add yourself' });
    if (me.friends.includes(target.userId)) return res.status(400).json({ error: 'Already friends' });
    if (tooFast(me.userId)) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    // They already asked me: asking back means yes.
    if ((me.reqIn ?? []).includes(target.userId)) {
      const friend = await makeFriends(me, target);
      return res.json({ state: 'friends', friend });
    }
    if ((me.reqOut ?? []).includes(target.userId)) return res.json({ state: 'sent' });
    if ((me.reqOut ?? []).length >= 50) return res.status(400).json({ error: 'You have too many requests waiting. Wait for some to be answered.' });
    me.reqOut = [...(me.reqOut ?? []), target.userId];
    target.reqIn = [...(target.reqIn ?? []), me.userId];
    save();
    io.to(`user:${target.userId}`).emit('friend-request', await card(me));
    res.json({ state: 'sent' });
  });

  router.post('/friends/respond', requireAuth, async (req: any, res: any) => {
    const me = res.locals.user as User;
    const id = typeof req.body?.userId === 'string' ? req.body.userId.trim().toUpperCase() : '';
    const other = data.users[id];
    if (!other || !(me.reqIn ?? []).includes(other.userId)) return res.status(404).json({ error: 'That request is no longer there' });
    if (req.body?.accept) {
      const friend = await makeFriends(me, other);
      return res.json({ ok: true, friend });
    }
    me.reqIn = without(me.reqIn, other.userId);
    other.reqOut = without(other.reqOut, me.userId);
    save();
    res.json({ ok: true });
  });

  router.post('/friends/cancel', requireAuth, (req: any, res: any) => {
    const me = res.locals.user as User;
    const id = typeof req.body?.userId === 'string' ? req.body.userId.trim().toUpperCase() : '';
    const other = data.users[id];
    me.reqOut = without(me.reqOut, id);
    if (other) other.reqIn = without(other.reqIn, me.userId);
    save();
    res.json({ ok: true });
  });

  return router;
}
