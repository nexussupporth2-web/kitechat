/* eslint-disable @typescript-eslint/no-explicit-any */
// Web Push for a closed app (messages and incoming calls), written for Cloudflare Workers with no extra packages.
// Standards used: VAPID (RFC 8292) to prove who we are, and aes128gcm message encryption (RFC 8291 / RFC 8188).

const enc = new TextEncoder();

export const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string): Uint8Array => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export interface Vapid {
  /** Public key, 65 bytes, base64url. The phones need this. */
  pub: string;
  /** Private key as a JWK. */
  priv: JsonWebKey;
}

/** Makes a fresh key pair (done once; the server keeps it). */
export async function makeVapid(): Promise<Vapid> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const priv = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { pub: b64u(pub), priv };
}

async function vapidHeader(endpoint: string, v: Vapid, subject: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.pub}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

/** Encrypts the message for one phone (RFC 8291). */
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPub = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const eph = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPub = new Uint8Array((await crypto.subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one notification. Returns 'gone' when the phone no longer wants them (so the caller removes it). */
export async function sendWebPush(sub: PushSub, message: unknown, v: Vapid, subject: string, opts: { ttl?: number; urgent?: boolean } = {}): Promise<'ok' | 'gone' | 'error'> {
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub.keys.p256dh, sub.keys.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(sub.endpoint, v, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl ?? 60),
        Urgency: opts.urgent ? 'high' : 'normal'
      },
      body
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}
