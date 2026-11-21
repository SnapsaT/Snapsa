// Registers this device for push, creates the loud "heads-up" channel, and sends the FCM token to the server.
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

export const SNAPSA_CHANNEL_ID = 'snapsa_loud_v3'; // must match android.notification.channelId on the server 
const OLD_CHANNEL_IDS = ['snapsa_default', 'snapsa_messages_v2']; // created by earlier builds; Android never lets an app change a channel's sound after creation, so we replace it

let listenersAdded = false;

// Loud "ping" for when a notification arrives while the app is open.
let _ctx = null, _master = null;
export function playSnapsaPing() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!_ctx) {
      _ctx = new AC();
      const comp = _ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 0; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.15;
      _master = _ctx.createGain(); _master.gain.value = 2.2; // was 0.25 per note — now ~9x louder, compressor keeps it clean
      _master.connect(comp); comp.connect(_ctx.destination);
    }
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    const t = _ctx.currentTime;
    // bright 3-note chime + low body note
    [[784, 0, 0.45], [1175, 0.12, 0.45], [1568, 0.24, 0.6], [392, 0, 0.35]].forEach(([freq, at, dur]) => {
      ['sine', 'triangle'].forEach((type, k) => {
        const o = _ctx.createOscillator(), g = _ctx.createGain();
        o.type = type; o.frequency.value = freq * (k ? 2 : 1);
        const peak = k ? 0.35 : 0.9;
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(peak, t + at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
        o.connect(g); g.connect(_master);
        o.start(t + at); o.stop(t + at + dur + 0.05);
      });
    });
    try { navigator.vibrate?.([60, 40, 60]); } catch {}
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
      for (const id of OLD_CHANNEL_IDS) { try { await PushNotifications.deleteChannel({ id }); } catch {} }
      await PushNotifications.createChannel({
        id: SNAPSA_CHANNEL_ID, name: 'Snapsa messages & alerts', description: 'Messages, likes, comments, follows and more',
        importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#FF2D95', sound: 'snapsa_ping',
      });
    } catch (e) { console.error('[push] createChannel', e); }
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.register();
  } catch (e) { console.error('[push]', e); }
}
