// src/videoSave.js — saves a (watermarked) Snapsa video onto the phone. Works in the installed Android app and in a browser.
// In the app the video lands in the Gallery under Movies/Snapsa (see native/saveMedia.js).
import { saveUrlToDevice } from './native/saveMedia';

export async function saveVideoToDevice({ videoId, authorName, snapUrl, authToken, onProgress }) {
  const url = `${snapUrl}/snapsa/videos/${videoId}/download`;
  const safe = String(authorName || 'snapsa').replace(/[^a-z0-9_-]/gi, '');
  const name = `snapsa_${safe}_${videoId}.mp4`;
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const r = await saveUrlToDevice(url, name, { headers, onProgress });
  return { where: r?.where || 'Downloads', path: name };
}
