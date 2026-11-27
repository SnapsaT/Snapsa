// src/FeedLoader.jsx — first-load screen of the feed: neon ring + circle waves (like the voice call) around the Snapsa logo.
// Put the logo in public/FeedLoadLogo.png (falls back to /SnapsaLogo.png).
import React, { useState } from 'react';

export default function FeedLoader({ label = 'Loading' }) {
  const [src, setSrc] = useState('/FeedLoadLogo.png');
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'clamp(28px,7vh,64px)', pointerEvents: 'none' }}>
      <div className="fl-wrap">
        <span className="fl-wave fl-w1" /><span className="fl-wave fl-w2" /><span className="fl-wave fl-w3" />
        <span className="fl-thin fl-t1" /><span className="fl-thin fl-t2" />
        <span className="fl-glow" />
        <span className="fl-ring" />
        <img className="fl-logo" src={src} alt="" draggable={false} onError={() => { if (src !== '/SnapsaLogo.png') setSrc('/SnapsaLogo.png'); }} />
      </div>
      <div className="fl-text">{label}<span className="fl-dots"><i>.</i><i>.</i><i>.</i></span></div>
      <style>{`
        .fl-wrap{position:relative;width:min(66vw,300px);aspect-ratio:1;display:grid;place-items:center}
        .fl-wrap>span,.fl-wrap>img{position:absolute;border-radius:50%}
        .fl-ring{width:78%;height:78%;background:conic-gradient(from 0deg,#8b2bff,#3f6bff,#b44cff,#ff2d95,#8b2bff);
          -webkit-mask:radial-gradient(circle,transparent 50%,#000 53%,#000 98%,transparent 100%);mask:radial-gradient(circle,transparent 50%,#000 53%,#000 98%,transparent 100%);
          filter:blur(.4px) drop-shadow(0 0 14px rgba(150,70,255,.9));animation:flSpin 2.6s linear infinite}
        .fl-glow{width:80%;height:80%;box-shadow:0 0 50px 8px rgba(130,60,255,.55),inset 0 0 40px 6px rgba(130,60,255,.35);animation:flBreath 1.8s ease-in-out infinite alternate}
        .fl-thin{border:1.5px solid rgba(150,90,255,.75);box-shadow:0 0 10px rgba(120,60,255,.7)}
        .fl-t1{width:92%;height:92%}.fl-t2{width:100%;height:100%;border-color:rgba(70,120,255,.6)}
        .fl-wave{width:78%;height:78%;border:2px solid rgba(185,72,255,.75);box-shadow:0 0 16px #8b22ff;opacity:0;animation:flWave 2.4s ease-out infinite}
        .fl-w2{animation-delay:.8s}.fl-w3{animation-delay:1.6s}
        .fl-logo{width:40%;height:40%;border-radius:22%;object-fit:cover;z-index:2;box-shadow:0 0 26px rgba(170,70,255,.6);animation:flLogo 1.8s ease-in-out infinite alternate}
        .fl-text{color:#fff;font:400 clamp(22px,6vw,30px) "Courier New",ui-monospace,Menlo,monospace;letter-spacing:.16em;text-shadow:0 0 14px rgba(170,90,255,.8)}
        .fl-dots i{font-style:normal;opacity:.2;animation:flDot 1.2s infinite}.fl-dots i:nth-child(2){animation-delay:.2s}.fl-dots i:nth-child(3){animation-delay:.4s}
        @keyframes flSpin{to{transform:rotate(360deg)}}
        @keyframes flWave{0%{transform:scale(.9);opacity:.85}100%{transform:scale(1.55);opacity:0}}
        @keyframes flBreath{from{opacity:.6}to{opacity:1}}
        @keyframes flLogo{from{transform:scale(.97)}to{transform:scale(1.04)}}
        @keyframes flDot{0%,100%{opacity:.2}50%{opacity:1}}
      `}</style>
    </div>
  );
}
