// src/PostExtras.jsx — building blocks for Snapsa Posts (ported from the WernPost composer):
//   Feel · Mood · Place · Tag · Song · Poll · Q&A · timed Burn · photo Annotate
// Everything the author picks is shown on the post as WORDS ("feeling happy in Stellenbosch with @thabo"), never as a lone emoji.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, Music, Check, Type, Smile } from 'lucide-react';

export const PC = { pink: '#FF2D95', purple: '#B44CFF', dark: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };

export const FEELINGS = [
  ['happy', '😊'], ['loved', '🥰'], ['excited', '🤩'], ['blessed', '🙏'], ['grateful', '🙌'], ['relaxed', '😌'], ['proud', '😎'], ['motivated', '💪'],
  ['nostalgic', '🥹'], ['hungry', '😋'], ['tired', '😴'], ['sad', '😢'], ['angry', '😡'], ['sick', '🤒'], ['confused', '🤔'], ['lonely', '🌧️'],
];
export const MOOD_LEVELS = [['Peak', '⚡'], ['Calm', '🌊'], ['Focused', '🎯'], ['Hyped', '🔥'], ['Low', '🌧️']];
export const BURN_PRESETS = [['No burn', 0], ['1 hour', 3600e3], ['6 hours', 6 * 3600e3], ['24 hours', 24 * 3600e3], ['3 days', 3 * 86400e3], ['7 days', 7 * 86400e3]];
export const POLL_HOURS = [1, 6, 24, 72];

