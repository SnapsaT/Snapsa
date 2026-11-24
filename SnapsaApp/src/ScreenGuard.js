// src/ScreenGuard.js — blocks screenshots and screen recording (Android FLAG_SECURE) while sensitive content is on screen.
// Uses @capacitor/privacy-screen. In a browser it does nothing. Counted, so two guarded screens can overlap safely.
import { useEffect } from 'react';

let count = 0;
async function plugin() {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return null;
    return (await import('@capacitor/privacy-screen')).PrivacyScreen;
  } catch { return null; }
}
export async function guardOn() {
  count++;
  const P = await plugin();
  if (P && count > 0) { try { await P.enable({ android: { preventScreenshots: true, dimBackground: false, privacyModeOnActivityHidden: 'splash' } }); } catch {} }
}
export async function guardOff() {
  count = Math.max(0, count - 1);
  if (count > 0) return;
  const P = await plugin();
  if (P && count === 0) { try { await P.disable(); } catch {} }
}
export function useScreenGuard(active) {
  useEffect(() => {
    if (!active) return;
    guardOn();
    return () => { guardOff(); };
  }, [active]);
}
