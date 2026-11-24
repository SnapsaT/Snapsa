// src/StoryShared.js — fonts, backgrounds and smart suggestions shared by the story screens.
export const STORY_FONTS = [
  { id: 'system',  label: 'Default', style: { fontFamily: 'system-ui, sans-serif', fontWeight: 700 } },
  { id: 'serif',   label: 'Classic', style: { fontFamily: 'Georgia, serif', fontWeight: 700, fontStyle: 'italic' } },
  { id: 'mono',    label: 'Code',    style: { fontFamily: 'monospace', fontWeight: 700, letterSpacing: '-1px' } },
  { id: 'rounded', label: 'Rounded', style: { fontFamily: '"Helvetica Neue", sans-serif', fontWeight: 900, letterSpacing: '1px' } },
  { id: 'thin',    label: 'Light',   style: { fontFamily: 'system-ui, sans-serif', fontWeight: 300, letterSpacing: '3px', textTransform: 'uppercase', fontSize: '20px' } },
  { id: 'shadow',  label: 'Shadow',  style: { fontFamily: 'Impact, sans-serif', fontWeight: 900, textShadow: '3px 3px 0px rgba(0,0,0,0.5)', letterSpacing: '2px' } },
];

export const STORY_BG_GRADIENTS = [
  'linear-gradient(135deg,#9333ea,#4338ca,#2563eb)', 'linear-gradient(135deg,#f97316,#ef4444,#db2777)',
  'linear-gradient(135deg,#06b6d4,#3b82f6,#4f46e5)', 'linear-gradient(135deg,#10b981,#16a34a,#0f766e)',
  'linear-gradient(135deg,#1e293b,#111827,#000000)', 'linear-gradient(135deg,#f472b6,#fb7185,#d946ef)',
  'linear-gradient(135deg,#fbbf24,#fb923c,#eab308)', 'linear-gradient(135deg,#c026d3,#9333ea,#06b6d4)',
  'linear-gradient(135deg,#b91c1c,#c2410c,#a16207)', 'linear-gradient(135deg,#a78bfa,#c084fc,#818cf8)',
];

export const buildStorySuggestions = () => {
  const h = new Date().getHours(), d = new Date().getDay();
  const greeting = h >= 5 && h < 12 ? 'Good morning ☀️' : h < 17 && h >= 12 ? 'Good afternoon 😎' : h >= 17 && h < 21 ? 'Good evening 🌇' : 'Burning the midnight oil 🌙';
  const day = d === 0 ? 'Sunday reset mode 🧘' : d === 1 && h < 12 ? 'New week, new goals 💪' : d === 5 && h >= 14 ? 'TGIF! The weekend is knocking 🎉' : d === 6 ? 'Saturday vibes 🌟' : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][d - 1] + ' energy ⚡';
  const extras = ['Drop your current vibe in one word 🎯', 'Grateful for the small things today 🙏', 'What song is on repeat right now? 🎵', 'Share your current view 📸', "This week's lesson so far… 📖"];
  return [greeting, day, extras[Math.floor(Math.random() * extras.length)]];
};

export const timeAgo = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
