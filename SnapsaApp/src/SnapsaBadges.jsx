import { useMemo } from "react";

const TIER_CONFIG = {
  bronze: {
    label: "BRONZE",
    icon: "🥉",
    grad: [
      { offset: "0%",   color: "#F4A460" },
      { offset: "50%",  color: "#CD7F32" },
      { offset: "100%", color: "#8B4513" },
    ],
    glowColor:     "#CD7F32",
    textColor:     "#CD7F32",
    rimColor:      "#DEB887",
    innerGradient: ["#F4A460", "#8B4513"],
    stars: 1,
  },
  silver: {
    label: "SILVER",
    icon: "🥈",
    grad: [
      { offset: "0%",   color: "#F5F5F5" },
      { offset: "50%",  color: "#C0C0C0" },
      { offset: "100%", color: "#696969" },
    ],
    glowColor:     "#C0C0C0",
    textColor:     "#808080",
    rimColor:      "#E0E0E0",
    innerGradient: ["#F5F5F5", "#696969"],
    stars: 2,
  },
  gold: {
    label: "GOLD",
    icon: "🥇",
    grad: [
      { offset: "0%",   color: "#FFF8DC" },
      { offset: "50%",  color: "#FFD700" },
      { offset: "100%", color: "#B8860B" },
    ],
    glowColor:     "#FFD700",
    textColor:     "#DAA520",
    rimColor:      "#FFD700",
    innerGradient: ["#FFF8DC", "#B8860B"],
    stars: 3,
  },
  platinum: {
    label: "PLATINUM",
    icon: "💎",
    grad: [
      { offset: "0%",   color: "#FFE0EC" },
      { offset: "40%",  color: "#FF7AA8" },
      { offset: "70%",  color: "#FF2D78" },
      { offset: "100%", color: "#C20055" },
    ],
    glowColor:     "#FF2D78",
    textColor:     "#FF2D78",
    rimColor:      "#FFB3D1",
    innerGradient: ["#FFE0EC", "#C20055"],
    stars: 4,
  },
};

// Facebook-style shield path
// viewBox 0 0 100 120
// Flat top, rounded bottom-left and bottom-right that taper to a point
function shieldPath() {
  return `
    M 50,112
    C 50,112 8,88 8,52
    L 8,18
    C 8,14 11,11 15,11
    L 85,11
    C 89,11 92,14 92,18
    L 92,52
    C 92,88 50,112 50,112
    Z
  `;
}

