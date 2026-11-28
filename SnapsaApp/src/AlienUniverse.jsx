import React, { useMemo } from 'react';
import './AlienUniverse.css';

/**
 * SNAPSA Alien Universe — background scene (no planets, no galaxy).
 * Neon-purple theme: holo grid floor, a hovering UFO, and little aliens who
 * walk, wave and work. Pure SVG + CSS animation, no timers, no re-renders.
 *
 * <AlienBackground />   ← used behind every screen
 * <Alien variant="mint" pose="walking" />
 * <UFO />
 */

let _uid = 0;

const SKINS = {
  mint:   { hi: '#eafff6', base: '#86f2c4', mid: '#2fbf94', sh: '#0e5754', glow: '#6ef3c5' },
  violet: { hi: '#f5efff', base: '#c6a8ff', mid: '#8a5cf0', sh: '#33186c', glow: '#b44cff' },
  pink:   { hi: '#ffeaf4', base: '#ffa0cb', mid: '#e8458f', sh: '#6a1138', glow: '#ff2d95' },
  cyan:   { hi: '#e8fdff', base: '#8eecff', mid: '#27b4d8', sh: '#0b4a66', glow: '#22e4ff' },
  amber:  { hi: '#fff6e0', base: '#ffd37c', mid: '#f09a2a', sh: '#6b3406', glow: '#ffd600' },
};

/** One alien. pose: idle | walking | waving | working */
export function Alien({ variant = 'mint', pose = 'idle', size = 64, className = '', style }) {
  const id = useMemo(() => `atu${++_uid}`, []);
  const c = SKINS[variant] || SKINS.mint;
  return (
    <svg
      className={`atu-alien ${pose} ${className}`}
      viewBox="0 0 80 132"
      width={size}
      height={(size * 132) / 80}
      style={style}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`${id}s`} cx="32%" cy="22%" r="85%">
          <stop offset="0" stopColor={c.hi} />
          <stop offset=".28" stopColor={c.base} />
          <stop offset=".7" stopColor={c.mid} />
          <stop offset="1" stopColor={c.sh} />
        </radialGradient>
        <linearGradient id={`${id}u`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6a4bc4" />
          <stop offset=".55" stopColor="#2b1763" />
          <stop offset="1" stopColor="#120a30" />
        </linearGradient>
        <radialGradient id={`${id}e`} cx="35%" cy="28%" r="80%">
          <stop offset="0" stopColor="#4a63a8" />
          <stop offset=".5" stopColor="#0a0f26" />
          <stop offset="1" stopColor="#02030a" />
        </radialGradient>
        <radialGradient id={`${id}g`}>
          <stop offset="0" stopColor={c.glow} stopOpacity=".95" />
          <stop offset="1" stopColor={c.glow} stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse className="atu-shadow" cx="40" cy="128" rx="23" ry="3.6" fill="#000" opacity=".5" />

      <g className="atu-bob">
        {/* legs */}
        <g className="atu-leg l">
          <rect x="28" y="98" width="9" height="20" rx="4.5" fill={`url(#${id}u)`} />
          <ellipse cx="32.5" cy="119" rx="7.5" ry="3.6" fill={c.glow} opacity=".92" />
        </g>
        <g className="atu-leg r">
          <rect x="43" y="98" width="9" height="20" rx="4.5" fill={`url(#${id}u)`} />
          <ellipse cx="47.5" cy="119" rx="7.5" ry="3.6" fill={c.glow} opacity=".92" />
        </g>

        {/* back arm (left) */}
        <g className="atu-arm l">
          <rect x="16.5" y="71" width="8.5" height="25" rx="4.2" fill={`url(#${id}s)`} />
          <circle cx="20.7" cy="97" r="4.6" fill={`url(#${id}s)`} />
        </g>

        {/* suit */}
        <path
          d="M24 77 Q24 68 33 68 H47 Q56 68 56 77 V98 Q56 102 52 102 H28 Q24 102 24 98 Z"
          fill={`url(#${id}u)`}
          stroke={c.glow}
          strokeOpacity=".75"
          strokeWidth="1"
        />
        <path d="M27 95 H53" stroke={c.glow} strokeOpacity=".6" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="40" cy="83" r="9" fill={`url(#${id}g)`} />
        <circle cx="40" cy="83" r="5.8" fill={c.glow} />
        <text x="40" y="86.3" textAnchor="middle" fontSize="8.4" fontWeight="900" fill="#1a0533" fontFamily="Inter,system-ui,sans-serif">S</text>

        {/* neck + head */}
        <rect x="36" y="63" width="8" height="8" rx="3" fill={c.mid} />
        <g className="atu-head">
          {/* antennae */}
          <path d="M34 14 Q28 7 25 3" stroke={c.mid} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M46 14 Q52 7 55 3" stroke={c.mid} strokeWidth="2" fill="none" strokeLinecap="round" />
          <circle className="atu-bulb" cx="25" cy="3.2" r="3.2" fill={c.glow} />
          <circle className="atu-bulb b" cx="55" cy="3.2" r="3.2" fill={c.glow} />
          {/* ears */}
          <path d="M16 38 Q5 33 4 28 Q12 28 17 32 Z" fill={`url(#${id}s)`} />
          <path d="M64 38 Q75 33 76 28 Q68 28 63 32 Z" fill={`url(#${id}s)`} />
          {/* head */}
          <path
            d="M40 12 C58 12 66 27 64 43 C62 57 51 66 40 66 C29 66 18 57 16 43 C14 27 22 12 40 12 Z"
            fill={`url(#${id}s)`}
          />
          <ellipse cx="30" cy="20" rx="8" ry="4" fill="#fff" opacity=".28" transform="rotate(-24 30 20)" />
          {/* eyes */}
          <g className="atu-eyes">
            <ellipse cx="29.5" cy="42" rx="7.4" ry="10" transform="rotate(-14 29.5 42)" fill={`url(#${id}e)`} />
            <ellipse cx="50.5" cy="42" rx="7.4" ry="10" transform="rotate(14 50.5 42)" fill={`url(#${id}e)`} />
            <circle cx="27.4" cy="37.6" r="2.5" fill="#fff" />
            <circle cx="31.6" cy="46" r="1.2" fill="#fff" opacity=".8" />
            <circle cx="48.4" cy="37.6" r="2.5" fill="#fff" />
            <circle cx="52.6" cy="46" r="1.2" fill="#fff" opacity=".8" />
          </g>
          {/* mouth + cheeks */}
          <path d="M34.5 56 Q40 60.5 45.5 56" stroke={c.sh} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <ellipse cx="23.5" cy="52" rx="3.6" ry="2.2" fill="#ff6fa3" opacity=".5" />
          <ellipse cx="56.5" cy="52" rx="3.6" ry="2.2" fill="#ff6fa3" opacity=".5" />
        </g>

        {/* front arm (right) */}
        <g className="atu-arm r">
          <rect x="55" y="71" width="8.5" height="25" rx="4.2" fill={`url(#${id}s)`} />
          <circle cx="59.3" cy="97" r="4.6" fill={`url(#${id}s)`} />
        </g>
      </g>
    </svg>
  );
}

