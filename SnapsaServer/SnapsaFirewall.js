// SnapsaFirewall.js — Snapsa's own application firewall (WAF). Every request passes through it BEFORE any route runs.
// Malicious requests are DROPPED: the connection is closed with no answer at all, so an attacker learns nothing.
//
// What it does
//   1. Banned addresses are dropped instantly (repeat offenders are banned automatically, longer each time).
//   2. Scanner / attack tools (sqlmap, nikto, nmap, …) and probes for files that don't exist here (.env, .git, wp-admin, phpmyadmin, …).
//   3. Broken or hostile requests: odd HTTP methods, huge URLs/headers, path tricks (../, %2e%2e, null bytes), Log4Shell-style strings.
//   4. Database injection: query / body keys that start with "$" (NoSQL operators), "__proto__" / "constructor" (prototype pollution),
//      absurdly deep or huge JSON. Message TEXT is never judged, so people can still write code or "select" in chats.
//   5. Flood control per address (generous, because many phones share one mobile-network address).
//   6. Safe headers on every answer; server errors never leak internal details (the real error stays in the server log).
//   7. WebSocket guard: ban check + connection cap per address.
// Single-instance memory (like the rest of this server); an admin can look at / lift bans via /snapsa/admin/firewall.
import crypto from 'crypto';

