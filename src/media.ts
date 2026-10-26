import { api, uploadToStorage } from './api.ts';
import { compressAudio, compressImage, compressVideo, mediaDuration } from './compress.ts';
import type { FeedPost } from './types.ts';

interface SignResponse {
  key: string;
  uploadUrl: string;
}

export interface MediaConfig {
  enabled: boolean;
  limits: {
    story: { imageBytes: number; videoBytes: number; audioBytes: number; maxMediaSec: number; ttlMs: number };
    reel: { videoBytes: number; maxVideoSec: number };
    share: { bytes: number; mediaOriginalBytes: number };
    quotaBytes: number;
  };
}

export type Phase = 'compressing' | 'uploading';
export type ProgressFn = (phase: Phase, p: number) => void;

export const phaseLabel = (phase: Phase) => (phase === 'compressing' ? 'Optimizing' : 'Uploading');

interface Prepared {
  blob: Blob;
  mime: string;
}

/** Compress any image/video/audio. Other file types are returned untouched. */
async function prepare(file: File, onProgress: ProgressFn): Promise<Prepared> {
  const type = file.type;
  if (type.startsWith('image/')) {
    onProgress('compressing', 0);
    const blob = await compressImage(file);
    onProgress('compressing', 1);
    return { blob, mime: blob.type || type };
  }
  if (type.startsWith('video/')) {
    const r = await compressVideo(file, p => onProgress('compressing', p));
    return { blob: r.blob, mime: r.mime };
  }
  if (type.startsWith('audio/')) {
    const r = await compressAudio(file, p => onProgress('compressing', p));
    return { blob: r.blob, mime: r.mime };
  }
  return { blob: file, mime: type || 'application/octet-stream' };
}

const isMedia = (f: File) => /^(image|video|audio)\//.test(f.type);
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Send a file to a friend. Photos, videos and audio are compressed first; it is held in storage only until downloaded. */
export async function sendFileToFriend(file: File, recipientId: string, cfg: MediaConfig, onProgress: ProgressFn) {
  const limit = isMedia(file) ? cfg.limits.share.mediaOriginalBytes : cfg.limits.share.bytes;
  if (file.size > limit) throw new Error(`This file is too large. The limit is ${mb(limit)}.`);

  const { blob, mime } = await prepare(file, onProgress);
  if (blob.size > cfg.limits.share.bytes) throw new Error(`Still too large after compression (limit ${mb(cfg.limits.share.bytes)}).`);

  const name = blob === file ? file.name : file.name.replace(/\.[^.]+$/, '') + extensionFor(mime, file.name);
  const s = await api<SignResponse>('/api/media/sign', { kind: 'share', mime, size: blob.size, name, recipientId });
  await uploadToStorage(s.uploadUrl, blob, mime, p => onProgress('uploading', p));
  await api('/api/shares', { key: s.key, recipientId, name });
}

function extensionFor(mime: string, fallbackName: string) {
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'audio/mp4') return '.m4a';
  const m = fallbackName.match(/\.[^.]+$/);
  return m ? m[0] : '';
}

/** Download a shared file, save it to the device, then tell the server to delete it from storage. */
export async function downloadSharedFile(id: string) {
  const { url, name } = await api<{ url: string; name: string }>(`/api/shares/${id}/url`);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  await api(`/api/shares/${id}/done`, {});
}

/** Validate, compress, upload and publish a story/status or reel. */
export async function publishPost(kind: 'story' | 'reel' | 'album', file: File, caption: string, cfg: MediaConfig, onProgress: ProgressFn, visibility?: 'public' | 'friends') {
  const isImage = file.type.startsWith('image/');
  const isAudio = file.type.startsWith('audio/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isAudio && !isVideo) throw new Error('Choose a photo, video or audio file');
  if (kind === 'reel' && !isVideo) throw new Error('Reels must be a video');
  if (kind === 'album' && isAudio) throw new Error('Album items can be a photo or a video');
  if (file.size > cfg.limits.share.mediaOriginalBytes) throw new Error(`This file is too large. The limit is ${mb(cfg.limits.share.mediaOriginalBytes)}.`);

  if (isVideo || isAudio) {
    const maxSec = kind === 'story' ? cfg.limits.story.maxMediaSec : cfg.limits.reel.maxVideoSec;
    const dur = await mediaDuration(file);
    if (dur > maxSec + 0.5) throw new Error(`Too long. ${kind === 'story' ? 'Statuses' : kind === 'album' ? 'Album videos' : 'Reels'} can be up to ${maxSec} seconds.`);
  }

  const { blob, mime } = await prepare(file, onProgress);
  const s = await api<SignResponse>('/api/media/sign', { kind, mime, size: blob.size });
  await uploadToStorage(s.uploadUrl, blob, mime, p => onProgress('uploading', p));
  await api('/api/posts', { key: s.key, caption, visibility });
}

/** Publish a photo or video to the Kite Network. The server checks it for adult content before it appears. */
export async function publishNetwork(file: File, caption: string, visibility: 'public' | 'friends', onProgress: ProgressFn) {
  const isVideo = file.type.startsWith('video/');
  if (!file.type.startsWith('image/') && !isVideo) throw new Error('Choose a photo or a video');
  if (file.size > 100 * 1024 * 1024) throw new Error('This file is too large (limit 100 MB).');
  if (isVideo) {
    const dur = await mediaDuration(file);
    if (dur > 30.5) throw new Error('Videos can be up to 30 seconds.');
  }
  const { blob, mime } = await prepare(file, onProgress);
  const s = await api<SignResponse>('/api/media/sign', { kind: 'network', mime, size: blob.size });
  await uploadToStorage(s.uploadUrl, blob, mime, p => onProgress('uploading', p));
  await api('/api/network/posts', { key: s.key, caption, visibility });
}

export async function loadFeed() {
  return api<{ posts: FeedPost[]; usedBytes: number; quotaBytes: number }>('/api/feed');
}

export function deletePost(id: string) {
  return api(`/api/posts/${id}`, undefined, 'DELETE');
}
