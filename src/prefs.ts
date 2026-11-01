// Personal choices kept on this phone only: tones and fonts.
// Small settings go in localStorage; your own uploaded sound or font file goes in IndexedDB (too big for localStorage).

export type SoundKind = 'ring' | 'notif';
export type SoundMode = 'default' | 'custom' | 'system';
interface SoundChoice {
  mode: SoundMode;
  /** File name of the uploaded sound, for display. */
  name?: string;
}

const SOUNDS_KEY = 'kite-sounds';
const FONT_KEY = 'kite-font';
const DEFAULT_SRC: Record<SoundKind, string> = { ring: '/ringtone.mp3', notif: '/notification.mp3' };

// ---------- tiny IndexedDB helper ----------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kite-prefs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(key: string, value: Blob | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    if (value) tx.objectStore('blobs').put(value, key);
    else tx.objectStore('blobs').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function dbGet(key: string): Promise<Blob | null> {
  const db = await openDb();
  const out = await new Promise<Blob | null>((resolve, reject) => {
    const req = db.transaction('blobs').objectStore('blobs').get(key);
    req.onsuccess = () => resolve((req.result as Blob) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

// ---------- tones ----------
function loadSounds(): Record<SoundKind, SoundChoice> {
  try {
    const s = JSON.parse(localStorage.getItem(SOUNDS_KEY) || '{}');
    return { ring: s.ring ?? { mode: 'default' }, notif: s.notif ?? { mode: 'default' } };
  } catch {
    return { ring: { mode: 'default' }, notif: { mode: 'default' } };
  }
}
let sounds = loadSounds();
const customUrl: Partial<Record<SoundKind, string>> = {};

export const getSoundChoice = (k: SoundKind): SoundChoice => sounds[k];

/** The file to play right now, or null when the phone's own sound should be used (nothing plays inside the app). */
export function soundSrc(k: SoundKind): string | null {
  const c = sounds[k];
  if (c.mode === 'system') return null;
  if (c.mode === 'custom' && customUrl[k]) return customUrl[k]!;
  return DEFAULT_SRC[k];
}

function saveSounds() {
  try {
    localStorage.setItem(SOUNDS_KEY, JSON.stringify(sounds));
  } catch {
    /* ignore */
  }
}

export function setSoundMode(k: SoundKind, mode: 'default' | 'system') {
  sounds = { ...sounds, [k]: { mode } };
  saveSounds();
}

export async function setCustomSound(k: SoundKind, file: File): Promise<void> {
  if (!file.type.startsWith('audio/')) throw new Error('Please choose an audio file (mp3, m4a, wav…).');
  if (file.size > 3 * 1024 * 1024) throw new Error('That sound is too big. Choose one under 3 MB.');
  await dbPut('sound-' + k, file);
  if (customUrl[k]) URL.revokeObjectURL(customUrl[k]!);
  customUrl[k] = URL.createObjectURL(file);
  sounds = { ...sounds, [k]: { mode: 'custom', name: file.name } };
  saveSounds();
}

// ---------- fonts ----------
export interface FontOption {
  id: string;
  name: string;
  family: string;
  /** Google Fonts name (all four are free to use, SIL Open Font Licence). */
  google?: string;
}
export const FONTS: FontOption[] = [
  { id: 'default', name: 'Default', family: '' },
  { id: 'nunito', name: 'Nunito', family: "'Nunito', sans-serif", google: 'Nunito:wght@400;600;700' },
  { id: 'lora', name: 'Lora', family: "'Lora', serif", google: 'Lora:wght@400;600;700' },
  { id: 'caveat', name: 'Caveat', family: "'Caveat', cursive", google: 'Caveat:wght@400;600;700' },
  { id: 'poppins', name: 'Poppins', family: "'Poppins', sans-serif", google: 'Poppins:wght@400;500;600' }
];
export const CUSTOM_FONT_FAMILY = "'KiteCustomFont', sans-serif";

export const currentFont = (): string => {
  try {
    return localStorage.getItem(FONT_KEY) || 'default';
  } catch {
    return 'default';
  }
};
export const customFontName = (): string => {
  try {
    return localStorage.getItem(FONT_KEY + '-name') || '';
  } catch {
    return '';
  }
};

function loadGoogleFont(f: FontOption) {
  if (!f.google) return;
  const id = 'kite-font-' + f.id;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
  document.head.appendChild(link);
}

async function registerCustomFont(blob: Blob) {
  const face = new FontFace('KiteCustomFont', await blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
}

function setFamily(family: string) {
  if (family) document.documentElement.style.setProperty('--app-font', family);
  else document.documentElement.style.removeProperty('--app-font');
}

/** Pick one of the ready-made fonts (or 'default'). */
export function applyFont(id: string) {
  const f = FONTS.find(x => x.id === id) ?? FONTS[0];
  loadGoogleFont(f);
  setFamily(f.family);
  try {
    localStorage.setItem(FONT_KEY, f.id);
  } catch {
    /* ignore */
  }
}

/** Use a font file the person uploaded. */
export async function setCustomFont(file: File): Promise<void> {
  if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('Please choose a font file ending in .ttf, .otf, .woff or .woff2.');
  if (file.size > 5 * 1024 * 1024) throw new Error('That font file is too big. Choose one under 5 MB.');
  try {
    await registerCustomFont(file);
  } catch {
    throw new Error('That file could not be used as a font.');
  }
  await dbPut('font', file);
  setFamily(CUSTOM_FONT_FAMILY);
  try {
    localStorage.setItem(FONT_KEY, 'custom');
    localStorage.setItem(FONT_KEY + '-name', file.name);
  } catch {
    /* ignore */
  }
}

/** Run once when the app starts: bring back the saved font and tones. */
export async function initPrefs(): Promise<void> {
  const font = currentFont();
  if (font === 'custom') {
    try {
      const b = await dbGet('font');
      if (b) {
        await registerCustomFont(b);
        setFamily(CUSTOM_FONT_FAMILY);
      }
    } catch {
      /* keep the default font */
    }
  } else if (font !== 'default') applyFont(font);
  for (const k of ['ring', 'notif'] as SoundKind[]) {
    if (sounds[k].mode !== 'custom') continue;
    try {
      const b = await dbGet('sound-' + k);
      if (b) customUrl[k] = URL.createObjectURL(b);
    } catch {
      /* falls back to the default tone */
    }
  }
}
