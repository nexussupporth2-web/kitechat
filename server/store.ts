import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { r2Enabled, getText, putText } from './r2.ts';

export interface User {
  userId: string;
  name: string;
  avatar: string;
  passwordHash: string;
  friends: string[];
  createdAt: number;
  /** Chat wallpaper picked by this user (an image in storage). */
  wallpaper?: { key: string; at: number };
}

export type MsgStatus = 'sent' | 'received' | 'read';

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  /** True once the file has been downloaded (and deleted) or has expired. */
  gone: boolean;
}

export interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  message: string;
  timestamp: number;
  status: MsgStatus;
  reactions: Record<string, string>;
  file?: FileInfo;
}

export interface Post {
  id: string;
  ownerId: string;
  kind: 'story' | 'reel' | 'album';
  key: string;
  mime: string;
  size: number;
  caption: string;
  createdAt: number;
  /** Stories expire; reels stay until deleted (null). */
  expiresAt: number | null;
}

export interface Share {
  id: string;
  senderId: string;
  recipientId: string;
  name: string;
  mime: string;
  size: number;
  key: string;
  messageId: string;
  createdAt: number;
}

interface Data {
  secret: string;
  users: Record<string, User>;
  messages: Message[];
  posts: Post[];
  shares: Share[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'kitechat.json');
const DB_KEY = 'db/kitechat.json';

export const data: Data = {
  secret: crypto.randomBytes(32).toString('hex'),
  users: {},
  messages: [],
  posts: [],
  shares: []
};
export const messageIndex = new Map<string, Message>();

/** Load saved data (from R2 when configured, otherwise a local file). Must finish before the server starts listening. */
export async function initStore(): Promise<void> {
  let raw: string | null = null;
  try {
    if (r2Enabled) raw = await getText(DB_KEY);
    else if (fs.existsSync(FILE)) raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    // Refuse to start rather than overwrite good data with an empty file later.
    console.error('Could not load saved data:', e);
    throw e;
  }
  if (raw) {
    const saved = JSON.parse(raw) as Partial<Data>;
    data.secret = saved.secret || data.secret;
    data.users = saved.users || {};
    data.messages = saved.messages || [];
    data.posts = saved.posts || [];
    data.shares = saved.shares || [];
  }
  messageIndex.clear();
  for (const m of data.messages) messageIndex.set(m.id, m);
  console.log(
    `Data loaded from ${r2Enabled ? 'Cloudflare R2' : 'local file'}: ${Object.keys(data.users).length} users, ${data.messages.length} messages`
  );
  if (!raw) save();
}

let timer: NodeJS.Timeout | null = null;
let writing = false;
let dirty = false;

async function writeNow(): Promise<void> {
  if (writing) {
    dirty = true;
    return;
  }
  writing = true;
  try {
    const body = JSON.stringify(data);
    if (r2Enabled) {
      await putText(DB_KEY, body);
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, FILE);
    }
  } catch (e) {
    console.error('Failed to persist data:', e);
  } finally {
    writing = false;
    if (dirty) {
      dirty = false;
      await writeNow();
    }
  }
}

/** Debounced save so bursts of changes cause one write. */
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void writeNow();
  }, 1500);
}

export async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await writeNow();
  while (writing) await new Promise(r => setTimeout(r, 50));
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
  return out.reverse();
}
