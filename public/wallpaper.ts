import { api, uploadToStorage } from './api.ts';

/** Shown when nobody has picked a wallpaper yet (file lives in the public folder). */
export const DEFAULT_WALLPAPER = '/wallpaper-kites.jpg';

const MAX_BYTES = 900 * 1024;

/** Shrink a photo so it is light to store and quick to load on a phone. */
async function compressWallpaper(file: File): Promise<Blob> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('This image format is not supported. Try a JPG, PNG or WebP photo.');
  }
  try {
    let best: Blob | null = null;
    for (const side of [1280, 1000, 800]) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      for (const q of [0.75, 0.65, 0.55]) {
        const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', q));
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= MAX_BYTES) return blob;
      }
    }
    if (best && best.size <= 1024 * 1024) return best;
    throw new Error('This picture is too big. Please choose a smaller one.');
  } finally {
    bmp.close();
  }
}

export async function setMyWallpaper(file: File): Promise<void> {
  const blob = await compressWallpaper(file);
  const s = await api<{ key: string; uploadUrl: string }>('/api/media/sign', { kind: 'wallpaper', mime: 'image/jpeg', size: blob.size });
  await uploadToStorage(s.uploadUrl, blob, 'image/jpeg');
  await api('/api/wallpaper', { key: s.key });
}

export const resetMyWallpaper = () => api('/api/wallpaper', undefined, 'DELETE');

/** The picture to show in the chat with this friend (the most recently changed one), or the default. */
export async function loadChatWallpaper(friendId: string): Promise<string> {
  try {
    const r = await api<{ url: string | null }>(`/api/wallpaper/${encodeURIComponent(friendId)}`);
    return r.url || DEFAULT_WALLPAPER;
  } catch {
    return DEFAULT_WALLPAPER;
  }
}
