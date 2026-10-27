import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Bell, Check, ChevronRight, Copy, LogOut, MoreVertical, Phone, Sparkles, UserPlus, Users, Video, X } from 'lucide-react';
import { api, ApiError, getToken, loadToken, setToken } from './api.ts';
import Auth from './Auth.tsx';
import Avatar from './Avatar.tsx';
import Chat from './Chat.tsx';
import CallScreen from './CallScreen.tsx';
import Feed from './Feed.tsx';
import Network, { Moderation } from './Network.tsx';
import Profile from './Profile.tsx';
import ProfileSettings from './ProfileSettings.tsx';
import { downloadSharedFile, sendFileToFriend, uploadBroadcastFile, type MediaConfig } from './media.ts';
import { enableNotifications, notificationState, notify, playMessageSound, registerSW, startRinging, stopRinging, subscribePush, unlockAudioOnFirstTap } from './notify.ts';
import { useCall } from './useCall.ts';
import { DEFAULT_WALLPAPER, loadChatWallpaper, resetMyWallpaper, setMyWallpaper } from './wallpaper.ts';
import type { ChatMessage, Friend, User } from './types.ts';

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
  const [socket, setSocket] = useState<Socket | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
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
  const [moderationOpen, setModerationOpen] = useState(false);
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
  const filesEnabled = !!mediaCfg?.enabled;

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const friendsRef = useRef<Friend[]>([]);
  friendsRef.current = friends;
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const calls = useCall(socket);
  const selected = friends.find(f => f.userId === selectedId) ?? null;

  const loadData = useCallback(async () => {
    try {
      const [f, m] = await Promise.all([
        api<{ friends: Friend[] }>('/api/friends'),
        api<{ messages: ChatMessage[] }>('/api/messages')
      ]);
      setFriends(f.friends);
      setMessages(m.messages);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.blocked)) onLogout();
    }
  }, [onLogout]);

  const refreshWallpaper = useCallback(() => {
    const id = selectedRef.current;
    if (id) void loadChatWallpaper(id).then(url => selectedRef.current === id && setWallpaperUrl(url));
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
    const s = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
    setSocket(s);

    s.on('connect', () => {
      setConnected(true);
      loadData(); // also resyncs after a reconnect
      if (selectedRef.current) s.emit('mark-messages-read', { friendId: selectedRef.current });
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', err => {
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

    s.on('presence-update', ({ userId, isOnline }: { userId: string; isOnline: boolean }) =>
      setFriends(prev => prev.map(f => (f.userId === userId ? { ...f, isOnline } : f)))
    );
    s.on('friend-added', (f: Friend) => {
      setFriends(prev => [...prev.filter(x => x.userId !== f.userId), f]);
      loadData(); // also brings in their picture
    });
    s.on('profile-updated', () => loadData());
    s.on('chat-message', (msg: ChatMessage) => {
      setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
      if (msg.senderId !== user.userId) {
        const watching = !document.hidden && selectedRef.current === msg.senderId;
        if (watching) s.emit('mark-messages-read', { friendId: msg.senderId });
        else if (document.hidden) {
          void notify('KiteChat', 'You have a message', `msg-${msg.senderId}`);
        } else playMessageSound();
      }
    });
    s.on('wallpaper-updated', () => refreshWallpaper());
    s.on('message-updated', (msg: ChatMessage) => setMessages(prev => prev.map(m => (m.id === msg.id ? msg : m))));
    s.on('message-status-update', ({ messageIds, status }: { messageIds: string[]; status: ChatMessage['status'] }) => {
      const ids = new Set(messageIds);
      setMessages(prev => prev.map(m => (ids.has(m.id) ? { ...m, status } : m)));
    });
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
  };

  const unread = (id: string) => messages.filter(m => m.senderId === id && m.status !== 'read').length;

  const addFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    try {
      const { friend } = await api<{ friend: Friend }>('/api/friends', { friendId: newFriendId });
      setFriends(prev => [...prev.filter(f => f.userId !== friend.userId), friend]);
      setNewFriendId('');
      setAddOpen(false);
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
                {user.isAdmin && (
                  <button role="menuitem" onClick={() => { setMenuOpen(false); setBroadcastNote(''); setBroadcastOpen(true); }} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">
                    📢 System Broadcast
                  </button>
                )}
                {user.isAdmin && (
                  <button role="menuitem" onClick={() => { setMenuOpen(false); setModerationOpen(true); }} className="w-full text-left px-4 py-3 text-sm text-white hover:bg-slate-800">
                    🛡️ Moderation
                  </button>
                )}
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
          <ProfileSettings key={user.userId} userId={user.userId} onChanged={u => onUserChange({ ...user, ...u })} />
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
            {friends.length === 0 ? (
              <div className="text-center py-12 px-4 text-slate-500">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-xs">No friends yet. Tap Add and enter their User ID.</p>
              </div>
            ) : (
              [...friends].sort((a, b) => Number(!!b.isAdmin) - Number(!!a.isAdmin)).map(f => {
                const n = unread(f.userId);
                return (
                  <button
                    key={f.userId}
                    onClick={() => selectFriend(f)}
                    className={`w-full text-left flex items-center justify-between p-3 rounded-2xl transition-colors ${
                      selectedId === f.userId ? 'bg-slate-800 border border-slate-700' : 'hover:bg-slate-800/50 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative shrink-0">
                        <Avatar avatar={f.avatar} photoUrl={f.photoUrl} />
                        <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-slate-900 ${f.isOnline ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-white truncate">
                          {f.name}
                          {f.isAdmin && <span className="ml-2 align-middle px-1.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-400 text-[10px] font-semibold">Official</span>}
                        </h4>
                        <span className="text-[10px] font-mono text-cyan-400">{f.userId}</span>
                      </div>
                    </div>
                    {n > 0 ? (
                      <span className="min-w-5 h-5 px-1.5 rounded-full bg-emerald-500 text-accent-ink text-[11px] font-bold flex items-center justify-center">{n}</span>
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-500" />
                    )}
                  </button>
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
              messages={messages}
              friendTyping={!!typing[selected.userId]}
              callDisabled={inCall || !!calls.incoming}
              filesEnabled={filesEnabled}
              onSendFile={(file, onProgress) => {
                if (!mediaCfg) return Promise.reject(new Error('File sharing is not available'));
                return sendFileToFriend(file, selected.userId, mediaCfg, onProgress);
              }}
              onDownload={downloadSharedFile}
              callHint={inCall ? 'You are already in a call' : !selected.isOnline ? `${selected.name} is offline. They will get a call notification.` : ''}
              onSend={text => socket?.emit('chat-message', { recipientId: selected.userId, message: text })}
              onTyping={isTyping => socket?.emit('typing', { recipientId: selected.userId, isTyping })}
              onReact={(messageId, reaction) => socket?.emit('message-reaction', { messageId, reaction })}
              onCall={type => calls.startCall(selected, type)}
              onBack={() => setSelectedId(null)}
              onOpenProfile={() => setProfileFor(selected.userId)}
              wallpaperUrl={wallpaperUrl}
              onSetWallpaper={async file => {
                if (!filesEnabled) throw new Error('Wallpapers need file storage, which is not set up yet');
                await setMyWallpaper(file);
                refreshWallpaper();
              }}
              onResetWallpaper={async () => {
                await resetMyWallpaper();
                refreshWallpaper();
              }}
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
            onMessage={() => {
              setSelectedId(profileFor);
              setTab('chats');
              setProfileFor(null);
            }}
          />
        </div>
      )}

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

      {addOpen && (
        <Modal onClose={() => setAddOpen(false)}>
          <h3 className="text-lg font-bold text-white mb-1">Add friend</h3>
          <p className="text-xs text-slate-400 mb-5">Enter your friend's User ID. You'll both see each other in your lists.</p>
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
            <button type="submit" className="w-full h-11 bg-cyan-500 hover:bg-cyan-400 text-accent-ink font-semibold rounded-xl text-sm">Add to friends</button>
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
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
        {children}
      </div>
    </div>
  );
}
