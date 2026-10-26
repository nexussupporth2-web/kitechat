import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { r2Enabled, getText, putText } from './r2.ts';

export interface Product {
  id: string;
  name: string;
  price: string;
  description: string;
  photo?: { key: string };
}

export interface BizHours {
  open: string;
  close: string;
  closed: boolean;
}

export interface User {
  userId: string;
  name: string;
  avatar: string;
  passwordHash: string;
  friends: string[];
  createdAt: number;
  /** Chat wallpaper picked by this user (an image in storage). */
  wallpaper?: { key: string; at: number };
  /** Public @handle (lowercase letters, numbers, dots, underscores). Separate from the login User ID. */
  handle?: string;
  /** Profile picture (an image in storage). Without it the first letter of the name is shown. */
  photo?: { key: string; at: number };
  category?: string;
  gender?: string;
  /** YYYY-MM-DD */
  birthday?: string;
  showGender?: boolean;
  showBirthday?: boolean;
  /** Business details. Phone, business name and business category are required. */
  phone?: string;
  showPhone?: boolean;
  businessName?: string;
  bizCategory?: string;
  bizDescription?: string;
  bizAddress?: string;
  /** A Google Maps link. */
  mapLink?: string;
  /** Monday to Sunday. */
  bizHours?: BizHours[];
  email?: string;
  website?: string;
  /** Short status line, like "Open for orders". */
  about?: string;
  socials?: Record<string, string>;
  cover?: { key: string; at: number };
  products?: Product[];
  /** Adult-content strikes. Two strikes = blocked. */
  strikes?: { at: number; where: string }[];
  blocked?: boolean;
  appeal?: { at: number; message: string };
  /** People whose Network posts this user chose not to see. */
  hidden?: string[];
  /** Devices that allowed notifications (so a closed app can still be told about a message or call). */
  pushSubs?: { endpoint: string; keys: { p256dh: string; auth: string } }[];
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
  /** Sent by the admin to everyone at once. */
  broadcast?: boolean;
}

export interface Post {
  id: string;
  ownerId: string;
  kind: 'story' | 'reel' | 'album' | 'network';
  key: string;
  mime: string;
  size: number;
  caption: string;
  createdAt: number;
  /** Stories expire; reels stay until deleted (null). */
  expiresAt: number | null;
  /** Kite Network posts only. */
  visibility?: 'public' | 'friends';
  /** userId -> emoji */
  likes?: Record<string, string>;
  comments?: NetComment[];
}

export interface NetComment {
  id: string;
  userId: string;
  text: string;
  at: number;
}

export interface Report {
  id: string;
  postId: string;
  commentId?: string;
  reporterId: string;
  reason: string;
  at: number;
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
  reports: Report[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'kitechat.json');
const DB_KEY = 'db/kitechat.json';

export const data: Data = {
  secret: crypto.randomBytes(32).toString('hex'),
  users: {},
  messages: [],
  posts: [],
  shares: [],
  reports: []
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
    data.reports = saved.reports || [];
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
