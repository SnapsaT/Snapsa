// src/PostsScreen.jsx — opened by the "posts" button on the feed: read other people's posts and write your own.
// Composer = the WernPost composer: modes, Media/Camera/Annotate, Tag, Place, Feel, Mood, Song, Poll, Q&A and timed Burn.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Heart, MessageCircle, Eye, Share2, Image as ImageIcon, Camera, Smile, Send, X, MoreVertical, Trash2, MapPin, Users, Flame, BarChart3, HelpCircle, Music, Type, Zap } from 'lucide-react';
import { timeAgo } from './StoryShared';
import { SponsoredCard } from './AdsTab';
import SendToChatSheet from './VideoShareExtras';
import { PC as C, PostMeta, OfficialPill, BurnPill, PollCard, FeelPanel, MoodPanel, PlacePanel, TagPanel, SongPanel, QaPanel, PollPanel, BurnPanel, PhotoAnnotator, fmtBurn } from './PostExtras';

const VIBES = [['authentic', '❤️ Authentic'], ['pro', '💼 Pro'], ['creative', '🎨 Creative'], ['intimate', '🌸 Intimate'], ['anon', '👤 Anon']];
const AUDIENCE = [['everyone', '🌍 Everyone'], ['followers', '👥 Followers'], ['me', '🔒 Only Me']];

const Chip = ({ on, children, onClick }) => (
  <button onClick={onClick} style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 999, border: on ? '1.5px solid #fff' : `1px solid ${C.border}`, background: on ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.06)', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{children}</button>
);

function Avatar({ url, name, mediaHref, size = 40 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, border: '2px solid rgba(255,255,255,.85)' }}>
      {url ? <img src={mediaHref(url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (name || '?')[0].toUpperCase()}
    </div>
  );
}

