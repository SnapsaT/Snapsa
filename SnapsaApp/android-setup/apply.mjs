// Runs in GitHub Actions right after `npx cap add android` / `cap sync` (see the workflow step in the README).
// Adds what the generated Android project does not have: notification sound, call ringtone, status-bar icon.
// Safe to run many times.   Usage (from the SnapsaApp folder):  node android-setup/apply.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const main = path.join(appDir, 'android', 'app', 'src', 'main');
if (!fs.existsSync(main)) { console.error('android project not found at', main); process.exit(1); }
const res = path.join(main, 'res');
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

// 1) notification sound -> res/raw
copy(path.join(here, 'snapsa_ping.wav'), path.join(res, 'raw', 'snapsa_ping.wav'));

// 2) status-bar icon (white S) for every density
for (const d of fs.readdirSync(path.join(here, 'res'))) {
  const f = path.join(here, 'res', d, 'ic_stat_snapsa.png');
  if (fs.existsSync(f)) copy(f, path.join(res, d, 'ic_stat_snapsa.png'));
}
fs.mkdirSync(path.join(res, 'values'), { recursive: true });
fs.writeFileSync(path.join(res, 'values', 'snapsa_notif.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="snapsa_notif_color">#FF2D95</color>\n</resources>\n');

// 3) manifest: permissions + default notification icon / colour / channel
const mfPath = path.join(main, 'AndroidManifest.xml');
let mf = fs.readFileSync(mfPath, 'utf8');
for (const p of ['POST_NOTIFICATIONS', 'VIBRATE', 'WAKE_LOCK', 'MODIFY_AUDIO_SETTINGS', 'USE_FULL_SCREEN_INTENT']) {
  if (!mf.includes(`android.permission.${p}"`)) mf = mf.replace('<application', `<uses-permission android:name="android.permission.${p}" />\n    <application`);
}
const metas = [
  ['com.google.firebase.messaging.default_notification_icon', 'android:resource="@drawable/ic_stat_snapsa"'],
  ['com.google.firebase.messaging.default_notification_color', 'android:resource="@color/snapsa_notif_color"'],
  ['com.google.firebase.messaging.default_notification_channel_id', 'android:value="snapsa_alerts_v4"'],
];
for (const [name, val] of metas) {
  if (!mf.includes(name)) mf = mf.replace('</application>', `    <meta-data android:name="${name}" ${val} />\n    </application>`);
}
// Dark status bar / window (the web view sits below the bar, the strip behind it was showing up white)
try {
  const stPath = path.join(res, 'values', 'styles.xml');
  if (fs.existsSync(stPath)) {
    let st = fs.readFileSync(stPath, 'utf8');
    if (!st.includes('snapsa_dark_bars')) {
      st = st.replace(/(<style name="AppTheme\.NoActionBar"[^>]*>)/, `$1
        <!-- snapsa_dark_bars -->
        <item name="android:windowBackground">@android:color/black</item>
        <item name="android:statusBarColor">#05020A</item>
        <item name="android:navigationBarColor">#05020A</item>
        <item name="android:windowLightStatusBar">false</item>`);
      fs.writeFileSync(stPath, st);
    }
  }
} catch (e) { console.log('styles.xml tweak skipped:', e.message); }
// snapsa://profile/<username> opens the app on that profile (QR cards, shared links)
if (!mf.includes('android:scheme="snapsa"')) {
  mf = mf.replace('</activity>', `    <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="snapsa" />
            </intent-filter>
        </activity>`);
}
// Hardening: no cloud backup of app data (it could be copied off the phone), no plain-http traffic
if (!/android:allowBackup=/.test(mf)) mf = mf.replace('<application', '<application android:allowBackup="false"');
else mf = mf.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
if (!/android:usesCleartextTraffic=/.test(mf)) mf = mf.replace('<application', '<application android:usesCleartextTraffic="false"');
fs.writeFileSync(mfPath, mf);

// 4) Java: notification channels (custom sound / device ringtone) + the ringtone plugin
const javaRoot = path.join(main, 'java');
const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const mainActivity = find(javaRoot).find(f => f.endsWith('MainActivity.java'));
if (!mainActivity) { console.error('MainActivity.java not found'); process.exit(1); }
const pkg = /package\s+([\w.]+);/.exec(fs.readFileSync(mainActivity, 'utf8'))[1];
const dir = path.dirname(mainActivity);

fs.writeFileSync(mainActivity, `package ${pkg};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SnapsaRingtonePlugin.class);
    registerPlugin(SnapsaMediaPlugin.class);
    super.onCreate(savedInstanceState);
    createSnapsaChannels();
    handleSnapsaLink(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleSnapsaLink(intent);
  }

  // snapsa://profile/<username> -> tell the web app which profile to open (retries cover a cold start)
  private void handleSnapsaLink(Intent intent) {
    try {
      if (intent == null || intent.getData() == null) return;
      Uri d = intent.getData();
      if (!"snapsa".equals(d.getScheme())) return;
      String u = d.getLastPathSegment();
      if (u == null) return;
      final String user = u.replaceAll("[^A-Za-z0-9_.-]", "");
      if (user.isEmpty()) return;
      final String js = "window.__snapsaDeepLink='" + user + "';window.dispatchEvent(new CustomEvent('snapsa:deepLink',{detail:'" + user + "'}));";
      final Handler h = new Handler(Looper.getMainLooper());
      for (final long delay : new long[] { 300, 1800, 4500 }) {
        h.postDelayed(new Runnable() { public void run() {
          try { if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().evaluateJavascript(js, null); } catch (Exception ignored) {}
        } }, delay);
      }
    } catch (Exception ignored) {}
  }

  // Android never lets an app change a channel's sound after it exists, so these use NEW ids
  private void createSnapsaChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    for (String old : new String[] { "snapsa_loud_v3", "snapsa_messages_v2", "snapsa_default", "snapsa_calls_v1" }) {
      try { nm.deleteNotificationChannel(old); } catch (Exception ignored) {}
    }
    // Messages, likes, comments, follows...: Snapsa ping
    Uri ping = Uri.parse("android.resource://" + getPackageName() + "/raw/snapsa_ping");
    AudioAttributes pingAttrs = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    NotificationChannel alerts = new NotificationChannel("snapsa_alerts_v4", "Snapsa notifications", NotificationManager.IMPORTANCE_HIGH);
    alerts.setDescription("Messages, likes, comments, follows and more");
    alerts.setSound(ping, pingAttrs);
    alerts.enableVibration(true);
    alerts.setVibrationPattern(new long[] { 0, 250, 150, 250 });
    alerts.enableLights(true);
    alerts.setLightColor(0xFFFF2D95);
    alerts.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    nm.createNotificationChannel(alerts);

    // Calls: the phone's own ringtone
    Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    AudioAttributes ringAttrs = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    NotificationChannel calls = new NotificationChannel("snapsa_calls_v2", "Calls", NotificationManager.IMPORTANCE_HIGH);
    calls.setDescription("Incoming Snapsa calls");
    calls.setSound(ringtone, ringAttrs);
    calls.enableVibration(true);
    calls.setVibrationPattern(new long[] { 0, 800, 500, 800, 500, 800 });
    calls.enableLights(true);
    calls.setLightColor(0xFFFF2D95);
    calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    nm.createNotificationChannel(calls);
  }
}
`);

fs.writeFileSync(path.join(dir, 'SnapsaRingtonePlugin.java'), `package ${pkg};

import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Plays the phone's own ringing tone while a Snapsa call is incoming and the app is open.
@CapacitorPlugin(name = "SnapsaRingtone")
public class SnapsaRingtonePlugin extends Plugin {
  private Ringtone ringtone;

  @PluginMethod
  public void start(PluginCall call) {
    try {
      stopInternal();
      Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
      ringtone = RingtoneManager.getRingtone(getContext(), uri);
      if (Build.VERSION.SDK_INT >= 28) ringtone.setLooping(true);
      ringtone.play();
      call.resolve();
    } catch (Exception e) {
      call.reject(e.getMessage());
    }
  }

  @PluginMethod
  public void exitApp(PluginCall call) {
    call.resolve();
    getActivity().runOnUiThread(() -> getActivity().finish());
  }

  @PluginMethod
  public void stop(PluginCall call) {
    stopInternal();
    call.resolve();
  }

  private void stopInternal() {
    try { if (ringtone != null) { ringtone.stop(); } } catch (Exception ignored) {}
    ringtone = null;
  }
}
`);

fs.writeFileSync(path.join(dir, 'SnapsaMediaPlugin.java'), `package ${pkg};

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

// Saves a file from the app cache into the phone's Gallery / Downloads so the person can find it.
@CapacitorPlugin(name = "SnapsaMedia")
public class SnapsaMediaPlugin extends Plugin {
  @PluginMethod
  public void saveToGallery(PluginCall call) {
    String src = call.getString("path");
    String name = call.getString("name");
    String mime = call.getString("mime", "application/octet-stream");
    String folder = call.getString("folder", "Snapsa");
    if (src == null || name == null) { call.reject("path and name are needed"); return; }
    try {
      if (src.startsWith("file://")) src = Uri.parse(src).getPath();
      File f = new File(src);
      if (!f.exists()) { call.reject("file is missing"); return; }
      boolean video = mime.startsWith("video/"), image = mime.startsWith("image/");
      String base = video ? Environment.DIRECTORY_MOVIES : image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS;
      Uri out;
      if (Build.VERSION.SDK_INT >= 29) {
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, base + "/" + folder);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri coll = video ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                 : image ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                 : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        out = cr.insert(coll, v);
        if (out == null) { call.reject("could not create the file"); return; }
        try (InputStream in = new FileInputStream(f); OutputStream os = cr.openOutputStream(out)) { copy(in, os); }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(out, done, null, null);
      } else {
        File dir = new File(Environment.getExternalStoragePublicDirectory(base), folder);
        dir.mkdirs();
        File o = new File(dir, name);
        try (InputStream in = new FileInputStream(f); OutputStream os = new java.io.FileOutputStream(o)) { copy(in, os); }
        MediaScannerConnection.scanFile(getContext(), new String[] { o.getAbsolutePath() }, new String[] { mime }, null);
        out = Uri.fromFile(o);
      }
      JSObject r = new JSObject();
      r.put("uri", out.toString());
      r.put("where", base + "/" + folder);
      call.resolve(r);
    } catch (Exception e) {
      call.reject(e.getMessage() == null ? "save failed" : e.getMessage());
    }
  }

  private static void copy(InputStream in, OutputStream os) throws java.io.IOException {
    byte[] buf = new byte[64 * 1024];
    int n;
    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
    os.flush();
  }
}
`);
console.log('Snapsa Android extras applied to package', pkg);
