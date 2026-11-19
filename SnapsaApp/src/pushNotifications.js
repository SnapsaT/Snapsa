// Registers this device for push and sends the FCM token to the Snapsa server.
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

let listenersAdded = false;

export async function registerForPush(postToken) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!listenersAdded) {
      listenersAdded = true;
      await PushNotifications.addListener('registration', (t) => {
        postToken(t.value).catch(() => {});
      });
      await PushNotifications.addListener('registrationError', (e) => {
        console.error('[push] registrationError', JSON.stringify(e));
      });
      await PushNotifications.addListener('pushNotificationActionPerformed', () => {
        window.dispatchEvent(new CustomEvent('snapsa:openNotifications'));
      });
    }
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return;
    await PushNotifications.register();
  } catch (e) { console.error('[push]', e); }
}