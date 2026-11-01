import { api } from './api.ts';
import { startRingtone } from './ringtone.ts';

/** Notifications and sounds. System notifications use the phone's own default notification sound. */

let reg: ServiceWorkerRegistration | null = null;
let ctx: AudioContext | null = null;

export const notificationsSupported = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
export const notificationState = (): NotificationPermission | 'unsupported' =>
  notificationsSupported() ? Notification.permission : 'unsupported';

export async function registerSW(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    reg = await navigator.serviceWorker.register('/sw.js');
  } catch {
    /* ignore */
  }
}

function keyToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Registers this phone with the server so it can get notifications (messages, calls) even when the app is closed.
 * Safe to call again and again.
 */
export async function subscribePush(): Promise<void> {
  if (!notificationsSupported() || !('PushManager' in window) || Notification.permission !== 'granted') return;
  try {
    const { key } = await api<{ key: string | null }>('/api/push/key');
    if (!key) return; // the server has no notification keys set up
    await registerSW();
    const r = reg ?? (await navigator.serviceWorker.ready);
    const sub = (await r.pushManager.getSubscription()) ?? (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) }));
    await api('/api/push/subscribe', { subscription: sub.toJSON() });
  } catch {
    /* notifications for a closed app just stay off */
  }
}

/** Must be called from a tap. */
export async function enableNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    await registerSW();
    void subscribePush();
  }
  return result;
}

/** Shows a system notification, only when the app is not on screen. */
export async function notify(title: string, body: string, tag: string, urgent = false): Promise<void> {
  if (!document.hidden || notificationState() !== 'granted') return;
  try {
    const r = reg ?? (await navigator.serviceWorker.ready);
    await r.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: urgent,
      vibrate: urgent ? [400, 200, 400, 200, 400] : [200, 100, 200],
      silent: false
    } as NotificationOptions);
  } catch {
    /* ignore */
  }
}

// ----- in-app sounds (used while the app is open on screen) -----

function audio(): AudioContext | null {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Browsers only allow sound after a tap; unlock on the first one. */
export function unlockAudioOnFirstTap() {
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
}

function tone(freq: number, start: number, dur: number, vol = 0.25) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(vol, a.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.05);
}

/** The new-message sound (public/notification.mp3). Falls back to two soft beeps if the browser blocks the file. */
export function playMessageSound() {
  let played = false;
  try {
    const a = new Audio('/notification.mp3');
    a.volume = 1;
    void a.play().then(
      () => {
        played = true;
      },
      () => {
        if (!played) {
          tone(880, 0, 0.18);
          tone(1320, 0.12, 0.25);
        }
      }
    );
  } catch {
    tone(880, 0, 0.18);
    tone(1320, 0.12, 0.25);
  }
  try {
    navigator.vibrate?.(120);
  } catch {
    /* ignore */
  }
}

let stopRingtone: (() => void) | null = null;

/** Rings for an incoming call with the call ringtone (public/ringtone.mp3) and a vibration, until stopRinging(). */
export function startRinging() {
  if (stopRingtone) return;
  stopRingtone = startRingtone(1, true);
}

export function stopRinging() {
  stopRingtone?.();
  stopRingtone = null;
}
