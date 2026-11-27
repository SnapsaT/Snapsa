// src/StoryCreator.jsx — "Create Story" screen: suggestions, tool tiles, live preview, backgrounds, caption, Burn, Post.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Type, Image as ImageIcon, Mic, Box, Flame, Send, Music, BarChart3, HelpCircle, RefreshCw } from 'lucide-react';
import { SongPanel, QaPanel, Panel } from './PostExtras';
import { STORY_FONTS, STORY_BG_GRADIENTS, buildStorySuggestions } from './StoryShared';
import { Story3DPhoto, StoryVoicePlayer } from './StoryExtras';
import VoiceDraft from './VoiceDraft';
import { outboxAdd, isNetworkError } from './outbox';

const C = { pink: '#FF2D95', purple: '#B44CFF', dark: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };
const BGS = ['#FF2D95', '#7C3AED', '#10B981', '#F59E0B', '#0B0B14', '#1a1a2e', '#FF6B35', ...STORY_BG_GRADIENTS];
const TEXT_COLORS = ['#ffffff', '#000000', '#FFD600', '#FF2D95', '#22E4FF'];

const TOOLS = [
  { id: 'voice', label: 'Voice FX',   Icon: Mic,       g: 'linear-gradient(135deg,#a855f7,#ec4899)' },
  { id: 'music', label: 'Music',      Icon: Music,     g: 'linear-gradient(135deg,#10b981,#059669)' },
  { id: '3d',    label: '3D Spatial', Icon: Box,       g: 'linear-gradient(135deg,#2563eb,#3b82f6)' },
  { id: 'poll',  label: 'Poll',       Icon: BarChart3, g: 'linear-gradient(135deg,#6366f1,#3b82f6)' },
  { id: 'qa',    label: 'Q&A',        Icon: HelpCircle,g: 'linear-gradient(135deg,#ec4899,#f43f5e)' },
  { id: 'text',  label: 'Text Art',   Icon: Type,      g: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' },
  { id: 'flip',  label: 'Flip Story', Icon: RefreshCw, g: 'linear-gradient(135deg,#64748b,#475569)' },
  { id: 'media', label: 'Media',      Icon: ImageIcon, g: 'linear-gradient(135deg,#f97316,#ef4444)' },
];

const fieldStyle = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '11px 13px', color: 'white', fontSize: 15, outline: 'none' };
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function StoryCreator({ onClose, showToast, snapFetch }) {
  const suggestions = useMemo(buildStorySuggestions, []);
  const [kind, setKind] = useState('text');           // text | photo | video | voice
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [bg, setBg] = useState(BGS[7]);
  const [font, setFont] = useState(STORY_FONTS[0]);
  const [textColor, setTextColor] = useState('#ffffff');
  const [burn, setBurn] = useState(false);
  const [audience, setAudience] = useState('followers');   // public | followers
  const [song, setSong] = useState(null), [poll, setPoll] = useState(null), [qa, setQa] = useState(null), [flipText, setFlipText] = useState(null);
  const [panel, setPanel] = useState(null);
  const [is3d, setIs3d] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  // voice recording
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [draft, setDraft] = useState(null);           // { blob, ext, duration }
  const [recPanel, setRecPanel] = useState(false);
  const fileRef = useRef(null), vidRef = useRef(null), camRef = useRef(null);
  const recRef = useRef(null), chunksRef = useRef([]), timerRef = useRef(null), streamRef = useRef(null), mimeRef = useRef({ mime: '', ext: '.webm' });

  useEffect(() => () => { clearInterval(timerRef.current); try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {} }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const setMedia = (f, k) => {
    setFile(f); setPreview(f ? URL.createObjectURL(f) : null); setKind(k);
    if (k !== 'photo') setIs3d(false);
  };
  const pickFile = (e, want3d) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (f.type.startsWith('video/')) setMedia(f, 'video');
    else if (f.type.startsWith('image/')) { setMedia(f, 'photo'); if (want3d) setIs3d(true); }
    else showToast?.('Choose a photo or a video', 'error');
  };
  const want3dRef = useRef(false);

  const tool = (id) => {
    if (posting) return;
    if (id === 'text') { setMedia(null, 'text'); setRecPanel(false); }
    else if (id === 'media') { want3dRef.current = false; camRef.current?.click(); }
    else if (id === 'music') setPanel(p => p === 'music' ? null : 'music');
    else if (id === 'poll') setPoll(p => p ? null : { question: '', options: ['', ''] });
    else if (id === 'qa') setQa(q => q === null ? '' : null);
    else if (id === 'flip') setFlipText(f => f === null ? '' : null);
    else if (id === 'voice') { setRecPanel(true); if (kind !== 'voice') setMedia(null, 'voice'); }
    else if (id === '3d') {
      if (kind === 'photo' && file) setIs3d(v => !v);
      else { want3dRef.current = true; fileRef.current?.click(); }
    }
  };

  /* ── voice recording ── */
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
      mimeRef.current = { mime, ext: mime.includes('mp4') ? '.m4a' : '.webm' };
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
        const secs = Math.max(1, Math.round((Date.now() - recRef.current.t0) / 1000));
        if (blob.size > 800) setDraft({ blob, ext: mimeRef.current.ext, duration: secs });
        else showToast?.('That was too short — hold on a little longer', 'info');
      };
      rec.t0 = Date.now(); recRef.current = rec; rec.start(250);
      setRecording(true); setRecSecs(0);
      timerRef.current = setInterval(() => setRecSecs(s => { if (s + 1 >= 60) { stopRec(); } return s + 1; }), 1000);
    } catch { showToast?.('Microphone access is needed to record', 'error'); }
  };
  const stopRec = () => {
    clearInterval(timerRef.current);
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch {}
    setRecording(false);
  };

  /* ── post ── */
  const hasContent = kind === 'text' ? (text.trim().length > 0 || !!(poll && poll.question.trim()) || !!(qa && qa.trim()) || !!(flipText && flipText.trim())) : !!file;
  const post = async () => {
    if (posting || posted || !hasContent) { if (!hasContent) showToast?.(kind === 'text' ? 'Write something first' : 'Add your media first', 'info'); return; }
    setPosting(true);
    const fields = { text, bgColor: bg, textColor, fontStyle: font.id, effect: is3d ? '3d' : '', burn: burn ? 'true' : 'false', audience };
    if (qa && qa.trim()) fields.qa = qa.trim();
    if (flipText && flipText.trim()) fields.flipText = flipText.trim();
    if (song) fields.song = JSON.stringify(song);
    if (poll && poll.question.trim() && poll.options.filter(o => o.trim()).length >= 2) fields.poll = JSON.stringify({ question: poll.question, options: poll.options.filter(o => o.trim()) });
    const queue = async () => {
      try {
        await outboxAdd({ kind: 'story', fields, file: file || null });
        setPosting(false); setPosted(true);
        showToast?.('No connection. Your story will post when you are online', 'info');
        setTimeout(onClose, 900);
      } catch { showToast?.('Failed to save story', 'error'); setPosting(false); }
    };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { await queue(); return; }
    try {
      const fd = new FormData();
      if (file) fd.append('media', file);
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      const res = await snapFetch('/snapsa/stories', { method: 'POST', body: fd });
      if (res.ok) {
        setPosting(false); setPosted(true);
        showToast?.(burn ? '🔥 Burn story posted' : '✨ Story posted!', 'success');
        window.dispatchEvent(new CustomEvent('snapsa:storyPosted'));
        setTimeout(onClose, 900);
      } else { const d = await res.json().catch(() => ({})); showToast?.(d.error || 'Failed to post story', 'error'); setPosting(false); }
    } catch (e) {
      if (isNetworkError?.(e)) { await queue(); return; }
      showToast?.('Failed to post story', 'error'); setPosting(false);
    }
  };

  const gradientBg = kind === 'text' || kind === 'voice';
  const caption = text && kind !== 'text' ? (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 28, textAlign: 'center', padding: '0 14px', pointerEvents: 'none' }}>
      <span style={{ color: textColor, fontSize: 20, textShadow: '0 2px 8px rgba(0,0,0,.85)', ...font.style }}>{text}</span>
    </div>) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 650, background: C.dark, display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes scSpin{to{transform:rotate(360deg)}} @keyframes scPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}`}</style>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 14px) 16px 10px' }}>
        <h2 style={{ margin: 0, color: 'white', fontSize: 20, fontWeight: 800 }}>Create Story</h2>
        <button onClick={onClose} disabled={posting} aria-label="Close" style={{ background: 'rgba(255,255,255,.1)', border: 'none', borderRadius: '50%', padding: 8, opacity: posting ? 0.5 : 1 }}><X size={18} style={{ color: 'white' }} /></button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px' }}>
        {/* smart suggestions */}
        <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '4px 0 8px' }}>✨ SMART SUGGESTIONS</p>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 4 }}>
          {suggestions.map(s => (
            <button key={s} onClick={() => { setText(s); if (kind !== 'text' && !file && kind !== 'voice') setKind('text'); }}
              style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 999, background: 'rgba(180,76,255,.14)', border: `1px solid ${C.border}`, color: 'white', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{s}</button>
          ))}
        </div>

        {/* tools */}
        <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '16px 0 8px' }}>CREATIVE TOOLS</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          {TOOLS.map(({ id, label, Icon, g }) => {
            const on = (id === 'text' && kind === 'text') || (id === 'media' && (kind === 'photo' || kind === 'video') && !is3d) || (id === 'voice' && kind === 'voice') || (id === '3d' && is3d) || (id === 'music' && !!song) || (id === 'poll' && !!poll) || (id === 'qa' && qa !== null) || (id === 'flip' && flipText !== null);
            return (
              <button key={id} onClick={() => tool(id)} style={{ position: 'relative', background: g, border: on ? '2px solid #fff' : '2px solid transparent', borderRadius: 16, padding: '16px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: 'white', cursor: 'pointer' }}>
                <Icon size={22} />
                <span style={{ fontSize: 11.5, fontWeight: 800 }}>{label}</span>
                {on && <span style={{ position: 'absolute', top: 4, right: 6, fontSize: 11 }}>✓</span>}
              </button>
            );
          })}
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const w = want3dRef.current; want3dRef.current = false; pickFile(e, w); }} />
        <input ref={camRef} type="file" accept="image/*,video/*" hidden onChange={(e) => pickFile(e, false)} />

        {panel === 'music' && <SongPanel value={song} onChange={v => { setSong(v); if (v) setPanel(null); }} snapFetch={snapFetch} />}
        {poll && (
          <Panel title="POLL" color="rgba(59,130,246,.5)" bg="rgba(59,130,246,.07)" onRemove={() => setPoll(null)}>
            <input value={poll.question} onChange={e => setPoll({ ...poll, question: e.target.value.slice(0, 200) })} placeholder="Ask a question…" style={fieldStyle} />
            {poll.options.map((o, i) => <input key={i} value={o} onChange={e => setPoll({ ...poll, options: poll.options.map((x, j) => j === i ? e.target.value.slice(0, 60) : x) })} placeholder={`Option ${i + 1}`} style={{ ...fieldStyle, marginTop: 8 }} />)}
            {poll.options.length < 4 && <button onClick={() => setPoll({ ...poll, options: [...poll.options, ''] })} style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 12, border: '1.5px dashed rgba(96,165,250,.7)', background: 'transparent', color: '#93c5fd', fontWeight: 700 }}>+ Add option</button>}
          </Panel>
        )}
        {qa !== null && <QaPanel value={qa} onChange={v => setQa(v === '' && qa === '' ? null : v)} />}
        {flipText !== null && (
          <Panel title="FLIP STORY — the back of the card" onRemove={() => setFlipText(null)}>
            <textarea value={flipText} onChange={e => setFlipText(e.target.value.slice(0, 500))} rows={3} placeholder="Viewers tap Flip to read this…" style={{ ...fieldStyle, resize: 'none' }} />
          </Panel>
        )}

        {/* the story itself — big type box for text stories, a preview for photos / video / voice */}
        {kind === 'text' ? (
          <div style={{ position: 'relative', marginTop: 16, borderRadius: 22, overflow: 'hidden', background: bg, minHeight: 220, display: 'flex' }}>
            <Type size={16} style={{ position: 'absolute', top: 12, right: 14, color: 'rgba(255,255,255,.7)' }} />
            <textarea value={text} onChange={e => setText(e.target.value.slice(0, 500))} placeholder="Type....."
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none', padding: 18, minHeight: 220, color: textColor, fontSize: 40, lineHeight: 1.15, textShadow: '0 2px 8px rgba(0,0,0,.35)', ...font.style }} />
          </div>
        ) : (
          <>
            {!(kind === 'voice' && !(file && preview)) && <div style={{ margin: '16px auto 0', width: 'min(62vw, 250px)', aspectRatio: '9 / 16', borderRadius: 20, overflow: 'hidden', position: 'relative', border: `1px solid ${C.border}`, background: gradientBg ? bg : '#000' }}>
              {kind === 'photo' && preview && (is3d ? <Story3DPhoto src={preview} fill /> : <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />)}
              {kind === 'video' && preview && <video src={preview} controls muted playsInline loop style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
              {kind === 'voice' && (file && preview
                ? <StoryVoicePlayer src={preview} bg={bg} text={text} textColor={textColor} fontStyle={font.id} autoPlay={false} controls />
                : (<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'white', padding: 12, textAlign: 'center' }}><Mic size={40} /><span style={{ fontSize: 13, fontWeight: 700 }}>{recording ? 'Recording…' : 'Record a voice story'}</span></div>))}
              {kind !== 'voice' && caption}
              {burn && <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,.6)', color: '#fbbf24', fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 999 }}>🔥 BURN</div>}
            </div>}
            {kind !== 'voice' && <textarea value={text} onChange={e => setText(e.target.value.slice(0, 500))} rows={2} placeholder="Add a caption (optional)…" style={{ ...fieldStyle, marginTop: 14, resize: 'none' }} />}
          </>
        )}

        {/* voice recorder */}
        {recPanel && kind === 'voice' && (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            {recording ? (
              <button onClick={stopRec} style={{ width: 74, height: 74, borderRadius: '50%', border: 'none', background: '#ef4444', color: 'white', animation: 'scPulse 1s ease-in-out infinite', cursor: 'pointer' }}><Mic size={30} /></button>
            ) : (
              <button onClick={startRec} style={{ width: 74, height: 74, borderRadius: '50%', border: 'none', background: 'linear-gradient(135deg,#10b981,#14b8a6)', color: 'white', cursor: 'pointer' }}><Mic size={30} /></button>
            )}
            <p style={{ color: recording ? '#f87171' : C.gray, fontSize: 13, fontWeight: 700, margin: '8px 0 0' }}>{recording ? `${fmt(recSecs)} / 1:00 — tap to stop` : file ? 'Tap to record again' : 'Tap to record (up to 1 minute)'}</p>
          </div>
        )}

        {/* background swatches */}
        {gradientBg && (
          <>
            <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '18px 0 8px' }}>BACKGROUND</p>
            <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 4 }}>
              {BGS.map(b => (
                <button key={b} onClick={() => setBg(b)} aria-label="Background" style={{ flexShrink: 0, width: 38, height: 38, borderRadius: '50%', background: b, border: bg === b ? '3px solid #fff' : '2px solid rgba(255,255,255,.2)', cursor: 'pointer' }} />
              ))}
            </div>
          </>
        )}

        {/* fonts + text colours */}
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', marginTop: 14 }}>
          {STORY_FONTS.map(f => (
            <button key={f.id} onClick={() => setFont(f)} style={{ flexShrink: 0, padding: '7px 14px', borderRadius: 999, border: 'none', background: font.id === f.id ? '#fff' : 'rgba(255,255,255,.12)', color: font.id === f.id ? '#111' : '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{f.label}</button>
          ))}
          <span style={{ width: 1, background: 'rgba(255,255,255,.2)', flexShrink: 0 }} />
          {TEXT_COLORS.map(c => (
            <button key={c} onClick={() => setTextColor(c)} aria-label="Text colour" style={{ flexShrink: 0, width: 28, height: 28, borderRadius: '50%', background: c, border: textColor === c ? '3px solid #FF2D95' : '2px solid rgba(255,255,255,.35)', cursor: 'pointer' }} />
          ))}
        </div>
      </div>

      {/* who can see it — one compact row, then Post */}
      <div style={{ padding: '10px 16px calc(14px + env(safe-area-inset-bottom,0px))', background: '#0b0615', borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {[['followers', '👥 Followers'], ['public', '🌐 Public']].map(([id, l]) => (
            <button key={id} onClick={() => setAudience(id)} style={{ flexShrink: 0, padding: '11px 18px', borderRadius: 999, border: 'none', background: audience === id ? '#2563eb' : 'rgba(255,255,255,.1)', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{l}</button>
          ))}
          <button onClick={() => setBurn(v => !v)} style={{ flexShrink: 0, padding: '11px 18px', borderRadius: 999, border: 'none', background: burn ? '#f59e0b' : 'rgba(255,255,255,.1)', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><Flame size={16} /> Burn</button>
        </div>
        <button onClick={post} disabled={posting || posted} style={{ width: '100%', marginTop: 10, padding: '16px 0', borderRadius: 16, border: 'none', background: posted ? '#22c55e' : 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontSize: 17, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, opacity: (!hasContent && !posting) ? .55 : 1, cursor: 'pointer' }}>
          {posting ? <><span style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid #fff', borderTopColor: 'transparent', animation: 'scSpin .7s linear infinite' }} /> Posting…</>
            : posted ? '✓ Posted' : <><Send size={18} /> Post Story</>}
        </button>
        {burn && <p style={{ color: '#fbbf24', fontSize: 11.5, margin: '8px 0 0', textAlign: 'center' }}>🔥 Burn: each person gets one look, then it disappears for them.</p>}
      </div>

      {draft && (
        <VoiceDraft blob={draft.blob} ext={draft.ext} duration={draft.duration}
          onDiscard={() => setDraft(null)}
          onSend={(f) => { setDraft(null); setMedia(f, 'voice'); showToast?.('Voice ready — add a caption or post', 'success'); }} />
      )}
    </div>
  );
}