/** Hovering saucer with a soft beam and blinking neon lights. */
export function UFO({ className = '', size = 120, beam = true }) {
  const id = useMemo(() => `atuf${++_uid}`, []);
  return (
    <svg className={`atu-ufo ${className}`} viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}d`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3e9ff" />
          <stop offset=".38" stopColor="#a88bd6" />
          <stop offset=".78" stopColor="#4a2f86" />
          <stop offset="1" stopColor="#1a0d40" />
        </linearGradient>
        <radialGradient id={`${id}m`} cx="34%" cy="24%" r="85%">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".4" stopColor="#bff6ff" />
          <stop offset=".8" stopColor="#4a86d0" />
          <stop offset="1" stopColor="#25346f" />
        </radialGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#22e4ff" stopOpacity=".5" />
          <stop offset="1" stopColor="#b44cff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {beam && <polygon className="atu-beam" points="44,58 76,58 108,118 12,118" fill={`url(#${id}b)`} />}
      <path d="M40 38 C40 20 80 20 80 38 Z" fill={`url(#${id}m)`} stroke="#d6f8ff" strokeOpacity=".7" strokeWidth=".8" />
      <ellipse cx="60" cy="46" rx="52" ry="13" fill={`url(#${id}d)`} stroke="#c9a8ff" strokeOpacity=".8" strokeWidth=".8" />
      <ellipse cx="60" cy="43" rx="40" ry="5" fill="#fff" opacity=".18" />
      {[16, 32, 48, 64, 80, 96].map((x, i) => (
        <circle
          key={x}
          className="atu-light"
          cx={x + 2}
          cy={50 + Math.sin((i / 5) * Math.PI) * 3.2}
          r="2.6"
          fill={i % 2 ? '#22e4ff' : '#ff2d95'}
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </svg>
  );
}

// fixed sparkle positions (stable, not re-randomised on every render)
const SPARKS = [
  [6, 12, 'p'], [18, 30, 'c'], [31, 8, 'w'], [47, 22, 'p'], [63, 10, 'c'], [78, 28, 'w'],
  [91, 14, 'p'], [12, 52, 'c'], [38, 46, 'w'], [58, 40, 'p'], [84, 50, 'c'], [95, 36, 'w'],
  [25, 66, 'p'], [70, 62, 'w'], [50, 70, 'c'],
];

const WALKERS = [
  { v: 'mint',   size: 52, dur: 17, delay: 0,   left: '4%',  span: 62 },
  { v: 'pink',   size: 44, dur: 23, delay: -9,  left: '30%', span: 55 },
  { v: 'violet', size: 48, dur: 29, delay: -15, left: '10%', span: 70 },
];

export const AlienBackground = React.memo(function AlienBackground() {
  return (
    <div className="atu-bg" aria-hidden="true">
      <div className="atu-glow" />
      {SPARKS.map(([x, y, k], i) => (
        <i key={i} className={`atu-spark ${k}`} style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${(i * 0.37) % 4}s` }} />
      ))}

      {/* flying saucer + a smaller one far away */}
      <div className="atu-ufo-lane">
        <UFO className="atu-ufo-main" size={112} />
      </div>
      <div className="atu-ufo-lane far">
        <UFO className="atu-ufo-main" size={58} beam={false} />
      </div>

      {/* neon holo floor */}
      <div className="atu-floor"><div className="atu-grid" /></div>
      <div className="atu-horizon" />

      {/* crew */}
      <div className="atu-crew">
        {WALKERS.map((w, i) => (
          <div
            key={i}
            className="atu-walker"
            style={{ left: w.left, '--span': `${w.span}vw`, '--dur': `${w.dur}s`, animationDelay: `${w.delay}s` }}
          >
            <div className="atu-flip" style={{ animationDelay: `${w.delay}s` }}>
              <Alien variant={w.v} pose="walking" size={w.size} />
            </div>
          </div>
        ))}
        <div className="atu-station">
          <Alien variant="cyan" pose="waving" size={46} />
        </div>
        <div className="atu-station two">
          <Alien variant="amber" pose="working" size={42} />
          <div className="atu-console"><b /><b /><b /></div>
        </div>
      </div>
    </div>
  );
});

export default function AlienUniverse() {
  return <AlienBackground />;
}
