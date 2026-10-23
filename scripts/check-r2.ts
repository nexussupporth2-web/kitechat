/**
 * Checks your Cloudflare R2 settings from your own computer:
 *   npm run check:r2
 * It needs R2_* values in .env (or the environment). Nothing it writes is kept.
 */
import { r2Enabled, putText, getText, signPut, head, remove } from '../server/r2.ts';

const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    console.log(`  ok   ${label}`);
    return r;
  } catch (e: any) {
    console.error(`  FAIL ${label}: ${e?.name ?? 'Error'} ${e?.message ?? e}`);
    console.error('\nCommon causes: wrong Account ID, token not limited to this bucket, token lacks Object Read & Write, bucket name typo.');
    process.exit(1);
  }
}

if (!r2Enabled) {
  const missing = need.filter(k => !process.env[k]);
  console.error(`R2 is not configured. Missing: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`Checking bucket "${process.env.R2_BUCKET}"...`);
const key = `healthcheck/${Date.now()}.txt`;
await step('write an object', () => putText(key, 'kitechat'));
await step('read it back', async () => {
  if ((await getText(key)) !== 'kitechat') throw new Error('content mismatch');
});
await step('create a signed upload URL and upload with it', async () => {
  const body = 'signed upload';
  const url = await signPut(key, 'text/plain', body.length);
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const info = await head(key);
  if (!info || info.size !== body.length) throw new Error('uploaded object not found or wrong size');
});
await step('delete the test object', () => remove(key));

console.log('\nR2 is working. Remember to add the CORS rule (cloudflare/cors.json) so browsers can upload.');
