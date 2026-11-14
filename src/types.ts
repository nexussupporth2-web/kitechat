export type CallType = 'audio' | 'video';
export type MsgStatus = 'sent' | 'received' | 'read';

export interface User {
  userId: string;
  name: string;
  avatar: string;
  /** Link to the profile picture, if the user has one. */
  photoUrl?: string | null;
  isAdmin?: boolean;
  /** (Only for me) do friends see my "last seen"? */
  showLastSeen?: boolean;
  /** (Only for me) signed in with a temporary password, so a new one must be chosen. */
  mustChangePassword?: boolean;
  /** How this person chose to show their messages to friends. */
  style?: { color?: string; font?: string; accent?: string };
}

export interface Friend extends User {
  isOnline: boolean;
  /** Position among the chats this person pinned (0 to 2), or -1 when not pinned. */
  pinOrder?: number;
  /** When they were last online (null if they hide it). */
  lastSeen?: number | null;
  /** True when I blocked this person. */
  blockedByMe?: boolean;
  /** Group chats are shown like a friend in the list. */
  isGroup?: boolean;
  /** Group: the person who made it (they manage it). */
  ownerId?: string;
  /** Group: who is in it. */
  members?: { userId: string; name: string; avatar: string; photoUrl: string | null }[];
  /** Group: when I last read it. */
  lastRead?: number;
}

export const isGroupId = (id: string) => id.startsWith('grp_');

export interface ChatMessage {
  id: string;
  senderId: string;
  recipientId: string;
  message: string;
  timestamp: number;
  status: MsgStatus;
  reactions: Record<string, string>;
  file?: { id: string; name: string; size: number; gone: boolean; permanent?: boolean };
  broadcast?: boolean;
  pinned?: boolean;
  replyTo?: { id: string; senderId: string; text: string };
  forwarded?: boolean;
  edited?: boolean;
  deleted?: boolean;
  hiddenFor?: string[];
  /** A photo or voice note shown in the chat (kept 30 days). */
  media?: { kind: 'photo' | 'voice'; mime: string; size: number; dur?: number; expiresAt: number; gone?: boolean };
}

export interface FeedPost {
  id: string;
  kind: 'story' | 'reel';
  mime: string;
  size: number;
  caption: string;
  createdAt: number;
  expiresAt: number | null;
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
  url: string;
}

export interface IncomingCall {
  roomId: string;
  callerId: string;
  callerName: string;
  type: CallType;
}
