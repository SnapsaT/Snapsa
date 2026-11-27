// src/SnapsaCall.jsx — simple 1-to-1 voice and video calls (plain WebRTC, no extra layers).
// Signalling goes through the server: POST /snapsa/call/signal, answers arrive on the existing
// realtime socket as { type:'call_signal', ... } which SnapsaApp re-dispatches as 'snapsa:callSignal'.
// Start a call from anywhere with:  window.dispatchEvent(new CustomEvent('snapsa:startCall', { detail:{ userId, name, video } }))
import React, { useEffect, useRef, useState, useCallback } from 'react';
import SnapsaCallScreen from './SnapsaCalls';
import ringbackUrl from './assets/ringback.mp3';
import endcallUrl from './assets/endcall.mp3';

// Device ringtone for incoming calls (native Android plugin added by android-setup/apply.mjs); falls back to the in-app ping elsewhere
let _ringPlugin = null;
const nativeRing = async (on) => {
  try {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return false;
    if (!_ringPlugin) _ringPlugin = registerPlugin('SnapsaRingtone');
    if (on) await _ringPlugin.start(); else await _ringPlugin.stop();
    return true;
  } catch { return false; }
};
const ATTEMPTS_KEY = 'snapsa_call_attempts';
const OFFLINE_RING_MS = 10000;

