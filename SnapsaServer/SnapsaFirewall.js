// SnapsaFirewall.js — Snapsa's own application firewall (WAF + IPS + threat intelligence), controlled from the admin panel.
// Every request passes through it BEFORE any route runs. Anything it refuses is DROPPED — never answered with a "denied" message,
// so an attacker cannot even tell a firewall is there (blackhole: the connection is left silent until it times out, like a dead server).
//
//   RULES           Admin toggles per group: sign up, sign in, reading (fetch), interacting, uploads, messages, calls, wallet, ping, media.
//                   Each group can also have a per-address limit (requests / minute).
//   DEFAULT DENY    Only requests that match a real route of this server are let through. Anything else is dropped.
//   PROTOCOL        The HTTP method must be one the route really has, sane headers/URL sizes, optional host-name check.
//   IPS             Signatures (scanner tools, probes, injection, path tricks) + behaviour (password guessing, scanning, floods) → strikes → bans
//                   (each ban is longer than the last; bans are stored in the database and survive restarts).
//   THREAT INTEL    Public lists of known attacker addresses (FireHOL, Emerging Threats, optional Tor exit nodes, your own list), refreshed every 6 h.
//   SAFETY          Any change that blocks something is automatically UNDONE after 10 minutes unless confirmed ("Keep changes").
//                   FW_SAFE_MODE=1 in Render switches every rule off, so nobody can lock themselves out.
import crypto from 'crypto';

const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const SAFE_MODE = process.env.FW_SAFE_MODE === '1';
const ALLOW_ENV = new Set((process.env.FW_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean));
const HOPS = env('FW_PROXY_HOPS', 1);

/* ───────── what the admin can switch ───────── */
export const GROUPS = [
  { id: 'ping',     label: 'Ping / health check', desc: 'Lets Render and uptime tools see that the server is alive. Switching it off makes the site look dead from outside — and Render may restart it.', danger: true, defPerMin: 0 },
  { id: 'signup',   label: 'Sign up', desc: 'Creating new accounts (and the username check).', defPerMin: 6 },
  { id: 'signin',   label: 'Sign in', desc: 'Logging in (challenge + verify). People who are already signed in keep working.', danger: true, defPerMin: 30 },
  { id: 'fetch',    label: 'Fetch / reading', desc: 'Everything that only reads: feeds, videos, profiles, search, music, posts. Off = the whole app shows nothing.', danger: true, defPerMin: 0 },
  { id: 'write',    label: 'Interact (like, comment, follow …)', desc: 'Likes, comments, follows, reports, profile changes and everything else that writes.', defPerMin: 0 },
  { id: 'upload',   label: 'Uploads', desc: 'Videos, stories, posts with media, sounds, avatars.', defPerMin: 0 },
  { id: 'messages', label: 'Messages & groups', desc: 'Direct messages and group chats.', defPerMin: 0 },
  { id: 'calls',    label: 'Calls & live', desc: 'Voice / video calls and live streams.', defPerMin: 0 },
  { id: 'wallet',   label: 'Wallet, store & payments', desc: 'Coins, withdrawals, purchases, payment webhooks.', defPerMin: 0 },
  { id: 'media',    label: 'Media files', desc: 'Picture / video / audio files served by the server.', defPerMin: 0 },
  { id: 'ws',       label: 'Live connection (WebSocket)', desc: 'Real-time updates and instant message delivery.', danger: true, defPerMin: 0 },
];
const GROUP_IDS = new Set(GROUPS.map(g => g.id));
export const DEFAULT_FEEDS = [
  { id: 'firehol1',  label: 'FireHOL Level 1 — known attacker networks', url: 'https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset', on: false },
  { id: 'emerging',  label: 'Emerging Threats — blocked IPs', url: 'https://rules.emergingthreats.net/fwrules/emerging-Block-IPs.txt', on: true },
  { id: 'spamhaus',  label: 'Spamhaus DROP — hijacked networks', url: 'https://www.spamhaus.org/drop/drop.txt', on: false },
  { id: 'tor',       label: 'Tor exit nodes (people hiding their address)', url: 'https://check.torproject.org/torbulkexitlist', on: false },
];
export const defaultConfig = () => ({
  v: 1,
  defaultDeny: true,
  strictProtocol: true,
  hostCheck: false, allowedHosts: [],
  dropStyle: 'blackhole',                                   // 'blackhole' = silent (recommended) | 'reset' = close at once
  groups: Object.fromEntries(GROUPS.map(g => [g.id, { on: true, perMin: g.defPerMin }])),
  ips: { enabled: true, signatures: true, behavior: true, banStrikes: 12, banMinutes: 60, loginFailsToBan: 15 },
  intel: { enabled: true, feeds: DEFAULT_FEEDS.map(f => ({ ...f })), customBlock: [], customAllow: [] },
});

