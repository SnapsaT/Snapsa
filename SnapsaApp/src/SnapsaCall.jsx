// src/SnapsaCall.jsx — simple 1-to-1 voice and video calls (plain WebRTC, no extra layers).
// Signalling goes through the server: POST /snapsa/call/signal, answers arrive on the existing
// realtime socket as { type:'call_signal', ... } which SnapsaApp re-dispatches as 'snapsa:callSignal'.
// Start a call from anywhere with:  window.dispatchEvent(new CustomEvent('snapsa:startCall', { detail:{ userId, name, video } }))
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react';

const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const RING_TIMEOUT_MS = 40000;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function SnapsaCallHost({ snapFetch, playPing, showToast }) {
  const [call, setCall] = useState(null);      // what the screen shows
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [secs, setSecs] = useState(0);

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

  const post = useCallback(async (to, callId, type, extra = {}, callType = 'audio') => {
    try {
      const res = await snapFetch('/snapsa/call/signal', { method: 'POST', body: JSON.stringify({ to, callId, type, callType, ...extra }) });
      return res.ok ? await res.json().catch(() => ({})) : null;
    } catch { return null; }
  }, [snapFetch]);

  const stopTimers = () => {
    clearTimeout(ringTimer.current); ringTimer.current = null;
    clearInterval(ringTone.current); ringTone.current = null;
    clearInterval(tick.current); tick.current = null;
  };

  const cleanup = useCallback((note) => {
    stopTimers();
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    try { localRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    localRef.current = null; remoteStreamRef.current = null;
    pendingIce.current = []; offerSdp.current = null;
    const was = callRef.current;
    callRef.current = null;
    setMuted(false); setCamOff(false);
    if (was) {
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
      localRef.current = stream;
      if (localEl.current) localEl.current.srcObject = stream;
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
      remoteStreamRef.current = stream;
      if (remoteEl.current && remoteEl.current.srcObject !== stream) { remoteEl.current.srcObject = stream; remoteEl.current.play?.().catch(() => {}); }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected' && callRef.current) {
        clearTimeout(ringTimer.current); clearInterval(ringTone.current);
        setCall(cc => (cc ? { ...cc, status: 'active' } : cc));
        if (!tick.current) { const t0 = Date.now(); setSecs(0); tick.current = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000); }
      } else if (s === 'failed') {
        const cur = callRef.current; if (cur) post(cur.peerId, cur.id, 'end', {}, cur.video ? 'video' : 'audio');
        cleanup('Connection lost');
      }
    };
    return pc;
  };

  const startCall = useCallback(async ({ userId, name, video }) => {
    if (callRef.current) { showToast?.('You are already in a call', 'info'); return; }
    if (!navigator.onLine) { showToast?.('You need to be online to call', 'error'); return; }
    const c = { id: newId(), peerId: String(userId), peerName: name || 'Snapsa user', video: !!video, dir: 'out', status: 'ringing' };
    callRef.current = c; setCall({ ...c, note: '' });
    const stream = await getMedia(c.video);
    if (!stream) { cleanup('Could not start the call'); return; }
    try {
      const pc = await makePc(c);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const r = await post(c.peerId, c.id, 'offer', { sdp: offer.sdp }, c.video ? 'video' : 'audio');
      if (!r) { cleanup('Could not reach them'); return; }
      if (r.delivered === false && !r.queued) { cleanup(`${c.peerName} is not available right now`); return; }
      ringTimer.current = setTimeout(() => {
        const cur = callRef.current;
        if (cur && cur.id === c.id) { post(cur.peerId, cur.id, 'end', {}, cur.video ? 'video' : 'audio'); cleanup('No answer'); }
      }, RING_TIMEOUT_MS);
    } catch { cleanup('Could not start the call'); }
  }, [cleanup, post]);

  const accept = async () => {
    const c = callRef.current; if (!c || c.dir !== 'in') return;
    clearInterval(ringTone.current);
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

  // Channel for the "Incoming call" push (rings even when the app is closed)
  useEffect(() => {
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { PushNotifications } = await import('@capacitor/push-notifications');
        await PushNotifications.createChannel({ id: 'snapsa_calls_v1', name: 'Calls', description: 'Incoming Snapsa calls', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#FF2D95', sound: 'snapsa_ping' });
      } catch {}
    })();
  }, []);

  // incoming signals
  useEffect(() => {
    const onSignal = async (e) => {
      const m = e.detail || {};
      const c = callRef.current;
      if (m.signal === 'offer') {
        if (c) { post(String(m.from), m.callId, 'busy', {}, m.callType); return; }
        const inc = { id: m.callId, peerId: String(m.from), peerName: m.fromName || 'Snapsa user', video: m.callType === 'video', dir: 'in', status: 'incoming' };
        callRef.current = inc; offerSdp.current = m.sdp; pendingIce.current = [];
        setCall({ ...inc, note: '' });
        playPing?.();
        ringTone.current = setInterval(() => playPing?.(), 1800);
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
  const active = call.status === 'active';
  const showVideo = call.video && (active || call.status === 'connecting');
  const statusText = call.status === 'incoming' ? `Incoming ${call.video ? 'video' : 'voice'} call`
    : call.status === 'ringing' ? 'Calling…'
    : call.status === 'connecting' ? 'Connecting…'
    : active ? mmss(secs) : (call.note || 'Call ended');
  const btn = (bg) => ({ width: 58, height: 58, borderRadius: '50%', border: 'none', background: bg, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'linear-gradient(160deg,#05020a,#12061f 55%,#2b0f52)', color: 'white' }}>
      <video ref={el => { remoteEl.current = el; if (el && remoteStreamRef.current && el.srcObject !== remoteStreamRef.current) el.srcObject = remoteStreamRef.current; }}
        autoPlay playsInline
        style={showVideo ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } : { position: 'absolute', width: 1, height: 1, opacity: 0 }} />
      {showVideo && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,rgba(0,0,0,.55),transparent 28%,transparent 70%,rgba(0,0,0,.65))' }} />}

      <div style={{ position: 'relative', marginTop: 'calc(env(safe-area-inset-top,0px) + 70px)', textAlign: 'center', padding: '0 24px' }}>
        {!showVideo && (
          <div style={{ width: 110, height: 110, borderRadius: '50%', margin: '0 auto 18px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 44, fontWeight: 800, background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', boxShadow: '0 0 40px rgba(180,76,255,.6)' }}>
            {(call.peerName || '?')[0].toUpperCase()}
          </div>
        )}
        <div style={{ fontSize: 24, fontWeight: 800 }}>{call.peerName}</div>
        <div style={{ marginTop: 6, fontSize: 14, color: 'rgba(255,255,255,.75)' }}>{statusText}</div>
      </div>

      {call.video && (
        <video ref={el => { localEl.current = el; if (el && localRef.current && el.srcObject !== localRef.current) el.srcObject = localRef.current; }}
          autoPlay playsInline muted
          style={{ position: 'absolute', right: 14, top: 'calc(env(safe-area-inset-top,0px) + 14px)', width: 96, height: 136, objectFit: 'cover', borderRadius: 14, border: '2px solid rgba(255,255,255,.35)', background: '#000', transform: 'scaleX(-1)', opacity: camOff ? 0.25 : 1, zIndex: 2 }} />
      )}

      <div style={{ flex: 1 }} />
      <div style={{ position: 'relative', display: 'flex', gap: 22, alignItems: 'center', marginBottom: 'calc(env(safe-area-inset-bottom,0px) + 48px)' }}>
        {call.status === 'incoming' ? (
          <>
            <button onClick={decline} aria-label="Decline" style={{ ...btn('#e11d48'), width: 68, height: 68 }}><PhoneOff size={28} /></button>
            <button onClick={accept} aria-label="Answer" style={{ ...btn('#16a34a'), width: 68, height: 68 }}>{call.video ? <Video size={28} /> : <Phone size={28} />}</button>
          </>
        ) : call.status === 'ended' ? null : (
          <>
            <button onClick={toggleMute} aria-label="Mute" style={btn(muted ? '#e11d48' : 'rgba(255,255,255,.18)')}>{muted ? <MicOff size={24} /> : <Mic size={24} />}</button>
            {call.video && <button onClick={toggleCam} aria-label="Camera" style={btn(camOff ? '#e11d48' : 'rgba(255,255,255,.18)')}>{camOff ? <VideoOff size={24} /> : <Video size={24} />}</button>}
            <button onClick={hangup} aria-label="End call" style={{ ...btn('#e11d48'), width: 68, height: 68 }}><PhoneOff size={28} /></button>
          </>
        )}
      </div>
    </div>
  );
}