export const fmtBurn = (ms) => {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ' ' + Math.floor((m % 1440) / 60) + 'h' : ''}`;
};

/* ───── words under the name: "feeling happy · in Stellenbosch · with @thabo · mood Peak" ───── */
// Each kind of post detail has its own colour (feeling / place / mood level / tags / vibe)
export const META_COLORS = { feel: '#fbbf24', place: '#34d399', tag: '#e879f9', Peak: '#f59e0b', Calm: '#38bdf8', Focused: '#a78bfa', Hyped: '#f43f5e', Low: '#94a3b8', mood: '#60a5fa' };
export const VIBE_COLORS = { authentic: '#fb7185', pro: '#60a5fa', creative: '#fbbf24', intimate: '#e879f9', anon: '#94a3b8' };
export const colorPill = (col, extra) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px', borderRadius: 999, border: `1px solid ${col}77`, background: `${col}22`, color: col, fontSize: 12, fontWeight: 800, ...extra });
export function PostMeta({ p }) {
  const bits = [];
  if (p.feeling) bits.push(<span key="f" style={colorPill(META_COLORS.feel)}>feeling {p.feeling}</span>);
  if (p.place) bits.push(<span key="p" style={colorPill(META_COLORS.place)}>in {p.place}</span>);
  if (p.tags?.length) bits.push(<span key="t" style={colorPill(META_COLORS.tag)}>with {p.tags.map(t => '@' + t.username).join(', ')}</span>);
  if (p.moodLevel) bits.push(<span key="m" style={colorPill(META_COLORS[p.moodLevel] || META_COLORS.mood)}>mood: {p.moodLevel}</span>);
  if (!bits.length) return null;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 8px' }}>{bits}</div>;
}

export function OfficialPill({ label = 'OFFICIAL' }) {
  return <span style={{ display: 'inline-block', padding: '0 7px', lineHeight: '13px', borderRadius: 999, fontSize: 8, fontWeight: 900, letterSpacing: 1, color: '#0a0014', background: 'linear-gradient(135deg,#39ff14,#00e5ff)', boxShadow: '0 0 8px rgba(57,255,20,.55)' }}>{String(label).toUpperCase()}</span>;
}

/* ───── live countdown pill "🔥 59m 50s" — when it reaches zero the post is gone ───── */
export function BurnPill({ expiresAt, onGone }) {
  const [now, setNow] = useState(Date.now());
  const end = new Date(expiresAt).getTime();
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = end - now;
  useEffect(() => { if (left <= 0) onGone?.(); }, [left <= 0]);
  if (left <= 0) return null;
  const s = Math.floor(left / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const txt = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(249,115,22,.16)', border: '1px solid rgba(249,115,22,.5)', color: '#fb923c', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 800 }}>🔥 {txt}</span>;
}

/* ───── poll shown on a post ───── */
export function PollCard({ post, snapFetch, showToast, onChange }) {
  const poll = post.poll; if (!poll) return null;
  const voted = poll.myVote !== null && poll.myVote !== undefined;
  const showResults = voted || poll.ended || post.own;
  const vote = async (i) => {
    if (voted || poll.ended) return;
    const r = await snapFetch(`/snapsa/posts/${post._id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option: i }) }).catch(() => null);
    const d = await r?.json?.().catch(() => ({}));
    if (r?.ok && d.poll) onChange(d.poll); else showToast?.(d?.error || 'Could not vote', 'error');
  };
  return (
    <div style={{ background: 'rgba(59,130,246,.09)', border: '1px solid rgba(59,130,246,.35)', borderRadius: 14, padding: 12, margin: '4px 0 10px' }}>
      <div style={{ color: '#93c5fd', fontSize: 11, fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>📊 POLL</div>
      <div style={{ color: 'white', fontWeight: 800, fontSize: 15, marginBottom: 10 }}>{poll.question}</div>
      {poll.options.map((o, i) => {
        const pct = poll.total ? Math.round(o.count * 100 / poll.total) : 0;
        const mine = poll.myVote === i;
        return (
          <button key={i} disabled={showResults} onClick={() => vote(i)} style={{ position: 'relative', display: 'block', width: '100%', textAlign: 'left', marginBottom: 7, padding: '11px 12px', borderRadius: 11, overflow: 'hidden', border: mine ? '1.5px solid #60a5fa' : '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'white', fontSize: 14, fontWeight: 600, cursor: showResults ? 'default' : 'pointer' }}>
            {showResults && <span style={{ position: 'absolute', inset: 0, width: pct + '%', background: mine ? 'rgba(96,165,250,.38)' : 'rgba(255,255,255,.1)' }} />}
            <span style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{mine ? '✓ ' : ''}{o.text}</span>{showResults && <span style={{ fontWeight: 800 }}>{pct}%</span>}</span>
          </button>
        );
      })}
      <div style={{ color: PC.gray, fontSize: 11.5 }}>{poll.total} vote{poll.total === 1 ? '' : 's'} · {poll.ended ? 'Poll ended' : `ends ${new Date(poll.endsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</div>
    </div>
  );
}

/* ───── composer panels ───── */
const chipBase = { flexShrink: 0, padding: '8px 13px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'white' };
const inputStyle = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${PC.border}`, borderRadius: 12, padding: '11px 13px', color: 'white', fontSize: 15, outline: 'none' };
export const Panel = ({ color = PC.border, bg = 'rgba(255,255,255,.04)', title, onRemove, children }) => (
  <div style={{ background: bg, border: `1px solid ${color}`, borderRadius: 16, padding: 12, marginTop: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <span style={{ color: 'white', fontWeight: 800, fontSize: 12, letterSpacing: 1 }}>{title}</span>
      {onRemove && <button onClick={onRemove} style={{ background: 'none', border: 'none', color: '#f87171', fontWeight: 700, fontSize: 13 }}>Remove</button>}
    </div>{children}
  </div>
);

export function FeelPanel({ value, onPick }) {
  return <Panel title="HOW ARE YOU FEELING?" onRemove={value ? () => onPick('') : null}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{FEELINGS.map(([w, e]) => <button key={w} onClick={() => onPick(value === w ? '' : w)} style={{ ...chipBase, border: value === w ? '1.5px solid #fff' : `1px solid ${PC.border}`, background: value === w ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.06)' }}>{e} {w}</button>)}</div>
    <div style={{ color: PC.gray, fontSize: 11.5, marginTop: 8 }}>Shown on your post as “feeling {value || 'happy'}”.</div>
  </Panel>;
}
export function MoodPanel({ value, onPick }) {
  return <Panel title="MOOD" onRemove={value ? () => onPick('') : null}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{MOOD_LEVELS.map(([w, e]) => <button key={w} onClick={() => onPick(value === w ? '' : w)} style={{ ...chipBase, border: value === w ? '1.5px solid #fff' : `1px solid ${PC.border}`, background: value === w ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.06)' }}>{e} {w}</button>)}</div>
  </Panel>;
}
export function PlacePanel({ value, onChange }) {
  return <Panel title="PLACE" onRemove={value ? () => onChange('') : null}>
    <input value={value} onChange={e => onChange(e.target.value.slice(0, 80))} placeholder="Where are you? e.g. Stellenbosch" style={inputStyle} />
  </Panel>;
}

export function TagPanel({ tags, setTags, snapFetch }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState([]);
  useEffect(() => {
    const term = q.trim().replace(/^@/, '');
    if (term.length < 2) { setRes([]); return; }
    const t = setTimeout(() => snapFetch(`/snapsa/search?q=${encodeURIComponent(term)}`).then(r => r.ok ? r.json() : null).then(d => setRes((d?.users || []).slice(0, 6))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q]);
  const add = (u) => { if (!u || tags.some(t => t.toLowerCase() === u.toLowerCase()) || tags.length >= 10) return; setTags([...tags, u]); setQ(''); setRes([]); };
  return <Panel title="TAG PEOPLE" onRemove={tags.length ? () => setTags([]) : null}>
    {tags.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{tags.map(t => <span key={t} style={{ ...chipBase, padding: '5px 10px', fontSize: 12.5, background: 'rgba(180,76,255,.2)', border: `1px solid ${PC.border}` }}>@{t} <button onClick={() => setTags(tags.filter(x => x !== t))} style={{ background: 'none', border: 'none', color: 'white', padding: 0, marginLeft: 4 }}>×</button></span>)}</div>}
    <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(q.trim().replace(/^@/, '')); }} placeholder="Search a username…" style={inputStyle} />
    {res.map(u => <button key={u.id || u.username} onClick={() => add(u.username)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 6px', background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,.07)', color: 'white', fontWeight: 700 }}>@{u.username}</button>)}
  </Panel>;
}

export function SongPanel({ value, onChange, snapFetch }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes([]); return; }
    const t = setTimeout(() => snapFetch(`/snapsa/search?q=${encodeURIComponent(term)}`).then(r => r.ok ? r.json() : null).then(d => setRes((d?.sounds || []).slice(0, 6))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q]);
  return <Panel title="SONG" onRemove={value ? () => onChange(null) : null}>
    {value && <div style={{ ...chipBase, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(16,185,129,.18)', border: '1px solid rgba(16,185,129,.5)', marginBottom: 8 }}><Music size={14} /> {value.title}{value.artist ? ` — ${value.artist}` : ''}</div>}
    <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Snapsa sounds…" style={inputStyle} />
    {res.map(s => <button key={s.id} onClick={() => { onChange({ title: s.title, artist: s.artist || '', audioUrl: s.audioUrl || '' }); setQ(''); setRes([]); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 6px', background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,.07)', color: 'white', fontWeight: 700 }}>🎵 {s.title}<span style={{ color: PC.gray, fontWeight: 500 }}> {s.artist ? `— ${s.artist}` : ''}</span></button>)}
    {q.trim().length >= 2 && !res.length && <button onClick={() => { onChange({ title: q.trim().slice(0, 100), artist: '' }); setQ(''); }} style={{ ...chipBase, marginTop: 8, background: 'rgba(255,255,255,.08)', border: `1px solid ${PC.border}` }}>Use “{q.trim()}” as the song</button>}
  </Panel>;
}

export function QaPanel({ value, onChange }) {
  return <Panel title="Q&A" color="rgba(244,114,182,.5)" bg="rgba(244,114,182,.07)" onRemove={() => onChange('')}>
    <input value={value} onChange={e => onChange(e.target.value.slice(0, 200))} placeholder="What question should followers answer?" style={inputStyle} />
    <div style={{ color: '#f9a8d4', fontSize: 11.5, marginTop: 7 }}>People see this as a question on your post and reply with their answer.</div>
  </Panel>;
}

export function PollPanel({ poll, setPoll }) {
  const setOpt = (i, v) => setPoll({ ...poll, options: poll.options.map((o, j) => j === i ? v.slice(0, 80) : o) });
  return <Panel title="POLL" color="rgba(59,130,246,.5)" bg="rgba(59,130,246,.07)" onRemove={() => setPoll(null)}>
    <input value={poll.question} onChange={e => setPoll({ ...poll, question: e.target.value.slice(0, 200) })} placeholder="Ask a question…" style={inputStyle} />
    {poll.options.map((o, i) => <input key={i} value={o} onChange={e => setOpt(i, e.target.value)} placeholder={`Option ${i + 1}`} style={{ ...inputStyle, marginTop: 8 }} />)}
    {poll.options.length < 6 && <button onClick={() => setPoll({ ...poll, options: [...poll.options, ''] })} style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 12, border: '1.5px dashed rgba(96,165,250,.7)', background: 'transparent', color: '#93c5fd', fontWeight: 700 }}>+ Add option</button>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
      <span style={{ color: PC.gray, fontSize: 13, fontWeight: 700 }}>Duration:</span>
      {POLL_HOURS.map(h => <button key={h} onClick={() => setPoll({ ...poll, hours: h })} style={{ ...chipBase, padding: '7px 14px', border: 'none', background: poll.hours === h ? '#2563eb' : 'rgba(255,255,255,.08)' }}>{h}h</button>)}
    </div>
  </Panel>;
}

export function BurnPanel({ ms, setMs }) {
  const [h, setH] = useState(''); const [m, setM] = useState('');
  const setCustom = () => { const t = (parseInt(h || '0', 10) * 60 + parseInt(m || '0', 10)) * 60000; if (t >= 60000) setMs(Math.min(t, 30 * 86400e3)); };
  return <Panel title="🔥 BURN AFTER" color="rgba(249,115,22,.55)" bg="rgba(249,115,22,.08)">
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
      {BURN_PRESETS.map(([l, v]) => <button key={l} onClick={() => setMs(v)} style={{ padding: '11px 4px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 13, color: ms === v ? 'white' : '#e5d9f5', background: ms === v ? '#f97316' : 'rgba(255,255,255,.07)' }}>{v === 0 ? '∞ ' : ''}{l}</button>)}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
      <span style={{ color: PC.gray, fontSize: 13, fontWeight: 700 }}>Custom:</span>
      <input value={h} onChange={e => setH(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" placeholder="h" style={{ ...inputStyle, width: 56, padding: 9, textAlign: 'center' }} /><span style={{ color: PC.gray }}>h</span>
      <input value={m} onChange={e => setM(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" placeholder="m" style={{ ...inputStyle, width: 56, padding: 9, textAlign: 'center' }} /><span style={{ color: PC.gray }}>m</span>
      <button onClick={setCustom} style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 12, border: 'none', background: '#f97316', color: 'white', fontWeight: 800 }}>Set</button>
    </div>
    <div style={{ color: '#fdba74', fontSize: 12, marginTop: 9 }}>{ms ? `The post deletes itself ${fmtBurn(ms)} after you publish it.` : 'No burn — the post stays until you delete it.'}</div>
  </Panel>;
}

/* ───── photo annotator: draggable words + emoji on top of a photo; returns a flattened JPEG file ───── */
const EMOJIS = ['😀', '😂', '😍', '😎', '🥳', '😭', '🔥', '❤️', '💯', '✨', '🙏', '👏', '🎉', '🌍', '🎵', '💎'];
const COLORS = ['#ffffff', '#fde047', '#ff2d95', '#22d3ee', '#000000'];
export function PhotoAnnotator({ src, onDone, onCancel }) {
  const [items, setItems] = useState([]); const [sel, setSel] = useState(null);
  const [color, setColor] = useState('#ffffff'); const [txt, setTxt] = useState(''); const [tool, setTool] = useState(null);
  const box = useRef(null), imgRef = useRef(null), drag = useRef(null);
  const add = (it) => { const id = Date.now() + Math.random(); setItems(l => [...l, { id, x: .5, y: .5, size: it.emoji ? .12 : .06, ...it }]); setSel(id); setTool(null); setTxt(''); };
  const down = (e, id) => { e.stopPropagation(); setSel(id); const r = box.current.getBoundingClientRect(); drag.current = { id, r }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = (e) => { const d = drag.current; if (!d) return; const x = Math.min(1, Math.max(0, (e.clientX - d.r.left) / d.r.width)), y = Math.min(1, Math.max(0, (e.clientY - d.r.top) / d.r.height)); setItems(l => l.map(i => i.id === d.id ? { ...i, x, y } : i)); };
  const up = () => { drag.current = null; };
  const done = () => {
    const img = imgRef.current; if (!img) return;
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H); g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const i of items) {
      const px = i.size * H;
      if (i.emoji) { g.font = `${px}px serif`; g.fillText(i.emoji, i.x * W, i.y * H); }
      else { g.font = `800 ${px}px sans-serif`; g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = px * .15; g.fillStyle = i.color; g.fillText(i.text, i.x * W, i.y * H); g.shadowBlur = 0; }
    }
    c.toBlob(b => b && onDone(new File([b], `post_${Date.now()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9);
  };
  const cur = items.find(i => i.id === sel);
  const btn = { padding: '9px 14px', borderRadius: 12, border: `1px solid ${PC.border}`, background: 'rgba(255,255,255,.08)', color: 'white', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: '#000', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 12px) 14px 10px' }}>
        <button onClick={onCancel} style={{ ...btn, border: 'none' }}><X size={18} /> Cancel</button>
        <span style={{ color: 'white', fontWeight: 800 }}>Annotate</span>
        <button onClick={done} style={{ ...btn, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)' }}><Check size={18} /> Done</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10 }} onPointerMove={move} onPointerUp={up} onClick={() => setSel(null)}>
        <div ref={box} style={{ position: 'relative', display: 'inline-block', lineHeight: 0, touchAction: 'none' }}>
          <img ref={imgRef} src={src} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 230px)', display: 'block', userSelect: 'none' }} />
          {items.map(i => (
            <div key={i.id} onPointerDown={e => down(e, i.id)} style={{ position: 'absolute', left: i.x * 100 + '%', top: i.y * 100 + '%', transform: 'translate(-50%,-50%)', cursor: 'grab', whiteSpace: 'nowrap', userSelect: 'none', lineHeight: 1.1, outline: sel === i.id ? '1.5px dashed #fff' : 'none', padding: 2,
              fontSize: `calc(${i.size} * ${imgRef.current?.clientHeight || 300}px)`, color: i.color, fontWeight: 800, textShadow: '0 1px 6px rgba(0,0,0,.8)' }}>{i.emoji || i.text}</div>
          ))}
        </div>
      </div>
      <div style={{ padding: '8px 14px calc(14px + env(safe-area-inset-bottom,0px))', background: '#0b0615' }}>
        {tool === 'text' && <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input value={txt} onChange={e => setTxt(e.target.value.slice(0, 60))} placeholder="Type your text" autoFocus style={{ ...inputStyle, flex: 1 }} />
          <button onClick={() => txt.trim() && add({ text: txt.trim(), color })} style={{ ...btn, background: '#8b2cf5', border: 'none' }}>Add</button>
        </div>}
        {tool === 'emoji' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>{EMOJIS.map(e => <button key={e} onClick={() => add({ emoji: e })} style={{ fontSize: 26, background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 10, padding: '4px 8px' }}>{e}</button>)}</div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setTool(tool === 'text' ? null : 'text')} style={btn}><Type size={16} /> Text</button>
          <button onClick={() => setTool(tool === 'emoji' ? null : 'emoji')} style={btn}><Smile size={16} /> Emoji</button>
          {COLORS.map(c => <button key={c} onClick={() => { setColor(c); if (cur && cur.text) setItems(l => l.map(i => i.id === cur.id ? { ...i, color: c } : i)); }} aria-label="Colour" style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: color === c ? '2.5px solid #ff2d95' : '1.5px solid rgba(255,255,255,.5)' }} />)}
          {cur && <>
            <button onClick={() => setItems(l => l.map(i => i.id === cur.id ? { ...i, size: Math.min(.4, i.size * 1.2) } : i))} style={btn}>A+</button>
            <button onClick={() => setItems(l => l.map(i => i.id === cur.id ? { ...i, size: Math.max(.025, i.size / 1.2) } : i))} style={btn}>A−</button>
            <button onClick={() => { setItems(l => l.filter(i => i.id !== cur.id)); setSel(null); }} style={{ ...btn, color: '#f87171' }}><Trash2 size={16} /></button>
          </>}
        </div>
      </div>
    </div>
  );
}
