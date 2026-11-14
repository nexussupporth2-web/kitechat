import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KiteSocket } from './socket';
import { Bell, Check, ChevronRight, Copy, Download, LogOut, MoreVertical, Phone, Pin, Sparkles, UserPlus, Users, Video, X } from 'lucide-react';
import { api, ApiError, getToken, loadToken, setToken } from './api.ts';
import Auth from './Auth.tsx';
import Avatar from './Avatar.tsx';
import Chat from './Chat.tsx';
import CallScreen from './CallScreen.tsx';
import Feed from './Feed.tsx';
import Network, { Moderation } from './Network.tsx';
import Profile from './Profile.tsx';
import ProfileSettings, { ChangePasswordBox } from './ProfileSettings.tsx';
import ThemeSheet from './ThemeSheet.tsx';
import { chatMediaUrl, downloadSharedFile, sendChatPhoto, sendFileToFriend, sendVoiceNote, uploadBroadcastFile, type MediaConfig } from './media.ts';
import { enableNotifications, notificationState, notify, playMessageSound, registerSW, startRinging, stopRinging, subscribePush, unlockAudioOnFirstTap } from './notify.ts';
import { useCall } from './useCall.ts';
import { DEFAULT_WALLPAPER, loadChatWallpaper } from './wallpaper.ts';
import { isGroupId, type ChatMessage, type Friend, type User } from './types.ts';
import { GroupInfoBox, NewGroupBox } from './Groups.tsx';
import { qrMatrix, qrSvg } from './qr.ts';

// A shop's QR code opens KiteChat with "?u=THEIR_ID". Remember it (also through signing in), then clean the address.
const OPEN_PROFILE = 'kite.openProfile';
try {
  const u = new URLSearchParams(location.search).get('u');
  if (u) {
    sessionStorage.setItem(OPEN_PROFILE, u.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 20));
    history.replaceState(null, '', location.pathname);
  }
} catch {
  /* private mode: the QR link just opens the app */
}
const profileLink = (userId: string) => `${location.origin}/?u=${encodeURIComponent(userId)}`;