// Small star shape for the star-rating row
function starPath(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const outerAngle = (i * 72 - 90) * (Math.PI / 180);
    const innerAngle = (i * 72 - 90 + 36) * (Math.PI / 180);
    pts.push(`${cx + r * Math.cos(outerAngle)},${cy + r * Math.sin(outerAngle)}`);
    pts.push(`${cx + r * 0.4 * Math.cos(innerAngle)},${cy + r * 0.4 * Math.sin(innerAngle)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

export function SubscriptionBadge({
  tier = "bronze",
  sizePx = 48,
  showLabel = false,
  showIcon = true,
  pulsing = false,
}) {
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.bronze;
  const uid = useMemo(
    () => `badge-${tier}-${Math.random().toString(36).slice(2, 6)}`,
    [tier]
  );

  // viewBox is 100 wide × 120 tall to accommodate the pointed shield
  const vw = 100, vh = 120;
  const displayH = (sizePx / vw) * vh; // keep aspect ratio

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        filter: pulsing
          ? `drop-shadow(0 0 ${sizePx * 0.12}px ${cfg.glowColor})`
          : "none",
        animation: pulsing ? "badgePulse 2s infinite" : "none",
      }}
    >
      <style>{`
        @keyframes badgePulse {
          0%, 100% { opacity: 1; filter: drop-shadow(0 0 ${sizePx * 0.08}px ${cfg.glowColor}); }
          50%       { opacity: 0.88; filter: drop-shadow(0 0 ${sizePx * 0.18}px ${cfg.glowColor}); }
        }
        @keyframes shimmer {
          0%   { opacity: 0.15; }
          50%  { opacity: 0.45; }
          100% { opacity: 0.15; }
        }
        @keyframes platinumSpark {
          0%, 100% { opacity: 0; transform: scale(0) rotate(0deg);   }
          50%       { opacity: 1; transform: scale(1) rotate(180deg); }
        }
      `}</style>

      <svg
        width={sizePx}
        height={displayH}
        viewBox={`0 0 ${vw} ${vh}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: "visible" }}
      >
        <defs>
          {/* Main gradient — top-to-bottom */}
          <linearGradient id={`${uid}-main`} x1="0%" y1="0%" x2="0%" y2="100%">
            {cfg.grad.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>

          {/* Shine overlay — radial highlight */}
          <radialGradient id={`${uid}-shine`} cx="35%" cy="28%" r="60%">
            <stop offset="0%"   stopColor="#ffffff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0"    />
          </radialGradient>

          {/* Inner circle gradient */}
          <radialGradient id={`${uid}-inner`} cx="30%" cy="30%" r="70%">
            <stop offset="0%"   stopColor={cfg.innerGradient[0]} />
            <stop offset="100%" stopColor={cfg.innerGradient[1]} />
          </radialGradient>

          {/* Glow filter */}
          <filter id={`${uid}-glow`} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow
              dx="0" dy="3"
              stdDeviation="4"
              floodColor={cfg.glowColor}
              floodOpacity="0.55"
            />
          </filter>

          {/* Hard drop-shadow for depth */}
          <filter id={`${uid}-depth`} x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="rgba(0,0,0,0.5)" />
          </filter>

          {/* Clip to shield shape */}
          <clipPath id={`${uid}-clip`}>
            <path d={shieldPath()} />
          </clipPath>
        </defs>

        {/* ── Drop shadow behind shield ── */}
        <path
          d={shieldPath()}
          fill="rgba(0,0,0,0.22)"
          transform="translate(2,4) scale(0.97)"
          style={{ transformOrigin: "50px 60px" }}
        />

        {/* ── Shield body ── */}
        <path
          d={shieldPath()}
          fill={`url(#${uid}-main)`}
          filter={`url(#${uid}-glow)`}
          stroke={cfg.rimColor}
          strokeWidth="2.5"
          strokeOpacity="0.7"
        />

        {/* ── Shine overlay clipped to shield ── */}
        <path
          d={shieldPath()}
          fill={`url(#${uid}-shine)`}
          clipPath={`url(#${uid}-clip)`}
          style={{ animation: "shimmer 3s ease-in-out infinite" }}
        />

        {/* ── Thin inner border line ── */}
        <path
          d={shieldPath()}
          fill="none"
          stroke="rgba(255,255,255,0.3)"
          strokeWidth="2"
          transform="scale(0.88)"
          style={{ transformOrigin: "50px 60px" }}
        />

        {/* ── Horizontal divider band (Facebook-style) ── */}
        <rect
          x="8" y="36" width="84" height="22"
          fill="rgba(0,0,0,0.18)"
          clipPath={`url(#${uid}-clip)`}
        />
        <rect
          x="8" y="36" width="84" height="22"
          fill="rgba(255,255,255,0.08)"
          clipPath={`url(#${uid}-clip)`}
        />

        {/* ── Center icon ── */}
        {showIcon && (
          <text
            x="50"
            y="30"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="20"
            filter={`url(#${uid}-depth)`}
          >
            {cfg.icon}
          </text>
        )}

        {/* ── Tier label in the band ── */}
        <text
          x="50"
          y="47"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="10"
          fontWeight="900"
          fontFamily="system-ui, -apple-system, sans-serif"
          letterSpacing="1.5"
          fill="white"
          filter={`url(#${uid}-depth)`}
          style={{ textTransform: "uppercase" }}
        >
          {cfg.label}
        </text>

        {/* ── Star rating row ── */}
        {(() => {
          const totalStars = 4;
          const starR = 5.5;
          const spacing = 13;
          const totalW = (totalStars - 1) * spacing;
          const startX = 50 - totalW / 2;
          const y = 74;
          return Array.from({ length: totalStars }).map((_, i) => (
            <path
              key={i}
              d={starPath(startX + i * spacing, y, starR)}
              fill={i < cfg.stars ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.2)"}
              filter={i < cfg.stars ? `url(#${uid}-depth)` : undefined}
            />
          ));
        })()}

        {/* ── Bottom accent line ── */}
        <line
          x1="28" y1="88" x2="72" y2="88"
          stroke="rgba(255,255,255,0.35)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* ── Platinum sparkle particles ── */}
        {tier === "platinum" && (
          <>
            <circle cx="18" cy="22" r="2" fill="white" opacity="0">
              <animate attributeName="opacity" values="0;1;0" dur="2.8s" repeatCount="indefinite" />
              <animate attributeName="r"       values="1;2.5;1" dur="2.8s" repeatCount="indefinite" />
            </circle>
            <circle cx="82" cy="30" r="1.5" fill="white" opacity="0">
              <animate attributeName="opacity" values="0;1;0" dur="2.2s" begin="0.9s" repeatCount="indefinite" />
              <animate attributeName="r"       values="0.5;2;0.5" dur="2.2s" begin="0.9s" repeatCount="indefinite" />
            </circle>
            <circle cx="50" cy="100" r="1.5" fill="white" opacity="0">
              <animate attributeName="opacity" values="0;0.7;0" dur="3.1s" begin="1.6s" repeatCount="indefinite" />
            </circle>
            {/* 4-point star */}
            <path
              d="M 15,65 L 17,70 L 15,75 L 13,70 Z"
              fill="white"
              opacity="0.5"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 15 70"
                to="360 15 70"
                dur="4s"
                repeatCount="indefinite"
              />
            </path>
          </>
        )}
      </svg>

      {/* ── Optional text label beside badge ── */}
      {showLabel && (
        <span
          style={{
            color: cfg.textColor,
            fontWeight: 800,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            fontSize: sizePx * 0.28,
            textShadow: `0 1px 3px ${cfg.glowColor}50`,
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          {cfg.label}
        </span>
      )}
    </span>
  );
}