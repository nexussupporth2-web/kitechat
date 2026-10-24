import { useEffect, useRef } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Radio, Video, VideoOff } from 'lucide-react';
import type { ActiveCall } from './useCall.ts';

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

interface Props {
  call: ActiveCall;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  seconds: number;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onEnd: () => void;
}

export default function CallScreen({ call, localStream, remoteStream, micOn, camOn, seconds, onToggleMic, onToggleCam, onEnd }: Props) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = localStream;
  }, [localStream, call.type]);
  useEffect(() => {
    if (remoteRef.current) remoteRef.current.srcObject = remoteStream;
  }, [remoteStream, call.type]);

  const isVideo = call.type === 'video';
  const statusText =
    call.status === 'ringing' ? `Calling ${call.peerName}…` : call.status === 'connecting' ? 'Connecting…' : fmt(seconds);
  const round = (on: boolean) =>
    `w-12 h-12 rounded-full flex items-center justify-center transition-colors ${on ? 'bg-slate-800 hover:bg-slate-700 text-accent-ink border border-slate-700' : 'bg-rose-600 text-accent-ink'}`;

  return (
    <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col items-center justify-center p-3 sm:p-4">
      <div className="relative w-full max-w-md h-full max-h-[calc(100dvh-1.5rem)] sm:max-h-[min(92dvh,56rem)] bg-slate-900 rounded-3xl overflow-hidden border border-slate-800 shadow-2xl flex items-center justify-center">
        {/* Remote media. Always rendered so audio plays in audio-only calls too. */}
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className={isVideo && remoteStream ? 'absolute inset-0 w-full h-full object-cover' : 'hidden'}
        />

        {!(isVideo && remoteStream) && (
          <div className="flex flex-col items-center text-center p-8">
            <div className="w-24 h-24 rounded-full bg-cyan-500/15 text-cyan-400 flex items-center justify-center mb-5 ring-8 ring-cyan-500/10">
              {call.status === 'ringing' ? <Radio className="w-10 h-10 animate-pulse" /> : <Phone className="w-10 h-10" />}
            </div>
            <h3 className="text-xl font-bold text-white">{call.peerName}</h3>
            <p className="text-sm font-mono text-cyan-400 mt-1">{statusText}</p>
            <p className="text-[11px] text-slate-500 mt-3">{isVideo ? 'Video call' : 'Audio call'}</p>
          </div>
        )}

        {isVideo && remoteStream && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-md px-3 py-1 rounded-full text-xs font-mono text-fixed-white">
            {statusText}
          </div>
        )}

        {isVideo && (
          <div className="absolute top-4 right-4 w-24 h-36 sm:w-28 sm:h-44 rounded-2xl overflow-hidden border-2 border-slate-700/80 shadow-2xl bg-slate-950">
            <video ref={localRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100" />
            {!camOn && (
              <div className="absolute inset-0 bg-slate-950/90 flex items-center justify-center">
                <VideoOff className="w-5 h-5 text-slate-500" />
              </div>
            )}
          </div>
        )}

        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 py-3 px-5 bg-slate-900/90 backdrop-blur-md border border-slate-800 flex items-center gap-4 rounded-full shadow-2xl">
          <button onClick={onToggleMic} className={round(micOn)} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}>
            {micOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>
          {isVideo && (
            <button onClick={onToggleCam} className={round(camOn)} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}>
              {camOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
            </button>
          )}
          <button
            onClick={onEnd}
            className="px-5 h-12 rounded-full bg-rose-600 hover:bg-rose-500 text-accent-ink font-semibold text-xs flex items-center gap-2 shadow-lg shadow-rose-600/30"
            aria-label="End call"
          >
            <PhoneOff className="w-4 h-4" />
            <span>{call.status === 'ringing' ? 'Cancel' : 'End call'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
