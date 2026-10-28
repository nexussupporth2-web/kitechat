// KiteChat on Cloudflare, phase 1: sign-up and sign-in only.
// Data lives in a Durable Object (its own SQLite), so it is completely separate from Render's data.
/* eslint-disable @typescript-eslint/no-explicit-any */

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return b64(bits);
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

export async function signToken(secret: string, uid: string) {
  const payload = b64(enc.encode(JSON.stringify({ uid, exp: Date.now() + 30 * 24 * 3600 * 1000 })));
  return `${payload}.${await hmac(secret, payload)}`;
}

export class Hub {
  state: any;
  env: any;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
    state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, salt TEXT, hash TEXT, created INTEGER)`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sql = this.state.storage.sql;
    const secret: string = this.env.AUTH_SECRET;
    if (!secret) return json({ error: 'AUTH_SECRET is not set on the server' }, 500);
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const body: any = await req.json().catch(() => ({}));
    const { userId, password, name } = body;
    if (typeof userId !== 'string' || typeof password !== 'string') return json({ error: 'Missing required fields' }, 400);
    const id = userId.trim().toUpperCase();
    const view = (r: { id: string; name: string; avatar: string }) => ({
      userId: r.id, name: r.name, avatar: r.avatar, isAdmin: r.id === (this.env.ADMIN_ID || 'KITE_ADMIN').toUpperCase()
    });

    if (url.pathname === '/api/register') {
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (!/^[A-Z0-9_]{3,20}$/.test(id)) return json({ error: 'User ID must be 3-20 letters, numbers or underscores' }, 400);
      if (password.length < 6 || password.length > 128) return json({ error: 'Password must be 6-128 characters' }, 400);
      if (cleanName.length < 1 || cleanName.length > 40) return json({ error: 'Name must be 1-40 characters' }, 400);
      if ([...sql.exec('SELECT id FROM users WHERE id = ?', id)].length) return json({ error: 'User ID already exists' }, 409);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const row = { id, name: cleanName, avatar: cleanName.charAt(0).toUpperCase() };
      sql.exec('INSERT INTO users VALUES (?,?,?,?,?,?)', id, row.name, row.avatar, b64(salt), await hashPassword(password, salt), Date.now());
      return json({ token: await signToken(secret, id), user: view(row) });
    }

    if (url.pathname === '/api/login') {
      const rows = [...sql.exec('SELECT * FROM users WHERE id = ?', id)] as any[];
      const r = rows[0];
      if (!r || (await hashPassword(password, unb64(r.salt))) !== r.hash) return json({ error: 'Invalid user ID or password' }, 401);
      return json({ token: await signToken(secret, id), user: view(r) });
    }
    return json({ error: 'Not found' }, 404);
  }
}

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return json({ ok: true, platform: 'cloudflare' });
    if (url.pathname === '/api/register' || url.pathname === '/api/login') {
      return env.HUB.get(env.HUB.idFromName('main')).fetch(req);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not available in the test copy yet' }, 501);
    return env.ASSETS.fetch(req);
  }
};
