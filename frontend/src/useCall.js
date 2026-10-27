import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// STUN público por padrão; para redes restritivas defina VITE_ICE_SERVERS (JSON) com um servidor TURN.
function iceServers() {
  try {
    if (import.meta.env.VITE_ICE_SERVERS) return JSON.parse(import.meta.env.VITE_ICE_SERVERS);
  } catch {}
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

const RING_TIMEOUT_MS = 30_000;

// Chamada de áudio 1:1 via WebRTC. status: 'idle' | 'calling' | 'incoming' | 'connecting' | 'active'
export function useCall() {
  const [call, setCall] = useState({ peer: null, status: 'idle', muted: false, error: '', sharing: false, remoteScreen: null });
  const ref = useRef({ peer: null, status: 'idle', pc: null, stream: null, pending: [], timer: null, polite: false, ready: false, making: false, screen: null, sender: null });
  const audio = useRef(null);

  const patch = (p) => setCall((c) => ({ ...c, ...p }));
  const signal = (type, data) => {
    const peer = ref.current.peer;
    if (peer) api.callSignal(peer, type, data).catch(() => {});
  };

  const cleanup = useCallback((error = '') => {
    const r = ref.current;
    clearTimeout(r.timer);
    r.pc?.close();
    r.stream?.getTracks().forEach((t) => t.stop());
    r.screen?.getTracks().forEach((t) => t.stop());
    if (audio.current) audio.current.srcObject = null;
    Object.assign(r, { peer: null, status: 'idle', pc: null, stream: null, pending: [], timer: null, ready: false, making: false, screen: null, sender: null });
    setCall({ peer: null, status: 'idle', muted: false, error, sharing: false, remoteScreen: null });
  }, []);

  const setStatus = (status) => { ref.current.status = status; patch({ status }); };

  const negotiate = async () => {
    const r = ref.current;
    const pc = r.pc;
    try {
      r.making = true;
      await pc.setLocalDescription();
      signal('offer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    } catch {
      // renegociação falhou; a chamada de áudio segue como estava
    } finally {
      r.making = false;
    }
  };

  const makePeer = async () => {
    const r = ref.current;
    r.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    r.pc = pc;
    r.stream.getTracks().forEach((t) => pc.addTrack(t, r.stream));
    pc.onicecandidate = (e) => e.candidate && signal('ice', e.candidate.toJSON());
    pc.onnegotiationneeded = () => { if (r.ready && pc === r.pc) negotiate(); };
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        if (audio.current) {
          audio.current.srcObject = e.streams[0];
          audio.current.play().catch(() => {});
        }
        return;
      }
      // tela do outro lado: a trilha nasce "muted" e só passa a valer quando o vídeo começa a chegar
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      const show = () => patch({ remoteScreen: stream });
      const hide = () => patch({ remoteScreen: null });
      e.track.onunmute = show;
      e.track.onmute = hide;
      e.track.onended = hide;
      stream.onremovetrack = hide;
      if (!e.track.muted) show();
    };
    pc.onconnectionstatechange = () => {
      if (pc !== r.pc) return;
      if (pc.connectionState === 'connected') setStatus('active');
      if (pc.connectionState === 'failed') { signal('end'); cleanup('A conexão da chamada falhou'); }
      if (pc.connectionState === 'disconnected') {
        // pode se recuperar sozinha; dá alguns segundos antes de desistir
        setTimeout(() => {
          if (pc === r.pc && pc.connectionState === 'disconnected') { signal('end'); cleanup('Chamada interrompida'); }
        }, 8000);
      }
    };
    return pc;
  };

  const micError = (err) =>
    err?.name === 'NotAllowedError' ? 'Permissão do microfone negada' : 'Não foi possível acessar o microfone';

  const start = useCallback(async (peer) => {
    const r = ref.current;
    if (r.status !== 'idle') return;
    Object.assign(r, { peer, status: 'calling', polite: false });
    setCall({ peer, status: 'calling', muted: false, error: '' });
    try {
      await makePeer();
    } catch (err) {
      cleanup(micError(err));
      return;
    }
    signal('invite');
    r.timer = setTimeout(() => { signal('end'); cleanup('Sem resposta'); }, RING_TIMEOUT_MS);
  }, [cleanup]);

  const accept = useCallback(async () => {
    const r = ref.current;
    if (r.status !== 'incoming') return;
    clearTimeout(r.timer);
    r.polite = true;
    setStatus('connecting');
    try {
      await makePeer();
    } catch (err) {
      signal('reject');
      cleanup(micError(err));
      return;
    }
    signal('accept');
  }, [cleanup]);

  const hangup = useCallback(() => {
    const r = ref.current;
    if (r.status === 'idle') { patch({ error: '' }); return; }
    signal(r.status === 'incoming' ? 'reject' : 'end');
    cleanup();
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    const r = ref.current;
    const track = r.stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    patch({ muted: !track.enabled });
  }, []);

  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  const stopShare = useCallback(() => {
    const r = ref.current;
    if (!r.screen) return;
    if (r.sender && r.pc && r.pc.signalingState !== 'closed') r.pc.removeTrack(r.sender);
    r.screen.getTracks().forEach((t) => t.stop());
    r.screen = null;
    r.sender = null;
    patch({ sharing: false });
  }, []);

  const startShare = useCallback(async () => {
    const r = ref.current;
    if (!r.pc || r.screen || r.status !== 'active') return;
    patch({ error: '' });
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = screen.getVideoTracks()[0];
      track.contentHint = 'detail';
      track.onended = stopShare; // botão "parar de compartilhar" do próprio navegador
      r.screen = screen;
      r.sender = r.pc.addTrack(track, screen); // dispara a renegociação
      patch({ sharing: true });
    } catch (err) {
      if (err?.name !== 'NotAllowedError') patch({ error: 'Não foi possível compartilhar a tela' });
    }
  }, [stopShare]);

  const addIce = async (candidate) => {
    const r = ref.current;
    if (!r.pc?.remoteDescription) { r.pending.push(candidate); return; }
    await r.pc.addIceCandidate(candidate).catch(() => {});
  };

  // Chamado com cada evento `call` recebido pelo WebSocket.
  const handle = useCallback(async ({ from, signal: s }) => {
    const r = ref.current;
    if (s.type === 'invite') {
      if (r.status !== 'idle') {
        if (r.peer !== from) api.callSignal(from, 'busy').catch(() => {});
        return;
      }
      Object.assign(r, { peer: from, status: 'incoming' });
      setCall({ peer: from, status: 'incoming', muted: false, error: '' });
      r.timer = setTimeout(() => cleanup(), RING_TIMEOUT_MS);
      return;
    }
    if (from !== r.peer) return; // sinais de quem não é o par da chamada atual
    try {
      switch (s.type) {
        case 'accept': {
          clearTimeout(r.timer);
          setStatus('connecting');
          r.ready = true;
          await negotiate();
          break;
        }
        case 'offer': {
          if (!r.pc) return;
          // ofertas simultâneas: o lado "não educado" (quem ligou) ignora a do outro
          if (!r.polite && (r.making || r.pc.signalingState !== 'stable')) return;
          r.ready = true;
          await r.pc.setRemoteDescription(s.data);
          for (const c of r.pending.splice(0)) await r.pc.addIceCandidate(c).catch(() => {});
          await r.pc.setLocalDescription();
          signal('answer', { type: r.pc.localDescription.type, sdp: r.pc.localDescription.sdp });
          break;
        }
        case 'answer':
          if (!r.pc || r.pc.signalingState !== 'have-local-offer') return;
          await r.pc.setRemoteDescription(s.data);
          for (const c of r.pending.splice(0)) await r.pc.addIceCandidate(c).catch(() => {});
          break;
        case 'ice':
          if (s.data) await addIce(s.data);
          break;
        case 'reject': cleanup(`${from} recusou a chamada`); break;
        case 'busy': cleanup(`${from} está em outra chamada`); break;
        case 'end': cleanup(r.status === 'incoming' ? 'Chamada perdida' : ''); break;
      }
    } catch {
      signal('end');
      cleanup('Falha ao estabelecer a chamada');
    }
  }, [cleanup]);

  // Encerra a chamada ao fechar a aba.
  useEffect(() => {
    const bye = () => { if (ref.current.status !== 'idle') hangup(); };
    window.addEventListener('pagehide', bye);
    return () => { window.removeEventListener('pagehide', bye); bye(); };
  }, [hangup]);

  return { call, audio, canShare, start, accept, hangup, toggleMute, startShare, stopShare, handle };
}
