/* eslint-disable @typescript-eslint/no-explicit-any */
// The data of KiteChat on Cloudflare: kept in memory for speed and saved in the Durable Object's own storage.
// Every user, message, post, share and report is one saved record.
import type { User, Message, Post, Share, Report, Group } from '../server/store.ts';
export type {
  Product, BizHours, User, MsgStatus, FileInfo, Message, Post, NetComment, Report, Share, Group
} from '../server/store.ts';

interface Data {
  secret: string;
  users: Record<string, User>;
  messages: Message[];
  posts: Post[];
  shares: Share[];
  reports: Report[];
  groups: Group[];
}

export const data: Data = { secret: '', users: {}, messages: [], posts: [], shares: [], reports: [], groups: [] };

export const isGroupId = (id: string) => id.startsWith('grp_');
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
  data.groups = [];
  saved.clear();
  messageIndex.clear();
  const all: Map<string, any> = await st.list();
  for (const [k, v] of all) {
    if (k.startsWith('x:')) continue; // server-only keys (for example the notification keys) are not records
    saved.set(k, JSON.stringify(v));
    if (k.startsWith('u:')) data.users[k.slice(2)] = v;
    else if (k.startsWith('m:')) data.messages.push(v);
    else if (k.startsWith('p:')) data.posts.push(v);
    else if (k.startsWith('s:')) data.shares.push(v);
    else if (k.startsWith('r:')) data.reports.push(v);
    else if (k.startsWith('g:')) data.groups.push(v);
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
  for (const g of data.groups) now.set('g:' + g.id, g);

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

/**
 * What a person gets when the app opens: the newest messages of EACH chat (so a busy chat never pushes
 * a quiet one out). Messages they deleted for themselves, or that were held back by a block, are left out.
 */
export function messagesFor(userId: string, perChat = 200, total = 6000): Message[] {
  const out: Message[] = [];
  const count = new Map<string, number>();
  // The groups this person is in, and since when.
  const myGroups = new Map<string, number>();
  for (const g of data.groups) if (g.members.includes(userId)) myGroups.set(g.id, g.joined[userId] ?? 0);
  for (let i = data.messages.length - 1; i >= 0 && out.length < total; i--) {
    const m = data.messages[i];
    if (m.hiddenFor?.includes(userId)) continue;
    let other: string;
    if (isGroupId(m.recipientId)) {
      const since = myGroups.get(m.recipientId);
      if (since === undefined || m.timestamp < since) continue;
      other = m.recipientId;
    } else {
      if (m.senderId !== userId && m.recipientId !== userId) continue;
      other = m.senderId === userId ? m.recipientId : m.senderId;
    }
    const n = count.get(other) ?? 0;
    if (n >= perChat) continue;
    count.set(other, n + 1);
    out.push(m);
  }
  return out.reverse().sort((a, b) => a.timestamp - b.timestamp);
}

/** Older messages of one chat (before a time, and after a time if given), for scrolling up or jumping to a search result. Oldest first. */
/** Is this message part of the chat between `userId` and `chatId` (a friend, or a group they joined at `since`)? */
function inChatOf(m: Message, userId: string, chatId: string, since: number) {
  if (isGroupId(chatId)) return m.recipientId === chatId && m.timestamp >= since;
  return (m.senderId === userId && m.recipientId === chatId) || (m.senderId === chatId && m.recipientId === userId);
}

export function olderMessages(userId: string, friendId: string, before: number, limit = 100, after = -Infinity, since = 0): Message[] {
  const out: Message[] = [];
  for (let i = data.messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = data.messages[i];
    if (m.timestamp >= before || m.timestamp <= after) continue;
    const inChat = inChatOf(m, userId, friendId, since);
    if (!inChat || m.hiddenFor?.includes(userId)) continue;
    out.push(m);
  }
  return out.reverse().sort((a, b) => a.timestamp - b.timestamp);
}

/** Messages of one chat whose text or file name contains the words searched for. Newest first. */
export function searchMessages(userId: string, friendId: string, q: string, limit = 200, since = 0): { id: string; timestamp: number }[] {
  const needle = q.toLowerCase();
  const out: { id: string; timestamp: number }[] = [];
  for (let i = data.messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = data.messages[i];
    const inChat = inChatOf(m, userId, friendId, since);
    if (!inChat || m.deleted || m.hiddenFor?.includes(userId)) continue;
    if (m.message.toLowerCase().includes(needle) || (m.file && m.file.name.toLowerCase().includes(needle))) out.push({ id: m.id, timestamp: m.timestamp });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}
