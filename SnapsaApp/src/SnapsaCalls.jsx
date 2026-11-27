// src/SnapsaCalls.jsx — Snapsa call screens (voice + video). Pure UI: SnapsaCall.jsx (the host) feeds it state.
// Needs in /public:  SnapsaCallBg.jpg (galaxy + logo background)  and  SnapsaVideoFrame.png (neon frame with a see-through window)
import React, { useEffect, useRef, useState } from 'react';
import './SnapsaCall.css';
import callBgUrl from './assets/SnapsaCallBg.jpg';
import videoFrameUrl from './assets/SnapsaVideoFrame.png';

const MicIcon = ({ off }) => (
  <svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{off && <path d="M3 3l18 18" />}</svg>
);
const SpeakerIcon = ({ off }) => (
  <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3Z" />{!off && <path d="M16 8a5 5 0 0 1 0 8M18.5 5a9 9 0 0 1 0 14" />}{off && <path d="M16 9l5 6M21 9l-5 6" />}</svg>
);
const PhoneIcon = () => (<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></svg>);
const HangIcon = () => (<svg viewBox="0 0 24 24"><path d="M2.5 15.5c5.5-5 13.5-5 19 0l-2.5 3a2 2 0 0 1-2 .5l-3-1a2 2 0 0 1-1.3-1.5h-1.4a2 2 0 0 1-1.3 1.5l-3 1a2 2 0 0 1-2-.5l-2.5-3Z" /></svg>);
const CamIcon = ({ off }) => (<svg viewBox="0 0 24 24"><rect x="2" y="6" width="13" height="12" rx="3" /><path d="M15 10l6-3v10l-6-3" />{off && <path d="M3 3l18 18" />}</svg>);
const ExpandIcon = ({ on }) => (<svg viewBox="0 0 24 24">{on ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}</svg>);

const bars = Array.from({ length: 37 }, (_, i) => ({
  bar: `${Math.max(4, Math.abs(Math.sin(i * 0.48)) * 48 + Math.abs(Math.cos(i * 0.23)) * 20)}px`,
  delay: `${i * 0.045}s`,
}));

function Avatar({ avatar, name }) {
  return (
    <div className="voice-avatar">
      {avatar ? <img src={avatar} alt={name} /> : <span>{(name || '?').charAt(0).toUpperCase()}</span>}
    </div>
  );
}

