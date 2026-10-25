import webpush from 'web-push';
import { save, type User } from './store.ts';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

/** True when the two VAPID keys are set. Without them the app works as before, just without closed-app notifications. */
export const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
export const vapidPublicKey = VAPID_PUBLIC_KEY ?? null;

if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT || 'https://kitechat.onrender.com', VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

export interface PushPayload {
  kind: 'message' | 'call';
  title: string;
  body: string;
  tag: string;
}

export const canPush = (u: User | undefined) => pushEnabled && !!u?.pushSubs?.length;

/** Sends a notification to every device the user has allowed notifications on. Dead devices are forgotten. */
export async function sendPush(user: User | undefined, payload: PushPayload): Promise<void> {
  if (!pushEnabled || !user?.pushSubs?.length) return;
  const urgent = payload.kind === 'call';
  const dead = new Set<string>();
  await Promise.all(
    user.pushSubs.map(async sub => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: urgent ? 60 : 24 * 3600, urgency: urgent ? 'high' : 'normal' });
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) dead.add(sub.endpoint);
        else console.error('push failed', e?.statusCode ?? e?.message ?? e);
      }
    })
  );
  if (dead.size) {
    user.pushSubs = user.pushSubs.filter(s => !dead.has(s.endpoint));
    save();
  }
}
