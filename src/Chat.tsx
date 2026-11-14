import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Ban, ChevronDown, ChevronUp, Info, Mic, Search, Square, Zap, Bold, Code, Copy, CornerUpLeft, Download, FileText, Flag, Forward, Italic, Languages, MoreVertical, Pencil, Trash2, MessageSquare, Paperclip, Phone, Pin, Strikethrough, Video, X } from 'lucide-react';
import Avatar from './Avatar.tsx';
import KiteIcon from './KiteIcon.tsx';
import { formatBytes } from './api.ts';
import { formatMessage } from './format.tsx';
import { loadWallOpacity, onWallOpacityChange, wallpaperBackground } from './wallpaper.ts';
import { LANGUAGES, getChatLang, setChatLang, translateText } from './translate.ts';
import { ensureFont, FONTS, seeingStyles } from './prefs.ts';
import { phaseLabel, type Phase, type ProgressFn } from './media.ts';
import type { ChatMessage, Friend } from './types.ts';

const EMOJIS = ['👍', '❤️', '😂', '🔥', '👏'];

interface Props {
  me: string;
  friend: Friend;
  messages: ChatMessage[];
  friendTyping: boolean;
  callDisabled: boolean;
  callHint: string;
  filesEnabled: boolean;
  onSendFile: (file: File, onProgress: ProgressFn) => Promise<void>;
  onDownload: (fileId: string) => Promise<void>;
  onSend: (text: string, replyTo?: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onDelete: (messageId: string, scope: 'me' | 'all') => void;
  /** Send a copy of a text message to another friend. */
  onForward: (friendId: string, text: string) => void;
  forwardTargets: Friend[];
  onTyping: (isTyping: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
  /** Pin or unpin a message. Returns an error text, or null when it worked. */
  onPin: (messageId: string, pinned: boolean) => Promise<string | null>;
  onCall: (type: 'audio' | 'video') => void;
  onBack: () => void;
  onOpenProfile: () => void;
  wallpaperUrl: string;
  /** Only the admin can write in System Broadcast. */
  readOnly?: boolean;
  /** Block or unblock this person. Returns an error text, or null when it worked. */
  onBlock?: (blocked: boolean) => Promise<string | null>;
  /** Report this person to the admin. Returns an error text, or null when it worked. */
  onReport?: (reason: string) => Promise<string | null>;
  /** Older messages of this chat, loaded when scrolling up. Resolves to how many came back. */
  onLoadOlder?: (before: number) => Promise<number>;
  /** Search this whole chat on the server (also messages not loaded yet). Newest first. */
  onSearch?: (q: string) => Promise<{ id: string; timestamp: number }[]>;
  /** Load every message between two times (to reach an old search result). */
  onLoadRange?: (after: number, before: number) => Promise<void>;
  /** Send a photo that shows as a picture in the chat. */
  onSendPhoto?: (file: File, onProgress: ProgressFn) => Promise<void>;
  /** Send a recorded voice note. */
  onSendVoice?: (blob: Blob, durationSec: number, onProgress: ProgressFn) => Promise<void>;
  /** A link to a chat photo or voice note. */
  mediaUrl?: (messageId: string) => Promise<string>;
  /** Group: name of a member (shown above their messages). */
  nameOf?: (userId: string) => string;
  /** Group: open the members screen. */
  onGroupInfo?: () => void;
  /** Text to put in the typing box (for example from a product's "Enquire" button). */
  draft?: { text: string; at: number };
  /** My saved quick replies (shown under the lightning button). */
  quickReplies?: string[];
}

/** "last seen today at 3:40 pm", "last seen yesterday at 9:05 am" or "last seen 12 Nov". */
function lastSeenText(at: number) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return `last seen today at ${time}`;
  if (diff === 1) return `last seen yesterday at ${time}`;
  return `last seen ${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}`;
}

export default function Chat({ me, friend, messages, friendTyping, callDisabled, callHint, filesEnabled, onSendFile, onDownload, onSend, onEdit, onDelete, onForward, forwardTargets, onTyping, onReact, onPin, onCall, onBack, onOpenProfile, wallpaperUrl, readOnly, onBlock, onReport, onLoadOlder, onSearch, onLoadRange, onSendPhoto, onSendVoice, mediaUrl, nameOf, onGroupInfo, draft, quickReplies = [] }: Props) {
  const isGroup = !!friend.isGroup;
  const [input, setInput] = useState('');
  const [progress, setProgress] = useState<{ phase: Phase; p: number } | null>(null);
  const [fileError, setFileError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [fullPhoto, setFullPhoto] = useState<string | null>(null);

  // ----- voice notes: tap the mic to record, tap again to send, X to cancel -----
  const [recording, setRecording] = useState<{ start: number } | null>(null);
  const [recSec, setRecSec] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const recChunks = useRef<Blob[]>([]);
  const recCancel = useRef(false);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const MAX_VOICE_SEC = 300;
  const stopTracks = () => recorder.current?.stream.getTracks().forEach(t => t.stop());
  const startRecording = async () => {
    setFileError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setFileError('Voice notes are not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
      recChunks.current = [];
      recCancel.current = false;
      const start = Date.now();
      rec.ondataavailable = ev => ev.data.size && recChunks.current.push(ev.data);
      rec.onstop = async () => {
        stopTracks();
        if (recTimer.current) clearInterval(recTimer.current);
        setRecording(null);
        const dur = (Date.now() - start) / 1000;
        if (recCancel.current || dur < 1 || !onSendVoice) return;
        const blob = new Blob(recChunks.current, { type: rec.mimeType || type || 'audio/webm' });
        setProgress({ phase: 'uploading', p: 0 });
        try {
          await onSendVoice(blob, dur, (phase, p) => setProgress({ phase, p }));
        } catch (err) {
          setFileError(err instanceof Error ? err.message : 'Could not send the voice note');
        } finally {
          setProgress(null);
        }
      };
      recorder.current = rec;
      rec.start(1000);
      setRecording({ start });
      setRecSec(0);
      recTimer.current = setInterval(() => {
        const s = Math.floor((Date.now() - start) / 1000);
        setRecSec(s);
        if (s >= MAX_VOICE_SEC) rec.state !== 'inactive' && rec.stop();
      }, 250);
    } catch {
      setFileError('Please allow the microphone to record a voice note.');
    }
  };
  const finishRecording = (cancel: boolean) => {
    recCancel.current = cancel;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  };
  // Leaving the chat while recording throws the recording away.
  useEffect(
    () => () => {
      recCancel.current = true;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stopTracks();
      if (recTimer.current) clearInterval(recTimer.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const [wallOpacity, setWallOpacity] = useState(loadWallOpacity);
  // How this friend chose to show their messages (only if they share it and I choose to see it).
  const fs = seeingStyles() ? friend.style : undefined;
  useEffect(() => {
    if (fs?.font) ensureFont(fs.font);
  }, [fs?.font]);
  const fsStyle: React.CSSProperties = fs
    ? {
        ...(fs.color ? { color: fs.color } : {}),
        ...(fs.font ? { fontFamily: FONTS.find(f => f.id === fs.font)?.family } : {}),
        ...(fs.accent ? { borderLeft: `3px solid ${fs.accent}`, paddingLeft: '0.6rem' } : {})
      }
    : {};
  useEffect(() => onWallOpacityChange(setWallOpacity), []);

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError('');
    // Photos show as a picture in the chat; other files are sent as before (kept until downloaded).
    const isPhoto = /^image\/(jpeg|png|webp|heic|heif|gif|avif)$/i.test(file.type);
    if (isGroup && !isPhoto) {
      setFileError('In groups you can send photos and voice notes.');
      return;
    }
    setProgress({ phase: 'compressing', p: 0 });
    try {
      if (isPhoto && onSendPhoto) await onSendPhoto(file, (phase, p) => setProgress({ phase, p }));
      else await onSendFile(file, (phase, p) => setProgress({ phase, p }));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not send the file');
    } finally {
      setProgress(null);
    }
  };

  const download = async (id: string) => {
    setFileError('');
    setDownloading(id);
    try {
      await onDownload(id);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(null);
    }
  };
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pickerTop, setPickerTop] = useState(80);
  // Long-press menu: Copy, Reply, Forward, Edit, Delete.
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [menuNote, setMenuNote] = useState('');
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const pressFired = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const startPress = (e: React.PointerEvent, msg: ChatMessage) => {
    pressFired.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer.current = setTimeout(() => {
      pressFired.current = true;
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore */
      }
      setPickerFor(null);
      setDeleting(false);
      setMenuFor(msg);
    }, 500);
  };
  const movePress = (e: React.PointerEvent) => {
    const s = pressStart.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancelPress();
  };
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    setMenuNote('Copied');
    setTimeout(() => setMenuNote(''), 1500);
  };
  // Translating friend's messages into a language chosen for this chat.
  const [lang, setLang] = useState(() => getChatLang(friend.userId));
  const [langOpen, setLangOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // ----- search in this chat -----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [hits, setHits] = useState<{ id: string; timestamp: number }[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const blockedByMe = !!friend.blockedByMe;
  const toggleBlock = async () => {
    setMoreOpen(false);
    if (!onBlock) return;
    const next = !blockedByMe;
    if (next && !window.confirm(`Block ${friend.name}?\n\nThey will not be able to message you, call you or send you files. They will not be told.`)) return;
    const e = await onBlock(next);
    setMenuNote(e ?? (next ? `${friend.name} is blocked` : `${friend.name} is unblocked`));
    setTimeout(() => setMenuNote(''), 2500);
  };
  const report = async () => {
    setMoreOpen(false);
    if (!onReport) return;
    const reason = window.prompt(`Report ${friend.name} to the admin.\n\nWhat happened? (optional)`, '');
    if (reason === null) return;
    const e = await onReport(reason);
    if (e) {
      setMenuNote(e);
      setTimeout(() => setMenuNote(''), 3000);
      return;
    }
    if (!blockedByMe && onBlock && window.confirm(`Reported. The admin will look at it.\n\nAlso block ${friend.name}?`)) {
      const b = await onBlock(true);
      setMenuNote(b ?? `${friend.name} is reported and blocked`);
    } else setMenuNote('Reported. The admin will look at it.');
    setTimeout(() => setMenuNote(''), 3000);
  };
  const [translated, setTranslated] = useState<Record<string, string>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [transNote, setTransNote] = useState('');
  const chooseLang = (code: string) => {
    setLang(code);
    setChatLang(friend.userId, code);
    setTranslated({});
    setShowOriginal({});
    setTransNote('');
    setLangOpen(false);
  };
  const [pinNote, setPinNote] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const convo = useMemo(
    () =>
      messages.filter(
        m =>
          !m.hiddenFor?.includes(me) &&
          (isGroup
            ? m.recipientId === friend.userId
            : (m.senderId === friend.userId && m.recipientId === me) || (m.senderId === me && m.recipientId === friend.userId))
      ),
    [messages, friend.userId, me, isGroup]
  );

  useEffect(() => {
    if (!lang) return;
    let stop = false;
    (async () => {
      for (const m of convo) {
        if (stop) return;
        if (m.senderId === me || m.file || m.media || m.deleted || !m.message || translated[m.id] !== undefined) continue;
        try {
          const t = await translateText(m.id, m.message, lang);
          if (stop) return;
          setTranslated(p => ({ ...p, [m.id]: t }));
          setTransNote('');
        } catch (e) {
          if (stop) return;
          setTranslated(p => ({ ...p, [m.id]: '' }));
          setTransNote(e instanceof Error ? e.message : 'Could not translate');
        }
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, convo]);

  const pinned = useMemo(() => convo.filter(m => m.pinned).slice(-3), [convo]);

  const textOf = (m: ChatMessage) => (m.deleted ? '' : `${m.message} ${m.file?.name ?? ''}`.toLowerCase());
  const goToHit = async (list: { id: string; timestamp: number }[], i: number) => {
    const hit = list[i];
    if (!hit) return;
    setHitIdx(i);
    if (!convo.some(m => m.id === hit.id) && onLoadRange && convo.length) {
      setSearching(true);
      await onLoadRange(hit.timestamp - 1, convo[0].timestamp).catch(() => {});
      setSearching(false);
    }
    setTimeout(() => document.getElementById(`msg-${hit.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  };
  // Find matches a moment after the person stops typing: in what is loaded, plus older ones on the server.
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQ.trim().toLowerCase();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      const local = convo.filter(m => textOf(m).includes(q)).map(m => ({ id: m.id, timestamp: m.timestamp }));
      let remote: { id: string; timestamp: number }[] = [];
      if (onSearch) {
        setSearching(true);
        remote = await onSearch(q).catch(() => []);
        setSearching(false);
      }
      if (seq !== searchSeq.current) return;
      const byId = new Map<string, { id: string; timestamp: number }>();
      for (const h of [...local, ...remote]) byId.set(h.id, h);
      const list = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
      setHits(list);
      if (list.length) void goToHit(list, 0);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ, searchOpen]);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQ('');
    setHits([]);
  };
  const hitId = searchOpen ? hits[hitIdx]?.id : undefined;

  // Jump to the newest message when a new one arrives (not when older ones are added at the top).
  const lastId = convo.length ? convo[convo.length - 1].id : '';
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastId, friendTyping]);

  // ----- older messages: loaded by themselves when the person scrolls to the top -----
  const listRef = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const noMoreOlder = useRef(false);
  const keepPlace = useRef<number | null>(null);
  const firstId = convo.length ? convo[0].id : '';
  const loadOlder = async () => {
    if (!onLoadOlder || loadingOlder || noMoreOlder.current || !convo.length) return;
    const el = listRef.current;
    setLoadingOlder(true);
    try {
      keepPlace.current = el ? el.scrollHeight - el.scrollTop : null;
      const n = await onLoadOlder(convo[0].timestamp);
      if (n < 100) noMoreOlder.current = true;
      if (n === 0) keepPlace.current = null;
    } catch {
      noMoreOlder.current = true;
      keepPlace.current = null;
    } finally {
      setLoadingOlder(false);
    }
  };
  // After older messages appear above, keep the screen on the message the person was reading.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && keepPlace.current !== null) {
      el.scrollTop = el.scrollHeight - keepPlace.current;
      keepPlace.current = null;
    }
  }, [firstId]);

  const stopTyping = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    onTyping(false);
  };

  const taRef = useRef<HTMLTextAreaElement>(null);
  // A ready text (from "Enquire") goes into the typing box.
  useEffect(() => {
    if (!draft) return;
    setInput(draft.text);
    setTimeout(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }, 80);
  }, [draft?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [quickOpen, setQuickOpen] = useState(false);
  const [hasSel, setHasSel] = useState(false);
  const grow = () => {
    const t = taRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 150) + 'px';
  };
  useEffect(grow, [input]);

  /** Wraps the selected words in a formatting symbol (no typing of symbols needed). */
  const format = (mark: string) => {
    const t = taRef.current;
    if (!t) return;
    const a = t.selectionStart;
    const b = t.selectionEnd;
    if (a === b) return;
    const sel = input.slice(a, b);
    const next = input.slice(0, a) + mark + sel + mark + input.slice(b);
    if (next.length > 2000) return;
    setInput(next);
    requestAnimationFrame(() => {
      t.focus();
      t.setSelectionRange(a + mark.length, b + mark.length);
      setHasSel(true);
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (!e.target.value) return stopTyping();
    if (!typingTimer.current) onTyping(true);
    else clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2000);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    if (editing) {
      if (text !== editing.message) onEdit(editing.id, text);
      setEditing(null);
    } else {
      onSend(text, replyingTo?.id);
      setReplyingTo(null);
    }
    setInput('');
    setHasSel(false);
    stopTyping();
  };

  const fmtBtn = 'w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 flex items-center justify-center border border-slate-700';

  const dot = (on: boolean) => `w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-700'}`;
  const iconBtn =
    'w-10 h-10 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-accent-ink flex items-center justify-center transition-colors shadow-lg shadow-emerald-600/20';

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 sm:px-6 py-3 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack} className="md:hidden w-9 h-9 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-300" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <button onClick={isGroup ? onGroupInfo : onOpenProfile} className="flex items-center gap-3 min-w-0 text-left" aria-label={isGroup ? `Open ${friend.name} group info` : `Open ${friend.name}'s profile`}>
          <Avatar avatar={friend.avatar} photoUrl={friend.photoUrl} />
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white truncate">{friend.name}</h3>
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5 h-4">
              {!isGroup && <span className={`w-2 h-2 rounded-full ${friend.isOnline ? 'bg-emerald-500' : 'bg-slate-600'}`} />}
              {isGroup ? (
                <span className="truncate">{friend.members?.length ?? 0} people · tap for group info</span>
              ) : friendTyping ? (
                <span className="flex items-center gap-1" aria-label="typing">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" />
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:0.2s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:0.4s]" />
                </span>
              ) : (
                <span className="truncate">{friend.isOnline ? 'Online' : friend.lastSeen ? lastSeenText(friend.lastSeen) : 'Offline'}</span>
              )}
            </div>
          </div>
          </button>
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            onClick={() => {
              setLangOpen(o => !o);
              setCallOpen(false);
              setMoreOpen(false);
            }}
            className={`${iconBtn} ${lang ? 'ring-2 ring-cyan-400' : ''}`}
            title={lang ? 'Translating incoming messages' : 'Translate incoming messages'}
            aria-label="Translate incoming messages"
          >
            <Languages className="w-4 h-4" />
          </button>
          {langOpen && (
            <div className="absolute right-0 top-12 z-40 w-60 max-h-80 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-xl p-2">
              <p className="px-2 py-1 text-[11px] text-slate-400">Show incoming messages in:</p>
              <button onClick={() => chooseLang('')} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${!lang ? 'bg-slate-800 text-white' : 'text-slate-200 hover:bg-slate-800'}`}>Off (original language)</button>
              {LANGUAGES.map(([code, name]) => (
                <button key={code} onClick={() => chooseLang(code)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${lang === code ? 'bg-slate-800 text-white' : 'text-slate-200 hover:bg-slate-800'}`}>{name}</button>
              ))}
            </div>
          )}
          {!friend.isAdmin && !isGroup && (
            <>
              <button
                onClick={() => {
                  setCallOpen(o => !o);
                  setLangOpen(false);
                  setMoreOpen(false);
                }}
                disabled={callDisabled || blockedByMe}
                className={iconBtn}
                title={blockedByMe ? `Unblock ${friend.name} to call` : callHint || 'Call'}
                aria-label="Call"
                aria-expanded={callOpen}
              >
                <Phone className="w-4 h-4" />
              </button>
              {callOpen && (
                <div className="absolute right-0 top-12 z-40 w-48 rounded-2xl border border-slate-700 bg-slate-900 shadow-xl p-2">
                  <button
                    onClick={() => {
                      setCallOpen(false);
                      onCall('audio');
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-100 hover:bg-slate-800"
                  >
                    <Phone className="w-4 h-4" /> Audio call
                  </button>
                  <button
                    onClick={() => {
                      setCallOpen(false);
                      onCall('video');
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-100 hover:bg-slate-800"
                  >
                    <Video className="w-4 h-4" /> Video call
                  </button>
                </div>
              )}
            </>
          )}
          {(
            <>
              <button
                onClick={() => {
                  setMoreOpen(o => !o);
                  setLangOpen(false);
                  setCallOpen(false);
                }}
                className="w-10 h-10 rounded-full hover:bg-slate-800 text-slate-300 flex items-center justify-center"
                aria-label="More options"
                aria-expanded={moreOpen}
              >
                <MoreVertical className="w-5 h-5" />
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-12 z-40 w-52 rounded-2xl border border-slate-700 bg-slate-900 shadow-xl p-2">
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      setSearchOpen(true);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white hover:bg-slate-800"
                  >
                    <Search className="w-4 h-4" /> Search messages
                  </button>
                  {onGroupInfo && (
                    <button
                      onClick={() => {
                        setMoreOpen(false);
                        onGroupInfo();
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white hover:bg-slate-800"
                    >
                      <Info className="w-4 h-4" /> Group info
                    </button>
                  )}
                  {onBlock && (
                    <button onClick={() => void toggleBlock()} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rose-400 hover:bg-slate-800">
                      <Ban className="w-4 h-4" /> {blockedByMe ? `Unblock ${friend.name}` : `Block ${friend.name}`}
                    </button>
                  )}
                  {onReport && (
                    <button onClick={() => void report()} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rose-400 hover:bg-slate-800">
                      <Flag className="w-4 h-4" /> Report {friend.name}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2 px-3 sm:px-6 py-2 border-b border-slate-800 bg-slate-900/80">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            autoFocus
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && hits.length) void goToHit(hits, (hitIdx + 1) % hits.length);
              if (e.key === 'Escape') closeSearch();
            }}
            placeholder="Search this chat"
            className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
            aria-label="Search this chat"
          />
          <span className="text-[11px] text-slate-400 shrink-0">
            {searching ? '…' : searchQ.trim().length >= 2 ? (hits.length ? `${hitIdx + 1} of ${hits.length}` : 'No results') : ''}
          </span>
          <button disabled={!hits.length} onClick={() => void goToHit(hits, (hitIdx + 1) % hits.length)} className="w-8 h-8 rounded-full hover:bg-slate-800 text-slate-300 disabled:opacity-40 flex items-center justify-center" aria-label="Older result">
            <ChevronUp className="w-4 h-4" />
          </button>
          <button disabled={!hits.length} onClick={() => void goToHit(hits, (hitIdx - 1 + hits.length) % hits.length)} className="w-8 h-8 rounded-full hover:bg-slate-800 text-slate-300 disabled:opacity-40 flex items-center justify-center" aria-label="Newer result">
            <ChevronDown className="w-4 h-4" />
          </button>
          <button onClick={closeSearch} className="w-8 h-8 rounded-full hover:bg-slate-800 text-slate-300 flex items-center justify-center" aria-label="Close search">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {transNote && <p role="status" className="shrink-0 px-4 py-1.5 text-[11px] text-amber-300 bg-slate-900/80 border-b border-slate-800">{transNote}</p>}
      {(pinned.length > 0 || pinNote) && (
        <div className="shrink-0 border-b border-slate-800 bg-slate-900/80 px-4 py-2 space-y-1">
          {pinned.map(m => (
            <button
              key={m.id}
              onClick={() => document.getElementById(`msg-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              className="w-full flex items-center gap-2 text-left text-xs text-slate-200"
            >
              <Pin className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
              <span className="truncate">{m.file ? `File: ${m.file.name}` : m.message}</span>
            </button>
          ))}
          {pinNote && <p role="status" className="text-[11px] text-amber-300">{pinNote}</p>}
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-3 chat-wallpaper"
        style={{ backgroundImage: wallpaperBackground(wallpaperUrl, wallOpacity) }}
        onClick={() => setPickerFor(null)}
        ref={listRef}
        onScroll={e => {
          setPickerFor(null);
          if (e.currentTarget.scrollTop < 80) void loadOlder();
        }}
      >
        {loadingOlder && <p role="status" className="text-center text-[11px] text-slate-400">Loading older messages…</p>}
        {convo.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center">
            <MessageSquare className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm font-medium">No messages with {friend.name} yet.</p>
            <p className="text-xs text-slate-600 mt-1">Say hello, or start a call with the icons above.</p>
          </div>
        ) : (
          convo.map(msg => {
            const mine = msg.senderId === me;
            const reactions = Object.values(msg.reactions ?? {});
            const myReaction = msg.reactions?.[me];
            return (
              <div key={msg.id} id={`msg-${msg.id}`} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <div className={`relative max-w-[92%] sm:max-w-xl ${hitId === msg.id ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                  <div
                    onPointerDown={e => startPress(e, msg)}
                    onPointerMove={movePress}
                    onPointerUp={cancelPress}
                    onPointerLeave={cancelPress}
                    onPointerCancel={cancelPress}
                    onContextMenu={e => e.preventDefault()}
                    onClick={e => {
                      e.stopPropagation();
                      if (pressFired.current) {
                        pressFired.current = false;
                        return;
                      }
                      if (!msg.deleted) {
                        // The reaction bar floats above everything, just over the message.
                        const r = e.currentTarget.getBoundingClientRect();
                        setPickerTop(Math.max(72, Math.min(r.top - 48, window.innerHeight - 120)));
                        setPickerFor(pickerFor === msg.id ? null : msg.id);
                      }
                    }}
                    style={mine ? { WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' } : { ...fsStyle, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
                    className={`msg-text py-1 cursor-pointer select-none [-webkit-touch-callout:none] break-words text-left ${mine ? 'msg-mine' : 'msg-theirs'}`}
                  >
                    {msg.broadcast && <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70 mb-1">📢 System Broadcast</div>}
                    {isGroup && !mine && <div className="text-[11px] font-semibold text-cyan-400 mb-0.5">{nameOf?.(msg.senderId) ?? msg.senderId}</div>}
                    {msg.forwarded && !msg.deleted && <div className="text-[11px] italic opacity-60 mb-0.5">↪ Forwarded</div>}
                    {msg.replyTo && !msg.deleted && (
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          document.getElementById(`msg-${msg.replyTo!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }}
                        className="block w-full text-left mb-1 rounded-lg border-l-4 border-slate-500 bg-slate-900/60 px-2 py-1 text-[13px] leading-snug"
                      >
                        <span className="block text-[11px] font-semibold opacity-70">{msg.replyTo.senderId === me ? 'You' : isGroup ? nameOf?.(msg.replyTo.senderId) ?? '' : friend.name}</span>
                        <span className="block truncate opacity-80">{msg.replyTo.text}</span>
                      </button>
                    )}
                    {msg.deleted && <div className="italic opacity-60 text-base">🚫 This message was deleted</div>}
                    {msg.file?.permanent && msg.message && <div className="mb-2 break-words">{formatMessage(msg.message)}</div>}
                    {msg.deleted ? null : msg.media ? (
                      <ChatMedia msg={msg} mediaUrl={mediaUrl} onOpenPhoto={setFullPhoto} />
                    ) : msg.file ? (
                      <div className="flex items-center gap-3 min-w-[12rem] text-sm rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-slate-200">
                        <FileText className="w-8 h-8 shrink-0 opacity-80" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{msg.file.name}</div>
                          <div className="text-[11px] opacity-70">{formatBytes(msg.file.size)}</div>
                        </div>
                        {msg.file.gone ? (
                          <span className="text-[11px] opacity-70 shrink-0">{mine ? 'Delivered' : 'Deleted'}</span>
                        ) : mine && !msg.file.permanent ? (
                          <span className="text-[11px] opacity-70 shrink-0">Waiting…</span>
                        ) : (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              void download(msg.file!.id);
                            }}
                            disabled={downloading === msg.file.id}
                            className="shrink-0 px-2.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-accent-ink text-xs font-semibold flex items-center gap-1"
                          >
                            <Download className="w-3.5 h-3.5" />
                            {downloading === msg.file.id ? 'Saving…' : 'Save'}
                          </button>
                        )}
                      </div>
                    ) : (
                      formatMessage(!mine && lang && translated[msg.id] && !showOriginal[msg.id] ? translated[msg.id] : msg.message)
                    )}
                    {!mine && lang && !msg.file && !msg.media && !msg.deleted && msg.message && (
                      translated[msg.id] ? (
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            setShowOriginal(p => ({ ...p, [msg.id]: !p[msg.id] }));
                          }}
                          className="mt-0.5 block text-[11px] text-slate-400 underline underline-offset-2"
                        >
                          {showOriginal[msg.id] ? 'Show translation' : 'Translated · show original'}
                        </button>
                      ) : translated[msg.id] === undefined ? (
                        <span className="mt-0.5 block text-[11px] text-slate-500">Translating…</span>
                      ) : null
                    )}
                    {reactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5 -mb-0.5">
                        {reactions.map((emoji, i) => (
                          <span key={i} className="bg-slate-900/80 border border-slate-700 px-1.5 py-0.5 rounded-full text-[11px]">{emoji}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {pickerFor === msg.id && createPortal(
                    <div
                      style={{ top: pickerTop }}
                      className={`fixed ${mine ? 'right-3' : 'left-3'} flex items-center gap-1 bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-full shadow-xl z-[100] text-lg`}
                      onClick={e => e.stopPropagation()}
                    >
                      <button
                        onClick={async () => {
                          setPickerFor(null);
                          setPinNote((await onPin(msg.id, !msg.pinned)) ?? '');
                        }}
                        className={`p-1 rounded ${msg.pinned ? 'bg-slate-700 text-cyan-400' : 'text-slate-300'}`}
                        title={msg.pinned ? 'Unpin message' : 'Pin message'}
                        aria-label={msg.pinned ? 'Unpin message' : 'Pin message'}
                      >
                        <Pin className="w-4 h-4" />
                      </button>
                      {EMOJIS.map(emoji => (
                        <button
                          key={emoji}
                          onClick={() => {
                            onReact(msg.id, myReaction === emoji ? '' : emoji);
                            setPickerFor(null);
                          }}
                          className={`hover:scale-125 transition-transform p-0.5 rounded ${myReaction === emoji ? 'bg-slate-700' : ''}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>,
                    document.body
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-slate-500">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {msg.edited && !msg.deleted && <span className="text-[10px] text-slate-500 italic">edited</span>}
                  {mine && (
                    <div className="flex items-center gap-0.5" title={`Status: ${msg.status}`}>
                      <span className={dot(true)} />
                      <span className={dot(msg.status !== 'sent')} />
                      <span className={dot(msg.status === 'read')} />
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {(progress !== null || fileError) && (
        <div className="px-4 py-2 border-t border-slate-800 bg-slate-900/60 text-xs">
          {progress !== null ? (
            <div>
              <div className="text-slate-300 mb-1">{phaseLabel(progress.phase)}… {Math.round(progress.p * 100)}%</div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full bg-cyan-500 transition-all" style={{ width: `${progress.p * 100}%` }} />
              </div>
            </div>
          ) : (
            <span role="alert" className="text-rose-400">{fileError}</span>
          )}
        </div>
      )}

      {!readOnly && !blockedByMe && (replyingTo || editing) && (
        <div className="px-3 sm:px-4 pt-2 border-t border-slate-800 bg-slate-900/40 flex items-center gap-2">
          <div className="min-w-0 flex-1 rounded-lg border-l-4 border-cyan-500 bg-slate-900 px-2 py-1 text-xs">
            <span className="block font-semibold text-cyan-400">{editing ? 'Editing message' : `Replying to ${replyingTo!.senderId === me ? 'yourself' : isGroup ? nameOf?.(replyingTo!.senderId) ?? '' : friend.name}`}</span>
            <span className="block truncate text-slate-300">{(editing ?? replyingTo)!.file ? `File: ${(editing ?? replyingTo)!.file!.name}` : (editing ?? replyingTo)!.message}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (editing) setInput('');
              setEditing(null);
              setReplyingTo(null);
            }}
            className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-300"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {menuFor && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center" onClick={() => setMenuFor(null)}>
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-3 pb-6" onClick={e => e.stopPropagation()}>
            <div className="mx-2 mb-2 px-3 py-2 rounded-xl bg-slate-950 text-xs text-slate-300 truncate">{menuFor.deleted ? 'Deleted message' : menuFor.file ? `File: ${menuFor.file.name}` : menuFor.message}</div>
            {!deleting ? (
              <div className="flex flex-col">
                {(() => {
                  const m = menuFor;
                  const textOk = !m.deleted && !m.file && !m.media && !!m.message;
                  const item = 'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-slate-100 hover:bg-slate-800 text-left';
                  return (
                    <>
                      {textOk && (
                        <button className={item} onClick={() => { void copyText(m.message); setMenuFor(null); }}>
                          <Copy className="w-4 h-4" /> Copy
                        </button>
                      )}
                      {!m.deleted && !readOnly && (
                        <button className={item} onClick={() => { setEditing(null); setReplyingTo(m); setMenuFor(null); taRef.current?.focus(); }}>
                          <CornerUpLeft className="w-4 h-4" /> Reply
                        </button>
                      )}
                      {textOk && (
                        <button className={item} onClick={() => { setForwarding(m); setMenuFor(null); }}>
                          <Forward className="w-4 h-4" /> Forward
                        </button>
                      )}
                      {textOk && m.senderId === me && !m.broadcast && (
                        <button className={item} onClick={() => { setReplyingTo(null); setEditing(m); setInput(m.message); setMenuFor(null); setTimeout(() => taRef.current?.focus(), 50); }}>
                          <Pencil className="w-4 h-4" /> Edit
                        </button>
                      )}
                      <button className={`${item} text-rose-400`} onClick={() => setDeleting(true)}>
                        <Trash2 className="w-4 h-4" /> Delete
                      </button>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="flex flex-col">
                <p className="px-4 py-2 text-xs text-slate-400">Delete this message?</p>
                <button className="w-full px-4 py-3 rounded-xl text-sm text-rose-400 hover:bg-slate-800 text-left" onClick={() => { onDelete(menuFor.id, 'me'); setMenuFor(null); }}>
                  Delete for you
                  <span className="block text-[11px] text-slate-500">Removed only from your phone.</span>
                </button>
                {menuFor.senderId === me && !menuFor.broadcast && !menuFor.file && !menuFor.deleted && (
                  <button className="w-full px-4 py-3 rounded-xl text-sm text-rose-400 hover:bg-slate-800 text-left" onClick={() => { onDelete(menuFor.id, 'all'); setMenuFor(null); }}>
                    Delete for everyone
                    <span className="block text-[11px] text-slate-500">{isGroup ? 'Everyone in the group' : friend.name} will see “This message was deleted”.</span>
                  </button>
                )}
                <button className="w-full px-4 py-3 rounded-xl text-sm text-slate-300 hover:bg-slate-800 text-left" onClick={() => setMenuFor(null)}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      )}
      {forwarding && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center" onClick={() => setForwarding(null)}>
          <div className="w-full max-w-sm max-h-[80dvh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-t-3xl sm:rounded-3xl p-4 pb-6" onClick={e => e.stopPropagation()}>
            <h4 className="text-sm font-bold text-white">Forward to…</h4>
            <p className="mt-1 mb-3 text-xs text-slate-400 truncate">{forwarding.message}</p>
            {forwardTargets.length === 0 ? (
              <p className="text-xs text-slate-500">You have no friends to forward to yet.</p>
            ) : (
              forwardTargets.map(f => (
                <button
                  key={f.userId}
                  onClick={() => {
                    onForward(f.userId, forwarding.message);
                    setForwarding(null);
                    setMenuNote(`Forwarded to ${f.name}`);
                    setTimeout(() => setMenuNote(''), 2000);
                  }}
                  className="w-full flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-slate-800 text-left"
                >
                  <Avatar avatar={f.avatar} photoUrl={f.photoUrl} />
                  <span className="text-sm text-white truncate">{f.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      {menuNote && <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-slate-800 border border-slate-700 text-xs text-white">{menuNote}</div>}
      {readOnly && (
        <div className="p-4 border-t border-slate-800 bg-slate-900/40 text-center text-xs text-slate-400">Only System Admin can send messages here.</div>
      )}
      {!readOnly && hasSel && (
        <div className="px-3 sm:px-4 pt-2 border-t border-slate-800 bg-slate-900/40 flex items-center gap-2" role="toolbar" aria-label="Text formatting">
          <span className="text-[11px] text-slate-400 mr-1">Format:</span>
          <button type="button" onPointerDown={e => e.preventDefault()} onClick={() => format('*')} className={fmtBtn} aria-label="Bold" title="Bold"><Bold className="w-4 h-4" /></button>
          <button type="button" onPointerDown={e => e.preventDefault()} onClick={() => format('_')} className={fmtBtn} aria-label="Italic" title="Italic"><Italic className="w-4 h-4" /></button>
          <button type="button" onPointerDown={e => e.preventDefault()} onClick={() => format('~')} className={fmtBtn} aria-label="Strikethrough" title="Strikethrough"><Strikethrough className="w-4 h-4" /></button>
          <button type="button" onPointerDown={e => e.preventDefault()} onClick={() => format('```')} className={`${fmtBtn} font-mono text-xs`} aria-label="Monospace" title="Monospace">{'</>'}</button>
          <button type="button" onPointerDown={e => e.preventDefault()} onClick={() => format('`')} className={fmtBtn} aria-label="Inline code" title="Inline code"><Code className="w-4 h-4" /></button>
        </div>
      )}
      {!readOnly && blockedByMe && (
        <div className="p-4 border-t border-slate-800 bg-slate-900/40 text-center text-xs text-slate-400">
          You blocked {friend.name}.{' '}
          <button onClick={() => void toggleBlock()} className="text-cyan-400 font-semibold underline underline-offset-2">Unblock</button>
        </div>
      )}
      {!readOnly && !blockedByMe && <form onSubmit={submit} className="relative p-3 sm:p-4 border-t border-slate-800 bg-slate-900/40 flex gap-3 items-end">
        {filesEnabled && (
          <>
            <input ref={fileInput} type="file" className="hidden" onChange={pickFile} />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={progress !== null}
              className="w-11 h-11 shrink-0 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 flex items-center justify-center border border-slate-700"
              title="Send a photo (kept 30 days) or a file (kept until downloaded)"
              aria-label="Attach a file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </>
        )}
        {quickReplies.length > 0 && !recording && (
          <>
            <button
              type="button"
              onClick={() => setQuickOpen(o => !o)}
              className={`w-11 h-11 shrink-0 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 flex items-center justify-center border ${quickOpen ? 'border-amber-400' : 'border-slate-700'}`}
              title="Quick replies"
              aria-label="Quick replies"
              aria-expanded={quickOpen}
            >
              <Zap className="w-4 h-4" />
            </button>
            {quickOpen && (
              <div className="absolute left-3 right-3 bottom-full mb-2 z-30 max-h-64 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-xl p-2">
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Quick replies</p>
                {quickReplies.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setInput(cur => (cur.trim() ? `${cur.trimEnd()} ${q}` : q));
                      setQuickOpen(false);
                      setTimeout(() => taRef.current?.focus(), 50);
                    }}
                    className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-white hover:bg-slate-800 break-words"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {recording ? (
          <div className="flex-1 min-w-0 h-11 flex items-center gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 text-sm text-rose-200">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
            <span>Recording {Math.floor(recSec / 60)}:{String(recSec % 60).padStart(2, '0')}</span>
            <button type="button" onClick={() => finishRecording(true)} className="ml-auto w-8 h-8 rounded-full hover:bg-slate-800 text-slate-300 flex items-center justify-center" aria-label="Cancel voice note">
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
        <textarea
          ref={taRef}
          rows={1}
          value={input}
          onChange={handleChange}
          onSelect={e => setHasSel(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd)}
          onBlur={() => setTimeout(() => setHasSel(false), 150)}
          onKeyDown={e => {
            // On a computer Enter sends and Shift+Enter makes a new line. On a phone Enter makes a new line; use the send button.
            if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          maxLength={2000}
          placeholder={`Message ${friend.name}…`}
          className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-base text-white focus:outline-none focus:border-cyan-500 resize-none leading-snug"
        />
        )}
        {recording ? (
          <button type="button" onClick={() => finishRecording(false)} className="w-11 h-11 bg-rose-500 hover:bg-rose-400 text-white rounded-xl flex items-center justify-center shrink-0" aria-label="Stop and send voice note">
            <Square className="w-4 h-4 fill-current" />
          </button>
        ) : !input.trim() && !editing && onSendVoice && filesEnabled ? (
          <button type="button" onClick={() => void startRecording()} disabled={progress !== null} className="w-11 h-11 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-accent-ink rounded-xl flex items-center justify-center shrink-0" aria-label="Record a voice note" title="Record a voice note">
            <Mic className="w-5 h-5" />
          </button>
        ) : (
          <button type="submit" className="w-11 h-11 bg-cyan-500 hover:bg-cyan-400 text-accent-ink rounded-xl flex items-center justify-center shrink-0" aria-label="Send">
            <KiteIcon className="w-6 h-6" />
          </button>
        )}
      </form>}
      {fullPhoto && (
        <div className="fixed inset-0 z-[70] bg-black/95 flex items-center justify-center" onClick={() => setFullPhoto(null)}>
          <img src={fullPhoto} alt="" className="max-w-full max-h-full object-contain" />
          <button onClick={() => setFullPhoto(null)} className="absolute top-4 right-4 w-11 h-11 rounded-full bg-black/60 text-fixed-white flex items-center justify-center" aria-label="Close photo">
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
}

/** A photo or voice note inside a chat bubble. The link is fetched when it is shown. */
function ChatMedia({ msg, mediaUrl, onOpenPhoto }: { msg: ChatMessage; mediaUrl?: (id: string) => Promise<string>; onOpenPhoto: (url: string) => void }) {
  const media = msg.media!;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (media.gone || !mediaUrl) return;
    let live = true;
    mediaUrl(msg.id)
      .then(u => live && setUrl(u))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [msg.id, media.gone, mediaUrl]);
  if (media.gone || failed) {
    return <div className="italic opacity-60 text-sm">{media.kind === 'photo' ? '📷 Photo expired' : '🎤 Voice note expired'}</div>;
  }
  if (media.kind === 'photo') {
    return url ? (
      <img
        src={url}
        alt="Photo"
        loading="lazy"
        onClick={e => {
          e.stopPropagation();
          onOpenPhoto(url);
        }}
        className="block max-w-[16rem] max-h-80 rounded-xl object-cover cursor-zoom-in"
      />
    ) : (
      <div className="w-48 h-36 rounded-xl bg-slate-800/70 animate-pulse" aria-label="Loading photo" />
    );
  }
  const dur = media.dur ? `${Math.floor(media.dur / 60)}:${String(media.dur % 60).padStart(2, '0')}` : '';
  return (
    <div className="flex items-center gap-2 min-w-[14rem]">
      <span aria-hidden>🎤</span>
      {url ? (
        <audio src={url} controls preload="metadata" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} className="h-9 max-w-[15rem]" />
      ) : (
        <span className="text-xs opacity-70">Loading…</span>
      )}
      {dur && <span className="text-[11px] opacity-70 shrink-0">{dur}</span>}
    </div>
  );
}
