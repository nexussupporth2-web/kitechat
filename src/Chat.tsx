import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, FileText, Image as ImageIcon, MessageSquare, Paperclip, Phone, Video, X } from 'lucide-react';
import KiteIcon from './KiteIcon.tsx';
import { formatBytes } from './api.ts';
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
  onSend: (text: string) => void;
  onTyping: (isTyping: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
  onCall: (type: 'audio' | 'video') => void;
  onBack: () => void;
  onOpenProfile: () => void;
  wallpaperUrl: string;
  onSetWallpaper: (file: File) => Promise<void>;
  onResetWallpaper: () => Promise<void>;
}

export default function Chat({ me, friend, messages, friendTyping, callDisabled, callHint, filesEnabled, onSendFile, onDownload, onSend, onTyping, onReact, onCall, onBack, onOpenProfile, wallpaperUrl, onSetWallpaper, onResetWallpaper }: Props) {
  const [input, setInput] = useState('');
  const [progress, setProgress] = useState<{ phase: Phase; p: number } | null>(null);
  const [fileError, setFileError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const wallInput = useRef<HTMLInputElement>(null);
  const [wallOpen, setWallOpen] = useState(false);
  const [wallBusy, setWallBusy] = useState(false);
  const [wallError, setWallError] = useState('');

  const changeWallpaper = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setWallError('');
    setWallBusy(true);
    try {
      await onSetWallpaper(file);
      setWallOpen(false);
    } catch (err) {
      setWallError(err instanceof Error ? err.message : 'Could not change the wallpaper');
    } finally {
      setWallBusy(false);
    }
  };

  const useDefaultWallpaper = async () => {
    setWallError('');
    setWallBusy(true);
    try {
      await onResetWallpaper();
      setWallOpen(false);
    } catch (err) {
      setWallError(err instanceof Error ? err.message : 'Could not reset the wallpaper');
    } finally {
      setWallBusy(false);
    }
  };

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError('');
    setProgress({ phase: 'compressing', p: 0 });
    try {
      await onSendFile(file, (phase, p) => setProgress({ phase, p }));
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const convo = useMemo(
    () => messages.filter(m => m.senderId === friend.userId || m.recipientId === friend.userId),
    [messages, friend.userId]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [convo.length, friendTyping]);

  const stopTyping = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    onTyping(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
    onSend(text);
    setInput('');
    stopTyping();
  };

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
          <button onClick={onOpenProfile} className="flex items-center gap-3 min-w-0 text-left" aria-label={`Open ${friend.name}'s profile`}>
          <div className="w-10 h-10 shrink-0 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-sm">{friend.avatar}</div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white truncate">{friend.name}</h3>
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5 h-4">
              <span className={`w-2 h-2 rounded-full ${friend.isOnline ? 'bg-emerald-500' : 'bg-slate-600'}`} />
              {friendTyping ? (
                <span className="flex items-center gap-1" aria-label="typing">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" />
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:0.2s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:0.4s]" />
                </span>
              ) : (
                <span>{friend.isOnline ? 'Online' : 'Offline'}</span>
              )}
            </div>
          </div>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setWallError(''); setWallOpen(true); }} className="w-10 h-10 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center border border-slate-700" title="Chat wallpaper" aria-label="Chat wallpaper">
            <ImageIcon className="w-4 h-4" />
          </button>
          <button onClick={() => onCall('audio')} disabled={callDisabled} className={iconBtn} title={callHint || 'Audio call'}>
            <Phone className="w-4 h-4" />
          </button>
          <button onClick={() => onCall('video')} disabled={callDisabled} className={iconBtn} title={callHint || 'Video call'}>
            <Video className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-3 chat-wallpaper"
        style={{
          backgroundImage: `linear-gradient(color-mix(in srgb, var(--color-slate-950) 40%, transparent), color-mix(in srgb, var(--color-slate-950) 40%, transparent)), url("${wallpaperUrl}")`
        }}
        onClick={() => setPickerFor(null)}
      >
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
              <div key={msg.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <div className="relative max-w-[85%] sm:max-w-md">
                  <div
                    onClick={e => {
                      e.stopPropagation();
                      setPickerFor(pickerFor === msg.id ? null : msg.id);
                    }}
                    className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow cursor-pointer break-words whitespace-pre-wrap ${
                      mine ? 'bg-cyan-600 text-accent-ink rounded-br-sm' : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-sm'
                    }`}
                  >
                    {msg.file ? (
                      <div className="flex items-center gap-3 min-w-[12rem]">
                        <FileText className="w-8 h-8 shrink-0 opacity-80" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{msg.file.name}</div>
                          <div className="text-[11px] opacity-70">{formatBytes(msg.file.size)}</div>
                        </div>
                        {msg.file.gone ? (
                          <span className="text-[11px] opacity-70 shrink-0">{mine ? 'Delivered' : 'Deleted'}</span>
                        ) : mine ? (
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
                      msg.message
                    )}
                    {reactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5 -mb-0.5">
                        {reactions.map((emoji, i) => (
                          <span key={i} className="bg-black/30 px-1.5 py-0.5 rounded-full text-[11px]">{emoji}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {pickerFor === msg.id && (
                    <div
                      className={`absolute -top-9 ${mine ? 'right-0' : 'left-0'} flex items-center gap-1 bg-slate-900 border border-slate-700 px-2 py-1 rounded-full shadow-lg z-10`}
                      onClick={e => e.stopPropagation()}
                    >
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
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-slate-500">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
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

      {wallOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4" onClick={() => !wallBusy && setWallOpen(false)}>
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setWallOpen(false)} disabled={wallBusy} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-base font-bold text-white mb-1">Chat wallpaper</h3>
            <p className="text-xs text-slate-400 mb-4">Your friends will see the picture you choose in their chat with you. The most recent change by either of you is used.</p>
            <div className="h-40 rounded-2xl border border-slate-800 mb-4 chat-wallpaper" style={{ backgroundImage: `url("${wallpaperUrl}")` }} />
            {wallError && <div role="alert" className="mb-3 text-xs text-rose-400">{wallError}</div>}
            <input ref={wallInput} type="file" accept="image/*" className="hidden" onChange={changeWallpaper} />
            <div className="flex gap-3">
              <button onClick={useDefaultWallpaper} disabled={wallBusy} className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-white text-sm font-medium border border-slate-700">
                Use kites
              </button>
              <button onClick={() => wallInput.current?.click()} disabled={wallBusy} className="flex-1 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-accent-ink text-sm font-semibold">
                {wallBusy ? 'Please wait…' : 'Choose photo'}
              </button>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="p-3 sm:p-4 border-t border-slate-800 bg-slate-900/40 flex gap-3">
        {filesEnabled && (
          <>
            <input ref={fileInput} type="file" className="hidden" onChange={pickFile} />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={progress !== null}
              className="w-11 h-11 shrink-0 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 flex items-center justify-center border border-slate-700"
              title="Send a file (kept only until it is downloaded)"
              aria-label="Attach a file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </>
        )}
        <input
          type="text"
          value={input}
          onChange={handleChange}
          maxLength={2000}
          placeholder={`Message ${friend.name}…`}
          className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500"
        />
        <button type="submit" className="w-11 h-11 bg-cyan-500 hover:bg-cyan-400 text-accent-ink rounded-xl flex items-center justify-center shrink-0" aria-label="Send">
          <KiteIcon className="w-6 h-6" />
        </button>
      </form>
    </div>
  );
}
