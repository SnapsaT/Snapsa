// src/postCardImage.js — draws a post as a picture that looks like a screenshot of the post card
// (author + CREW + verified + OFFICIAL, time, vibe, place/feeling/tags, caption, photo, likes/comments/shares/views).
// Returns a PNG Blob. Everything is drawn by hand on a canvas, so it works the same in the app and in the browser.
const COL = { bg: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.42)', gray: '#A59BC4', pink: '#FF2D95', white: '#FFFFFF' };
const VIBES = { authentic: ['❤️ Authentic', '#fb7185'], pro: ['💼 Pro', '#60a5fa'], creative: ['🎨 Creative', '#fbbf24'], intimate: ['🌸 Intimate', '#e879f9'], anon: ['👻 Anon', '#94a3b8'] };
const META = { feel: '#f472b6', place: '#34d399', tag: '#60a5fa', mood: '#fbbf24' };
const FONT = '"Roboto","Helvetica Neue",Arial,sans-serif';

const rr = (c, x, y, w, h, r) => { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
const font = (c, px, weight = 400) => { c.font = `${weight} ${px}px ${FONT}`; };

const loadImg = (url) => new Promise((resolve) => {
  if (!url) return resolve(null);
  const tryLoad = (src, cors) => new Promise((ok) => { const i = new Image(); if (cors) i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  (async () => {
    let i = await tryLoad(url, true);
    if (!i) { try { const r = await fetch(url); if (r.ok) { const b = await r.blob(); i = await tryLoad(URL.createObjectURL(b), false); } } catch {} }
    resolve(i);
  })();
});
const loadVideoFrame = (url) => new Promise((resolve) => {
  if (!url) return resolve(null);
  const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.playsInline = true; v.preload = 'auto';
  const done = (r) => { try { v.removeAttribute('src'); v.load(); } catch {} resolve(r); };
  const t = setTimeout(() => done(null), 8000);
  v.onloadeddata = () => { try { v.currentTime = Math.min(0.3, (v.duration || 1) / 2); } catch { clearTimeout(t); done(v.videoWidth ? v : null); } };
  v.onseeked = () => { clearTimeout(t); try { const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); c.toDataURL(); done(c); } catch { done(null); } };
  v.onerror = () => { clearTimeout(t); done(null); };
  v.src = url;
});

const wrap = (c, text, maxW) => {
  const lines = [];
  String(text || '').split('\n').forEach((para) => {
    if (!para) { lines.push(''); return; }
    let line = '';
    para.split(/(\s+)/).forEach((tok) => {
      if (c.measureText(line + tok).width <= maxW || !line) {
        if (c.measureText(tok).width > maxW) { for (const ch of tok) { if (c.measureText(line + ch).width > maxW) { lines.push(line); line = ch; } else line += ch; } }
        else line += tok;
      } else { lines.push(line.trimEnd()); line = tok.trimStart(); }
    });
    lines.push(line.trimEnd());
  });
  return lines;
};
const fit = (c, text, maxW) => { let t = String(text || ''); if (c.measureText(t).width <= maxW) return t; while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };

const pill = (c, x, y, text, { h = 44, px = 26, color = '#fff', bg, border, weight = 800, grad, textColor } = {}) => {
  font(c, px, weight); const w = Math.ceil(c.measureText(text).width) + h * 0.8;
  c.save();
  if (grad) { const g = c.createLinearGradient(x, y, x + w, y + h); grad.forEach(([o, col]) => g.addColorStop(o, col)); c.fillStyle = g; } else c.fillStyle = bg || `${color}22`;
  rr(c, x, y, w, h, h / 2); c.fill();
  if (border !== false && !grad) { c.strokeStyle = border || `${color}77`; c.lineWidth = 2; rr(c, x, y, w, h, h / 2); c.stroke(); }
  c.fillStyle = textColor || color; c.textBaseline = 'middle'; c.textAlign = 'left'; font(c, px, weight);
  c.fillText(text, x + h * 0.4, y + h / 2 + 1);
  c.restore(); return w;
};

export async function renderPostCard(p, { mediaHref = (u) => u, timeText = '', ownName } = {}) {
  const W = 1080, M = 34, PAD = 34, CW = W - M * 2, IW = CW - PAD * 2, X = M + PAD;
  const [avatar, mediaImg] = await Promise.all([
    loadImg(p.avatarUrl ? mediaHref(p.avatarUrl) : null),
    p.mediaUrl ? (p.mediaType === 'video' ? loadVideoFrame(mediaHref(p.mediaUrl)) : loadImg(mediaHref(p.mediaUrl))) : null,
  ]);
  const repostImg = p.repost && !p.repost.gone && p.repost.mediaUrl && p.repost.mediaType !== 'video' ? await loadImg(mediaHref(p.repost.mediaUrl)) : null;

  const cv = document.createElement('canvas'); cv.width = W; cv.height = 6000;
  const c = cv.getContext('2d'); c.textBaseline = 'alphabetic';
  let y = M + PAD;

  /* header */
  const av = 112;
  c.save(); c.beginPath(); c.arc(X + av / 2, y + av / 2, av / 2, 0, Math.PI * 2); c.closePath(); c.clip();
  if (avatar) { const s = Math.max(av / avatar.width, av / avatar.height); c.drawImage(avatar, X + av / 2 - (avatar.width * s) / 2, y + av / 2 - (avatar.height * s) / 2, avatar.width * s, avatar.height * s); }
  else { const g = c.createLinearGradient(X, y, X + av, y + av); g.addColorStop(0, '#8b2cf5'); g.addColorStop(1, '#ff2d95'); c.fillStyle = g; c.fillRect(X, y, av, av); c.fillStyle = '#fff'; font(c, 52, 800); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText((p.authorDisplayName || p.authorName || '?')[0].toUpperCase(), X + av / 2, y + av / 2 + 2); c.textAlign = 'left'; }
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,.88)'; c.lineWidth = 4; c.beginPath(); c.arc(X + av / 2, y + av / 2, av / 2 - 1, 0, Math.PI * 2); c.stroke();

  const TX = X + av + 26; let ty = y;
  const name = p.burned ? 'Burned identity' : (p.authorDisplayName || p.authorName || ownName || 'Snapsa user');
  const badgeW = (p.crew && p.authorId ? 120 : 0) + (p.authorSnapsaTier && p.authorId ? 56 : 0) + 20;
  font(c, 40, 800); const nm = fit(c, name, IW - av - 26 - badgeW - 60);
  c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(nm, TX, ty + 24);
  let bx = TX + c.measureText(nm).width + 16;
  if (p.crew && p.authorId) bx += pill(c, bx, ty + 6, 'CREW', { h: 36, px: 22, weight: 900, grad: [[0, '#ff9a1f'], [0.55, '#ff4d00'], [1, '#d61a00']], textColor: '#fff' }) + 14;
  if (p.authorSnapsaTier && p.authorId) {   // verified tick
    c.fillStyle = '#e11d48'; c.beginPath(); c.arc(bx + 20, ty + 24, 20, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 5; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); c.moveTo(bx + 11, ty + 24); c.lineTo(bx + 18, ty + 31); c.lineTo(bx + 30, ty + 17); c.stroke();
  }
  ty += 54;
  if (p.authorOfficial) { const lab = (p.authorOfficial === true ? 'OFFICIAL' : String(p.authorOfficial)).toUpperCase(); pill(c, TX, ty, lab, { h: 30, px: 18, weight: 900, grad: [[0, '#39ff14'], [1, '#00e5ff']], textColor: '#0a0014' }); ty += 40; }
  font(c, 26, 500); c.fillStyle = COL.gray; c.textBaseline = 'middle';
  const tt = timeText || ''; c.fillText(tt, TX, ty + 22);
  const [vl, vc] = VIBES[p.vibe] || VIBES.authentic;
  let vx = TX + c.measureText(tt).width + 16;
  vx += pill(c, vx, ty + 2, vl, { h: 40, px: 24, color: vc }) + 10;
  if (p.visibility && p.visibility !== 'everyone') { font(c, 24, 500); c.fillStyle = COL.gray; c.fillText(p.visibility === 'me' ? '· Only me' : '· Followers', vx, ty + 22); }
  y = Math.max(y + av, ty + 46) + 22;

  /* place / feeling / tags / mood */
  const bits = [];
  if (p.feeling) bits.push([`feeling ${p.feeling}`, META.feel]);
  if (p.place) bits.push([`in ${p.place}`, META.place]);
  if (p.tags?.length) bits.push([`with ${p.tags.map(t => '@' + t.username).join(', ')}`, META.tag]);
  if (p.moodLevel) bits.push([`mood: ${p.moodLevel}`, META.mood]);
  if (bits.length) {
    let px = X, rowH = 48;
    bits.forEach(([t, col]) => { font(c, 26, 800); const w = c.measureText(t).width + 40; if (px + w > X + IW) { px = X; y += rowH + 8; } pill(c, px, y, t, { h: rowH - 4, px: 26, color: col }); px += w + 10; });
    y += rowH + 12;
  }

  /* burned identity */
  if (p.burned) { pill(c, X + IW / 2 - 160, y + 10, '🔥 DEFCON 1', { h: 64, px: 32, weight: 900, grad: [[0, '#ff5a1f'], [1, '#ff2d2d']], textColor: '#fff' }); y += 100; }

  /* caption */
  if (p.text) {
    font(c, 34, 400); c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
    wrap(c, p.text, IW).forEach((ln) => { c.fillText(ln, X, y + 36); y += 50; });
    y += 10;
  }

  /* repost */
  if (p.repost) {
    const bh0 = y; let by = y + 18;
    const inner = [];
    if (p.repost.gone) inner.push('🔁 The original post is no longer available');
    else { inner.push(`🔁 Reposted from ${p.repost.authorName || ''}`); }
    const boxStart = y;
    c.fillStyle = 'rgba(255,255,255,.04)'; // sized after measuring
    font(c, 26, 800); const head = inner[0];
    let h = 28 + 36;
    let lines = []; if (!p.repost.gone && p.repost.text) { font(c, 30, 400); lines = wrap(c, p.repost.text, IW - 48).slice(0, 8); h += lines.length * 44 + 8; }
    let ih = 0; if (repostImg) { ih = Math.min(560, Math.round((IW - 48) * (repostImg.height / repostImg.width))); h += ih + 12; }
    c.fillStyle = 'rgba(255,255,255,.05)'; rr(c, X, boxStart, IW, h, 24); c.fill(); c.strokeStyle = COL.border; c.lineWidth = 2; rr(c, X, boxStart, IW, h, 24); c.stroke();
    c.fillStyle = COL.gray; font(c, 26, 800); c.textBaseline = 'alphabetic'; c.fillText(head, X + 24, boxStart + 44);
    by = boxStart + 64;
    font(c, 30, 400); c.fillStyle = '#fff'; lines.forEach((ln) => { c.fillText(ln, X + 24, by + 30); by += 44; });
    if (repostImg) { c.save(); rr(c, X + 24, by + 8, IW - 48, ih, 16); c.clip(); const s = Math.max((IW - 48) / repostImg.width, ih / repostImg.height); c.drawImage(repostImg, X + 24 + (IW - 48) / 2 - (repostImg.width * s) / 2, by + 8 + ih / 2 - (repostImg.height * s) / 2, repostImg.width * s, repostImg.height * s); c.restore(); }
    y = boxStart + h + 16; void bh0;
  }

  /* Q&A */
  if (p.qa) {
    font(c, 32, 800); const ql = wrap(c, p.qa, IW - 48); const h = 70 + ql.length * 44;
    c.fillStyle = 'rgba(244,114,182,.10)'; rr(c, X, y, IW, h, 24); c.fill(); c.strokeStyle = 'rgba(244,114,182,.45)'; c.lineWidth = 2; rr(c, X, y, IW, h, 24); c.stroke();
    c.fillStyle = '#f9a8d4'; font(c, 22, 800); c.fillText('❓ Q&A', X + 24, y + 38); c.fillStyle = '#fff'; font(c, 32, 800); ql.forEach((ln, i) => c.fillText(ln, X + 24, y + 80 + i * 44));
    y += h + 16;
  }

  /* photo / video */
  if (mediaImg) {
    const iw = mediaImg.videoWidth || mediaImg.width, ih0 = mediaImg.videoHeight || mediaImg.height;
    const mh = Math.min(1500, Math.round(IW * (ih0 / iw)));
    c.save(); rr(c, X, y, IW, mh, 30); c.clip(); c.fillStyle = '#000'; c.fillRect(X, y, IW, mh);
    const s = Math.max(IW / iw, mh / ih0); c.drawImage(mediaImg, X + IW / 2 - (iw * s) / 2, y + mh / 2 - (ih0 * s) / 2, iw * s, ih0 * s);
    if (p.mediaType === 'video') { c.fillStyle = 'rgba(0,0,0,.45)'; c.beginPath(); c.arc(X + IW / 2, y + mh / 2, 70, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.moveTo(X + IW / 2 - 22, y + mh / 2 - 36); c.lineTo(X + IW / 2 + 40, y + mh / 2); c.lineTo(X + IW / 2 - 22, y + mh / 2 + 36); c.closePath(); c.fill(); }
    c.restore(); y += mh + 20;
  } else if (p.mediaUrl) {
    c.fillStyle = 'rgba(255,255,255,.06)'; rr(c, X, y, IW, 360, 30); c.fill(); c.fillStyle = COL.gray; font(c, 32, 700); c.textAlign = 'center'; c.fillText(p.mediaType === 'video' ? '🎬 Video' : '🖼️ Photo', X + IW / 2, y + 190); c.textAlign = 'left'; y += 380;
  }

  /* song */
  if (p.song) { pill(c, X, y, `🎵 ${p.song.title}${p.song.artist ? ' — ' + p.song.artist : ''}`.slice(0, 60), { h: 52, px: 26, color: '#6ee7b7' }); y += 68; }

  /* poll */
  if (p.poll) {
    const opts = p.poll.options || []; font(c, 32, 800);
    const ql = wrap(c, p.poll.question || '', IW - 48); const h = 40 + ql.length * 44 + opts.length * 70 + 20;
    c.fillStyle = 'rgba(96,165,250,.10)'; rr(c, X, y, IW, h, 24); c.fill(); c.strokeStyle = 'rgba(96,165,250,.45)'; c.lineWidth = 2; rr(c, X, y, IW, h, 24); c.stroke();
    c.fillStyle = '#fff'; font(c, 32, 800); let py = y + 52; ql.forEach((ln) => { c.fillText(ln, X + 24, py); py += 44; });
    const total = opts.reduce((a, o) => a + (o.votes || o.count || 0), 0);
    opts.forEach((o) => {
      const label = typeof o === 'string' ? o : (o.text || o.label || ''); const v = typeof o === 'string' ? 0 : (o.votes || o.count || 0);
      c.fillStyle = 'rgba(255,255,255,.07)'; rr(c, X + 24, py - 10, IW - 48, 58, 29); c.fill();
      if (total) { c.fillStyle = 'rgba(139,44,245,.45)'; rr(c, X + 24, py - 10, Math.max(58, (IW - 48) * (v / total)), 58, 29); c.fill(); }
      c.fillStyle = '#fff'; font(c, 28, 700); c.fillText(fit(c, label, IW - 200), X + 48, py + 29);
      if (total) { c.textAlign = 'right'; c.fillText(`${Math.round((v / total) * 100)}%`, X + IW - 48, py + 29); c.textAlign = 'left'; }
      py += 70;
    });
    y += h + 16;
  }

  /* stats row */
  y += 8; const sy = y + 24; c.textBaseline = 'middle'; font(c, 30, 700);
  const liked = !!p.likedByMe; c.fillStyle = liked ? COL.pink : COL.gray;
  // heart
  c.save(); c.translate(X, sy - 20); c.beginPath(); c.moveTo(20, 38); c.bezierCurveTo(-6, 20, 2, 0, 20, 10); c.bezierCurveTo(38, 0, 46, 20, 20, 38); c.closePath(); if (liked) c.fill(); else { c.strokeStyle = COL.gray; c.lineWidth = 3; c.stroke(); } c.restore();
  c.fillStyle = liked ? COL.pink : COL.gray; c.fillText(String(p.likeCount || 0), X + 58, sy);
  // comment bubble
  let cx = X + 58 + c.measureText(String(p.likeCount || 0)).width + 50;
  c.strokeStyle = COL.gray; c.lineWidth = 3; rr(c, cx, sy - 20, 42, 34, 17); c.stroke(); c.beginPath(); c.moveTo(cx + 8, sy + 13); c.lineTo(cx + 2, sy + 24); c.lineTo(cx + 18, sy + 14); c.stroke();
  c.fillStyle = COL.gray; c.fillText(String(p.commentCount || 0), cx + 58, sy);
  // share
  cx = cx + 58 + c.measureText(String(p.commentCount || 0)).width + 50;
  c.strokeStyle = COL.gray; c.fillStyle = COL.gray; c.lineWidth = 3;
  c.beginPath(); c.moveTo(cx + 36, sy - 14); c.lineTo(cx + 6, sy); c.lineTo(cx + 36, sy + 14); c.stroke();
  [[36, -14], [6, 0], [36, 14]].forEach(([dx, dy]) => { c.beginPath(); c.arc(cx + dx, sy + dy, 7, 0, Math.PI * 2); c.fillStyle = COL.card; c.fill(); c.stroke(); });
  c.fillStyle = COL.gray; c.fillText(String(p.shareCount || 0), cx + 58, sy);
  // views
  const vs = String(p.viewCount || 0); c.textAlign = 'right'; c.fillText(vs, X + IW, sy);
  const vw = c.measureText(vs).width; c.textAlign = 'left';
  const bxv = X + IW - vw - 50; c.fillRect(bxv, sy - 2, 6, 14); c.fillRect(bxv + 14, sy - 18, 6, 30); c.fillRect(bxv + 28, sy - 8, 6, 20); c.fillRect(bxv + 12, sy + 16, 0, 0);
  y = sy + 42;

  /* card border (drawn last, now that we know the height) */
  const cardH = y + PAD - M;
  const out = document.createElement('canvas'); out.width = W; out.height = cardH + M * 2 + 54;
  const o = out.getContext('2d');
  o.fillStyle = COL.bg; o.fillRect(0, 0, out.width, out.height);
  o.save(); rr(o, M, M, CW, cardH, 44); o.fillStyle = COL.card; o.fill(); o.restore();
  o.save(); rr(o, M, M, CW, cardH, 44); o.clip(); o.drawImage(cv, 0, 0, W, y + PAD + M, 0, 0, W, y + PAD + M); o.restore();
  o.strokeStyle = COL.border; o.lineWidth = 3; rr(o, M, M, CW, cardH, 44); o.stroke();
  o.fillStyle = 'rgba(165,155,196,.8)'; o.font = `700 22px ${FONT}`; o.textAlign = 'center'; o.textBaseline = 'middle';
  o.fillText('SNAPSA  ·  YOUR WORLD. ALL IN ONE PLACE.', W / 2, M + cardH + 34);
  return await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the post card'))), 'image/png'));
}
