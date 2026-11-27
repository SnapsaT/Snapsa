// src/StoriesScreen.jsx — opened by the "storie" button on the feed: see everyone's stories and create your own.
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Flame, Eye } from 'lucide-react';
import StoryCreator from './StoryCreator';
import { timeAgo } from './StoryShared';

const C = { pink: '#FF2D95', dark: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };

// One arc per story around the avatar (a single story = one full ring). A burn story's arc is amber with a flame on it.
function StoryRing({ stories, seenAll, size = 62, children }) {
  const n = Math.max(1, stories.length), r = size / 2 - 3, c = 2 * Math.PI * r, gap = n > 1 ? Math.min(6, c / n / 3) : 0, seg = c / n - gap;
  const id = 'sr' + Math.random().toString(36).slice(2, 7);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FF2D95" /><stop offset=".55" stopColor="#B44CFF" /><stop offset="1" stopColor="#FFD600" /></linearGradient></defs>
        {stories.map((st, i) => {
          const seen = st.viewedByMe === true || (st.viewedByMe === undefined && seenAll);
          return <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} strokeLinecap="round"
            stroke={seen ? 'rgba(255,255,255,.28)' : st.burn ? '#fbbf24' : `url(#${id})`}
            strokeDasharray={`${Math.max(1, seg)} ${c - Math.max(1, seg)}`} strokeDashoffset={-(i * (c / n)) - gap / 2}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 5, borderRadius: '50%', overflow: 'hidden', background: C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>{children}</div>
      {stories.map((st, i) => {
        if (!st.burn) return null;
        const a = ((i + 0.5) / n) * 2 * Math.PI - Math.PI / 2;
        return <span key={'f' + i} style={{ position: 'absolute', left: size / 2 + Math.cos(a) * r - 8, top: size / 2 + Math.sin(a) * r - 9, fontSize: 14, lineHeight: '18px', width: 16, textAlign: 'center', filter: 'drop-shadow(0 0 3px #000)' }}>🔥</span>;
      })}
    </div>
  );
}

export default function StoriesScreen({ onClose, snapFetch, mediaHref, showToast, currentUser, ownAvatar, StoryViewer, renderBadge }) {
  const [groups, setGroups] = useState(null);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const myId = String(currentUser?._id || currentUser?.id || '');

  const load = useCallback(() => {
    snapFetch('/snapsa/stories/feed').then(r => r.ok ? r.json() : null).then(d => { setGroups(d?.users || []); }).catch(() => setGroups(g => g || []));
  }, [snapFetch]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { window.addEventListener('snapsa:storyPosted', load); return () => window.removeEventListener('snapsa:storyPosted', load); }, [load]);

  const mine = (groups || []).find(g => String(g.authorId) === myId);
  const others = (groups || []).filter(g => String(g.authorId) !== myId);
  const unseen = others.filter(g => !g.allViewedByMe);
  const seen = others.filter(g => g.allViewedByMe);

  const open = (g) => setViewing(g);
  const closeViewer = () => { setViewing(null); load(); };   // reload so burned stories vanish right away

  const Card = ({ g }) => {
    const last = g.stories[g.stories.length - 1] || {};
    const burn = g.stories.some(s => s.burn);
    return (
      <button onClick={() => open(g)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 12, cursor: 'pointer', color: 'white' }}>
        <StoryRing stories={g.stories} seenAll={g.allViewedByMe}>
          {g.avatarUrl ? <img src={mediaHref(g.avatarUrl)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (g.authorDisplayName || g.authorName || '?')[0].toUpperCase()}
        </StoryRing>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.authorDisplayName || g.authorName}</span>{renderBadge?.(g)}</div>
          <div style={{ color: C.gray, fontSize: 12, marginTop: 2 }}>{g.stories.length} {g.stories.length === 1 ? 'story' : 'stories'} · {last.createdAt ? timeAgo(last.createdAt) : ''}</div>
        </div>
      </button>
    );
  };
  const Label = ({ children }) => <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '18px 0 8px' }}>{children}</p>;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 560, background: C.dark, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'calc(env(safe-area-inset-top,0px) + 12px) 14px 12px', background: '#000', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} aria-label="Back" style={{ background: 'none', border: 'none', padding: 6, cursor: 'pointer' }}><ArrowLeft size={22} style={{ color: 'white' }} /></button>
        <h2 style={{ margin: 0, color: 'white', fontSize: 19, fontWeight: 800, flex: 1 }}>Stories</h2>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 100px' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '14px 4px 6px' }}>
          <button onClick={() => (mine ? open(mine) : setCreating(true))} aria-label="Your story" style={{ width: 58, height: 58, borderRadius: '50%', flexShrink: 0, border: mine ? 'none' : `2px dashed ${C.pink}`, padding: mine ? 3 : 2, background: mine ? 'linear-gradient(135deg,#FF2D95,#B44CFF,#FFD600)' : 'transparent', cursor: 'pointer' }}>
            <span style={{ display: 'flex', width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: C.dark, alignItems: 'center', justifyContent: 'center' }}>
              {ownAvatar ? <img src={ownAvatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Plus size={22} style={{ color: C.pink }} />}
            </span>
          </button>
          <button onClick={() => setCreating(true)} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}>
            <div style={{ color: 'white', fontWeight: 800, fontSize: 17 }}>Share a moment</div>
            {mine && <div style={{ color: C.gray, fontSize: 12, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}><Eye size={12} /> {mine.stories.reduce((n, s) => n + (s.viewers?.length || 0), 0)} views on your {mine.stories.length} active {mine.stories.length === 1 ? 'story' : 'stories'} · tap your photo to watch</div>}
          </button>
        </div>

        {groups === null && <p style={{ color: C.gray, textAlign: 'center', marginTop: 40 }}>Loading stories…</p>}
        {groups && unseen.length > 0 && <><Label>NEW</Label><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{unseen.map(g => <Card key={g.authorId} g={g} />)}</div></>}
        {groups && seen.length > 0 && <><Label>SEEN</Label><div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: .75 }}>{seen.map(g => <Card key={g.authorId} g={g} />)}</div></>}
        {groups && others.length === 0 && <p style={{ color: C.gray, textAlign: 'center', marginTop: 40, fontSize: 14 }}>No stories from other people yet.</p>}
      </div>

      {creating && <StoryCreator onClose={() => setCreating(false)} showToast={showToast} snapFetch={snapFetch} />}
      {viewing && StoryViewer && <StoryViewer group={viewing} onClose={closeViewer} currentUser={currentUser} showToast={showToast} />}
    </div>
  );
}
