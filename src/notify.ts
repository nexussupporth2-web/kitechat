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

/** Must be called from a tap. */
export async function enableNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') await registerSW();
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

export function playMessageSound() {
  tone(880, 0, 0.18);
  tone(1320, 0.12, 0.25);
  try {
    navigator.vibrate?.(120);
  } catch {
    /* ignore */
  }
}

let ringTimer: ReturnType<typeof setInterval> | null = null;

export function startRinging() {
  if (ringTimer) return;
  const ring = () => {
    tone(740, 0, 0.35, 0.3);
    tone(988, 0.4, 0.35, 0.3);
    try {
      navigator.vibrate?.([300, 150, 300]);
    } catch {
      /* ignore */
    }
  };
  ring();
  ringTimer = setInterval(ring, 2000);
}

export function stopRinging() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
  try {
    navigator.vibrate?.(0);
  } catch {
    /* ignore */
  }
}
