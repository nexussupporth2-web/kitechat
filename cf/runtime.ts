/* eslint-disable @typescript-eslint/no-explicit-any */
// The settings (secrets and variables) and the R2 bucket, shared by the other files.
export const ENV: Record<string, string> = {};
export let BUCKET: any = null;

export function setEnv(env: any) {
  for (const k of Object.keys(env)) if (typeof env[k] === 'string') ENV[k] = env[k].trim();
  BUCKET = env.BUCKET ?? null;
}
