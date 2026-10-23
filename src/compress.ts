/**
 * In-browser compression, run before anything is uploaded so only the small version is stored.
 *  - Images: resized to at most 1280 px and re-encoded as WebP (JPEG where WebP is unavailable).
 *  - Video: re-encoded to H.264/AAC MP4 at up to 720p with a bitrate tuned to the resolution.
 *  - Audio: re-encoded to mono AAC at 64 kbps.
 * Video/audio use WebCodecs through Mediabunny, which is loaded only when needed.
 */

export type ProgressCb = (p: number) => void;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

const IMAGE_MAX_SIDE = 1280;
const IMAGE_TARGET_BYTES = 250 * 1024;
const VIDEO_SHORT_SIDE = 720;

export class UnsupportedMediaError extends Error {}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
}

export async function compressImage(file: File): Promise<Blob> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file); // applies EXIF rotation
  } catch {
    throw new UnsupportedMediaError('This image format is not supported. Try a JPG, PNG or WebP photo.');
  }

  let best: Blob | null = null;
  try {
    for (const side of [IMAGE_MAX_SIDE, 1080, 900]) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.8, 0.7, 0.6, 0.5]) {
        let blob = await canvasBlob(canvas, 'image/webp', quality);
        if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', quality);
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= IMAGE_TARGET_BYTES) return blob;
      }
      if (scale === 1) break; // already smaller than this step, shrinking further is pointless
    }
  } finally {
    bmp.close();
  }
  if (!best) throw new UnsupportedMediaError('Could not process the photo');
  // Never return something bigger than what the user picked.
  return best.size < file.size || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? best : file;
}

function readVideoMeta(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = () => URL.revokeObjectURL(url);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => {
      done();
      resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    };
    v.onerror = () => {
      done();
      reject(new UnsupportedMediaError('Could not read this video. Try an MP4 file.'));
    };
    v.src = url;
  });
}

export async function mediaDuration(file: File): Promise<number> {
  if (file.type.startsWith('audio/')) {
    return new Promise((resolve, reject) => {
      const a = document.createElement('audio');
      const url = URL.createObjectURL(file);
      a.preload = 'metadata';
      a.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(a.duration);
      };
      a.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new UnsupportedMediaError('Could not read this audio file.'));
      };
      a.src = url;
    });
  }
  return (await readVideoMeta(file)).duration;
}

/** Choose a bitrate that looks clean at the output size without wasting space. */
export function videoBitrateFor(width: number, height: number): number {
  const bits = width * height * 30 * 0.055; // about 0.055 bits per pixel per frame at 30 fps
  return Math.round(Math.min(2_000_000, Math.max(600_000, bits)));
}

/**
 * Re-encode a video to MP4 (H.264 + AAC), max 720p on the short side.
 * Returns the original file when compression is not possible or would not make it smaller.
 */
export async function compressVideo(file: File, onProgress?: ProgressCb): Promise<{ blob: Blob; mime: string; compressed: boolean }> {
  const original = { blob: file as Blob, mime: file.type, compressed: false };
  try {
    const meta = await readVideoMeta(file);
    const scale = Math.min(1, VIDEO_SHORT_SIDE / Math.min(meta.width, meta.height));
    const width = even(meta.width * scale);
    const height = even(meta.height * scale);

    const mb = await import('mediabunny');
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });

    const aacOk = await mb.canEncodeAudio('aac').catch(() => false);
    const conversion = await mb.Conversion.init({
      input,
      output,
      video: { width, height, fit: 'contain', codec: 'avc', quality: new mb.Quality({ bitrate: videoBitrateFor(width, height) }) },
      audio: { ...(aacOk ? { codec: 'aac' as const } : {}), quality: new mb.Quality({ bitrate: 96_000 }) }
    });
    if (!conversion.isValid) throw new UnsupportedMediaError('This browser cannot compress this video');

    conversion.onProgress = p => onProgress?.(Math.min(1, p));
    await conversion.execute();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('No output');
    const blob = new Blob([buffer], { type: 'video/mp4' });
    onProgress?.(1);
    if (blob.size >= file.size && ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) return original;
    return { blob, mime: 'video/mp4', compressed: true };
  } catch (e) {
    console.warn('Video compression failed, using the original file', e);
    return original;
  }
}

/** Re-encode audio to small mono AAC (m4a). Falls back to the original. */
export async function compressAudio(file: File, onProgress?: ProgressCb): Promise<{ blob: Blob; mime: string; compressed: boolean }> {
  const original = { blob: file as Blob, mime: file.type, compressed: false };
  try {
    const mb = await import('mediabunny');
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
    const aacOk = await mb.canEncodeAudio('aac').catch(() => false);
    const conversion = await mb.Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: { ...(aacOk ? { codec: 'aac' as const } : {}), numberOfChannels: 1, quality: new mb.Quality({ bitrate: 64_000 }) }
    });
    if (!conversion.isValid) throw new UnsupportedMediaError('This browser cannot compress this audio');
    conversion.onProgress = p => onProgress?.(Math.min(1, p));
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('No output');
    const blob = new Blob([buffer], { type: 'audio/mp4' });
    onProgress?.(1);
    if (blob.size >= file.size && ['audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/ogg'].includes(file.type)) return original;
    return { blob, mime: 'audio/mp4', compressed: true };
  } catch (e) {
    console.warn('Audio compression failed, using the original file', e);
    return original;
  }
}