/* ─────────── VOICE CALL (also used while a video call is ringing) ─────────── */
export function SnapsaVoiceCall({ background = callBgUrl, avatar, name, status = 'Calling…', duration = '00:00', connected = false, incoming = false, muted, speaker, onMute, onSpeaker, onEndCall, onAnswer, onDecline, ended = false }) {
  return (
    <div className="snapsa-voice" style={{ backgroundImage: `url(${background})` }}>
      <div className="voice-shade" />
      <div className="voice-center">
        <div className={`voice-rings ${connected || !ended ? 'active' : ''}`}>
          <div className="voice-ring ring-1" /><div className="voice-ring ring-2" /><div className="voice-ring ring-3" />
          <Avatar avatar={avatar} name={name} />
        </div>
        <h2 className="voice-name">{name}</h2>
        <p className="voice-status">{connected ? duration : status}</p>
        <div className={`voice-wave ${connected || incoming || status.startsWith('Calling') ? 'playing' : ''}`}>
          {bars.map((b, i) => <span key={i} style={{ '--bar': b.bar, '--delay': b.delay }} />)}
        </div>
      </div>
      <div className="voice-controls">
        {incoming ? (
          <>
            <button className="voice-button end-call" onClick={onDecline} aria-label="Decline"><HangIcon /><span>Decline</span></button>
            <button className="voice-button answer-call" onClick={onAnswer} aria-label="Answer"><PhoneIcon /><span>Answer</span></button>
          </>
        ) : ended ? null : (
          <>
            <button className={`voice-button ${muted ? 'selected' : ''}`} onClick={onMute}><MicIcon off={muted} /><span>{muted ? 'Unmute' : 'Mute'}</span></button>
            <button className={`voice-button ${speaker ? 'selected' : ''}`} onClick={onSpeaker}><SpeakerIcon off={!speaker} /><span>Speaker</span></button>
            <button className="voice-button end-call" onClick={onEndCall}><HangIcon /><span>End Call</span></button>
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────── VIDEO CALL ─────────── */
export function SnapsaVideoCall({ name, remoteStream, localStream, duration = '00:00', muted, cameraOff, speaker, onMute, onCamera, onSpeaker, onEndCall }) {
  const remoteRef = useRef(null);
  const localRef = useRef(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { const el = remoteRef.current; if (el && remoteStream && el.srcObject !== remoteStream) { el.srcObject = remoteStream; el.play?.().catch(() => {}); } }, [remoteStream]);
  useEffect(() => { const el = localRef.current; if (el && localStream && el.srcObject !== localStream) el.srcObject = localStream; }, [localStream]);
  useEffect(() => { if (remoteRef.current) remoteRef.current.volume = speaker ? 1 : 0.45; }, [speaker]);

  return (
    <div className={`snapsa-video ${expanded ? 'expanded' : ''}`} style={{ backgroundImage: `url(${callBgUrl})` }}>
      <div className="sv-stage">
        <div className="sv-remote">
          <video ref={remoteRef} autoPlay playsInline />
          {!remoteStream && <div className="sv-wait">Waiting for video…</div>}
        </div>
        <div className="sv-local">
          <video ref={localRef} autoPlay playsInline muted />
          {cameraOff && <div className="sv-camoff">Camera off</div>}
        </div>
        <img className="sv-frame" src={videoFrameUrl} alt="" draggable={false} />
        <div className="sv-name">{name}</div>
        <div className="sv-timer">{duration}</div>
        <button className="sv-btn" style={{ left: '12.2%' }} onClick={onMute} aria-label="Mute"><MicIcon off={muted} /><small>{muted ? 'Unmute' : 'Mute'}</small></button>
        <button className="sv-btn" style={{ left: '30.5%' }} onClick={onCamera} aria-label="Camera"><CamIcon off={cameraOff} /><small>{cameraOff ? 'Start Video' : 'Stop Video'}</small></button>
        <button className="sv-btn sv-end" style={{ left: '50%' }} onClick={onEndCall} aria-label="End call"><HangIcon /><small>End Call</small></button>
        <button className="sv-btn" style={{ left: '69.4%' }} onClick={onSpeaker} aria-label="Speaker"><SpeakerIcon off={!speaker} /><small>Speaker</small></button>
        <button className="sv-btn" style={{ left: '87.7%' }} onClick={() => setExpanded(v => !v)} aria-label="Expand"><ExpandIcon on={expanded} /><small>{expanded ? 'Restore' : 'Expand'}</small></button>
      </div>
    </div>
  );
}

/* Picks the right screen. `call` = { video, status:'incoming'|'ringing'|'connecting'|'active'|'ended', peerName, avatar, note } */
export default function SnapsaCallScreen({ call, secs, muted, camOff, speaker, localStream, remoteStream, onMute, onCamera, onSpeaker, onEnd, onAnswer, onDecline }) {
  const audioRef = useRef(null);
  useEffect(() => { const el = audioRef.current; if (el && remoteStream && el.srcObject !== remoteStream) { el.srcObject = remoteStream; el.play?.().catch(() => {}); } }, [remoteStream]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = speaker ? 1 : 0.45; }, [speaker]);

  const active = call.status === 'active';
  const mm = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const showFrame = call.video && (active || call.status === 'connecting');
  const status = call.status === 'incoming' ? `Incoming ${call.video ? 'video' : 'voice'} call`
    : call.status === 'ringing' ? 'Calling…'
    : call.status === 'connecting' ? 'Connecting…'
    : call.status === 'ended' ? (call.note || 'Call ended') : 'Calling…';

  return (
    <>
      {/* voice calls have no <video>, so remote sound plays through this */}
      {!showFrame && <audio ref={audioRef} autoPlay playsInline />}
      {showFrame ? (
        <SnapsaVideoCall name={call.peerName} remoteStream={remoteStream} localStream={localStream} duration={mm} muted={muted} cameraOff={camOff} speaker={speaker}
          onMute={onMute} onCamera={onCamera} onSpeaker={onSpeaker} onEndCall={onEnd} />
      ) : (
        <SnapsaVoiceCall avatar={call.avatar} name={call.peerName} status={status} duration={mm} connected={active} incoming={call.status === 'incoming'} ended={call.status === 'ended'}
          muted={muted} speaker={speaker} onMute={onMute} onSpeaker={onSpeaker} onEndCall={onEnd} onAnswer={onAnswer} onDecline={onDecline} />
      )}
    </>
  );
}
