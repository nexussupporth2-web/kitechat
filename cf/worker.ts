// KiteChat on Cloudflare: the front door. It sends every API and live-connection request to the hub.
/* eslint-disable @typescript-eslint/no-explicit-any */
export { Hub } from './hub.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return json({ ok: true, platform: 'cloudflare' });
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      return env.HUB.get(env.HUB.idFromName('main')).fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};
