import { useCallback, useEffect, useRef, useState } from 'react';
import type { KiteSocket } from './socket';
import { api } from './api.ts';
import type { CallType, Friend, IncomingCall } from './types.ts';

export type CallStatus = 'ringing' | 'connecting' | 'connected';

export interface ActiveCall {
  roomId: string;
  type: CallType;
  peerId: string;
  peerName: string;
  status: CallStatus;
  isCaller: boolean;
}

type Ack = { ok: boolean; error?: string; peers?: string[] };
type SignalData =
  | { type: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

const RING_TIMEOUT_MS = 45_000;

/**
 * 1:1 WebRTC calling on top of the socket signalling channel.
 * Flow: caller gets media -> invites -> joins the room and waits.
 *       callee accepts -> gets media -> joins -> creates the offer to the caller.
 */
export function useCall(socket: KiteSocket | null) {
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');

  const socketRef = useRef<KiteSocket | null>(socket);
  socketRef.current = socket;
  const callRef = useRef<ActiveCall | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const peerSocketRef = useRef<string | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const iceRef = useRef<RTCIceServer[] | null>(null);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateCall = (c: ActiveCall | null) => {
    callRef.current = c;
    setCall(c);
  };
  const updateIncoming = (c: IncomingCall | null) => {
    incomingRef.current = c;
    setIncoming(c);
  };
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  };

  const emitAck = (event: string, payload: unknown) =>
    new Promise<Ack>(resolve => {
      const s = socketRef.current;
      if (!s || !s.connected) return resolve({ ok: false, error: 'Not connected to server' });
      const t = setTimeout(() => resolve({ ok: false, error: 'Server did not respond' }), 8000);
      s.emit(event, payload, (r: Ack) => {
        clearTimeout(t);
        resolve(r);
      });
    });

  const teardown = useCallback(() => {
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    peerSocketRef.current = null;
    pendingIce.current = [];
    localRef.current?.getTracks().forEach(t => t.stop());
    localRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    callRef.current = null;
    setCall(null);
    setSeconds(0);
    setMicOn(true);
    setCamOn(true);
  }, []);

  const endCall = useCallback(() => {
    const c = callRef.current;
    const s = socketRef.current;
    if (c && s) {
      if (c.isCaller && c.status === 'ringing') s.emit('call-cancel', { roomId: c.roomId });
      s.emit('leave-room');
    }
    teardown();
  }, [teardown]);

  const ensureIce = async () => {
    if (iceRef.current) return;
    try {
      const { iceServers } = await api<{ iceServers: RTCIceServer[] }>('/api/ice');
      iceRef.current = iceServers;
    } catch {
      iceRef.current = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  };

  const getMedia = async (type: CallType) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Calls need HTTPS and a browser with camera/microphone support');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
      });
    } catch {
      throw new Error(
        type === 'video' ? 'Could not access camera/microphone. Check permissions.' : 'Could not access microphone. Check permissions.'
      );
    }
  };

  const sendSignal = (to: string, data: SignalData) => socketRef.current?.emit('signal', { to, data });

  const createPeer = (remoteId: string) => {
    pcRef.current?.close();
    pendingIce.current = [];
    const pc = new RTCPeerConnection({ iceServers: iceRef.current ?? [] });
    pcRef.current = pc;
    peerSocketRef.current = remoteId;

    const local = localRef.current;
    local?.getTracks().forEach(t => pc.addTrack(t, local));

    pc.onicecandidate = e => {
      if (e.candidate) sendSignal(remoteId, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = e => {
      setRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      if (pc.connectionState === 'connected') {
        const c = callRef.current;
        if (c) updateCall({ ...c, status: 'connected' });
      } else if (pc.connectionState === 'failed') {
        showNotice('Call connection failed. A TURN server may be needed for this network.');
        endCall();
      }
    };
    return pc;
  };

  const flushIce = async (pc: RTCPeerConnection) => {
    const queued = pendingIce.current;
    pendingIce.current = [];
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch (e) {
        console.warn('addIceCandidate failed', e);
      }
    }
  };

  const failStart = (e: unknown) => {
    if (callRef.current) endCall();
    else teardown();
    showNotice(e instanceof Error ? e.message : 'Could not start the call');
  };

  const startCall = useCallback(
    async (friend: Friend, type: CallType) => {
      if (callRef.current || incomingRef.current) return;
      try {
        await ensureIce();
        const stream = await getMedia(type);
        localRef.current = stream;
        setLocalStream(stream);
        setCamOn(type === 'video');
        const roomId = `CALL-${crypto.randomUUID()}`;
        updateCall({ roomId, type, peerId: friend.userId, peerName: friend.name, status: 'ringing', isCaller: true });

        const inv = await emitAck('call-invite', { recipientId: friend.userId, roomId, type });
        if (!inv.ok) throw new Error(inv.error || 'Could not reach friend');
        const join = await emitAck('join-room', { roomId });
        if (!join.ok) throw new Error(join.error || 'Could not join call');

        ringTimer.current = setTimeout(() => {
          if (callRef.current?.status === 'ringing') {
            showNotice(`${friend.name} didn't answer`);
            endCall();
          }
        }, RING_TIMEOUT_MS);
      } catch (e) {
        failStart(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endCall, teardown]
  );

  const acceptCall = useCallback(async () => {
    const inc = incomingRef.current;
    if (!inc || callRef.current) return;
    updateIncoming(null);
    try {
      await ensureIce();
      const stream = await getMedia(inc.type);
      localRef.current = stream;
      setLocalStream(stream);
      setCamOn(inc.type === 'video');
      updateCall({
        roomId: inc.roomId,
        type: inc.type,
        peerId: inc.callerId,
        peerName: inc.callerName,
        status: 'connecting',
        isCaller: false
      });
      const join = await emitAck('join-room', { roomId: inc.roomId });
      if (!join.ok) throw new Error(join.error || 'Call is no longer available');
      // Newcomer makes the offer to whoever is already waiting in the room.
      const target = join.peers?.[0];
      if (target) {
        const pc = createPeer(target);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(target, { type: 'offer', sdp: offer });
      }
    } catch (e) {
      failStart(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endCall, teardown]);

  const declineCall = useCallback(() => {
    const inc = incomingRef.current;
    if (!inc) return;
    socketRef.current?.emit('call-decline', { roomId: inc.roomId });
    updateIncoming(null);
  }, []);

  const toggleMic = useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() ?? [];
    const next = !tracks.some(t => t.enabled);
    tracks.forEach(t => (t.enabled = next));
    setMicOn(next);
  }, []);

  const toggleCam = useCallback(() => {
    const tracks = localRef.current?.getVideoTracks() ?? [];
    if (!tracks.length) return;
    const next = !tracks.some(t => t.enabled);
    tracks.forEach(t => (t.enabled = next));
    setCamOn(next);
  }, []);

  // Signalling listeners: registered once per socket, they only read refs.
  useEffect(() => {
    if (!socket) return;

    const onIncoming = (inc: IncomingCall) => {
      if (callRef.current || incomingRef.current) {
        socket.emit('call-decline', { roomId: inc.roomId });
        return;
      }
      updateIncoming(inc);
    };

    const onCancelled = ({ roomId }: { roomId: string }) => {
      const inc = incomingRef.current;
      if (inc && inc.roomId === roomId) {
        updateIncoming(null);
        showNotice(`Missed call from ${inc.callerName}`);
      }
      const c = callRef.current;
      if (c && c.roomId === roomId && !c.isCaller && c.status !== 'connected') {
        socket.emit('leave-room');
        teardown();
      }
    };

    const onDeclined = ({ roomId, name }: { roomId: string; name?: string }) => {
      const c = callRef.current;
      if (c && c.roomId === roomId && c.isCaller) {
        showNotice(`${name || c.peerName} declined the call`);
        endCall();
      }
    };

    const onPeerLeft = () => {
      const c = callRef.current;
      if (!c) return;
      if (c.status === 'ringing') return;
      showNotice(`${c.peerName} left the call`);
      endCall();
    };

    const onSignal = async ({ from, data }: { from: string; data: SignalData }) => {
      if (!callRef.current) return;
      try {
        if (data.type === 'offer') {
          const c = callRef.current;
          if (c.status === 'ringing') {
            if (ringTimer.current) clearTimeout(ringTimer.current);
            updateCall({ ...c, status: 'connecting' });
          }
          const pc = createPeer(from);
          await pc.setRemoteDescription(data.sdp);
          await flushIce(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(from, { type: 'answer', sdp: answer });
        } else if (data.type === 'answer') {
          const pc = pcRef.current;
          if (!pc || peerSocketRef.current !== from) return;
          await pc.setRemoteDescription(data.sdp);
          await flushIce(pc);
        } else if (data.type === 'candidate') {
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate);
          else pendingIce.current.push(data.candidate);
        }
      } catch (e) {
        console.error('Signalling error', e);
      }
    };

    const onDisconnect = () => {
      if (callRef.current) {
        showNotice('Lost connection to the server');
        teardown();
      }
      updateIncoming(null);
    };

    socket.on('incoming-call', onIncoming);
    socket.on('call-cancelled', onCancelled);
    socket.on('call-declined', onDeclined);
    socket.on('peer-left', onPeerLeft);
    socket.on('signal', onSignal);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('incoming-call', onIncoming);
      socket.off('call-cancelled', onCancelled);
      socket.off('call-declined', onDeclined);
      socket.off('peer-left', onPeerLeft);
      socket.off('signal', onSignal);
      socket.off('disconnect', onDisconnect);
      teardown();
      updateIncoming(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, teardown, endCall]);

  // Call timer
  const connected = call?.status === 'connected';
  useEffect(() => {
    if (!connected) return;
    setSeconds(0);
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [connected]);

  return { incoming, call, localStream, remoteStream, micOn, camOn, seconds, notice, startCall, acceptCall, declineCall, endCall, toggleMic, toggleCam };
}
