/* eslint-disable @typescript-eslint/no-explicit-any */
// A very small stand-in for Express, so the media and Kite Network code can run on Cloudflare unchanged.

export type Request = any;
export type Response = any;
export type NextFunction = () => void;
export type RequestHandler = (req: any, res: any, next: any) => any;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handlers: RequestHandler[];
}

export interface CallCtx {
  headers: Headers;
  body: any;
  query: Record<string, string>;
  ip: string;
}

export function Router(): any {
  const routes: Route[] = [];
  const add =
    (method: string) =>
    (path: string, ...handlers: RequestHandler[]) => {
      const keys: string[] = [];
      const re = new RegExp('^' + path.replace(/:([A-Za-z0-9_]+)/g, (_m, k) => (keys.push(k), '([^/]+)')) + '/?$');
      routes.push({ method, re, keys, handlers });
    };

  const router: any = { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') };

  /** Runs the first matching route. Returns null when nothing matches. */
  router.handle = (method: string, pathname: string, c: CallCtx): Promise<globalThis.Response> | null => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const headers: Record<string, string> = {};
      c.headers.forEach((v, k) => (headers[k] = v));
      const req = { method, path: pathname, params, query: c.query, body: c.body, headers, ip: c.ip };
      return new Promise(resolve => {
        let sent = false;
        const res: any = {
          locals: {},
          statusCode: 200,
          status(code: number) {
            this.statusCode = code;
            return this;
          },
          json(body: unknown) {
            if (sent) return this;
            sent = true;
            resolve(new Response(JSON.stringify(body), { status: this.statusCode, headers: { 'content-type': 'application/json' } }));
            return this;
          }
        };
        const fail = (e: unknown) => {
          console.error('route failed', e);
          if (!sent) res.status(500).json({ error: 'Something went wrong' });
        };
        let i = 0;
        const next = () => {
          const h = r.handlers[i++];
          if (!h) {
            if (!sent) res.status(404).json({ error: 'Not found' });
            return;
          }
          try {
            const p = h(req, res, next);
            if (p && typeof p.catch === 'function') p.catch(fail);
          } catch (e) {
            fail(e);
          }
        };
        next();
      });
    }
    return null;
  };
  return router;
}
