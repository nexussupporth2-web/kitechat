import { data, save, type User } from './store.ts';
import { r2Enabled, signGet, remove } from './r2.ts';

/**
 * Automatic adult-content check (Sightengine). Set SIGHTENGINE_USER and SIGHTENGINE_SECRET in Render.
 * Without them nothing can be scanned, so the public Kite Network stays switched off.
 */
const API_USER = process.env.SIGHTENGINE_USER?.trim() ?? '';
const API_SECRET = process.env.SIGHTENGINE_SECRET?.trim() ?? '';
export const moderationEnabled = !!(API_USER && API_SECRET);

/** Chance (0-1) above which we treat a picture as adult. Lower = stricter. */
const HARD = 0.6; // sexual activity, sexual display, erotica
const SOFT = 0.8; // very suggestive

interface Nudity {
  sexual_activity?: number;
  sexual_display?: number;
  erotica?: number;
  very_suggestive?: number;
}

const bad = (n?: Nudity) =>
  !!n && ((n.sexual_activity ?? 0) >= HARD || (n.sexual_display ?? 0) >= HARD || (n.erotica ?? 0) >= HARD || (n.very_suggestive ?? 0) >= SOFT);

const ADMIN = (process.env.ADMIN_ID || 'KITE_ADMIN').trim().toUpperCase();

/**
 * Is this person's profile really public right now? They chose Public, the adult-content check is switched on,
 * and the account is older than 24 hours (the admin is exempt from the 24 hours).
 */
export const profilePublic = (u: User | undefined) =>
  !!u && u.profileType === 'public' && moderationEnabled && (u.userId === ADMIN || Date.now() - u.createdAt >= 24 * 60 * 60 * 1000);

export type ScanResult = 'clean' | 'adult' | 'error';

/** Looks at the uploaded file in storage. Photos are checked by link, videos by frames. */
export async function scanMedia(key: string, mime: string): Promise<ScanResult> {
  if (!moderationEnabled || !r2Enabled) return 'error';
  try {
    const url = await signGet(key, { expiresIn: 600 });
    if (mime.startsWith('image/')) {
      const q = new URLSearchParams({ models: 'nudity-2.0', api_user: API_USER, api_secret: API_SECRET, url });
      const r = await fetch(`https://api.sightengine.com/1.0/check.json?${q}`, { signal: AbortSignal.timeout(20_000) });
      const j = (await r.json()) as { status?: string; nudity?: Nudity };
      if (j.status !== 'success') return 'error';
      return bad(j.nudity) ? 'adult' : 'clean';
    }
    if (mime.startsWith('video/')) {
      const f = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!f.ok) return 'error';
      const form = new FormData();
      form.append('media', new Blob([await f.arrayBuffer()], { type: mime }), 'video');
      form.append('models', 'nudity-2.0');
      form.append('api_user', API_USER);
      form.append('api_secret', API_SECRET);
      const r = await fetch('https://api.sightengine.com/1.0/video/check-sync.json', { method: 'POST', body: form, signal: AbortSignal.timeout(90_000) });
      const j = (await r.json()) as { status?: string; data?: { frames?: { nudity?: Nudity }[] } };
      if (j.status !== 'success') return 'error';
      return (j.data?.frames ?? []).some(fr => bad(fr.nudity)) ? 'adult' : 'clean';
    }
    return 'clean';
  } catch (e) {
    console.error('scan failed', e);
    return 'error';
  }
}

export interface Verdict {
  ok: boolean;
  status?: number;
  error?: string;
  blocked?: boolean;
}

/**
 * Checks a freshly uploaded file. If it is adult content the file is deleted immediately,
 * the uploader gets a final warning (first time) or is blocked (next time).
 * Audio and other types pass. If the scanner is down the upload is refused (and deleted), with no strike.
 */
export async function checkUpload(user: User, key: string, mime: string, where: string): Promise<Verdict> {
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) return { ok: true };
  if (!moderationEnabled) return { ok: true };
  const result = await scanMedia(key, mime);
  if (result === 'clean') return { ok: true };
  await remove(key).catch(() => {});
  if (result === 'error') return { ok: false, status: 503, error: 'We could not check this file right now. Please try again in a minute.' };

  user.strikes = [...(user.strikes ?? []), { at: Date.now(), where }];
  if (user.strikes.length >= 2) {
    user.blocked = true;
    save();
    return { ok: false, status: 403, blocked: true, error: 'That file was removed. Adult content is not allowed on Kite, so your account has been blocked.' };
  }
  save();
  return { ok: false, status: 422, error: 'That file was removed because adult content is not allowed on Kite. FINAL WARNING: the next time, your account will be blocked.' };
}

export const blockedMessage = 'Your account has been blocked for breaking the no adult content rule. You can send an appeal.';

export function listBlocked() {
  return Object.values(data.users)
    .filter(u => u.blocked)
    .map(u => ({ userId: u.userId, name: u.name, strikes: u.strikes ?? [], appeal: u.appeal ?? null }));
}
