/* eslint-disable @typescript-eslint/no-explicit-any */
// File storage on Cloudflare R2.
// Reading, deleting and checking files use the bucket directly. Signed upload / download links
// (used by phones to talk to R2 straight) are made with the R2 access keys.
import { ENV, BUCKET } from './runtime.ts';

/** True when the bucket and the three R2 settings are present. */
export let r2Enabled = false;

export function initR2() {
  r2Enabled = !!(BUCKET && ENV.R2_ACCOUNT_ID && ENV.R2_ACCESS_KEY_ID && ENV.R2_SECRET_ACCESS_KEY);
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
const uriEnc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** AWS Signature V4 "presigned URL" for the R2 S3 endpoint. */
async function presign(method: 'GET' | 'PUT', key: string, expires: number, extraQuery: Record<string, string>, signed: Record<string, string>) {
  const bucket = ENV.R2_BUCKET || 'kitechat';
  const host = `${ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const headers: Record<string, string> = { host, ...signed };
  const names = Object.keys(headers).sort();
  const signedNames = names.join(';');
  const q: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ENV.R2_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedNames,
    ...extraQuery
  };
  const qs = Object.keys(q)
    .sort()
    .map(k => `${uriEnc(k)}=${uriEnc(q[k])}`)
    .join('&');
  const path = '/' + [bucket, ...key.split('/')].map(uriEnc).join('/');
  const canonical = [method, path, qs, names.map(n => `${n}:${headers[n]}\n`).join(''), signedNames, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256hex(canonical)].join('\n');
  const kDate = await hmac(enc.encode('AWS4' + ENV.R2_SECRET_ACCESS_KEY), date);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig = hex(await hmac(kSigning, toSign));
  return `https://${host}${path}?${qs}&X-Amz-Signature=${sig}`;
}

export async function putText(key: string, body: string): Promise<void> {
  await BUCKET.put(key, body, { httpMetadata: { contentType: 'application/json' } });
}

export async function getText(key: string): Promise<string | null> {
  const o = await BUCKET.get(key);
  return o ? await o.text() : null;
}

/** Signed upload link. Size and type are signed, so the upload must match what was validated. */
export function signPut(key: string, contentType: string, contentLength: number, expiresIn = 900): Promise<string> {
  return presign('PUT', key, expiresIn, {}, { 'content-length': String(contentLength), 'content-type': contentType });
}

export function signGet(key: string, opts: { expiresIn?: number; downloadName?: string } = {}): Promise<string> {
  const extra: Record<string, string> = {};
  if (opts.downloadName) extra['response-content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`;
  return presign('GET', key, opts.expiresIn ?? 3600, extra, {});
}

export async function head(key: string): Promise<{ size: number; type: string } | null> {
  const o = await BUCKET.head(key);
  return o ? { size: o.size ?? 0, type: o.httpMetadata?.contentType ?? '' } : null;
}

export async function remove(key: string): Promise<void> {
  await BUCKET.delete(key);
}