function PostCard({ p, mediaHref, renderBadges, onOpenMedia, snapFetch, showToast, onLike, onOpenComments, onShare, onDelete, onGone, onPoll }) {
  const [menu, setMenu] = useState(false);
  const vibeLabel = (VIBES.find(v => v[0] === p.vibe) || VIBES[0])[1];
  const icon = { background: 'none', border: 'none', color: C.gray, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, cursor: 'pointer', padding: 0 };
  return (
    <div data-pid={p._id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <Avatar url={p.avatarUrl} name={p.authorName} mediaHref={mediaHref} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ color: 'white', fontWeight: 800, fontSize: 15 }}>{p.authorDisplayName || p.authorName}</span>
            {p.authorId && renderBadges?.(p)}
            {p.expiresAt && <BurnPill expiresAt={p.expiresAt} onGone={onGone} />}
          </div>
          {p.authorOfficial && <div style={{ margin: '3px 0 1px' }}><OfficialPill label={p.authorOfficial === true ? 'OFFICIAL' : p.authorOfficial} /></div>}
          <div style={{ color: C.gray, fontSize: 11.5, marginTop: 1 }}>{timeAgo(p.createdAt)} · {vibeLabel}{p.visibility !== 'everyone' ? ` · ${p.visibility === 'me' ? 'Only me' : 'Followers'}` : ''}</div>
        </div>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setMenu(v => !v)} aria-label="More" style={{ background: 'none', border: 'none', color: C.gray, padding: 4, cursor: 'pointer' }}><MoreVertical size={20} /></button>
          {menu && <>
            <div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
            <div style={{ position: 'absolute', right: 0, top: 30, zIndex: 21, minWidth: 150, background: '#1b0d33', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,.5)' }}>
              <button onClick={() => { setMenu(false); onShare(p); }} style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '12px 14px', background: 'none', border: 'none', color: 'white', fontWeight: 700, textAlign: 'left' }}><Share2 size={16} /> Share</button>
              {p.own && <button onClick={() => { setMenu(false); onDelete(p); }} style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '12px 14px', background: 'none', border: 'none', borderTop: `1px solid ${C.border}`, color: '#f87171', fontWeight: 700, textAlign: 'left' }}><Trash2 size={16} /> Delete post</button>}
            </div>
          </>}
        </div>
      </div>
      <PostMeta p={p} />
      {p.text && <p style={{ color: 'white', fontSize: 15, lineHeight: 1.5, margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.text}</p>}
      {p.repost && (p.repost.gone
        ? <div style={{ border: `1px dashed ${C.border}`, borderRadius: 14, padding: 12, margin: '0 0 10px', color: C.gray, fontSize: 13 }}>🔁 The original post is no longer available</div>
        : <div style={{ border: `1px solid ${C.border}`, borderRadius: 14, padding: 12, margin: '0 0 10px', background: 'rgba(255,255,255,.04)' }}>
            <div style={{ color: C.gray, fontSize: 12, fontWeight: 800, marginBottom: 4 }}>🔁 Reposted from {p.repost.authorName}</div>
            {p.repost.text && <p style={{ color: 'white', fontSize: 14, lineHeight: 1.45, margin: '0 0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.repost.text}</p>}
            {p.repost.mediaUrl && (p.repost.mediaType === 'video'
              ? <video src={mediaHref(p.repost.mediaUrl)} controls playsInline style={{ width: '100%', borderRadius: 10, maxHeight: 300, background: '#000' }} />
              : <img src={mediaHref(p.repost.mediaUrl)} alt="" onClick={() => onOpenMedia?.(mediaHref(p.repost.mediaUrl))} style={{ width: '100%', borderRadius: 10, maxHeight: 320, objectFit: 'cover', cursor: 'zoom-in' }} />)}
          </div>)}
      {p.qa && <div style={{ background: 'rgba(244,114,182,.1)', border: '1px solid rgba(244,114,182,.4)', borderRadius: 14, padding: '10px 12px', margin: '0 0 10px' }}>
        <div style={{ color: '#f9a8d4', fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>❓ Q&amp;A</div>
        <div style={{ color: 'white', fontWeight: 700, margin: '3px 0 8px' }}>{p.qa}</div>
        <button onClick={() => onOpenComments(p)} style={{ padding: '7px 14px', borderRadius: 999, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, fontSize: 12.5 }}>Answer</button>
      </div>}
      {p.mediaUrl && (p.mediaType === 'video'
        ? <video src={mediaHref(p.mediaUrl)} controls playsInline style={{ width: '100%', borderRadius: 12, maxHeight: 360, background: '#000', marginBottom: 10 }} />
        : <img src={mediaHref(p.mediaUrl)} alt="" onClick={() => onOpenMedia?.(mediaHref(p.mediaUrl))} style={{ width: '100%', borderRadius: 12, maxHeight: 420, objectFit: 'cover', marginBottom: 10, cursor: 'zoom-in' }} />)}
      {p.song && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(16,185,129,.15)', border: '1px solid rgba(16,185,129,.45)', color: '#6ee7b7', borderRadius: 999, padding: '5px 12px', fontSize: 12.5, fontWeight: 700, marginBottom: 10 }}><Music size={14} /> {p.song.title}{p.song.artist ? ` — ${p.song.artist}` : ''}</div>}
      {p.poll && <PollCard post={p} snapFetch={snapFetch} showToast={showToast} onChange={poll => onPoll(p, poll)} />}
      <div style={{ display: 'flex', gap: 18, marginTop: 6, alignItems: 'center' }}>
        <button onClick={() => onLike(p)} style={{ ...icon, color: p.likedByMe ? C.pink : C.gray }}><Heart size={19} fill={p.likedByMe ? C.pink : 'none'} /> {p.likeCount}</button>
        <button onClick={() => onOpenComments(p)} style={icon}><MessageCircle size={19} /> {p.commentCount}</button>
        <button onClick={() => onShare(p)} style={icon}><Share2 size={18} /> {p.shareCount || 0}</button>
        <span style={{ marginLeft: 'auto', color: C.gray, display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700 }}><Eye size={18} /> {p.viewCount || 0}</span>
      </div>
    </div>
  );
}

export default function PostsScreen({ onClose, snapFetch, mediaHref, showToast, currentUser, ownName, ownAvatar, ownBadges, renderBadges }) {
  const [tab, setTab] = useState('read');
  const [posts, setPosts] = useState(null);
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(null);          // post whose comments are open
  // composer
  const [text, setText] = useState('');
  const [vibe, setVibe] = useState('authentic');
  const [aud, setAud] = useState('everyone');
  const [feeling, setFeeling] = useState('');
  const [moodLevel, setMoodLevel] = useState('');
  const [place, setPlace] = useState('');
  const [tags, setTags] = useState([]);
  const [song, setSong] = useState(null);
  const [poll, setPoll] = useState(null);          // { question, options:[], hours }
  const [qa, setQa] = useState(null);              // null | string
  const [burnMs, setBurnMs] = useState(0);
  const [panel, setPanel] = useState(null);        // which composer panel is open
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [annotating, setAnnotating] = useState(false);
  const [posting, setPosting] = useState(false);
  const fileRef = useRef(null), camRef = useRef(null);

  // Views: a post counts when at least half of it scrolls into view (scrolling past counts). One report per post per session.
  const seenRef = useRef(new Set()), queueRef = useRef([]), flushT = useRef(null);
  useEffect(() => {
    if (tab !== 'read' || !posts || !posts.length || typeof IntersectionObserver === 'undefined') return;
    const flush = () => { const ids = queueRef.current.splice(0); if (ids.length) snapFetch('/snapsa/posts/views', { method: 'POST', body: JSON.stringify({ ids }) }).catch(() => {}); };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.getAttribute('data-pid');
        if (e.isIntersecting && id && !seenRef.current.has(id)) {
          seenRef.current.add(id); queueRef.current.push(id);
          setPosts(l => (l || []).map(x => x._id === id && !x.own ? { ...x, viewCount: (x.viewCount || 0) + 1 } : x));
          clearTimeout(flushT.current); flushT.current = setTimeout(flush, 1200);
        }
      }
    }, { threshold: 0.5 });
    const t = setTimeout(() => document.querySelectorAll('[data-pid]').forEach(el => io.observe(el)), 50);
    return () => { clearTimeout(t); io.disconnect(); };
  }, [tab, posts && posts.length, mine]);
  useEffect(() => () => { clearTimeout(flushT.current); const ids = queueRef.current.splice(0); if (ids.length) snapFetch('/snapsa/posts/views', { method: 'POST', body: JSON.stringify({ ids }) }).catch(() => {}); }, []);

  const [viewImg, setViewImg] = useState(null);        // full-screen photo
  const [shareFor, setShareFor] = useState(null);     // post being shared (action sheet)
  const [sendFor, setSendFor] = useState(null);       // post being sent as a message
  const sharePost = useCallback((p) => setShareFor(p), []);
  const shareOutside = useCallback(async (p) => {
    const t = `${p.authorName ? '@' + p.authorName + ' on Snapsa: ' : ''}${(p.text || '').slice(0, 200)}`;
    try { const { Share } = await import('@capacitor/share'); await Share.share({ text: t, dialogTitle: 'Share post' }); }
    catch { try { await navigator.share?.({ text: t }); } catch { return; } }
    snapFetch(`/snapsa/posts/${p._id}/share`, { method: 'POST' }).catch(() => {});
    setPosts(l => (l || []).map(x => x._id === p._id ? { ...x, shareCount: (x.shareCount || 0) + 1 } : x));
  }, [snapFetch]);
  const repost = useCallback(async (p) => {
    try {
      const r = await snapFetch(`/snapsa/posts/${p._id}/repost`, { method: 'POST', body: JSON.stringify({}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not repost');
      showToast?.('🔁 Reposted to your feed', 'success');
      setPosts(l => [d.post, ...(l || []).map(x => x._id === p._id ? { ...x, shareCount: (x.shareCount || 0) + 1 } : x)]);
    } catch (e) { showToast?.(e.message, 'error'); }
  }, [snapFetch, showToast]);

  const load = useCallback(() => {
    snapFetch(`/snapsa/posts${mine ? '?mine=1' : ''}`).then(r => r.ok ? r.json() : null).then(d => setPosts(d?.posts || [])).catch(() => setPosts(p => p || []));
  }, [snapFetch, mine]);
  useEffect(() => { setPosts(null); load(); }, [load]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setFile(f); setPreview(URL.createObjectURL(f)); };
  const isPhoto = !!file && file.type.startsWith('image/');
  const togglePanel = (k) => setPanel(v => v === k ? null : k);

  const reset = () => { setText(''); setFile(null); setPreview(null); setFeeling(''); setMoodLevel(''); setPlace(''); setTags([]); setSong(null); setPoll(null); setQa(null); setBurnMs(0); setPanel(null); };
  const publish = async () => {
    if (posting) return;
    if (!text.trim() && !file && !poll && !qa) { showToast?.('Write something or add media', 'info'); return; }
    if (poll && (!poll.question.trim() || poll.options.filter(o => o.trim()).length < 2)) { showToast?.('A poll needs a question and at least 2 options', 'info'); return; }
    setPosting(true);
    try {
      const fd = new FormData();
      if (file) fd.append('media', file);
      fd.append('text', text); fd.append('vibe', vibe); fd.append('visibility', aud);
      if (feeling) fd.append('feeling', feeling);
      if (moodLevel) fd.append('moodLevel', moodLevel);
      if (place.trim()) fd.append('place', place.trim());
      if (tags.length) fd.append('tags', JSON.stringify(tags));
      if (song) fd.append('song', JSON.stringify(song));
      if (poll) fd.append('poll', JSON.stringify({ question: poll.question, options: poll.options.filter(o => o.trim()), hours: poll.hours }));
      if (qa && qa.trim()) fd.append('qa', qa.trim());
      if (burnMs) fd.append('burnMs', String(burnMs));
      const res = await snapFetch('/snapsa/posts', { method: 'POST', body: fd });
      if (res.ok) { showToast?.('✨ Posted', 'success'); reset(); setTab('read'); setMine(false); load(); }
      else { const d = await res.json().catch(() => ({})); showToast?.(d.error || 'Could not post', 'error'); }
    } catch { showToast?.('You need to be online to post', 'error'); }
    setPosting(false);
  };

  const like = useCallback((p) => {
    setPosts(list => list.map(x => x._id === p._id ? { ...x, likedByMe: !x.likedByMe, likeCount: x.likeCount + (x.likedByMe ? -1 : 1) } : x));
    snapFetch(`/snapsa/posts/${p._id}/like`, { method: 'POST' }).catch(() => {});
  }, [snapFetch]);
  const remove = useCallback(async (p) => {
    const r = await snapFetch(`/snapsa/posts/${p._id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.ok) setPosts(list => list.filter(x => x._id !== p._id)); else showToast?.('Could not delete', 'error');
  }, [snapFetch, showToast]);
  const gone = useCallback((id) => setPosts(list => (list || []).filter(x => x._id !== id)), []);
  const setPostPoll = useCallback((p, poll) => setPosts(l => l.map(x => x._id === p._id ? { ...x, poll } : x)), []);

  const BTNS = [
    ['Media', ImageIcon, () => fileRef.current?.click(), !!file],
    ['Tag', Users, () => togglePanel('tag'), tags.length > 0],
    ['Place', MapPin, () => togglePanel('place'), !!place.trim()],
    ['Feel', Smile, () => togglePanel('feel'), !!feeling],
    ['Mood', Zap, () => togglePanel('mood'), !!moodLevel],
    ['Burn', Flame, () => togglePanel('burn'), burnMs > 0],
    ['Poll', BarChart3, () => { if (!poll) setPoll({ question: '', options: ['', ''], hours: 24 }); else setPoll(null); }, !!poll],
    ['Q&A', HelpCircle, () => setQa(q => q === null ? '' : null), qa !== null],
    ['Camera', Camera, () => camRef.current?.click(), false],
    ['Annotate', Type, () => { if (isPhoto) setAnnotating(true); else showToast?.('Add a photo first, then annotate it', 'info'); }, false, !isPhoto],
    ['Song', Music, () => togglePanel('song'), !!song],
  ];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 560, background: C.dark, display: 'flex', flexDirection: 'column' }}>
      {viewImg && (
        <div onClick={() => setViewImg(null)} style={{ position: 'absolute', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.95)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <button onClick={() => setViewImg(null)} aria-label="Close" style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top,0px) + 14px)', right: 14, background: 'rgba(255,255,255,.14)', border: 'none', borderRadius: '50%', width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={20} style={{ color: 'white' }} /></button>
          <img src={viewImg} alt="" onClick={e => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      )}
      {shareFor && !sendFor && (
        <div onClick={() => setShareFor(null)} style={{ position: 'absolute', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#12061f', borderTop: `1px solid ${C.border}`, borderRadius: '22px 22px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom,0px))' }}>
            <h3 style={{ margin: '0 0 12px', color: 'white' }}>Share post</h3>
            {[['💬', 'Send as message', 'Send it to people you follow', () => setSendFor(shareFor)],
              ['🔁', 'Repost', 'Put it on your own feed', () => { const q = shareFor; setShareFor(null); repost(q); }],
              ['📤', 'Share outside Snapsa', 'WhatsApp, SMS and other apps', () => { const q = shareFor; setShareFor(null); shareOutside(q); }]].map(([ic, t, sub, fn]) => (
              <button key={t} onClick={fn} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '12px 8px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ fontSize: 26 }}>{ic}</span>
                <span><span style={{ display: 'block', color: 'white', fontWeight: 800, fontSize: 15 }}>{t}</span><span style={{ display: 'block', color: C.gray, fontSize: 12 }}>{sub}</span></span>
              </button>))}
          </div>
        </div>
      )}
      {sendFor && <SendToChatSheet title="Send post to…" snapFetch={snapFetch} snapUrl="" showToast={showToast}
        message={`📝 ${sendFor.authorName ? '@' + sendFor.authorName + ' on Snapsa' : 'A Snapsa post'}${sendFor.text ? ':\n“' + sendFor.text.slice(0, 280) + '”' : ''}`}
        sharedPath={`/snapsa/posts/${sendFor._id}/share`}
        onClose={(n) => { if (n) setPosts(l => (l || []).map(x => x._id === sendFor._id ? { ...x, shareCount: (x.shareCount || 0) + n } : x)); setSendFor(null); setShareFor(null); }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'calc(env(safe-area-inset-top,0px) + 12px) 14px 10px', background: '#000', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} aria-label="Back" style={{ background: 'none', border: 'none', padding: 6, cursor: 'pointer' }}><ArrowLeft size={22} style={{ color: 'white' }} /></button>
        <h2 style={{ margin: 0, color: 'white', fontSize: 19, fontWeight: 800, flex: 1 }}>Snapsa Posts</h2>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px 4px' }}>
        <Chip on={tab === 'read'} onClick={() => setTab('read')}>📖 Read</Chip>
        <Chip on={tab === 'write'} onClick={() => setTab('write')}>✍️ Write</Chip>
        {tab === 'read' && <Chip on={mine} onClick={() => setMine(m => !m)}>My posts</Chip>}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px 110px' }}>
        {tab === 'read' ? (
          posts === null ? <p style={{ color: C.gray, textAlign: 'center', marginTop: 40 }}>Loading posts…</p>
          : posts.length === 0 ? <p style={{ color: C.gray, textAlign: 'center', marginTop: 40 }}>{mine ? "You haven't posted yet." : 'No posts yet. Be the first!'}</p>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{posts.map((p, i) => <React.Fragment key={p._id}>
              <PostCard p={p} mediaHref={mediaHref} renderBadges={renderBadges} onOpenMedia={setViewImg} snapFetch={snapFetch} showToast={showToast} onLike={like} onOpenComments={setOpen} onShare={sharePost} onDelete={remove} onGone={() => gone(p._id)} onPoll={setPostPoll} />
              {!mine && (i === 2 || (i > 2 && (i - 2) % 6 === 0)) && <SponsoredCard snapFetch={snapFetch} mediaHref={mediaHref} />}
            </React.Fragment>)}</div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none' }}>{VIBES.map(([id, l]) => <Chip key={id} on={vibe === id} onClick={() => setVibe(id)}>{l}</Chip>)}</div>

            {/* who is posting: avatar + name + verification badge (anon hides all of it) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 10px' }}>
              {vibe === 'anon'
                ? <div style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(255,255,255,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>👤</div>
                : <Avatar url={ownAvatar} name={ownName || currentUser?.firstName} mediaHref={mediaHref} size={46} />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ color: '#e879f9', fontWeight: 800, fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vibe === 'anon' ? 'Anonymous' : (ownName || currentUser?.firstName || 'You')}</span>
                {vibe !== 'anon' && ownBadges}
              </div>
            </div>

            <textarea value={text} onChange={e => setText(e.target.value.slice(0, 2000))} rows={5} placeholder="What's on your mind?"
              style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 16, padding: 14, color: 'white', fontSize: 16, outline: 'none', resize: 'none' }} />
            <div style={{ color: C.gray, fontSize: 11, textAlign: 'right', marginTop: 2 }}>{text.length}/2000</div>

            {/* what you've chosen, as words */}
            {(feeling || moodLevel || place.trim() || tags.length > 0 || song || burnMs > 0) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 8px' }}>
                {[feeling && ['feel', `feeling ${feeling}`, () => setFeeling('')], moodLevel && ['mood', `mood: ${moodLevel}`, () => setMoodLevel('')], place.trim() && ['place', `in ${place.trim()}`, () => setPlace('')],
                  tags.length > 0 && ['tag', `with ${tags.map(t => '@' + t).join(', ')}`, () => setTags([])], song && ['song', `🎵 ${song.title}`, () => setSong(null)], burnMs > 0 && ['burn', `🔥 burns in ${fmtBurn(burnMs)}`, () => setBurnMs(0)]].filter(Boolean).map(([k, l, x]) => (
                  <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(180,76,255,.18)', border: `1px solid ${C.border}`, borderRadius: 999, padding: '4px 10px', color: 'white', fontSize: 12.5, fontWeight: 700 }}>{l}<button onClick={x} aria-label="Remove" style={{ background: 'none', border: 'none', color: 'white', padding: 0, lineHeight: 1 }}>×</button></span>))}
              </div>
            )}

            {preview && (
              <div style={{ position: 'relative', marginTop: 8 }}>
                {file?.type.startsWith('video/') ? <video src={preview} controls style={{ width: '100%', borderRadius: 12, maxHeight: 260 }} /> : <img src={preview} alt="" style={{ width: '100%', borderRadius: 12, maxHeight: 260, objectFit: 'cover' }} />}
                <button onClick={() => { setFile(null); setPreview(null); }} aria-label="Remove" style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,.6)', border: 'none', borderRadius: '50%', padding: 6 }}><X size={14} style={{ color: 'white' }} /></button>
              </div>
            )}

            {poll && <PollPanel poll={poll} setPoll={setPoll} />}
            {qa !== null && <QaPanel value={qa} onChange={v => setQa(v === '' && qa === '' ? null : v)} />}
            {panel === 'feel' && <FeelPanel value={feeling} onPick={v => { setFeeling(v); if (v) setPanel(null); }} />}
            {panel === 'mood' && <MoodPanel value={moodLevel} onPick={v => { setMoodLevel(v); if (v) setPanel(null); }} />}
            {panel === 'place' && <PlacePanel value={place} onChange={setPlace} />}
            {panel === 'tag' && <TagPanel tags={tags} setTags={setTags} snapFetch={snapFetch} />}
            {panel === 'song' && <SongPanel value={song} onChange={v => { setSong(v); if (v) setPanel(null); }} snapFetch={snapFetch} />}
            {panel === 'burn' && <BurnPanel ms={burnMs} setMs={setBurnMs} />}

            <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '14px 0 8px' }}>VISIBLE TO</p>
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none' }}>{AUDIENCE.map(([id, l]) => <Chip key={id} on={aud === id} onClick={() => setAud(id)}>{l}</Chip>)}</div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginTop: 14 }}>
              {BTNS.map(([l, Icon, fn, on, dim]) => (
                <button key={l} onClick={fn} style={{ padding: '12px 2px', borderRadius: 14, border: on ? '1.5px solid #fbbf24' : `1px solid ${C.border}`, background: on ? 'rgba(245,158,11,.14)' : 'rgba(255,255,255,.06)', color: 'white', opacity: dim ? .45 : 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}><Icon size={20} />{l}</button>
              ))}
            </div>
            <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={pick} />
            <input ref={camRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={pick} />
            <button onClick={publish} disabled={posting} style={{ width: '100%', marginTop: 18, padding: '16px 0', borderRadius: 16, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontSize: 18, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, opacity: posting ? .6 : 1, cursor: 'pointer' }}><Send size={18} /> {posting ? 'Posting…' : 'Post'}</button>
          </div>
        )}
      </div>
      {annotating && preview && <PhotoAnnotator src={preview} onCancel={() => setAnnotating(false)} onDone={(f) => { setFile(f); setPreview(URL.createObjectURL(f)); setAnnotating(false); }} />}
      {open && <Comments post={open} snapFetch={snapFetch} showToast={showToast} onClose={() => { setPosts(l => l.map(x => x._id === open._id ? { ...x, commentCount: open._cc ?? x.commentCount } : x)); setOpen(null); }} onCount={n => { open._cc = n; }} />}
    </div>
  );
}

function Comments({ post, snapFetch, showToast, onClose, onCount }) {
  const [list, setList] = useState(null);
  const [t, setT] = useState('');
  const [anon, setAnon] = useState(false);
  useEffect(() => { snapFetch(`/snapsa/posts/${post._id}/comments`).then(r => r.ok ? r.json() : null).then(d => { setList(d?.comments || []); onCount(d?.comments?.length || 0); }).catch(() => setList([])); }, [post._id]);
  const send = async () => {
    const text = t.trim(); if (!text) return;
    setT('');
    const r = await snapFetch(`/snapsa/posts/${post._id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, anon }) }).catch(() => null);
    if (r?.ok) { const d = await r.json(); setList(l => { const n = [...(l || []), d.comment]; onCount(n.length); return n; }); } else showToast?.('Could not comment', 'error');
  };
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 5, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '75%', background: '#12061f', borderRadius: '22px 22px 0 0', border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', color: 'white', fontWeight: 800, display: 'flex', justifyContent: 'space-between' }}>{post.qa ? 'Answers' : 'Comments'} <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'white' }}><X size={18} /></button></div>
        {post.qa && <div style={{ margin: '0 16px 8px', padding: '9px 12px', borderRadius: 12, background: 'rgba(244,114,182,.1)', border: '1px solid rgba(244,114,182,.4)', color: 'white', fontWeight: 700 }}>❓ {post.qa}</div>}
        <div style={{ overflowY: 'auto', padding: '0 16px', flex: 1 }}>
          {list === null ? <p style={{ color: C.gray }}>Loading…</p> : list.length === 0 ? <p style={{ color: C.gray }}>{post.qa ? 'No answers yet.' : 'No comments yet.'}</p> : list.map((c, i) => (
            <p key={i} style={{ color: 'white', fontSize: 14, margin: '0 0 10px' }}><strong style={{ color: C.pink }}>{c.authorDisplayName || c.authorName}</strong> {c.text}</p>))}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '10px 14px calc(10px + env(safe-area-inset-bottom,0px))', alignItems: 'center' }}>
          <button onClick={() => setAnon(a => !a)} title="Comment as" style={{ flexShrink: 0, padding: '8px 10px', borderRadius: 999, border: anon ? '1.5px solid #fff' : `1px solid ${C.border}`, background: anon ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.06)', color: 'white', fontSize: 12, fontWeight: 700 }}>{anon ? '👤 Anon' : '🙂 Me'}</button>
          <input value={t} onChange={e => setT(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={post.qa ? 'Write your answer…' : 'Add a comment…'} style={{ flex: 1, background: 'rgba(255,255,255,.08)', border: `1px solid ${C.border}`, borderRadius: 999, padding: '10px 14px', color: 'white', outline: 'none' }} />
          <button onClick={send} style={{ border: 'none', borderRadius: '50%', width: 42, height: 42, background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white' }}><Send size={16} /></button>
        </div>
      </div>
    </div>
  );
}