/** Save the QR code as a picture (with the name under it) to print or share. */
function downloadQr(userId: string, name: string) {
  const m = qrMatrix(profileLink(userId));
  const cell = 12;
  const border = 4;
  const side = (m.length + border * 2) * cell;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side + 110;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  m.forEach((row, y) => row.forEach((dark, x) => dark && g.fillRect((x + border) * cell, (y + border) * cell, cell, cell)));
  g.textAlign = 'center';
  g.font = 'bold 34px sans-serif';
  g.fillText(name.slice(0, 30), side / 2, side + 30);
  g.font = '24px sans-serif';
  g.fillText('Scan to chat with us on KiteChat', side / 2, side + 72);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `kitechat-qr-${userId}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Shows a friendly screen instead of a blank page if something crashes, and recovers by itself. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  private retry = () => this.setState({ failed: false });
  componentDidMount() {
    document.addEventListener('visibilitychange', this.onVisible);
  }
  componentWillUnmount() {
    document.removeEventListener('visibilitychange', this.onVisible);
  }
  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.state.failed) this.retry();
  };
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-full bg-slate-950 text-slate-100 flex flex-col items-center justify-center text-center p-8 gap-4">
        <p className="text-sm text-slate-300">Something went wrong. Tap the button to continue.</p>
        <button onClick={() => window.location.reload()} className="px-5 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-accent-ink rounded-xl text-sm font-semibold">
          Reload
        </button>
      </div>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  );
}

function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  // Restore a saved session. If the free server is still waking up, keep trying instead of failing.
  useEffect(() => {
    if (!loadToken()) {
      setBooting(false);
      return;
    }
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      api<{ user: User }>('/api/me')
        .then(r => {
          if (cancelled) return;
          setUser(r.user);
          setBooting(false);
        })
        .catch(e => {
          if (cancelled) return;
          if (e instanceof ApiError && (e.status === 401 || e.blocked)) {
            setToken(null);
            setBooting(false);
          } else if (++tries < 30) {
            setTimeout(attempt, 3000);
          } else {
            setBooting(false);
          }
        });
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  if (booting) {
    return (
      <div className="min-h-full bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
        Waking up KiteChat… this can take a minute.
      </div>
    );
  }
  if (!user) return <Auth onAuthed={setUser} />;
  return <Messenger key={user.userId} user={user} onLogout={logout} onUserChange={setUser} />;
}

function Messenger({ user, onLogout, onUserChange }: { user: User; onLogout: () => void; onUserChange: (u: User) => void }) {
  const [socket, setSocket] = useState<KiteSocket | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Friend[]>([]);
  // My quick replies (for the lightning button in chats).
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  useEffect(() => {
    api<{ replies: string[] }>('/api/account/quick-replies')
      .then(r => setQuickReplies(r.replies))
      .catch(() => {});
    const onSaved = (e: Event) => setQuickReplies((e as CustomEvent<string[]>).detail ?? []);
    window.addEventListener('kite-quick-replies', onSaved);
    return () => window.removeEventListener('kite-quick-replies', onSaved);
  }, []);
  // Text to put in a chat's typing box (from a product's "Enquire" button).
  const [draft, setDraft] = useState<{ chatId: string; text: string; at: number } | null>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [requests, setRequests] = useState<{ userId: string; name: string; avatar: string; photoUrl: string | null }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [newFriendId, setNewFriendId] = useState('');
  const [addError, setAddError] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'chats' | 'feed' | 'network' | 'profile'>('chats');
  const [menuOpen, setMenuOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [listNote, setListNote] = useState('');
  const [moderationOpen, setModerationOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastNote, setBroadcastNote] = useState('');
  const [broadcastFile, setBroadcastFile] = useState<File | null>(null);
  const broadcastFileRef = useRef<HTMLInputElement>(null);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [mediaCfg, setMediaCfg] = useState<MediaConfig | null>(null);
  const [connected, setConnected] = useState(true);
  const [wallpaperUrl, setWallpaperUrl] = useState(DEFAULT_WALLPAPER);
  const [notifState, setNotifState] = useState(notificationState());

  // Opened from a shop's QR code: show that profile once signed in.
  useEffect(() => {
    try {
      const id = sessionStorage.getItem(OPEN_PROFILE);
      if (!id) return;
      sessionStorage.removeItem(OPEN_PROFILE);
      if (id !== user.userId) setProfileFor(id);
    } catch {
      /* nothing remembered */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const filesEnabled = !!mediaCfg?.enabled;

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const friendsRef = useRef<Friend[]>([]);
  friendsRef.current = friends;
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const calls = useCall(socket);
  // For the admin, "System Broadcast" is a chat of its own that shows each broadcast once.
  const BC = '__broadcast__';
  const selected: Friend | null =
    selectedId === BC
      ? { userId: BC, name: 'System Broadcast', avatar: '📢', photoUrl: null, isAdmin: true, isOnline: true }
      : friends.find(f => f.userId === selectedId) ?? groups.find(g => g.userId === selectedId) ?? null;
  const chatMessages = (() => {
    if (!user.isAdmin) return messages;
    if (selectedId !== BC) return messages.filter(m => !(m.broadcast && m.senderId === user.userId));
    const seen = new Set<string>();
    const out: ChatMessage[] = [];
    for (const m of messages) {
      if (!m.broadcast || m.senderId !== user.userId) continue;
      const key = (m as ChatMessage & { broadcastId?: string }).broadcastId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...m, recipientId: BC, status: 'read' });
    }
    return out;
  })();

  const loadData = useCallback(async () => {
    try {
      const [f, m] = await Promise.all([
        api<{ friends: Friend[] }>('/api/friends'),
        api<{ messages: ChatMessage[] }>('/api/messages')
      ]);
      setFriends(f.friends);
      // Group chats (an older server without groups just has none).
      api<{ groups: Friend[] }>('/api/groups')
        .then(r => setGroups(r.groups))
        .catch(() => {});
      // Keep older messages already loaded by scrolling up (the server sends only the newest of each chat).
      setMessages(prev => {
        const other = (x: ChatMessage) => (isGroupId(x.recipientId) ? x.recipientId : x.senderId === user.userId ? x.recipientId : x.senderId);
        const oldest = new Map<string, number>();
        for (const x of m.messages) oldest.set(other(x), Math.min(oldest.get(other(x)) ?? Infinity, x.timestamp));
        const ids = new Set(m.messages.map(x => x.id));
        const keep = prev.filter(x => !ids.has(x.id) && !x.hiddenFor?.includes(user.userId) && x.timestamp < (oldest.get(other(x)) ?? -Infinity));
        return keep.length ? [...keep, ...m.messages].sort((a, b) => a.timestamp - b.timestamp) : m.messages;
      });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.blocked)) onLogout();
    }
    // Friend requests waiting for an answer (never blocks the rest).
    try {
      const r = await api<{ incoming: { userId: string; name: string; avatar: string; photoUrl: string | null }[] }>('/api/friends/requests');
      setRequests(r.incoming);
    } catch {
      /* an older server without friend requests */
    }
  }, [onLogout, user.userId]);

  const answerRequest = async (userId: string, accept: boolean) => {
    try {
      await api('/api/friends/respond', { userId, accept });
    } catch {
      /* it may already be answered */
    }
    void loadData();
  };

  const refreshWallpaper = useCallback(() => {
    const id = selectedRef.current;
    if (id && id !== '__broadcast__') void loadChatWallpaper(id).then(url => selectedRef.current === id && setWallpaperUrl(url));
  }, []);
  useEffect(() => {
    setWallpaperUrl(DEFAULT_WALLPAPER);
    refreshWallpaper();
  }, [selectedId, refreshWallpaper]);

  useEffect(() => {
    unlockAudioOnFirstTap();
    if (notificationState() === 'granted') void registerSW().then(subscribePush);
  }, []);

  useEffect(() => {
    api<MediaConfig>('/api/media/config')
      .then(setMediaCfg)
      .catch(() => setMediaCfg(null));
  }, []);

  // One socket per session; handlers read mutable state through refs.
  useEffect(() => {
    const s = new KiteSocket(getToken());
    setSocket(s);

    s.on('connect', () => {
      setConnected(true);
      loadData(); // also resyncs after a reconnect
      if (selectedRef.current) s.emit('mark-messages-read', { friendId: selectedRef.current });
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (err: Error) => {
      setConnected(false);
      if (err.message === 'unauthorized') onLogout();
    });

    // When the phone wakes the page up again, reconnect right away and refresh everything.
    const wake = () => {
      if (document.visibilityState === 'hidden') return;
      if (!s.connected) s.connect();
      else void loadData();
      refreshWallpaper();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);

    s.on('presence-update', ({ userId, isOnline, lastSeen }: { userId: string; isOnline: boolean; lastSeen?: number | null }) =>
      setFriends(prev => prev.map(f => (f.userId === userId ? { ...f, isOnline, ...(lastSeen !== undefined ? { lastSeen } : {}) } : f)))
    );
    s.on('friend-added', (f: Friend) => {
      setFriends(prev => [...prev.filter(x => x.userId !== f.userId), f]);
      loadData(); // also brings in their picture
    });
    s.on('profile-updated', () => loadData());
    s.on('group-updated', () => loadData());
    // A friend changed their User ID: swap it everywhere on this screen.
    s.on('friend-id-changed', ({ oldId, newId }: { oldId: string; newId: string }) => {
      const sw = (x: string) => (x === oldId ? newId : x);
      setFriends(prev => prev.map(f => (f.userId === oldId ? { ...f, userId: newId } : f)));
      setMessages(prev =>
        prev.map(m =>
          m.senderId === oldId || m.recipientId === oldId || (m.reactions && oldId in m.reactions)
            ? {
                ...m,
                senderId: sw(m.senderId),
                recipientId: sw(m.recipientId),
                reactions: Object.fromEntries(Object.entries(m.reactions ?? {}).map(([k, v]) => [sw(k), v])),
                ...(m.replyTo ? { replyTo: { ...m.replyTo, senderId: sw(m.replyTo.senderId) } } : {})
              }
            : m
        )
      );
      setSelectedId(cur => (cur === oldId ? newId : cur));
      loadData();
    });
    s.on('friend-request', () => loadData());
    s.on('friend-removed', ({ userId: gone }: { userId: string }) => {
      setFriends(prev => prev.filter(f => f.userId !== gone));
      setMessages(prev => prev.filter(m => m.senderId !== gone && m.recipientId !== gone));
      setSelectedId(cur => (cur === gone ? null : cur));
      loadData();
    });
    s.on('chat-message', (msg: ChatMessage) => {
      setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
      if (msg.senderId !== user.userId) {
        // In a group the chat is the group, otherwise it is the person who wrote.
        const chatId = isGroupId(msg.recipientId) ? msg.recipientId : msg.senderId;
        const watching = !document.hidden && selectedRef.current === chatId;
        if (watching) {
          s.emit('mark-messages-read', { friendId: chatId });
          if (isGroupId(chatId)) setGroups(prev => prev.map(g => (g.userId === chatId ? { ...g, lastRead: Date.now() } : g)));
        } else if (document.hidden) {
          void notify('KiteChat', 'You have a message', `msg-${chatId}`);
        } else playMessageSound();
      }
    });
    s.on('wallpaper-updated', () => refreshWallpaper());
    s.on('message-updated', (msg: ChatMessage) => setMessages(prev => prev.map(m => (m.id === msg.id ? msg : m))));
    s.on('message-status-update', ({ messageIds, status }: { messageIds: string[]; status: ChatMessage['status'] }) => {
      const ids = new Set(messageIds);
      setMessages(prev => prev.map(m => (ids.has(m.id) ? { ...m, status } : m)));
    });
    s.on('message-edited', ({ messageId, message }: { messageId: string; message: string }) =>
      setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, message, edited: true } : m)))
    );
    s.on('message-deleted', ({ messageId, scope, userId: uid }: { messageId: string; scope: 'all' | 'me'; userId?: string }) =>
      setMessages(prev =>
        prev.map(m =>
          m.id !== messageId
            ? m
            : scope === 'all'
              ? { ...m, deleted: true, message: '', pinned: false, reactions: {} }
              : { ...m, hiddenFor: [...(m.hiddenFor ?? []), uid ?? ''] }
        )
      )
    );
    s.on('message-reaction-update', ({ messageId, reactions }: { messageId: string; reactions: Record<string, string> }) =>
      setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, reactions } : m)))
    );
    s.on('typing', ({ senderId, isTyping }: { senderId: string; isTyping: boolean }) => {
      setTyping(prev => ({ ...prev, [senderId]: isTyping }));
      clearTimeout(typingTimers.current[senderId]);
      if (isTyping) {
        typingTimers.current[senderId] = setTimeout(() => setTyping(prev => ({ ...prev, [senderId]: false })), 4000);
      }
    });

    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      s.disconnect();
      setSocket(null);
    };
  }, [user.userId, loadData, onLogout, refreshWallpaper]);

  const selectFriend = (f: Friend) => {
    setSelectedId(f.userId);
    socket?.emit('mark-messages-read', { friendId: f.userId });
    if (f.isGroup) setGroups(prev => prev.map(g => (g.userId === f.userId ? { ...g, lastRead: Date.now() } : g)));
  };

  const unread = (id: string) => {
    if (isGroupId(id)) {
      const since = groups.find(g => g.userId === id)?.lastRead ?? 0;
      return messages.filter(m => m.recipientId === id && m.senderId !== user.userId && m.timestamp > since && !m.hiddenFor?.includes(user.userId)).length;
    }
    return messages.filter(m => m.senderId === id && m.recipientId === user.userId && m.status !== 'read').length;
  };

  const addFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    try {
      // Sends a friend request. If they had already asked me, we become friends straight away.
      const r = await api<{ state: 'sent' | 'friends'; friend?: Friend }>('/api/friends/request', { userId: newFriendId });
      const friend = r.friend;
      if (r.state === 'friends' && friend) setFriends(prev => [...prev.filter(f => f.userId !== friend.userId), friend]);
      setNewFriendId('');
      setAddOpen(false);
      setListNote(r.state === 'friends' ? 'You are now friends.' : 'Friend request sent. You can chat once they accept.');
      setTimeout(() => setListNote(''), 5000);
      if (r.state === 'friends') void loadData();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Could not add friend');
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(user.userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const inCall = !!calls.call;

  // Ring (and show a system notification) for an incoming call.
  const incomingId = calls.incoming && !inCall ? calls.incoming.callerName : null;
  useEffect(() => {
    if (!incomingId) return;
    startRinging();
    void notify('KiteChat', 'You have an incoming call', 'incoming-call', true);
    return stopRinging;
  }, [incomingId]);

  const sendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = broadcastText.trim();
    if ((!text && !broadcastFile) || broadcastBusy) return;
    if (!window.confirm('Send this to everyone?')) return;
    setBroadcastBusy(true);
    setBroadcastNote('');
    try {
      let file: { key: string; name: string } | undefined;
      if (broadcastFile) {
        setBroadcastNote('Uploading the attachment…');
        file = await uploadBroadcastFile(broadcastFile, () => {});
      }
      const r = await api<{ sent: number }>('/api/broadcast', { message: text, file });
      setBroadcastText('');
      setBroadcastFile(null);
      setBroadcastNote(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`);
    } catch (err) {
      setBroadcastNote(err instanceof Error ? err.message : 'Could not send the broadcast');
    } finally {
      setBroadcastBusy(false);
    }
  };

  /** Pin or unpin a chat. Up to 3 chats stay at the top of the list. */
  const pinChat = async (f: Friend) => {
    const pin = !(f.pinOrder != null && f.pinOrder >= 0);
    setListNote('');
    try {
      await api('/api/chats/pin', { friendId: f.userId, pinned: pin });
      await loadData();
    } catch (err) {
      setListNote(err instanceof ApiError ? err.message : 'Could not pin this chat');
      setTimeout(() => setListNote(''), 4000);
    }
  };

  const pinMessage = async (messageId: string, pinned: boolean): Promise<string | null> => {
    try {
      await api(`/api/messages/${messageId}/pin`, { pinned });
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : 'Could not pin this message';
    }
  };

  const goTo = (t: 'chats' | 'feed' | 'network' | 'profile') => {
    setTab(t);
    setMenuOpen(false);
  };

  const turnOnNotifications = async () => setNotifState(await enableNotifications());

  return (
    <div className="h-full bg-slate-950 text-slate-100 flex flex-col font-sans">
      {!connected && (
        <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-amber-500/90 text-accent-ink text-xs font-semibold px-4 py-2 rounded-full shadow-xl">
          Reconnecting…
        </div>
      )}

      {calls.notice && (
        <div role="status" className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] bg-slate-800 border border-slate-700 text-slate-100 text-xs px-4 py-2 rounded-full shadow-xl max-w-[90vw] text-center">
          {calls.notice}
        </div>
      )}

      {calls.incoming && !inCall && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-sm w-full text-center shadow-2xl">
            <div className="w-16 h-16 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center mx-auto mb-4 animate-bounce">
              {calls.incoming.type === 'audio' ? <Phone className="w-8 h-8" /> : <Video className="w-8 h-8" />}
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Incoming {calls.incoming.type === 'audio' ? 'audio' : 'video'} call</h3>
            <p className="text-sm text-slate-400 mb-6"><strong className="text-white">{calls.incoming.callerName}</strong> is calling you.</p>
            <div className="flex gap-3">
              <button onClick={calls.declineCall} className="flex-1 py-3 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 font-semibold text-sm border border-rose-500/30">Decline</button>
              <button onClick={calls.acceptCall} className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-accent-ink font-semibold text-sm">Accept</button>
            </div>
          </div>
        </div>
      )}

      {calls.call && (
        <CallScreen
          call={calls.call}
          localStream={calls.localStream}
          remoteStream={calls.remoteStream}
          micOn={calls.micOn}
          camOn={calls.camOn}
          seconds={calls.seconds}
          onToggleMic={calls.toggleMic}
          onToggleCam={calls.toggleCam}
          onEnd={calls.endCall}
        />
      )}

      <header
        className={`${selected && tab === 'chats' ? 'hidden md:flex' : 'flex'} items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-slate-800 bg-slate-900/60 shrink-0 relative z-30`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setTab('chats')}
            className="w-11 h-11 shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-cyan-500 to-indigo-600 text-accent-ink font-bold text-lg flex items-center justify-center shadow"
            title="Chats"
            aria-label="Go to chats"
          >
            {user.photoUrl ? <img src={user.photoUrl} alt="" className="w-full h-full rounded-full object-cover" /> : user.avatar}
          </button>
          <button onClick={() => setShareOpen(true)} className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 min-w-0" title="Share my User ID">
            <span className="font-mono text-cyan-400 truncate block">{user.userId}</span>
          </button>
        </div>
        <div className="flex items-center gap-2 relative">
          {notifState === 'default' && (
            <button onClick={turnOnNotifications} className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center" title="Turn on notifications" aria-label="Turn on notifications">
              <Bell className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => setMenuOpen(o => !o)} className="w-9 h-9 rounded-lg hover:bg-slate-800 text-slate-300 flex items-center justify-center" aria-label="Menu" aria-expanded={menuOpen}>
            <MoreVertical className="w-5 h-5" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div role="menu" className="absolute right-0 top-11 z-50 w-56 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl py-1.5 overflow-hidden">
                {tab !== 'chats' && (
                  <button role="menuitem" onClick={() => goTo('chats')} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">Chats</button>
                )}
                {filesEnabled && (
                  <>
                    <button role="menuitem" onClick={() => goTo('network')} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">Kite 🪁 Network</button>
                    <button role="menuitem" onClick={() => goTo('feed')} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">Stories &amp; Reels</button>
                    <button role="menuitem" onClick={() => goTo('profile')} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">Profile Settings</button>
                  </>
                )}
                <button role="menuitem" onClick={() => { setMenuOpen(false); setThemeOpen(true); }} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">🎨 Personalise</button>
                {user.isAdmin && (
                  <button role="menuitem" onClick={() => { setMenuOpen(false); setSelectedId(BC); setTab('chats'); }} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">
                    📢 System Broadcast
                  </button>
                )}
                {user.isAdmin && (
                  <button role="menuitem" onClick={() => { setMenuOpen(false); setModerationOpen(true); }} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">
                    🛡️ Moderation
                  </button>
                )}
                <button role="menuitem" onClick={() => { setMenuOpen(false); setNewGroupOpen(true); }} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800 flex items-center gap-2">
                  <Users className="w-4 h-4" /> New group
                </button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); onLogout(); }} className="w-full text-left px-4 py-3 text-sm text-rose-400 hover:bg-slate-800 flex items-center gap-2">
                  <LogOut className="w-4 h-4" /> Logout
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 flex min-h-0">
        {tab === 'network' ? (
          <Network me={user} onBlocked={onLogout} onOpenProfile={setProfileFor} />
        ) : tab === 'feed' ? (
          <Feed me={user.userId} />
        ) : tab === 'profile' ? (
          <ProfileSettings
            key={user.userId}
            userId={user.userId}
            onChanged={u => onUserChange({ ...user, ...u })}
            isAdmin={user.isAdmin}
            onIdChanged={(u, token) => {
              // New sign-in first, then the app restarts itself with the new User ID.
              setToken(token);
              onUserChange({ ...user, ...u });
            }}
            onPasswordChanged={token => {
              setToken(token);
              if (user.mustChangePassword) onUserChange({ ...user, mustChangePassword: false });
            }}
            showLastSeen={user.showLastSeen !== false}
            onShowLastSeen={show => onUserChange({ ...user, showLastSeen: show })}
          />
        ) : (
        <>
        <aside className={`${selected ? 'hidden md:flex' : 'flex'} w-full md:w-80 shrink-0 bg-slate-900 border-r border-slate-800 flex-col`}>
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Friends ({friends.length})</span>
            <button onClick={() => { setAddOpen(true); setAddError(''); }} className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-accent-ink rounded-lg">
              <UserPlus className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {requests.length > 0 && (
              <div className="mb-2 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-2">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-400">Friend requests ({requests.length})</p>
                {requests.map(r => (
                  <div key={r.userId} className="flex items-center gap-2 p-2">
                    <Avatar avatar={r.avatar} photoUrl={r.photoUrl} className="w-9 h-9 text-sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white truncate">{r.name}</p>
                      <p className="text-[10px] font-mono text-cyan-400 truncate">{r.userId}</p>
                    </div>
                    <button onClick={() => answerRequest(r.userId, true)} className="px-2.5 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-accent-ink text-xs font-semibold">Accept</button>
                    <button onClick={() => answerRequest(r.userId, false)} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs">Decline</button>
                  </div>
                ))}
              </div>
            )}
            {listNote && <p role="status" className="px-3 py-2 text-xs text-amber-300">{listNote}</p>}
            {user.isAdmin && (
              <button
                onClick={() => setSelectedId(BC)}
                className="w-full text-left flex items-center justify-between p-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 hover:bg-cyan-500/10"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar avatar="📢" className="w-10 h-10 text-lg" />
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-white truncate">
                      System Broadcast
                      <span className="ml-2 align-middle px-1.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-400 text-[10px] font-semibold">Official</span>
                    </h4>
                    <span className="text-[11px] text-slate-400">Your updates to everyone</span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-500" />
              </button>
            )}
            {friends.length === 0 && groups.length === 0 ? (
              <div className="text-center py-12 px-4 text-slate-500">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-xs">No friends yet. Tap Add and enter their User ID.</p>
              </div>
            ) : (
              [...friends, ...groups]
                // System Broadcast first, then the chats this person pinned, then everyone else.
                .sort((a, b) => Number(!!b.isAdmin) - Number(!!a.isAdmin) || (a.pinOrder != null && a.pinOrder >= 0 ? a.pinOrder : 99) - (b.pinOrder != null && b.pinOrder >= 0 ? b.pinOrder : 99))
                .map(f => {
                const n = unread(f.userId);
                const isPinned = f.pinOrder != null && f.pinOrder >= 0;
                return (
                  <div
                    key={f.userId}
                    className={`w-full flex items-center gap-1 rounded-2xl transition-colors ${
                      selectedId === f.userId ? 'bg-slate-800 border border-slate-700' : 'hover:bg-slate-800/50 border border-transparent'
                    }`}
                  >
                    <button onClick={() => selectFriend(f)} className="flex-1 min-w-0 text-left flex items-center justify-between p-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative shrink-0">
                          <Avatar avatar={f.avatar} photoUrl={f.photoUrl} />
                          {!f.isGroup && <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-slate-900 ${f.isOnline ? 'bg-emerald-500' : 'bg-slate-600'}`} />}
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-white truncate">
                            {f.name}
                            {f.isAdmin && <span className="ml-2 align-middle px-1.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-400 text-[10px] font-semibold">Official</span>}
                          </h4>
                          <span className="text-[10px] font-mono text-cyan-400">{f.isAdmin ? 'Updates from Kite' : f.isGroup ? `Group · ${f.members?.length ?? 0} people` : f.userId}</span>
                        </div>
                      </div>
                      {n > 0 ? (
                        <span className="min-w-5 h-5 px-1.5 rounded-full bg-emerald-500 text-accent-ink text-[11px] font-bold flex items-center justify-center">{n}</span>
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-500" />
                      )}
                    </button>
                    {f.isAdmin || f.isGroup ? (
                      <span className="w-10 shrink-0" />
                    ) : (
                      <button
                        onClick={() => void pinChat(f)}
                        className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center ${isPinned ? 'text-cyan-400' : 'text-slate-600 hover:text-slate-300'}`}
                        title={isPinned ? 'Unpin chat' : 'Pin chat to the top'}
                        aria-label={isPinned ? 'Unpin chat' : 'Pin chat to the top'}
                      >
                        <Pin className={`w-4 h-4 ${isPinned ? 'fill-current' : ''}`} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <section className={`${selected ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col bg-slate-950`}>
          {selected ? (
            <Chat
              key={selected.userId}
              me={user.userId}
              friend={selected}
              messages={chatMessages}
              readOnly={!user.isAdmin && !!selected.isAdmin}
              friendTyping={!!typing[selected.userId]}
              callDisabled={inCall || !!calls.incoming}
              filesEnabled={filesEnabled}
              onSendFile={(file, onProgress) => {
                if (selected.userId === BC) {
                  return uploadBroadcastFile(file, onProgress).then(async f => {
                    await api('/api/broadcast', { message: '', file: f });
                  });
                }
                if (!mediaCfg) return Promise.reject(new Error('File sharing is not available'));
                return sendFileToFriend(file, selected.userId, mediaCfg, onProgress);
              }}
              onDownload={downloadSharedFile}
              callHint={inCall ? 'You are already in a call' : !selected.isOnline ? `${selected.name} is offline. They will get a call notification.` : ''}
              onSend={(text, replyTo) => (selected.userId === BC ? void api('/api/broadcast', { message: text }).catch(() => {}) : socket?.emit('chat-message', { recipientId: selected.userId, message: text, replyTo }))}
              onTyping={isTyping => selected.userId !== BC && !selected.isGroup && socket?.emit('typing', { recipientId: selected.userId, isTyping })}
              onEdit={(messageId, text) => socket?.emit('edit-message', { messageId, message: text })}
              onDelete={(messageId, scope) => socket?.emit('delete-message', { messageId, scope })}
              onForward={(friendId, text) => socket?.emit('chat-message', { recipientId: friendId, message: text, forwarded: true })}
              forwardTargets={[...friends.filter(f => !f.isAdmin && !f.blockedByMe), ...groups]}
              onSendPhoto={selected.userId === BC || !mediaCfg ? undefined : (file, onProgress) => sendChatPhoto(file, selected.userId, onProgress)}
              onSendVoice={selected.userId === BC || !mediaCfg ? undefined : (blob, dur, onProgress) => sendVoiceNote(blob, dur, selected.userId, onProgress)}
              mediaUrl={chatMediaUrl}
              draft={draft && draft.chatId === selected.userId ? draft : undefined}
              quickReplies={selected.userId === BC ? [] : quickReplies}
              nameOf={selected.isGroup ? id => selected.members?.find(m => m.userId === id)?.name ?? friends.find(f => f.userId === id)?.name ?? 'Former member' : undefined}
              onGroupInfo={selected.isGroup ? () => setGroupInfoOpen(true) : undefined}
              onLoadOlder={selected.userId === BC ? undefined : async before => {
                const r = await api<{ messages: ChatMessage[] }>(`/api/messages/older?friendId=${encodeURIComponent(selected.userId)}&before=${before}`).catch(() => ({ messages: [] as ChatMessage[] }));
                if (r.messages.length) {
                  setMessages(prev => {
                    const have = new Set(prev.map(m => m.id));
                    const add = r.messages.filter(m => !have.has(m.id));
                    return add.length ? [...add, ...prev].sort((a, b) => a.timestamp - b.timestamp) : prev;
                  });
                }
                return r.messages.length;
              }}
              onSearch={selected.userId === BC ? undefined : async q => {
                const r = await api<{ hits: { id: string; timestamp: number }[] }>(`/api/messages/search?friendId=${encodeURIComponent(selected.userId)}&q=${encodeURIComponent(q)}`).catch(() => ({ hits: [] }));
                return r.hits;
              }}
              onLoadRange={selected.userId === BC ? undefined : async (after, before) => {
                const r = await api<{ messages: ChatMessage[] }>(`/api/messages/older?friendId=${encodeURIComponent(selected.userId)}&before=${before}&after=${after}`).catch(() => ({ messages: [] as ChatMessage[] }));
                if (!r.messages.length) return;
                setMessages(prev => {
                  const have = new Set(prev.map(m => m.id));
                  const add = r.messages.filter(m => !have.has(m.id));
                  return add.length ? [...add, ...prev].sort((a, b) => a.timestamp - b.timestamp) : prev;
                });
              }}
              onBlock={selected.userId === BC || selected.isAdmin || selected.isGroup ? undefined : async blocked => {
                try {
                  await api('/api/block', { userId: selected.userId, blocked });
                  setFriends(prev => prev.map(f => (f.userId === selected.userId ? { ...f, blockedByMe: blocked } : f)));
                  return null;
                } catch (err) {
                  return err instanceof ApiError ? err.message : 'That did not work. Please try again.';
                }
              }}
              onReport={selected.userId === BC || selected.isAdmin || selected.isGroup ? undefined : async reason => {
                try {
                  await api('/api/report-user', { userId: selected.userId, reason });
                  return null;
                } catch (err) {
                  return err instanceof ApiError ? err.message : 'Could not send the report. Please try again.';
                }
              }}
              onReact={(messageId, reaction) => socket?.emit('message-reaction', { messageId, reaction })}
              onPin={pinMessage}
              onCall={type => calls.startCall(selected, type)}
              onBack={() => setSelectedId(null)}
              onOpenProfile={() => selected.userId !== BC && setProfileFor(selected.userId)}
              wallpaperUrl={wallpaperUrl}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center mb-4">
                <Sparkles className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Welcome, {user.name.split(' ')[0]}</h2>
              <p className="text-sm text-slate-400 max-w-sm mb-6">Pick a friend to chat or call. Share your User ID so friends can add you.</p>
              <button onClick={() => setShareOpen(true)} className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-semibold border border-slate-700">
                My User ID: <code className="text-cyan-400 font-mono ml-1">{user.userId}</code>
              </button>
            </div>
          )}
        </section>
        </>
        )}
      </main>

      {profileFor && (
        <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col">
          <Profile
            key={profileFor}
            userId={profileFor}
            isMe={profileFor === user.userId}
            onBack={() => setProfileFor(null)}
            onFriendsChanged={() => void loadData()}
            onMessage={draft => {
              setSelectedId(profileFor);
              if (draft) setDraft({ chatId: profileFor, text: draft, at: Date.now() });
              setTab('chats');
              setProfileFor(null);
            }}
          />
        </div>
      )}

      {themeOpen && <ThemeSheet userId={user.userId} filesEnabled={filesEnabled} onChanged={refreshWallpaper} onClose={() => setThemeOpen(false)} />}
      {moderationOpen && <Moderation onClose={() => setModerationOpen(false)} onChanged={() => {}} />}

      {broadcastOpen && (
        <Modal onClose={() => !broadcastBusy && setBroadcastOpen(false)}>
          <h3 className="text-lg font-bold text-white mb-1">📢 System Broadcast</h3>
          <p className="text-xs text-slate-400 mb-4">This message goes to everyone's chat with you, as a normal message marked “Broadcast”.</p>
          <form onSubmit={sendBroadcast} className="space-y-3">
            <textarea
              value={broadcastText}
              onChange={e => setBroadcastText(e.target.value)}
              maxLength={2000}
              rows={6}
              placeholder="What's new in KiteChat…"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 resize-none"
            />
            <div className="text-[11px] text-slate-500 text-right">{broadcastText.length}/2000</div>
            <input ref={broadcastFileRef} type="file" className="hidden" onChange={e => { setBroadcastFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => broadcastFileRef.current?.click()} disabled={broadcastBusy} className="px-3 py-2 rounded-xl bg-slate-800 text-sm text-slate-200">
                {broadcastFile ? 'Change attachment' : 'Attach a file'}
              </button>
              {broadcastFile && (
                <span className="min-w-0 flex-1 flex items-center gap-2 text-xs text-slate-300">
                  <span className="truncate">{broadcastFile.name}</span>
                  <button type="button" onClick={() => setBroadcastFile(null)} disabled={broadcastBusy} className="text-rose-400">Remove</button>
                </span>
              )}
            </div>
            {broadcastNote && <p role="status" className="text-xs text-cyan-400">{broadcastNote}</p>}
            <button type="submit" disabled={broadcastBusy || (!broadcastText.trim() && !broadcastFile)} className="w-full h-11 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-accent-ink font-semibold rounded-xl text-sm">
              {broadcastBusy ? 'Sending…' : 'Send to everyone'}
            </button>
          </form>
        </Modal>
      )}

      {newGroupOpen && (
        <NewGroupBox
          friends={friends.filter(f => !f.isAdmin && !f.blockedByMe)}
          onClose={() => setNewGroupOpen(false)}
          onCreated={id => {
            setNewGroupOpen(false);
            void loadData();
            setTab('chats');
            setSelectedId(id);
          }}
        />
      )}
      {groupInfoOpen && selected?.isGroup && (
        <GroupInfoBox
          group={selected}
          me={user.userId}
          friends={friends}
          onClose={() => setGroupInfoOpen(false)}
          onChanged={() => void loadData()}
          onLeft={() => {
            setGroupInfoOpen(false);
            setSelectedId(null);
            setGroups(prev => prev.filter(g => g.userId !== selected.userId));
          }}
        />
      )}

      {user.mustChangePassword && (
        <ChangePasswordBox
          forced
          onDone={token => {
            setToken(token);
            onUserChange({ ...user, mustChangePassword: false });
          }}
        />
      )}

      {addOpen && (
        <Modal onClose={() => setAddOpen(false)}>
          <h3 className="text-lg font-bold text-white mb-1">Add friend</h3>
          <p className="text-xs text-slate-400 mb-5">Enter your friend's User ID. They'll get a friend request, and you can chat once they accept.</p>
          {addError && <div role="alert" className="mb-3 p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">{addError}</div>}
          <form onSubmit={addFriend} className="space-y-4">
            <input
              required
              autoFocus
              value={newFriendId}
              onChange={e => setNewFriendId(e.target.value.toUpperCase())}
              placeholder="e.g. SAM456"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm font-mono tracking-wider text-white focus:outline-none focus:border-cyan-500"
            />
            <button type="submit" className="w-full h-11 bg-cyan-500 hover:bg-cyan-400 text-accent-ink font-semibold rounded-xl text-sm">Send friend request</button>
          </form>
        </Modal>
      )}

      {shareOpen && (
        <Modal onClose={() => setShareOpen(false)}>
          <h3 className="text-lg font-bold text-white mb-1">Your User ID</h3>
          <p className="text-xs text-slate-400 mb-5">Share this so friends can add you.</p>
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 mb-5 text-center">
            <span className="text-2xl font-mono font-bold text-cyan-400 tracking-widest block break-all">{user.userId}</span>
            <span className="text-[11px] text-slate-400 mt-1 block">{user.name}</span>
          </div>
          <button onClick={copyId} className="w-full py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-medium text-sm flex items-center justify-center gap-2 border border-slate-700">
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-cyan-400" />}
            <span>{copied ? 'Copied' : 'Copy User ID'}</span>
          </button>
          {/* Shop QR code: customers scan it to open this profile in KiteChat */}
          <div className="mt-5 flex flex-col items-center">
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(profileLink(user.userId)))}`} alt="Your QR code" className="w-48 h-48 rounded-xl" />
            <p className="mt-2 text-[11px] text-slate-400 text-center">Customers scan this to open your profile in KiteChat.</p>
            <button onClick={() => downloadQr(user.userId, user.name)} className="mt-3 w-full py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-medium text-sm flex items-center justify-center gap-2 border border-slate-700">
              <Download className="w-4 h-4 text-cyan-400" />
              <span>Download QR</span>
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-sm max-h-[92dvh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
        {children}
      </div>
    </div>
  );
}