const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const RING_TIMEOUT_MS = 40000;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function SnapsaCallHost({ snapFetch, playPing, showToast }) {
  const [call, setCall] = useState(null);      // what the screen shows
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [secs, setSecs] = useState(0);
  const [speaker, setSpeaker] = useState(true);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const callRef = useRef(null);                // live call data (never stale)
  const pcRef = useRef(null);
  const localRef = useRef(null);               // local MediaStream
  const remoteStreamRef = useRef(null);
  const remoteEl = useRef(null);
  const localEl = useRef(null);
  const pendingIce = useRef([]);
  const offerSdp = useRef(null);
  const ringTimer = useRef(null);
  const ringTone = useRef(null);
  const tick = useRef(null);
  const ringback = useRef(null);
  const nativeRinging = useRef(false);

  const post = useCallback(async (to, callId, type, extra = {}, callType = 'audio') => {
    try {
      const res = await snapFetch('/snapsa/call/signal', { method: 'POST', body: JSON.stringify({ to, callId, type, callType, ...extra }) });
      return res.ok ? await res.json().catch(() => ({})) : null;
    } catch { return null; }
  }, [snapFetch]);

  const stopRingback = () => { try { ringback.current?.pause(); } catch {} ringback.current = null; };
  const startRingback = () => { stopRingback(); try { const a = new Audio(ringbackUrl); a.loop = true; a.volume = 0.8; ringback.current = a; a.play().catch(() => {}); } catch {} };
  const stopRinging = () => { if (nativeRinging.current) { nativeRinging.current = false; nativeRing(false); } };
  const playEnd = () => { try { const a = new Audio(endcallUrl); a.volume = 0.9; a.play().catch(() => {}); } catch {} };
  const stopTimers = () => {
    stopRingback(); stopRinging();
    clearTimeout(ringTimer.current); ringTimer.current = null;
    clearInterval(ringTone.current); ringTone.current = null;
    clearInterval(tick.current); tick.current = null;
  };

  const cleanup = useCallback((note) => {
    stopTimers();
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    try { localRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    localRef.current = null; remoteStreamRef.current = null; setLocalStream(null); setRemoteStream(null);
    pendingIce.current = []; offerSdp.current = null;
    const was = callRef.current;
    callRef.current = null;
    setMuted(false); setCamOff(false);
    if (was) {
      playEnd();
      setCall(c => (c ? { ...c, status: 'ended', note: note || 'Call ended' } : c));
      setTimeout(() => setCall(null), 1400);
    }
  }, []);

  const getMedia = async (video) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
      });
      localRef.current = stream; setLocalStream(stream);
      return stream;
    } catch {
      showToast?.(video ? 'Camera and microphone access is needed for video calls' : 'Microphone access is needed for calls', 'error');
      return null;
    }
  };

  const makePc = async (c) => {
    let iceServers = FALLBACK_ICE;
    try {
      const r = await snapFetch('/snapsa/call/ice');
      const d = r.ok ? await r.json() : null;
      if (d?.iceServers?.length) iceServers = d.iceServers;
    } catch {}
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    localRef.current?.getTracks().forEach(t => pc.addTrack(t, localRef.current));
    pc.onicecandidate = (e) => {
      if (e.candidate) post(c.peerId, c.id, 'ice', { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }, c.video ? 'video' : 'audio');
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      remoteStreamRef.current = stream; setRemoteStream(stream);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected' && callRef.current) {
        clearTimeout(ringTimer.current); clearInterval(ringTone.current); stopRingback();
        setCall(cc => (cc ? { ...cc, status: 'active' } : cc));
        if (!tick.current) { const t0 = Date.now(); setSecs(0); tick.current = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000); }
      } else if (s === 'failed') {
        const cur = callRef.current; if (cur) post(cur.peerId, cur.id, 'end', {}, cur.video ? 'video' : 'audio');
        cleanup('Connection lost');
      }
    };
    return pc;
  };

  const queueAttempt = (c) => {
    try {
      const list = JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || '[]');
      list.push({ to: c.peerId, callType: c.video ? 'video' : 'audio', callId: c.id, at: Date.now() });
      localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(list.slice(-20)));
    } catch {}
  };
  const flushAttempts = useCallback(async () => {
    if (!navigator.onLine) return;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || '[]'); } catch {}
    if (!list.length) return;
    const left = [];
    for (const a of list) {
      try { const r = await snapFetch('/snapsa/call/attempt', { method: 'POST', body: JSON.stringify(a) }); if (!r.ok && r.status >= 500) left.push(a); } catch { left.push(a); }
    }
    try { localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(left)); } catch {}
  }, [snapFetch]);
  const offlineAttempt = (c) => {
    clearTimeout(ringTimer.current);
    ringTimer.current = setTimeout(() => {
      if (callRef.current?.id !== c.id) return;
      queueAttempt(c); flushAttempts();
      cleanup('No connection');
    }, OFFLINE_RING_MS);
  };

  const startCall = useCallback(async ({ userId, name, video, avatar }) => {
    if (callRef.current) { showToast?.('You are already in a call', 'info'); return; }
    const c = { id: newId(), peerId: String(userId), peerName: name || 'Snapsa user', avatar: avatar || '', video: !!video, dir: 'out', status: 'ringing' };
    callRef.current = c; setCall({ ...c, note: '' });
    startRingback();
    // No connection: it still rings for 10 s, then ends and the attempt is sent as soon as you are back online
    if (!navigator.onLine) { offlineAttempt(c); return; }
    const stream = await getMedia(c.video);
    if (!stream) { cleanup('Could not start the call'); return; }
    try {
      const pc = await makePc(c);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const r = await post(c.peerId, c.id, 'offer', { sdp: offer.sdp }, c.video ? 'video' : 'audio');
      if (!r) { offlineAttempt(c); return; }
      if (r.delivered === false && !r.queued) { cleanup(`${c.peerName} is not available right now`); return; }
      ringTimer.current = setTimeout(() => {
        const cur = callRef.current;
        if (cur && cur.id === c.id) { post(cur.peerId, cur.id, 'end', {}, cur.video ? 'video' : 'audio'); cleanup('No answer'); }
      }, RING_TIMEOUT_MS);
    } catch { cleanup('Could not start the call'); }
  }, [cleanup, post]);

  const accept = async () => {
    const c = callRef.current; if (!c || c.dir !== 'in') return;
    clearInterval(ringTone.current); stopRinging();
    setCall(cc => (cc ? { ...cc, status: 'connecting' } : cc));
    const stream = await getMedia(c.video);
    if (!stream) { await post(c.peerId, c.id, 'decline', {}, c.video ? 'video' : 'audio'); cleanup('Call declined'); return; }
    try {
      const pc = await makePc(c);
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp.current });
      for (const cand of pendingIce.current) { try { await pc.addIceCandidate(cand); } catch {} }
      pendingIce.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await post(c.peerId, c.id, 'answer', { sdp: answer.sdp }, c.video ? 'video' : 'audio');
    } catch { cleanup('Could not connect'); }
  };
  const decline = async () => { const c = callRef.current; if (c) await post(c.peerId, c.id, 'decline', {}, c.video ? 'video' : 'audio'); cleanup('Call declined'); };
  const hangup = async () => { const c = callRef.current; if (c) await post(c.peerId, c.id, 'end', {}, c.video ? 'video' : 'audio'); cleanup('Call ended'); };

  // The "snapsa_calls_v2" channel (device ringtone) is created natively by android-setup/apply.mjs at build time.
  // Send any call attempts that were made while offline
  useEffect(() => {
    flushAttempts();
    window.addEventListener('online', flushAttempts);
    return () => window.removeEventListener('online', flushAttempts);
  }, [flushAttempts]);

  // incoming signals
  useEffect(() => {
    const onSignal = async (e) => {
      const m = e.detail || {};
      const c = callRef.current;
      if (m.signal === 'offer') {
        if (c) { post(String(m.from), m.callId, 'busy', {}, m.callType); return; }
        const inc = { id: m.callId, peerId: String(m.from), peerName: m.fromName || 'Snapsa user', avatar: m.fromAvatar || '', video: m.callType === 'video', dir: 'in', status: 'incoming' };
        callRef.current = inc; offerSdp.current = m.sdp; pendingIce.current = [];
        setCall({ ...inc, note: '' });
        nativeRing(true).then(ok => {
          if (ok && callRef.current?.id === inc.id) { nativeRinging.current = true; return; }
          if (callRef.current?.id !== inc.id) { nativeRing(false); return; }
          playPing?.();
          ringTone.current = setInterval(() => playPing?.(), 1800);
        });
        ringTimer.current = setTimeout(() => { if (callRef.current?.id === inc.id) cleanup('Missed call'); }, RING_TIMEOUT_MS + 3000);
        return;
      }
      if (!c || c.id !== m.callId) return;
      if (m.signal === 'answer' && pcRef.current) {
        try {
          await pcRef.current.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          for (const cand of pendingIce.current) { try { await pcRef.current.addIceCandidate(cand); } catch {} }
          pendingIce.current = [];
          setCall(cc => (cc ? { ...cc, status: 'connecting' } : cc));
        } catch {}
      } else if (m.signal === 'ice' && m.candidate) {
        if (pcRef.current?.remoteDescription) { try { await pcRef.current.addIceCandidate(m.candidate); } catch {} }
        else pendingIce.current.push(m.candidate);
      } else if (m.signal === 'decline') cleanup('Call declined');
      else if (m.signal === 'busy') cleanup(`${c.peerName} is on another call`);
      else if (m.signal === 'end') cleanup(c.status === 'incoming' ? 'Missed call' : 'Call ended');
    };
    const onStart = (e) => startCall(e.detail || {});
    window.addEventListener('snapsa:callSignal', onSignal);
    window.addEventListener('snapsa:startCall', onStart);
    return () => { window.removeEventListener('snapsa:callSignal', onSignal); window.removeEventListener('snapsa:startCall', onStart); };
  }, [cleanup, post, playPing, startCall]);

  useEffect(() => () => { stopTimers(); try { pcRef.current?.close(); localRef.current?.getTracks().forEach(t => t.stop()); } catch {} }, []);

  const toggleMute = () => { const t = localRef.current?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; setMuted(!t.enabled); } };
  const toggleCam = () => { const t = localRef.current?.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; setCamOff(!t.enabled); } };

  if (!call) return null;
  return (
    <SnapsaCallScreen call={call} secs={secs} muted={muted} camOff={camOff} speaker={speaker}
      localStream={localStream} remoteStream={remoteStream}
      onMute={toggleMute} onCamera={toggleCam} onSpeaker={() => setSpeaker(v => !v)}
      onEnd={hangup} onAnswer={accept} onDecline={decline} />
  );
}
