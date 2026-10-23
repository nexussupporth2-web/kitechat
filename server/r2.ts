import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;

/** True when all four R2 settings are present. Without them the app runs without media and uses a local data file. */
export const r2Enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

const client = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
      // R2 rejects the newer default checksum headers on presigned URLs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })
  : null;

function c(): S3Client {
  if (!client) throw new Error('R2 is not configured');
  return client;
}

export async function putText(key: string, body: string): Promise<void> {
  await c().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
}

export async function getText(key: string): Promise<string | null> {
  try {
    const res = await c().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return (await res.Body?.transformToString()) ?? null;
  } catch (e: any) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Presigned upload URL. Size and type are signed, so the upload must match what was validated. */
export function signPut(key: string, contentType: string, contentLength: number, expiresIn = 900): Promise<string> {
  return getSignedUrl(
    c(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType, ContentLength: contentLength }),
    { expiresIn }
  );
}

export function signGet(key: string, opts: { expiresIn?: number; downloadName?: string } = {}): Promise<string> {
  return getSignedUrl(
    c(),
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ResponseContentDisposition: opts.downloadName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`
        : undefined
    }),
    { expiresIn: opts.expiresIn ?? 3600 }
  );
}

export async function head(key: string): Promise<{ size: number; type: string } | null> {
  try {
    const res = await c().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { size: res.ContentLength ?? 0, type: res.ContentType ?? '' };
  } catch (e: any) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function remove(key: string): Promise<void> {
  await c().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  }