/* ───────── helpers ───────── */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BAD_UA = /(sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|dirbuster|gobuster|wfuzz|ffuf|hydra|zgrab|havij|netsparker|burpcollaborator|w3af|arachni|metasploit|jaeles|nuclei|whatweb|paros|skipfish)/i;
const PROBE_PATH = /(^|\/)(\.env|\.git|\.svn|\.hg|\.ds_store|\.aws|\.ssh|\.htaccess|\.htpasswd|wp-admin|wp-login|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|myadmin|cgi-bin|actuator|server-status|vendor\/phpunit|boaform|jenkins|manager\/html|etc\/passwd|etc\/shadow|proc\/self|web-inf|config\.json|composer\.(json|lock)|package-lock\.json|backup\.(sql|zip|tar)|id_rsa)(\/|$|\?)|\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp|ini|env)(\?|$)/i;
const TRICKS = /(\.\.[\/\\]|%2e%2e|%252e|%00|\x00|\\x00|%c0%ae|%u002e)/i;
const QUERY_ATTACK = /(\$\{\s*jndi:|<\s*script|javascript:|onerror\s*=|onload\s*=|union\s+(all\s+)?select|information_schema|sleep\s*\(\s*\d|benchmark\s*\(|;\s*drop\s+table|'\s*or\s*'?1'?\s*=\s*'?1|\bexec\s*\(|\/etc\/passwd|base64_decode\(|\bwget\s+http|\bcurl\s+http)/i;
const BAD_KEY = /^(\$|__proto__$|constructor$|prototype$)/;

const ip4 = (s) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); if (!m) return null; const p = m.slice(1).map(Number); if (p.some(n => n > 255)) return null; return ((p[0] * 16777216) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0; };
const parseRange = (tok) => {   // "1.2.3.4" or "1.2.3.0/24" → [start, end] (IPv4 only)
  const [a, bits] = String(tok).trim().split('/'); const n = ip4(a); if (n === null) return null;
  const b = bits === undefined ? 32 : Number(bits); if (!Number.isInteger(b) || b < 0 || b > 32) return null;
  const size = b === 0 ? 4294967296 : Math.pow(2, 32 - b); const start = Math.floor(n / size) * size;
  return [start, start + size - 1];
};
const buildRanges = (list) => { const r = list.filter(Boolean).sort((a, b) => a[0] - b[0]); const out = []; for (const x of r) { const l = out[out.length - 1]; if (l && x[0] <= l[1] + 1) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); } return out; };
const inRanges = (ranges, n) => { let lo = 0, hi = ranges.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, r = ranges[mid]; if (n < r[0]) hi = mid - 1; else if (n > r[1]) lo = mid + 1; else return true; } return false; };
const isPrivate = (ip) => ip === '127.0.0.1' || ip === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(ip);
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(x.hostname) && u.length <= 300; } catch { return false; } };

