// src/AdminFirewall.jsx — admin tab: the Snapsa Firewall. Switch rule groups on/off, default deny, IPS, threat-intelligence lists, bans.
// Anything the firewall refuses is DROPPED (silent) — it never answers "denied". Blocking changes undo themselves after 10 minutes unless you press "Keep changes".
import React, { useCallback, useEffect, useRef, useState } from 'react';

const C = { pink: '#FF2D95', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4', green: '#4ade80', red: '#f87171', amber: '#fbbf24' };
const box = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 14, marginBottom: 14 };
const inp = { boxSizing: 'border-box', padding: '9px 10px', borderRadius: 10, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.05)', color: 'white', fontSize: 14, outline: 'none' };
const H = ({ children, sub }) => <div style={{ marginBottom: 10 }}><div style={{ color: 'white', fontWeight: 800, fontSize: 15 }}>{children}</div>{sub && <div style={{ color: C.gray, fontSize: 12.5, marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}</div>;
const Switch = ({ on, onChange, disabled }) => (
  <button disabled={disabled} onClick={() => onChange(!on)} aria-pressed={on} style={{ width: 50, height: 28, borderRadius: 999, border: 'none', padding: 3, background: on ? 'linear-gradient(135deg,#22c55e,#16a34a)' : 'rgba(255,255,255,.18)', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flexShrink: 0, opacity: disabled ? .5 : 1, cursor: 'pointer' }}>
    <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'white', display: 'block' }} />
  </button>
);
const Row = ({ title, desc, right, danger }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid rgba(255,255,255,.06)' }}>
    <div style={{ flex: 1, minWidth: 0 }}><div style={{ color: 'white', fontWeight: 700, fontSize: 14 }}>{title}{danger && <span style={{ color: C.amber, fontSize: 11, marginLeft: 6 }}>⚠ careful</span>}</div>{desc && <div style={{ color: C.gray, fontSize: 12, lineHeight: 1.35, marginTop: 2 }}>{desc}</div>}</div>
    {right}
  </div>
);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