const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const CFG = {
  maxUrl: 2048,
  maxHeaders: 80,
  floodPer10s: env('FW_FLOOD_10S', 700),           // requests per 10s from ONE address before extra requests are dropped
  banAtStrikes: env('FW_BAN_STRIKES', 12),          // attack points inside the window → ban
  strikeWindowMs: 10 * 60 * 1000,
  baseBanMs: env('FW_BAN_MINUTES', 60) * 60 * 1000, // doubles each time the same address is banned again (max 24h)
  maxJsonDepth: 12,
  maxJsonKeys: 5000,
  wsPerIp: env('FW_WS_PER_IP', 60),
};
const ALLOW = new Set((process.env.FW_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean));

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BAD_UA = /(sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|dirbuster|gobuster|wfuzz|ffuf|hydra|zgrab|havij|netsparker|burpcollaborator|w3af|arachni|metasploit|jaeles|nuclei|whatweb|paros|skipfish)/i;
const PROBE_PATH = /(^|\/)(\.env|\.git|\.svn|\.hg|\.ds_store|\.aws|\.ssh|\.htaccess|\.htpasswd|wp-admin|wp-login|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|myadmin|cgi-bin|actuator|server-status|vendor\/phpunit|boaform|jenkins|manager\/html|etc\/passwd|etc\/shadow|proc\/self|web-inf|config\.json|composer\.(json|lock)|package-lock\.json|backup\.(sql|zip|tar)|id_rsa)(\/|$|\?)|\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp|ini|env)(\?|$)/i;
const TRICKS = /(\.\.[\/\\]|%2e%2e|%252e|%00|\x00|\\x00|%c0%ae|%u002e)/i;
const QUERY_ATTACK = /(\$\{\s*jndi:|<\s*script|javascript:|onerror\s*=|onload\s*=|union\s+(all\s+)?select|information_schema|sleep\s*\(\s*\d|benchmark\s*\(|;\s*drop\s+table|'\s*or\s*'?1'?\s*=\s*'?1|\bexec\s*\(|\/etc\/passwd|base64_decode\(|\bwget\s+http|\bcurl\s+http)/i;
const BAD_KEY = /^(\$|__proto__$|constructor$|prototype$)/;

export function createSnapsaFirewall({ log = console } = {}) {
  const bans = new Map();       // ip -> { until, count, reason, at }
  const strikes = new Map();    // ip -> [{ at, pts }]
  const hits = new Map();       // ip -> { n, t0 }
  const ws = new Map();         // ip -> open sockets
  const stats = { dropped: 0, banned: 0, flood: 0, injected: 0, probes: 0, startedAt: Date.now() };
  const recent = [];            // last 100 events for the admin view

  // The real address: Render's front door appends the visitor to X-Forwarded-For, so the entry counted from the RIGHT is trustworthy
  // (anything a visitor writes themselves sits further left and is ignored). Put FW_PROXY_HOPS=2 if Cloudflare is added in front.
  const HOPS = env('FW_PROXY_HOPS', 1);
  const ipOf = (req) => {
    const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const raw = xff.length ? xff[Math.max(0, xff.length - HOPS)] : (req.ip || req.socket?.remoteAddress || '');
    return String(raw).replace(/^::ffff:/, '').slice(0, 64);
  };
  const isLocal = (ip) => ip === '127.0.0.1' || ip === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ALLOW.has(ip);
  const note = (ip, why, extra) => { recent.push({ at: new Date().toISOString(), ip, why, ...(extra ? { extra: String(extra).slice(0, 120) } : {}) }); if (recent.length > 100) recent.shift(); };

  const drop = (req, res, ip, why, extra) => {
    stats.dropped++; note(ip, why, extra);
    try { log.warn?.(`[firewall] dropped ${ip} ${why}`); } catch {}
    try { req.socket?.destroy(); } catch {}
    try { res.destroy?.(); } catch {}
  };
  const strike = (ip, pts, why) => {
    if (isLocal(ip)) return;
    const now = Date.now(), list = (strikes.get(ip) || []).filter(s => now - s.at < CFG.strikeWindowMs); list.push({ at: now, pts }); strikes.set(ip, list);
    if (list.reduce((a, s) => a + s.pts, 0) >= CFG.banAtStrikes) {
      const prev = bans.get(ip), count = (prev?.count || 0) + 1;
      const ms = Math.min(24 * 3600 * 1000, CFG.baseBanMs * Math.pow(2, count - 1));
      bans.set(ip, { until: now + ms, count, reason: why, at: now }); strikes.delete(ip); stats.banned++;
      try { log.warn?.(`[firewall] BANNED ${ip} for ${Math.round(ms / 60000)} min (${why})`); } catch {}
    }
  };
  const banned = (ip) => { const b = bans.get(ip); if (!b) return false; if (Date.now() > b.until) { bans.delete(ip); return false; } return true; };

  // housekeeping so the maps never grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of bans) if (now > b.until + 24 * 3600 * 1000) bans.delete(ip);
    for (const [ip, l] of strikes) { const k = l.filter(s => now - s.at < CFG.strikeWindowMs); if (k.length) strikes.set(ip, k); else strikes.delete(ip); }
    for (const [ip, h] of hits) if (now - h.t0 > 20000) hits.delete(ip);
  }, 60000).unref?.();

  /* ── gate: runs first, before anything else ── */
  const gate = (req, res, next) => {
    const ip = ipOf(req);
    if (!isLocal(ip) && banned(ip)) return drop(req, res, ip, 'banned address');

    // safe headers on every answer
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.removeHeader('X-Powered-By');

    if (!METHODS.has(req.method)) { strike(ip, 4, 'bad method'); return drop(req, res, ip, `bad method ${String(req.method).slice(0, 12)}`); }
    const url = req.url || '';
    if (url.length > CFG.maxUrl) { strike(ip, 3, 'huge url'); return drop(req, res, ip, 'url too long'); }
    if (Object.keys(req.headers).length > CFG.maxHeaders) { strike(ip, 3, 'too many headers'); return drop(req, res, ip, 'too many headers'); }

    const ua = String(req.headers['user-agent'] || '');
    if (BAD_UA.test(ua)) { stats.probes++; strike(ip, 12, 'attack tool'); return drop(req, res, ip, 'attack tool', ua); }

    let pathPart = url, qs = '';
    const qi = url.indexOf('?'); if (qi >= 0) { pathPart = url.slice(0, qi); qs = url.slice(qi + 1); }
    let decoded = pathPart; try { decoded = decodeURIComponent(pathPart); } catch { strike(ip, 3, 'bad encoding'); return drop(req, res, ip, 'bad url encoding'); }
    if (TRICKS.test(pathPart) || TRICKS.test(decoded) || decoded.includes('\\')) { stats.probes++; strike(ip, 6, 'path trick'); return drop(req, res, ip, 'path trick', pathPart); }
    if (PROBE_PATH.test(decoded)) { stats.probes++; strike(ip, 4, 'probe'); return drop(req, res, ip, 'probe', pathPart); }

    if (qs) {
      let dq = qs; try { dq = decodeURIComponent(qs.replace(/\+/g, ' ')); } catch {}
      if (TRICKS.test(qs) || TRICKS.test(dq)) { strike(ip, 6, 'path trick in query'); return drop(req, res, ip, 'path trick in query'); }
      if (QUERY_ATTACK.test(dq) || /(^|&)[^=&]*(\[\s*\$|%5b%24|\$where|\$ne\b|\$gt\b|\$regex|__proto__)/i.test(qs) || /\[\s*\$/.test(dq)) {
        stats.injected++; strike(ip, 6, 'injection in query'); return drop(req, res, ip, 'injection in query', dq);
      }
    }
    const lh = `${req.headers.referer || ''} ${req.headers['x-forwarded-host'] || ''} ${ua}`;
    if (/\$\{\s*jndi:/i.test(lh)) { strike(ip, 12, 'log4shell'); return drop(req, res, ip, 'log4shell header'); }

    // flood control (per address, generous for shared mobile addresses)
    if (!isLocal(ip)) {
      const now = Date.now(); let h = hits.get(ip);
      if (!h || now - h.t0 > 10000) { h = { n: 0, t0: now }; hits.set(ip, h); }
      if (++h.n > CFG.floodPer10s) { stats.flood++; if (h.n === CFG.floodPer10s + 1) strike(ip, 2, 'flood'); return drop(req, res, ip, 'flood'); }
    }

    // never show server internals: any 5xx answer carries a plain message; the real one goes to the server log only
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

  /* ── inspect: runs right after the JSON body is read ── */
  const scan = (node, depth, budget, ip) => {
    if (node === null || typeof node !== 'object') return null;
    if (depth > CFG.maxJsonDepth) return 'json too deep';
    if (--budget.n < 0) return 'json too big';
    if (Array.isArray(node)) { if (node.length > 5000) return 'array too big'; for (const v of node) { const r = scan(v, depth + 1, budget, ip); if (r) return r; } return null; }
    for (const k of Object.keys(node)) {
      if (BAD_KEY.test(k)) return `bad key "${k.slice(0, 30)}"`;
      const r = scan(node[k], depth + 1, budget, ip); if (r) return r;
    }
    return null;
  };
  const inspect = (req, res, next) => {
    const ip = ipOf(req);
    const budget = { n: CFG.maxJsonKeys };
    const why = scan(req.body, 0, budget, ip) || scan(req.query, 0, budget, ip) || scan(req.params, 0, budget, ip);
    if (why) { stats.injected++; strike(ip, 6, why); return drop(req, res, ip, `injection: ${why}`); }
    next();
  };

  /* ── websocket guard ── */
  const allowUpgrade = (req) => {
    const ip = ipOf(req);
    if (!isLocal(ip) && banned(ip)) { stats.dropped++; note(ip, 'banned address (ws)'); return false; }
    if (BAD_UA.test(String(req.headers['user-agent'] || ''))) { strike(ip, 12, 'attack tool'); return false; }
    if (!isLocal(ip) && (ws.get(ip) || 0) >= CFG.wsPerIp) { note(ip, 'too many websockets'); return false; }
    return true;
  };
  const wsOpened = (req) => { const ip = ipOf(req); ws.set(ip, (ws.get(ip) || 0) + 1); };
  const wsClosed = (req) => { const ip = ipOf(req); const n = (ws.get(ip) || 1) - 1; if (n <= 0) ws.delete(ip); else ws.set(ip, n); };

  /* ── final error handler: no stack traces, no internals ── */
  const errorHandler = (err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large to upload.' });
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) { strike(ipOf(req), 2, 'bad json'); return res.status(400).json({ error: 'Bad request.' }); }
    try { log.error?.('[SnapServer]', err?.message); } catch {}
    if (res.headersSent) return next(err);
    const status = Number(err?.status) >= 400 && Number(err?.status) < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Something went wrong on our side. Please try again.' : 'Request not allowed.' });
  };

  const snapshot = () => ({
    stats: { ...stats, upSeconds: Math.round((Date.now() - stats.startedAt) / 1000) },
    bans: [...bans].map(([ip, b]) => ({ ip, reason: b.reason, times: b.count, minutesLeft: Math.max(0, Math.round((b.until - Date.now()) / 60000)) })),
    recent: recent.slice(-40).reverse(),
  });
  const unban = (ip) => { strikes.delete(ip); return bans.delete(ip); };
  const unbanAll = () => { const n = bans.size; bans.clear(); strikes.clear(); return n; };

  return { gate, inspect, allowUpgrade, wsOpened, wsClosed, errorHandler, snapshot, unban, unbanAll, ipOf, newId: () => crypto.randomBytes(4).toString('hex') };
}
