// The call ringtone (public/ringtone.mp3). Plays in a loop until stopped.
// Browsers only allow sound after the person has tapped something on the page; if it is blocked, a vibration is used instead.

/** Starts the ringtone and returns a function that stops it. `vibrate` is for the phone that is being called. */
export function startRingtone(volume = 1, vibrate = false): () => void {
  let audio: HTMLAudioElement | null = null;
  let vibTimer: ReturnType<typeof setInterval> | null = null;
  try {
    audio = new Audio('/ringtone.mp3');
    audio.loop = true;
    audio.volume = Math.max(0, Math.min(1, volume));
    void audio.play().catch(() => {
      /* blocked until the person taps the page: the vibration below still tells them */
    });
  } catch {
    audio = null;
  }
  if (vibrate && typeof navigator.vibrate === 'function') {
    const buzz = () => navigator.vibrate([400, 200, 400, 200, 400]);
    buzz();
    vibTimer = setInterval(buzz, 3000);
  }
  return () => {
    if (vibTimer) clearInterval(vibTimer);
    if (typeof navigator.vibrate === 'function') navigator.vibrate(0);
    if (audio) {
      audio.pause();
      audio.src = '';
    }
  };
}
