// Registers this device for push, creates the loud "heads-up" channel, and sends the FCM token to the server.
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

export const SNAPSA_CHANNEL_ID = 'snapsa_default'; // must match android.notification.channelId on the server

let listenersAdded = false;

// Short "ping" for when a notification arrives while the app is open.
let _ctx = null;
export function playSnapsaPing() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _ctx = _ctx || new AC();
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    const t = _ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const o = _ctx.createOscillator(), g = _ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25);
      o.connect(g); g.connect(_ctx.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.3);
    });
  } catch {}
}

export async function registerForPush(postToken) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!listenersAdded) {
      listenersAdded = true;
      await PushNotifications.addListener('registration', (t) => { postToken(t.value).catch(() => {}); });
      await PushNotifications.addListener('registrationError', (e) => { console.error('[push] registrationError', JSON.stringify(e)); });
      await PushNotifications.addListener('pushNotificationActionPerformed', () => {
        window.dispatchEvent(new CustomEvent('snapsa:openNotifications'));
      });
    }
    // Without a HIGH-importance channel Android only drops the notification into the status bar, silently.
    try {
      await PushNotifications.createChannel({
        id: SNAPSA_CHANNEL_ID, name: 'Snapsa notifications', description: 'Likes, comments, messages, follows and more',
        importance: 5, visibility: 1, vibration: true, lights: true,
      });
    } catch (e) { console.error('[push] createChannel', e); }
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.register();
  } catch (e) { console.error('[push]', e); }
}
