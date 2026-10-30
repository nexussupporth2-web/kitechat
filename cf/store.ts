/* eslint-disable @typescript-eslint/no-explicit-any */
// The data of KiteChat on Cloudflare: kept in memory for speed and saved in the Durable Object's own storage.
// Every user, message, post, share and report is one saved record.
import type { User, Message, Post, Share, Report } from '../server/store.ts';
export type {
  Product, BizHours, User, MsgStatus, FileInfo, Message, Post, NetComment, Report, Share
} from '../server/store.ts';

interface Data {
  secret: string;
  users: Record<string, User>;
  messages: Message[];
  posts: Post[];
  shares: Share[];
  reports: Report[];
}

export const data: Data = { secret: '', users: {}, messages: [], posts: [], shares: [], reports: [] };
export const messageIndex = new Map<string, Message>();

let storage: any = null;
/** What is already saved: record key -> its JSON text. Only changed records are written again. */
const saved = new Map<string, string>();
let queued = false;

export async function initStore(st: any): Promise<void> {
  storage = st;
  // Start from empty: the same running server can start this twice, and records must not be added twice.
  data.users = {};
  data.messages = [];
  data.posts = [];
  data.shares = [];
  data.reports = [];
  saved.clear();
  messageIndex.clear();
  const all: Map<string, any> = await st.list();
  for (const [k, v] of all) {
    saved.set(k, JSON.stringify(v));
    if (k.startsWith('u:')) data.users[k.slice(2)] = v;
    else if (k.startsWith('m:')) data.messages.push(v);
    else if (k.startsWith('p:')) data.posts.push(v);
    else if (k.startsWith('s:')) data.shares.push(v);
    else if (k.startsWith('r:')) data.reports.push(v);
  }
  data.messages.sort((a, b) => a.timestamp - b.timestamp);
  messageIndex.clear();
  for (const m of data.messages) messageIndex.set(m.id, m);
}

function flushNow() {
  queued = false;
  if (!storage) return;
  const now = new Map<string, any>();
  for (const u of Object.values(data.users)) now.set('u:' + u.userId, u);
  for (const m of data.messages) now.set('m:' + m.id, m);
  for (const p of data.posts) now.set('p:' + p.id, p);
  for (const s of data.shares) now.set('s:' + s.id, s);
  for (const r of data.reports) now.set('r:' + r.id, r);

  const changed: Record<string, any> = {};
  for (const [k, v] of now) {
    const text = JSON.stringify(v);
    if (saved.get(k) !== text) {
      changed[k] = v;
      saved.set(k, text);
    }
  }
  const gone: string[] = [];
  for (const k of [...saved.keys()]) {
    if (!now.has(k)) {
      gone.push(k);
      saved.delete(k);
    }
  }
  const keys = Object.keys(changed);
  for (let i = 0; i < keys.length; i += 100) {
    const part: Record<string, any> = {};
    for (const k of keys.slice(i, i + 100)) part[k] = changed[k];
    void storage.put(part);
  }
  for (let i = 0; i < gone.length; i += 100) void storage.delete(gone.slice(i, i + 100));
}

/** Save what changed. Many calls in one go cause a single write. */
export function save() {
  if (queued) return;
  queued = true;
  queueMicrotask(flushNow);
}

export async function flush(): Promise<void> {
  flushNow();
}

export function addMessage(m: Message) {
  data.messages.push(m);
  messageIndex.set(m.id, m);
  save();
}

export function messagesFor(userId: string, limit = 1000): Message[] {
  const out: Message[] = [];
  for (let i = data.messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = data.messages[i];
    if (m.senderId === userId || m.recipientId === userId) out.push(m);
  }
  return out.reverse().sort((a, b) => a.timestamp - b.timestamp);
}