const clean = (inp, base) => {   // turn whatever the admin screen sends into a valid config (never trust the input)
  const d = JSON.parse(JSON.stringify(base)); if (!inp || typeof inp !== 'object') return d;
  const b = (v, def) => (typeof v === 'boolean' ? v : def), n = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
  d.defaultDeny = b(inp.defaultDeny, d.defaultDeny); d.strictProtocol = b(inp.strictProtocol, d.strictProtocol); d.hostCheck = b(inp.hostCheck, d.hostCheck);
  if (Array.isArray(inp.allowedHosts)) d.allowedHosts = inp.allowedHosts.map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z0-9.-]{3,100}$/.test(x)).slice(0, 20);
  if (inp.dropStyle === 'blackhole' || inp.dropStyle === 'reset') d.dropStyle = inp.dropStyle;
  if (inp.groups && typeof inp.groups === 'object') for (const id of GROUP_IDS) { const g = inp.groups[id]; if (g) d.groups[id] = { on: b(g.on, d.groups[id].on), perMin: n(g.perMin, d.groups[id].perMin, 0, 10000) }; }
  if (inp.ips) { const i = inp.ips; d.ips = { enabled: b(i.enabled, d.ips.enabled), signatures: b(i.signatures, d.ips.signatures), behavior: b(i.behavior, d.ips.behavior), banStrikes: n(i.banStrikes, d.ips.banStrikes, 3, 200), banMinutes: n(i.banMinutes, d.ips.banMinutes, 1, 1440), loginFailsToBan: n(i.loginFailsToBan, d.ips.loginFailsToBan, 3, 200) }; }
  if (inp.intel) {
    const i = inp.intel; d.intel.enabled = b(i.enabled, d.intel.enabled);
    if (Array.isArray(i.feeds)) d.intel.feeds = i.feeds.slice(0, 8).map((f, k) => ({ id: String(f.id || 'feed' + k).replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'feed' + k, label: String(f.label || f.url || 'Feed').slice(0, 80), url: String(f.url || ''), on: !!f.on })).filter(f => safeUrl(f.url));
    for (const k of ['customBlock', 'customAllow']) if (Array.isArray(i[k])) d.intel[k] = i[k].map(x => String(x).trim()).filter(x => parseRange(x)).slice(0, 2000);
  }
  return d;
};
const restrictiveChange = (a, b) => {   // did the change block more than before?
  if (!a.defaultDeny && b.defaultDeny) return true; if (!a.strictProtocol && b.strictProtocol) return true; if (!a.hostCheck && b.hostCheck) return true;
  for (const id of GROUP_IDS) { if (a.groups[id].on && !b.groups[id].on) return true; if ((!a.groups[id].perMin && b.groups[id].perMin) || (b.groups[id].perMin && b.groups[id].perMin < a.groups[id].perMin)) return true; }
  if (!a.intel.enabled && b.intel.enabled) return true; if (b.intel.feeds.some(f => f.on && !(a.intel.feeds.find(x => x.id === f.id)?.on))) return true;
  if (b.intel.customBlock.length > a.intel.customBlock.length) return true;
  return false;
};

