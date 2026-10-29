import { io, type Socket } from 'socket.io-client';

type Handler = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * One live connection that works with both servers:
 *  - Render (Socket.IO), the way it always worked
 *  - Cloudflare (plain WebSocket)
 * It asks /healthz once to find out which one it is talking to.
 */
export class KiteSocket {
  connected = false;
  id: string | undefined;

  private handlers = new Map<string, Set<Handler>>();
  private inner: Socket | null = null;
  private ws: WebSocket | null = null;
  private mode: 'io' | 'ws' | null = null;
  private closed = false;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private acks = new Map<number, Handler>();
  private ackSeq = 0;

  constructor(private token: string | null) {
    void this.init();
  }

  on(event: string, fn: Handler) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(event: string, fn?: Handler) {
    if (fn) this.handlers.get(event)?.delete(fn);
    else this.handlers.delete(event);
    return this;
  }

  emit(event: string, data?: unknown, ack?: Handler) {
    if (this.mode === 'io') {
      if (ack) this.inner?.emit(event, data, ack);
      else this.inner?.emit(event, data);
    } else if (this.mode === 'ws' && this.ws?.readyState === WebSocket.OPEN) {
      const frame: { e: string; d: unknown; i?: number } = { e: event, d: data };
      if (ack) {
        frame.i = ++this.ackSeq;
        this.acks.set(frame.i, ack);
      }
      this.ws.send(JSON.stringify(frame));
    }
    return this;
  }

  /** Reconnect right away (used when the phone wakes up). */
  connect() {
    if (this.connected) return;
    if (this.mode === 'io') this.inner?.connect();
    else if (this.mode === 'ws') {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.openWs();
    }
  }

  disconnect() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.inner?.disconnect();
    this.ws?.close();
  }

  private fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach(fn => fn(...args));
  }

  private async init() {
    let platform = '';
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      platform = (await r.json()).platform || '';
    } catch {
      /* assume the classic server */
    }
    if (this.closed) return;
    if (platform === 'cloudflare') {
      this.mode = 'ws';
      this.openWs();
    } else {
      this.mode = 'io';
      const s = io({ auth: { token: this.token }, transports: ['websocket', 'polling'] });
      this.inner = s;
      s.on('connect', () => {
        this.connected = true;
        this.id = s.id;
        this.fire('connect');
      });
      s.on('disconnect', () => {
        this.connected = false;
        this.fire('disconnect');
      });
      s.on('connect_error', err => {
        this.connected = false;
        this.fire('connect_error', err);
      });
      s.onAny((event: string, ...args: unknown[]) => this.fire(event, ...args));
    }
  }

  private openWs() {
    if (this.closed || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token || '')}`);
    this.ws = ws;
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let f: { e?: string; d?: unknown; a?: number };
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof f.a === 'number') {
        const cb = this.acks.get(f.a);
        this.acks.delete(f.a);
        cb?.(f.d);
      } else if (f.e === '$id') {
        this.id = String(f.d);
        this.connected = true;
        this.retry = 0;
        this.fire('connect');
      } else if (f.e) {
        this.fire(f.e, f.d);
      }
    };
    ws.onclose = ev => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      const was = this.connected;
      this.connected = false;
      this.acks.clear();
      if (ev.code === 4401) {
        this.closed = true;
        this.fire('connect_error', new Error('unauthorized'));
        return;
      }
      if (was) this.fire('disconnect');
      else this.fire('connect_error', new Error('connection failed'));
      if (this.closed) return;
      const wait = Math.min(1000 * 2 ** this.retry++, 15000);
      this.retryTimer = setTimeout(() => this.openWs(), wait);
    };
    ws.onopen = () => {
      // A tiny message every 30 s keeps the connection alive; the server answers it without waking up.
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
    };
  }
}
