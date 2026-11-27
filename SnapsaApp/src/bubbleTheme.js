// src/bubbleTheme.js — chat bubble colours that change with the day of the week and the time of day.
import { useEffect, useState } from 'react';

// [hue A, hue B] for Sunday … Saturday
const DAYS = [[330, 28], [212, 186], [152, 174], [276, 316], [18, 350], [322, 262], [44, 24]];
// Morning is light and warm, afternoon vivid, evening rich, night deep.
const phase = (h) => h >= 5 && h < 11 ? { name: 'Morning', l: 50, s: 82, shift: 8 }
  : h >= 11 && h < 17 ? { name: 'Afternoon', l: 47, s: 90, shift: 0 }
  : h >= 17 && h < 21 ? { name: 'Evening', l: 41, s: 84, shift: -8 }
  : { name: 'Night', l: 32, s: 78, shift: -14 };

export function bubbleThemeNow(d = new Date()) {
  const [a, b] = DAYS[d.getDay()];
  const p = phase(d.getHours());
  const ha = (a + p.shift + 360) % 360, hb = (b + p.shift + 360) % 360;
  return {
    label: `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]} ${p.name}`,
    own: `linear-gradient(135deg, hsl(${ha} ${p.s}% ${p.l}%) 0%, hsl(${hb} ${p.s}% ${Math.max(22, p.l - 12)}%) 100%)`,
    other: `linear-gradient(145deg, hsla(${ha} 38% ${Math.max(16, p.l - 22)}%, .94), hsla(${hb} 34% ${Math.max(9, p.l - 32)}%, .94))`,
    glow: `hsla(${ha} ${p.s}% 60% / .45)`,
  };
}

export function useBubbleTheme() {
  const [t, setT] = useState(() => bubbleThemeNow());
  useEffect(() => { const i = setInterval(() => setT(bubbleThemeNow()), 5 * 60 * 1000); return () => clearInterval(i); }, []);
  return t;
}