export function createSnapsaFirewall({ log = console } = {}) {
  let cfg = defaultConfig();
  let pending = null;                 // { prev, expiresAt }  — a blocking change waiting to be confirmed
  let store = null;                   // database hooks (set by attachStore)
  let registry = { ready: false, routes: 0, match: () => ({ exists: true, methodOk: true }) };
  let intelState = { ranges: [], allow: [], feedStatus: {}, lastRefresh: 0 };
  const bans = new Map(), strikes = new Map(), hits = new Map(), grpHits = new Map(), authFails = new Map(), unknownPaths = new Map(), ws = new Map();
  const held = new Set(), heldPerIp = new Map();
  const stats = { dropped: 0, banned: 0, flood: 0, injected: 0, probes: 0, rules: 0, deny: 0, intel: 0, startedAt: Date.now() };
  const recent = [];

  const ipOf = (req) => {
    const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const raw = xff.length ? xff[Math.max(0, xff.length - HOPS)] : (req.ip || req.socket?.remoteAddress || '');
    return String(raw).replace(/^::ffff:/, '').slice(0, 64);
  };
  const isLocal = (ip) => isPrivate(ip) || ALLOW_ENV.has(ip);
  const note = (ip, why, extra) => { recent.push({ at: new Date().toISOString(), ip, why, ...(extra ? { extra: String(extra).slice(0, 120) } : {}) }); if (recent.length > 120) recent.shift(); };

  /* ── dropping ── */
  const drop = (req, res, ip, why, extra) => {
    stats.dropped++; note(ip, why, extra);
    try { log.warn?.(`[firewall] dropped ${ip} ${why}`); } catch {}
    const sock = req.socket;
    if (cfg.dropStyle === 'blackhole' && sock && held.size < 300 && (heldPerIp.get(ip) || 0) < 5) {
      // say NOTHING and leave the connection hanging, exactly like an address that does not answer; close it later
      held.add(sock); heldPerIp.set(ip, (heldPerIp.get(ip) || 0) + 1);
      try { req.resume(); } catch {}
      const done = () => { if (held.delete(sock)) { const n = (heldPerIp.get(ip) || 1) - 1; if (n <= 0) heldPerIp.delete(ip); else heldPerIp.set(ip, n); } };
      sock.once('close', done);
      const t = setTimeout(() => { try { sock.destroy(); } catch {} }, 20000 + Math.floor(Math.random() * 15000)); t.unref?.();
      sock.once('close', () => clearTimeout(t));
      return;
    }
    try { sock?.destroy(); } catch {}
  };
  const persistBan = (ip) => { const b = bans.get(ip); try { b && store?.saveBan?.({ ip, until: new Date(b.until), count: b.count, reason: b.reason }); } catch {} };
  const addBan = (ip, ms, reason, count) => { const now = Date.now(); const prev = bans.get(ip); const c = count || ((prev?.count || 0) + 1); bans.set(ip, { until: now + ms, count: c, reason, at: now }); stats.banned++; persistBan(ip); try { log.warn?.(`[firewall] BANNED ${ip} ${Math.round(ms / 60000)} min (${reason})`); } catch {} };
  const strike = (ip, pts, why) => {
    if (isLocal(ip) || !cfg.ips.enabled || SAFE_MODE) return;
    const now = Date.now(), win = 10 * 60 * 1000, list = (strikes.get(ip) || []).filter(s => now - s.at < win); list.push({ at: now, pts }); strikes.set(ip, list);
    if (list.reduce((a, s) => a + s.pts, 0) >= cfg.ips.banStrikes) {
      const count = (bans.get(ip)?.count || 0) + 1;
      addBan(ip, Math.min(24 * 3600 * 1000, cfg.ips.banMinutes * 60000 * Math.pow(2, count - 1)), why, count); strikes.delete(ip);
    }
  };
  const banned = (ip) => { const b = bans.get(ip); if (!b) return false; if (Date.now() > b.until) { bans.delete(ip); try { store?.deleteBan?.(ip); } catch {} return false; } return true; };

  /* ── threat intelligence ── */
  const intelHit = (ip) => { if (!cfg.intel.enabled) return null; const n = ip4(ip); if (n === null) return null; if (inRanges(intelState.allow, n)) return null; return inRanges(intelState.ranges, n) ? 'listed' : null; };
  const rebuildIntel = () => {
    const allow = buildRanges(cfg.intel.customAllow.map(parseRange));
    const parts = cfg.intel.customBlock.map(parseRange);
    for (const f of cfg.intel.feeds) if (f.on) for (const r of (feedCache.get(f.id) || [])) parts.push(r);
    intelState.allow = allow; intelState.ranges = buildRanges(parts);
  };
  const feedCache = new Map();
  const parseFeed = (text) => { const out = []; for (const line of String(text).split(/\r?\n/)) { const t = line.replace(/[#;].*$/, '').trim().split(/\s+/)[0]; if (!t) continue; const r = parseRange(t); if (r) out.push(r); } return out; };
  const refreshIntel = async () => {
    for (const f of cfg.intel.feeds) {
      if (!f.on) continue;
      const st = intelState.feedStatus[f.id] = { ...(intelState.feedStatus[f.id] || {}), checking: true };
      try {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
        const r = await fetch(f.url, { signal: ac.signal, headers: { 'user-agent': 'SnapsaFirewall/1' } }); clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const txt = await r.text(); if (txt.length > 12 * 1024 * 1024) throw new Error('list too large');
        const ranges = parseFeed(txt); if (!ranges.length) throw new Error('no addresses found');
        feedCache.set(f.id, ranges); Object.assign(st, { ok: true, count: ranges.length, at: Date.now(), error: '' });
      } catch (e) { Object.assign(st, { ok: false, error: String(e.message || e).slice(0, 80), at: Date.now() }); }
      st.checking = false;
    }
    intelState.lastRefresh = Date.now(); rebuildIntel();
  };

  /* ── route registry (default deny) ── */
  const buildRegistry = (app) => {
    try {
      const stack = app._router?.stack || app.router?.stack || [];
      const routeLayers = [], mounts = [];
      for (const l of stack) {
        if (l.route) routeLayers.push(l);
        else if (typeof l.match === 'function' && !(l.regexp && l.regexp.fast_slash) && !l.slash && l.name !== 'query' && l.name !== 'expressInit') mounts.push(l);
      }
      registry = {
        ready: routeLayers.length > 20, routes: routeLayers.length,
        match: (method, path) => {
          const m = method === 'HEAD' ? 'get' : method.toLowerCase();
          let exists = false;
          for (const l of routeLayers) { let ok = false; try { ok = l.match(path); } catch {} if (ok) { exists = true; if (method === 'OPTIONS' || l.route._all || l.route.methods?.[m] || l.route.methods?._all) return { exists: true, methodOk: true }; } }
          if (exists) return { exists: true, methodOk: false };
          for (const l of mounts) { let ok = false; try { ok = l.match(path); } catch {} if (ok) return { exists: true, methodOk: true }; }
          return { exists: false, methodOk: false };
        },
      };
    } catch { registry = { ready: false, routes: 0, match: () => ({ exists: true, methodOk: true }) }; }
  };

  const groupOf = (method, p) => {
    const mut = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (p.startsWith('/snapsa/admin')) return 'admin';
    if (p === '/' || p === '/health' || p === '/healthz' || p === '/ping') return 'ping';
    if (p === '/snapsa/auth/signup' || p === '/snapsa/username') return 'signup';
    if (p.startsWith('/snapsa/auth/')) return 'signin';
    if (p.startsWith('/snapsa/media') || p.startsWith('/uploads')) return 'media';
    if (mut && /^\/snapsa\/(videos\/upload|sounds\/upload|stories|avatar|music\/(tracks|upload)|posts|channel\/posts)\/?$/.test(p)) return 'upload';
    if (/^\/snapsa\/(wallet|store|webhooks|subscriptions|marketplace)(\/|$)/.test(p)) return 'wallet';
    if (/^\/snapsa\/(messages|groups|groups-join)(\/|$)/.test(p)) return 'messages';
    if (/^\/snapsa\/(call|live)(\/|$)/.test(p)) return 'calls';
    return mut ? 'write' : 'fetch';
  };

  const grpLimit = (ip, id, perMin) => { const k = ip + '|' + id, now = Date.now(); let h = grpHits.get(k); if (!h || now - h.t0 > 60000) { h = { n: 0, t0: now }; grpHits.set(k, h); } return ++h.n > perMin; };

  /* ── gate: runs first ── */
  const gate = (req, res, next) => {
    const ip = ipOf(req);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); res.removeHeader('X-Powered-By');
    const local = isLocal(ip);
    if (!local && banned(ip)) return drop(req, res, ip, 'banned address');
    if (!local && !SAFE_MODE) { const why = intelHit(ip); if (why) { stats.intel++; return drop(req, res, ip, 'threat intelligence list'); } }

    if (!METHODS.has(req.method)) { strike(ip, 4, 'bad method'); return drop(req, res, ip, `bad method ${String(req.method).slice(0, 12)}`); }
    const url = req.url || '';
    if (url.length > 2048) { strike(ip, 3, 'huge url'); return drop(req, res, ip, 'url too long'); }
    if (Object.keys(req.headers).length > 80) { strike(ip, 3, 'too many headers'); return drop(req, res, ip, 'too many headers'); }

    const ua = String(req.headers['user-agent'] || '');
    let pathPart = url, qs = ''; const qi = url.indexOf('?'); if (qi >= 0) { pathPart = url.slice(0, qi); qs = url.slice(qi + 1); }
    let decoded = pathPart; try { decoded = decodeURIComponent(pathPart); } catch { strike(ip, 3, 'bad encoding'); return drop(req, res, ip, 'bad url encoding'); }

    if (cfg.ips.enabled && cfg.ips.signatures) {
      if (BAD_UA.test(ua)) { stats.probes++; strike(ip, 12, 'attack tool'); return drop(req, res, ip, 'attack tool', ua); }
      if (TRICKS.test(pathPart) || TRICKS.test(decoded) || decoded.includes('\\')) { stats.probes++; strike(ip, 6, 'path trick'); return drop(req, res, ip, 'path trick', pathPart); }
      if (PROBE_PATH.test(decoded)) { stats.probes++; strike(ip, 4, 'probe'); return drop(req, res, ip, 'probe', pathPart); }
      if (qs) {
        let dq = qs; try { dq = decodeURIComponent(qs.replace(/\+/g, ' ')); } catch {}
        if (TRICKS.test(qs) || TRICKS.test(dq)) { strike(ip, 6, 'path trick in query'); return drop(req, res, ip, 'path trick in query'); }
        if (QUERY_ATTACK.test(dq) || /(^|&)[^=&]*(\[\s*\$|%5b%24|\$where|\$ne\b|\$gt\b|\$regex|__proto__)/i.test(qs) || /\[\s*\$/.test(dq)) { stats.injected++; strike(ip, 6, 'injection in query'); return drop(req, res, ip, 'injection in query', dq); }
      }
      if (/\$\{\s*jndi:/i.test(`${req.headers.referer || ''} ${req.headers['x-forwarded-host'] || ''} ${ua}`)) { strike(ip, 12, 'log4shell'); return drop(req, res, ip, 'log4shell header'); }
    }

    // flood control
    if (!local) {
      const now = Date.now(); let h = hits.get(ip); if (!h || now - h.t0 > 10000) { h = { n: 0, t0: now }; hits.set(ip, h); }
      if (++h.n > env('FW_FLOOD_10S', 700)) { stats.flood++; if (h.n === env('FW_FLOOD_10S', 700) + 1) strike(ip, 2, 'flood'); return drop(req, res, ip, 'flood'); }
    }

    let group = 'fetch';
    if (!SAFE_MODE) {
      group = groupOf(req.method, decoded);
      // protocol rules
      if (cfg.hostCheck && cfg.allowedHosts.length) { const host = String(req.headers.host || '').toLowerCase().split(':')[0]; if (!cfg.allowedHosts.includes(host) && !ALLOW_ENV.has(host)) { stats.rules++; return drop(req, res, ip, 'wrong host name', host); } }
      // default deny: only real routes of this server get through
      if (registry.ready && cfg.defaultDeny && group !== 'admin') {
        const m = registry.match(req.method, decoded);
        if (!m.exists || (cfg.strictProtocol && !m.methodOk)) {
          stats.deny++;
          if (!local && cfg.ips.enabled && cfg.ips.behavior) {   // many different unknown addresses = someone is scanning
            const now = Date.now(); let u = unknownPaths.get(ip); if (!u || now - u.t0 > 600000) { u = { t0: now, n: 0 }; unknownPaths.set(ip, u); }
            if (++u.n === 10) strike(ip, 12, 'scanning for pages');
          }
          return drop(req, res, ip, m.exists ? 'default deny: wrong method' : 'default deny: unknown address', `${req.method} ${pathPart.slice(0, 60)}`);
        }
      }
      // rule switches (the admin screen's own routes can never be switched off)
      if (group !== 'admin') {
        const g = cfg.groups[group];
        if (g && !g.on) { stats.rules++; return drop(req, res, ip, `rule off: ${group}`); }
        if (g && g.perMin > 0 && !local && grpLimit(ip, group, g.perMin)) { stats.rules++; strike(ip, 1, `too many ${group} requests`); return drop(req, res, ip, `limit: ${group}`); }
      }
    }
    req.fwGroup = group;

    // behaviour watching: password guessing
    if (!SAFE_MODE && cfg.ips.enabled && cfg.ips.behavior && !local && (group === 'signin' || group === 'signup')) {
      res.on('finish', () => {
        if (res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) {
          const now = Date.now(); let a = authFails.get(ip); if (!a || now - a.t0 > 600000) { a = { t0: now, n: 0 }; authFails.set(ip, a); }
          if (++a.n === cfg.ips.loginFailsToBan) { const count = (bans.get(ip)?.count || 0) + 1; addBan(ip, Math.min(24 * 3600000, cfg.ips.banMinutes * 60000 * Math.pow(2, count - 1)), 'password guessing', count); note(ip, 'banned: password guessing'); }
        }
      });
    }

    // never show server internals: 5xx answers carry a plain message
    const origJson = typeof res.json === 'function' ? res.json.bind(res) : null;
    if (origJson) res.json = (body) => {
      if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body) && body.error) {
        try { log.error?.(`[server-error] ${req.method} ${pathPart} → ${String(body.error).slice(0, 300)}`); } catch {}
        body = { error: 'Something went wrong on our side. Please try again.' };
      }
      return origJson(body);
    };
    next();
  };

  /* ── inspect: after the JSON body is read ── */
  const scan = (node, depth, budget) => {
    if (node === null || typeof node !== 'object') return null;
    if (depth > 12) return 'json too deep'; if (--budget.n < 0) return 'json too big';
    if (Array.isArray(node)) { if (node.length > 5000) return 'array too big'; for (const v of node) { const r = scan(v, depth + 1, budget); if (r) return r; } return null; }
    for (const k of Object.keys(node)) { if (BAD_KEY.test(k)) return `bad key "${k.slice(0, 30)}"`; const r = scan(node[k], depth + 1, budget); if (r) return r; }
    return null;
  };
  const inspect = (req, res, next) => {
    if (SAFE_MODE || !cfg.ips.enabled || !cfg.ips.signatures) return next();
    const ip = ipOf(req), budget = { n: 5000 };
    const why = scan(req.body, 0, budget) || scan(req.query, 0, budget) || scan(req.params, 0, budget);
    if (why) { stats.injected++; strike(ip, 6, why); return drop(req, res, ip, `injection: ${why}`); }
    next();
  };

  /* ── websocket guard (silent drop) ── */
  const allowUpgrade = (req) => {
    const ip = ipOf(req); let ok = true, why = '';
    if (!isLocal(ip) && banned(ip)) { ok = false; why = 'banned address (ws)'; }
    else if (!isLocal(ip) && !SAFE_MODE && intelHit(ip)) { ok = false; why = 'threat intelligence list (ws)'; stats.intel++; }
    else if (!SAFE_MODE && cfg.groups.ws && !cfg.groups.ws.on) { ok = false; why = 'rule off: ws'; stats.rules++; }
    else if (BAD_UA.test(String(req.headers['user-agent'] || ''))) { ok = false; why = 'attack tool (ws)'; strike(ip, 12, 'attack tool'); }
    else if (!isLocal(ip) && (ws.get(ip) || 0) >= env('FW_WS_PER_IP', 60)) { ok = false; why = 'too many websockets'; }
    if (!ok) { stats.dropped++; note(ip, why); try { req.socket.destroy(); } catch {} }
    return ok;
  };
  const wsOpened = (req) => { const ip = ipOf(req); ws.set(ip, (ws.get(ip) || 0) + 1); };
  const wsClosed = (req) => { const ip = ipOf(req); const n = (ws.get(ip) || 1) - 1; if (n <= 0) ws.delete(ip); else ws.set(ip, n); };

  /* ── final error handler ── */
  const errorHandler = (err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large to upload.' });
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) { strike(ipOf(req), 2, 'bad json'); return res.status(400).json({ error: 'Bad request.' }); }
    try { log.error?.('[SnapServer]', err?.message); } catch {}
    if (res.headersSent) return next(err);
    const status = Number(err?.status) >= 400 && Number(err?.status) < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Something went wrong on our side. Please try again.' : 'Request not allowed.' });
  };

  /* ── configuration (saved in the database) ── */
  const persist = async () => { try { await store?.saveConfig?.({ cfg, pending }); } catch (e) { log.warn?.('[firewall] could not save settings:', e.message); } };
  const setConfig = async (input, by) => {
    const next = clean(input, cfg);
    if (!pending && restrictiveChange(cfg, next)) pending = { prev: cfg, expiresAt: Date.now() + 10 * 60 * 1000 };
    cfg = next; rebuildIntel(); await persist();
    if (cfg.intel.enabled && cfg.intel.feeds.some(f => f.on && !feedCache.has(f.id))) refreshIntel().catch(() => {});
    note('admin', 'settings changed', by || '');
    return snapshot();
  };
  const confirm = async () => { pending = null; await persist(); return snapshot(); };
  const resetAll = async () => { cfg = defaultConfig(); pending = null; rebuildIntel(); await persist(); return snapshot(); };
  const loadState = (st) => { if (st?.cfg) { cfg = clean(st.cfg, defaultConfig()); pending = st.pending && st.pending.prev ? { prev: clean(st.pending.prev, defaultConfig()), expiresAt: Number(st.pending.expiresAt) || 0 } : null; } rebuildIntel(); };

  const snapshot = () => ({
    config: cfg, groups: GROUPS, safeMode: SAFE_MODE,
    pending: pending ? { secondsLeft: Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)) } : null,
    registry: { ready: registry.ready, routes: registry.routes },
    stats: { ...stats, held: held.size, upSeconds: Math.round((Date.now() - stats.startedAt) / 1000) },
    intel: { listed: intelState.ranges.length, lastRefresh: intelState.lastRefresh, feeds: cfg.intel.feeds.map(f => ({ id: f.id, ...(intelState.feedStatus[f.id] || {}) })) },
    bans: [...bans].map(([ip, b]) => ({ ip, reason: b.reason, times: b.count, minutesLeft: Math.max(0, Math.round((b.until - Date.now()) / 60000)) })).filter(b => b.minutesLeft > 0),
    recent: recent.slice(-60).reverse(),
  });

  const attachStore = async (s) => {
    store = s;
    try { loadState(await s.loadConfig()); } catch (e) { log.warn?.('[firewall] using default settings:', e.message); }
    try { for (const b of (await s.loadBans()) || []) if (new Date(b.until) > new Date()) bans.set(b.ip, { until: new Date(b.until).getTime(), count: b.count || 1, reason: b.reason || '', at: Date.now() }); } catch {}
    setInterval(async () => {   // other server copies / the admin screen may have changed things
      try { const st = await s.loadConfig(); if (st?.cfg && JSON.stringify(st.cfg) !== JSON.stringify(cfg)) loadState(st); } catch {}
    }, 30000).unref?.();
  };

  /* ── admin routes ── */
  const registerAdmin = (app, { snapAuth, requireSnapAdmin }) => {
    const A = [snapAuth, requireSnapAdmin];
    app.get('/snapsa/admin/firewall', ...A, (req, res) => res.json(snapshot()));
    app.put('/snapsa/admin/firewall/config', ...A, async (req, res) => res.json(await setConfig(req.body, String(req.userId))));
    app.post('/snapsa/admin/firewall/confirm', ...A, async (req, res) => res.json(await confirm()));
    app.post('/snapsa/admin/firewall/reset', ...A, async (req, res) => res.json(await resetAll()));
    app.post('/snapsa/admin/firewall/intel/refresh', ...A, async (req, res) => { await refreshIntel(); res.json(snapshot()); });
    app.post('/snapsa/admin/firewall/ban', ...A, (req, res) => {
      const ip = String(req.body?.ip || '').trim(); if (!/^[0-9a-f:.]{3,45}$/i.test(ip)) return res.status(400).json({ error: 'Not a valid address' });
      addBan(ip, Math.min(7 * 24 * 60, Math.max(1, Number(req.body?.minutes) || 60)) * 60000, 'banned by admin', 1); res.json(snapshot());
    });
    app.post('/snapsa/admin/firewall/unban', ...A, (req, res) => {
      if (req.body?.all) { for (const ip of bans.keys()) try { store?.deleteBan?.(ip); } catch {} bans.clear(); strikes.clear(); return res.json(snapshot()); }
      const ip = String(req.body?.ip || '').trim(); bans.delete(ip); strikes.delete(ip); try { store?.deleteBan?.(ip); } catch {} res.json(snapshot());
    });
  };

  /* ── timers ── */
  setInterval(async () => {
    const now = Date.now();
    if (pending && now > pending.expiresAt) { cfg = pending.prev; pending = null; rebuildIntel(); await persist(); note('system', 'change not confirmed — settings put back'); log.warn?.('[firewall] unconfirmed change reverted'); }
    for (const [ip, b] of bans) if (now > b.until + 24 * 3600000) bans.delete(ip);
    for (const [ip, l] of strikes) { const k = l.filter(s => now - s.at < 600000); if (k.length) strikes.set(ip, k); else strikes.delete(ip); }
    for (const [k, h] of hits) if (now - h.t0 > 20000) hits.delete(k);
    for (const [k, h] of grpHits) if (now - h.t0 > 120000) grpHits.delete(k);
    for (const m of [authFails, unknownPaths]) for (const [k, h] of m) if (now - h.t0 > 1200000) m.delete(k);
  }, 15000).unref?.();
  setInterval(() => { refreshIntel().catch(() => {}); }, 6 * 3600000).unref?.();
  setTimeout(() => { refreshIntel().catch(() => {}); }, 25000).unref?.();

  return { gate, inspect, allowUpgrade, wsOpened, wsClosed, errorHandler, snapshot, ipOf, attachStore, buildRegistry, registerAdmin, newId: () => crypto.randomBytes(4).toString('hex'), _test: { clean, groupOf, parseRange, inRanges, buildRanges, parseFeed, setCfg: (c) => { cfg = clean(c, cfg); rebuildIntel(); }, feedCache, rebuildIntel, getCfg: () => cfg } };
}