export default function AdminFirewall({ snapFetch, showToast }) {
  const [snap, setSnap] = useState(null), [draft, setDraft] = useState(null), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [banIp, setBanIp] = useState(''), [left, setLeft] = useState(0);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;

  const load = useCallback(async () => {
    try { const r = await snapFetch('/snapsa/admin/firewall', { cache: 'no-store' }); if (!r.ok) throw 0; const d = await r.json(); setSnap(d); if (!dirtyRef.current) setDraft(d.config); setLeft(d.pending?.secondsLeft || 0); } catch { showToast?.('Could not load the firewall', 'error'); }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => { if (!dirtyRef.current) load(); }, 10000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!left) return; const t = setInterval(() => setLeft(x => Math.max(0, x - 1)), 1000); return () => clearInterval(t); }, [left > 0]);

  const call = async (path, method = 'POST', body) => {
    setBusy(true);
    try {
      const r = await snapFetch(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed'); setSnap(d); setDraft(d.config); setDirty(false); setLeft(d.pending?.secondsLeft || 0); return d;
    } catch (e) { showToast?.(e.message === 'Failed' ? 'Could not do that' : e.message, 'error'); return null; } finally { setBusy(false); }
  };
  const set = (fn) => { setDraft(d => { const n = JSON.parse(JSON.stringify(d)); fn(n); return n; }); setDirty(true); };
  const apply = async () => { const d = await call('/snapsa/admin/firewall/config', 'PUT', draft); if (d) showToast?.(d.pending ? 'Applied — it will undo itself in 10 minutes unless you press Keep changes' : 'Applied', 'success'); };

  if (!snap || !draft) return <p style={{ color: C.gray }}>Loading the firewall…</p>;
  const st = snap.stats;
  const feedStatus = (id) => snap.intel.feeds.find(f => f.id === id) || {};

  return (
    <div style={{ paddingBottom: 90 }}>
      {snap.safeMode && <div style={{ ...box, borderColor: C.amber, color: C.amber, fontSize: 13 }}>🛟 <b>Safe mode is ON</b> (FW_SAFE_MODE=1 on Render). All rules below are ignored and only the basic attack checks run. Remove that setting on Render to use the rules again.</div>}
      {snap.pending && left > 0 && (
        <div style={{ ...box, borderColor: C.pink, background: 'rgba(255,45,149,.10)' }}>
          <div style={{ color: 'white', fontWeight: 800 }}>⏳ Blocking change is on trial — undoes itself in {mmss(left)}</div>
          <div style={{ color: C.gray, fontSize: 12.5, margin: '4px 0 10px' }}>Check that the app still works for people. If it does, keep it. If you got locked out, just wait — it goes back by itself.</div>
          <button disabled={busy} onClick={() => call('/snapsa/admin/firewall/confirm').then(d => d && showToast?.('Changes kept', 'success'))} style={{ width: '100%', padding: 12, borderRadius: 12, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800 }}>Keep changes</button>
        </div>)}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
        {[['Dropped', st.dropped], ['Banned', st.banned], ['Unknown paths', st.deny], ['Rule blocks', st.rules], ['Threat list', st.intel], ['Waiting', st.held]].map(([l, v]) => (
          <div key={l} style={{ ...box, marginBottom: 0, textAlign: 'center', padding: 10 }}><div style={{ color: 'white', fontWeight: 800, fontSize: 20 }}>{v}</div><div style={{ color: C.gray, fontSize: 11 }}>{l}</div></div>))}
      </div>

      <div style={box}>
        <H sub="Refused requests are never answered. “Silent” leaves the connection hanging, like a server that is not there, so attackers cannot tell a firewall exists.">How blocked requests are dropped</H>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['blackhole', '🕳️ Silent (best)'], ['reset', '✂️ Close at once']].map(([v, l]) => <button key={v} onClick={() => set(d => { d.dropStyle = v; })} style={{ flex: 1, padding: 10, borderRadius: 12, border: `1px solid ${draft.dropStyle === v ? C.pink : C.border}`, background: draft.dropStyle === v ? 'rgba(255,45,149,.15)' : 'transparent', color: 'white', fontWeight: 700, fontSize: 13 }}>{l}</button>)}
        </div>
      </div>

      <div style={box}>
        <H sub="The big switches.">Default deny &amp; protocol</H>
        <Row title="Default deny" desc={snap.registry.ready ? `Only the ${snap.registry.routes} real addresses of this server are let through. Everything else is dropped.` : 'Not active: the server could not read its own address list.'} right={<Switch on={draft.defaultDeny} onChange={v => set(d => { d.defaultDeny = v; })} />} />
        <Row title="Strict protocol checks" desc="The request method must be one the address really supports (for example nobody can DELETE a page that only reads)." right={<Switch on={draft.strictProtocol} onChange={v => set(d => { d.strictProtocol = v; })} />} />
        <Row title="Only accept my host names" desc="Drops requests that arrive under another host name (scanners hitting the raw address)." danger right={<Switch on={draft.hostCheck} onChange={v => set(d => { d.hostCheck = v; })} />} />
        {draft.hostCheck && <input value={draft.allowedHosts.join(', ')} onChange={e => set(d => { d.allowedHosts = e.target.value.split(',').map(x => x.trim()).filter(Boolean); })} placeholder="snapsaserver-gzs4.onrender.com, api.mydomain.com" style={{ ...inp, width: '100%', marginTop: 6 }} />}
      </div>

      <div style={box}>
        <H sub="Switch whole parts of the server on or off. The number is the most requests one address may make per minute (0 = no limit). Admin screens can never be switched off.">Rules</H>
        {snap.groups.map(g => (
          <Row key={g.id} title={g.label} desc={g.desc} danger={g.danger}
            right={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min="0" value={draft.groups[g.id].perMin} onChange={e => set(d => { d.groups[g.id].perMin = Number(e.target.value) || 0; })} style={{ ...inp, width: 58, padding: '6px 6px', textAlign: 'center' }} title="requests per minute per address" />
              <Switch on={draft.groups[g.id].on} onChange={v => set(d => { d.groups[g.id].on = v; })} /></div>} />))}
      </div>

      <div style={box}>
        <H sub="Watches for attacks as they happen and bans the address. Each ban is twice as long as the one before (up to 24 h) and survives restarts.">IPS — intrusion prevention</H>
        <Row title="IPS on" right={<Switch on={draft.ips.enabled} onChange={v => set(d => { d.ips.enabled = v; })} />} />
        <Row title="Attack signatures" desc="Hacking tools, probes for secret files, database injection, path tricks." right={<Switch on={draft.ips.signatures} onChange={v => set(d => { d.ips.signatures = v; })} />} />
        <Row title="Behaviour watching" desc="Password guessing and scanning for hidden pages." right={<Switch on={draft.ips.behavior} onChange={v => set(d => { d.ips.behavior = v; })} />} />
        {[['banStrikes', 'Attack points before a ban', 3, 200], ['banMinutes', 'First ban length (minutes)', 1, 1440], ['loginFailsToBan', 'Failed sign-ins before a ban (10 min)', 3, 200]].map(([k, l, lo, hi]) => (
          <Row key={k} title={l} right={<input type="number" min={lo} max={hi} value={draft.ips[k]} onChange={e => set(d => { d.ips[k] = Number(e.target.value) || lo; })} style={{ ...inp, width: 70, textAlign: 'center' }} />} />))}
      </div>

      <div style={box}>
        <H sub={`Public lists of addresses known for attacks. ${snap.intel.listed.toLocaleString()} address ranges loaded · updated ${ago(snap.intel.lastRefresh)}.`}>Threat intelligence</H>
        <Row title="Use threat lists" right={<Switch on={draft.intel.enabled} onChange={v => set(d => { d.intel.enabled = v; })} />} />
        {draft.intel.feeds.map((f, i) => { const s = feedStatus(f.id); return (
          <Row key={f.id} title={f.label} desc={s.checking ? 'Updating…' : s.ok ? `✅ ${s.count?.toLocaleString()} ranges · ${ago(s.at)}` : s.error ? `⚠️ ${s.error}` : f.on ? 'Waiting for first update' : 'Off'}
            right={<Switch on={f.on} onChange={v => set(d => { d.intel.feeds[i].on = v; })} />} />); })}
        <button disabled={busy} onClick={async () => { const d = await call('/snapsa/admin/firewall/intel/refresh'); if (d) showToast?.('Lists updated', 'success'); }} style={{ width: '100%', padding: 10, borderRadius: 12, border: `1px solid ${C.border}`, background: 'transparent', color: 'white', fontWeight: 700, margin: '10px 0' }}>Update lists now</button>
        <div style={{ color: C.gray, fontSize: 12, margin: '4px 0' }}>Always block (one address or range per line)</div>
        <textarea rows={3} value={draft.intel.customBlock.join('\n')} onChange={e => set(d => { d.intel.customBlock = e.target.value.split('\n').map(x => x.trim()).filter(Boolean); })} placeholder={'203.0.113.7\n198.51.100.0/24'} style={{ ...inp, width: '100%', fontFamily: 'monospace' }} />
        <div style={{ color: C.gray, fontSize: 12, margin: '8px 0 4px' }}>Never block (your own addresses — beats every list)</div>
        <textarea rows={2} value={draft.intel.customAllow.join('\n')} onChange={e => set(d => { d.intel.customAllow = e.target.value.split('\n').map(x => x.trim()).filter(Boolean); })} style={{ ...inp, width: '100%', fontFamily: 'monospace' }} />
      </div>

      <div style={box}>
        <H sub="Addresses the firewall has banned right now.">Banned addresses ({snap.bans.length})</H>
        {snap.bans.length === 0 && <div style={{ color: C.gray, fontSize: 13 }}>Nobody is banned.</div>}
        {snap.bans.map(b => <Row key={b.ip} title={<span style={{ fontFamily: 'monospace' }}>{b.ip}</span>} desc={`${b.reason} · ${b.minutesLeft} min left · ban #${b.times}`} right={<button onClick={() => call('/snapsa/admin/firewall/unban', 'POST', { ip: b.ip })} style={{ padding: '7px 12px', borderRadius: 10, border: 'none', background: 'rgba(74,222,128,.18)', color: C.green, fontWeight: 700 }}>Lift</button>} />)}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={banIp} onChange={e => setBanIp(e.target.value)} placeholder="Address to ban for 1 hour" style={{ ...inp, flex: 1 }} />
          <button disabled={!banIp.trim() || busy} onClick={async () => { if (await call('/snapsa/admin/firewall/ban', 'POST', { ip: banIp.trim(), minutes: 60 })) setBanIp(''); }} style={{ padding: '0 14px', borderRadius: 10, border: 'none', background: 'rgba(248,113,113,.2)', color: C.red, fontWeight: 800 }}>Ban</button>
        </div>
        {snap.bans.length > 1 && <button onClick={() => window.confirm('Lift every ban?') && call('/snapsa/admin/firewall/unban', 'POST', { all: true })} style={{ marginTop: 10, background: 'none', border: 'none', color: C.gray, textDecoration: 'underline' }}>Lift all bans</button>}
      </div>

      <div style={box}>
        <H sub="The last things the firewall dropped.">Recent activity</H>
        {snap.recent.length === 0 && <div style={{ color: C.gray, fontSize: 13 }}>Nothing yet.</div>}
        {snap.recent.slice(0, 40).map((e, i) => <div key={i} style={{ fontSize: 12, color: C.gray, padding: '4px 0', borderTop: '1px solid rgba(255,255,255,.05)', wordBreak: 'break-all' }}><span style={{ color: 'white' }}>{e.why}</span> · <span style={{ fontFamily: 'monospace' }}>{e.ip}</span>{e.extra ? ` · ${e.extra}` : ''} · {new Date(e.at).toLocaleTimeString()}</div>)}
      </div>

      <button onClick={() => window.confirm('Put every firewall setting back to the starting values?') && call('/snapsa/admin/firewall/reset')} style={{ background: 'none', border: 'none', color: C.gray, textDecoration: 'underline', fontSize: 13 }}>Reset all settings to start values</button>

      {dirty && (
        <div style={{ position: 'sticky', bottom: 10, marginTop: 12, display: 'flex', gap: 8, zIndex: 5 }}>
          <button onClick={() => { setDraft(snap.config); setDirty(false); }} style={{ padding: '14px 16px', borderRadius: 14, border: `1px solid ${C.border}`, background: '#12061f', color: 'white', fontWeight: 700 }}>Cancel</button>
          <button disabled={busy} onClick={apply} style={{ flex: 1, padding: 14, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, fontSize: 15 }}>{busy ? 'Applying…' : 'Apply changes'}</button>
        </div>)}
    </div>
  );
}
