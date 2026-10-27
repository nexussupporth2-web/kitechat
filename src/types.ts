export type CallType = 'audio' | 'video';
export type MsgStatus = 'sent' | 'received' | 'read';

export interface User {
  userId: string;
  name: string;
  avatar: string;
  /** Link to the profile picture, if the user has one. */
  photoUrl?: string | null;
  isAdmin?: boolean;
}

export interface Friend extends User {
  isOnline: boolean;
  /** Position among the chats this person pinned (0 to 2), or -1 when not pinned. */
  pinOrder?: number;
}

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
