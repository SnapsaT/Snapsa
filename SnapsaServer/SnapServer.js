

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createCanvas, loadImage } from 'canvas';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import https from 'https';
import { v2 as cloudinary } from 'cloudinary';
import Redis from 'ioredis';
import admin from 'firebase-admin';
import { registerSnapsaCrew } from './SnapsaCrew.js';
import { registerSnapsaGroups } from './SnapsaGroups.js';
import { createSnapsaFirewall } from './SnapsaFirewall.js';
import { registerSnapsaWallet, SnapsaWallet, SnapsaWalletApplication, SnapsaWalletPayout, SnapsaWalletEntry } from './SnapsaWallet.js';
import Models from './Models.js';
const { User, Post, Like, Comment, Share, Follower, Notification, FollowRequest } = Models;


const TARGETS = [
  { collection: 'snapsa_messages',  fields: ['text', 'mediaFile'] },
  { collection: 'snapsa_stories',   fields: ['text', 'mediaFile'] },
  { collection: 'snapsa_profiles',  fields: ['countryCode', 'countryName'] },
];

export function makeCrypto(secret) {
  if (!secret) throw new Error('SNAPSA_FIELD_KEY missing');
  const key = crypto.createHash('sha256').update(secret).digest();
  const enc = (v) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(String(v), 'utf8'), c.final()]); return 'enc:v1:' + [iv, c.getAuthTag(), e].map(b => b.toString('base64')).join('.'); };
  const dec = (s) => { const [iv, tag, e] = s.slice(7).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };
  return { enc, dec };
}

export async function migrateCollection(col, fields, { enc, dec }, dry) {
  let scanned = 0, changed = 0, values = 0, ops = [];
  const flush = async () => { if (ops.length && !dry) await col.bulkWrite(ops, { ordered: false }); ops = []; };
  for await (const d of col.find({})) {
    scanned++;
    const set = {};
    for (const f of fields) {
      const v = d[f];
      if (typeof v === 'string' && v !== '' && !v.startsWith('enc:v1:')) {
        const e = enc(v);
        if (dec(e) !== v) throw new Error(`round-trip failed on ${d._id} ${f}`); // never write something we can't read back
        set[f] = e; values++;
      }
    }
    if (Object.keys(set).length) { changed++; ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: set } } }); }
    if (ops.length >= 500) await flush();
  }
  await flush();
  return { scanned, changed, values };
}

if (process.argv[1] && process.argv[1].endsWith('migrate_encrypt_phase1.js')) {
  const dry = process.argv.includes('--dry');
  const c = makeCrypto(process.env.SNAPSA_FIELD_KEY);
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || process.env.SNAP_MONGO_URI);
  console.log(dry ? 'DRY RUN — nothing will be changed' : 'LIVE RUN');
  for (const t of TARGETS) {
    const r = await migrateCollection(mongoose.connection.collection(t.collection), t.fields, c, dry);
    console.log(`${t.collection}: scanned ${r.scanned}, rows ${dry ? 'that would change' : 'changed'} ${r.changed}, values ${r.values}`);
  }
  await mongoose.disconnect();
}

async function getSnapsaCoinBalance(userId, { session } = {}) {
  // Sequential on purpose: two parallel operations on one transaction session fail with
  // "Given transaction number N ... does not match any in-progress transactions".
  const user = await User.findById(userId).select('coins').session(session).lean();
  const profile = await SnapsaProfile.findOne({ userId }).select('coins').session(session).lean();
  return Math.max(0, user?.coins || 0) + (profile?.coins || 0);
}

async function awardCoins(userId, amount, { session } = {}) {
  if (!amount) return;
  if (amount > 0) {
    await SnapsaProfile.findOneAndUpdate({ userId }, { $inc: { coins: amount } }, { session, upsert: true });
    return;
  }
  
  
  const debit = -amount;
  const user = await User.findById(userId).select('coins').session(session).lean();
  const legacyAvailable = Math.max(0, user?.coins || 0);
  const fromLegacy = Math.min(legacyAvailable, debit);
  const fromSnapsa = debit - fromLegacy;
  if (fromLegacy > 0) {
    await User.findByIdAndUpdate(userId, { $inc: { coins: -fromLegacy } }, session ? { session } : {});
  }
  if (fromSnapsa > 0) {
    await SnapsaProfile.findOneAndUpdate({ userId }, { $inc: { coins: -fromSnapsa } }, { session, upsert: true });
  }
}

// ── Snapsa Treasury ─────────────────────────────────────────────────────────────────────
// Real money (cards) pays Snapsa when coins are bought. When coins are SPENT they used to just vanish from the
// user's wallet. Now they land here, and coins paid back out (gift conversions, watch rewards) are taken from here,
// so the books always balance. It is an accounting ledger owned by the platform, not any person's wallet.
// Only a founder can read it (GET /snapsa/admin/treasury). Recorded after the purchase is safely saved, so a
// ledger problem can never block a user's purchase.
const snapsaTreasurySchema = new mongoose.Schema({
  key:       { type: String, unique: true, default: 'main' },
  balance:   { type: Number, default: 1000000 },   // coins the platform currently holds
  totalIn:   { type: Number, default: 0 },   // coins received from spending
  totalOut:  { type: Number, default: 0 },   // coins paid out (conversions, rewards)
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'snapsa_treasury', versionKey: false });
const SnapsaTreasury = mongoose.models.SnapsaTreasury || mongoose.model('SnapsaTreasury', snapsaTreasurySchema);
const snapsaTreasuryEntrySchema = new mongoose.Schema({
  kind:   { type: String, index: true },     // store_purchase | live_gift_cut | gift_refund | watch_reward
  amount: { type: Number },                  // + into the treasury, - out of it
  userId: { type: mongoose.Schema.Types.ObjectId },
  note:   { type: String, default: '' },
  at:     { type: Date, default: Date.now, index: true },
}, { collection: 'snapsa_treasury_entries', versionKey: false });
const SnapsaTreasuryEntry = mongoose.models.SnapsaTreasuryEntry || mongoose.model('SnapsaTreasuryEntry', snapsaTreasuryEntrySchema);
async function treasuryMove(amount, { kind = '', userId = null, note = '' } = {}) {
  amount = Number(amount);
  if (!amount || !Number.isFinite(amount)) return;
  try {
    await SnapsaTreasury.findOneAndUpdate(
      { key: 'main' },
      { $inc: { balance: amount, [amount > 0 ? 'totalIn' : 'totalOut']: Math.abs(amount) }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    await SnapsaTreasuryEntry.create({ kind, amount, userId, note: String(note || '').slice(0, 200) });
  } catch (e) { console.error('[treasury]', e.message); }
}


const snapsaIdemSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  scope:     { type: String, required: true },
  key:       { type: String, required: true },
  state:     { type: String, enum: ['pending', 'done'], default: 'pending' },
  response:  { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 2 * 86400 },
}, { collection: 'snapsa_idempotency', versionKey: false });
snapsaIdemSchema.index({ userId: 1, scope: 1, key: 1 }, { unique: true });
const SnapsaIdempotency = mongoose.models.SnapsaIdempotency || mongoose.model('SnapsaIdempotency', snapsaIdemSchema);

async function idemClaim(req, res, scope) {
  const key = String(req.body?.requestId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) { res.status(400).json({ error: 'Missing or invalid requestId' }); return false; }
  try {
    await SnapsaIdempotency.create({ userId: req.userId, scope, key, state: 'pending' });
    req.idem = { userId: req.userId, scope, key };
    return true;
  } catch (e) {
    if (e?.code !== 11000) throw e;
    const prior = await SnapsaIdempotency.findOne({ userId: req.userId, scope, key }).lean();
    if (prior?.state === 'done') res.json({ ...(prior.response || { success: true }), duplicate: true });
    else res.status(409).json({ error: 'This request is already being processed', code: 'IN_PROGRESS' });
    return false;
  }
}
const idemDone = (req, response) => req.idem
  ? SnapsaIdempotency.updateOne({ userId: req.idem.userId, scope: req.idem.scope, key: req.idem.key },
      { $set: { state: 'done', response: JSON.parse(JSON.stringify(response)) } }).catch(() => {})
  : null;
const idemRelease = (req) => (req.idem && !req.idemCommitted)
  ? SnapsaIdempotency.deleteOne({ userId: req.idem.userId, scope: req.idem.scope, key: req.idem.key, state: 'pending' }).catch(() => {})
  : null;

// ── Account privacy ─────────────────────────────────────────────────────────
let _privateIdsCache = { ts: 0, ids: [] };
async function getPrivateAccountIds() {
  if (Date.now() - _privateIdsCache.ts < 15000) return _privateIdsCache.ids;
  try {
    const rows = await SnapsaProfile.find({ 'privacy.privateAccount': true }).select('userId').lean();
    _privateIdsCache = { ts: Date.now(), ids: rows.map(r => r.userId).filter(Boolean) };
  } catch { /* keep last known list */ }
  return _privateIdsCache.ids;
}
// Private accounts this viewer is NOT approved to see (never includes themselves).
async function hiddenPrivateAuthorIds(viewerId) {
  const priv = await getPrivateAccountIds();
  if (!priv.length) return [];
  if (!viewerId || !mongoose.Types.ObjectId.isValid(viewerId)) return priv;
  const followed = await Follower.find({ followerId: viewerId, followingId: { $in: priv } }).select('followingId').lean();
  const ok = new Set(followed.map(f => String(f.followingId)));
  ok.add(String(viewerId));
  return priv.filter(id => !ok.has(String(id)));
}
async function canViewAccountContent(viewerId, ownerId) {
  if (viewerId && String(viewerId) === String(ownerId)) return true;
  const priv = await getPrivateAccountIds();
  if (!priv.some(i => String(i) === String(ownerId))) return true;
  if (!viewerId || !mongoose.Types.ObjectId.isValid(viewerId)) return false;
  return !!(await Follower.exists({ followerId: viewerId, followingId: ownerId }));
}

async function snapsaTotalLikes(userId) {
  try {
    const r = await SnapsaVideo.aggregate([
      { $match: { authorId: new mongoose.Types.ObjectId(String(userId)) } },
      { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
      { $unwind: '$post' },
      { $match: { 'post.isActive': true } },
      { $group: { _id: null, n: { $sum: { $ifNull: ['$post.likeCount', 0] } } } },
    ]);
    return r[0]?.n || 0;
  } catch { return 0; }
}

async function reconcileFollowCounts() {
  try {
    const [ers, ings] = await Promise.all([
      Follower.aggregate([{ $group: { _id: '$followingId', n: { $sum: 1 } } }]),
      Follower.aggregate([{ $group: { _id: '$followerId', n: { $sum: 1 } } }]),
    ]);
    const m = new Map();
    for (const r of ers) m.set(String(r._id), { followerCount: r.n, followingCount: 0 });
    for (const r of ings) {
      const k = String(r._id);
      const o = m.get(k) || { followerCount: 0, followingCount: 0 };
      o.followingCount = r.n; m.set(k, o);
    }
    const entries = [...m.entries()].filter(([k]) => mongoose.Types.ObjectId.isValid(k));
    for (let i = 0; i < entries.length; i += 500) {
      await User.bulkWrite(entries.slice(i, i + 500).map(([k, v]) => ({
        updateOne: { filter: { _id: new mongoose.Types.ObjectId(k) }, update: { $set: v } },
      })));
    }
    const ids = entries.map(([k]) => new mongoose.Types.ObjectId(k));
    await User.updateMany(
      { _id: { $nin: ids }, $or: [{ followerCount: { $ne: 0 } }, { followingCount: { $ne: 0 } }] },
      { $set: { followerCount: 0, followingCount: 0 } }
    );
    console.log(`[follow-counts] reconciled ${entries.length} user(s)`);
  } catch (e) { console.error('[follow-counts]', e.message); }
}
  
async function createFollowEdge(followerId, followingId) {
  try { await Follower.create({ followerId, followingId }); }
  catch (e) { if (e?.code === 11000) return false; throw e; }
  await User.findByIdAndUpdate(followingId, { $inc: { followerCount: 1 } });
  await User.findByIdAndUpdate(followerId, { $inc: { followingCount: 1 } });
  return true;
}
async function approveAllPendingFollowRequests(ownerId) {
  const pending = await FollowRequest.find({ toUserId: ownerId, status: 'pending' }).lean();
  for (const r of pending) {
    await createFollowEdge(r.fromUserId, ownerId);
    await FollowRequest.updateOne({ _id: r._id }, { $set: { status: 'accepted' } });
  }
}

async function logCoinTransaction(doc, opts = {}) {
  
  try {
    await SnapsaCoinLedger.create([doc], opts);
  } catch (error) {
    console.error('[coin ledger write failed — balance itself is unaffected]', error.message);
  }
}

let IvsClient, CreateChannelCommand, GetChannelCommand, DeleteChannelCommand, 
    CreateStreamKeyCommand, StopStreamCommand, ListStreamSessionsCommand,
    IvschatClient, CreateChatTokenCommand, CreateRoomCommand, DeleteRoomCommand,
    DisconnectUserCommand, SendMessageCommand, GetRoomCommand;

let ivsClient = null;
let ivsChatClient = null;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  try {
    const pkgIVS = await import('@aws-sdk/client-ivs');
    const pkgIVSChat = await import('@aws-sdk/client-ivschat');
    
    IvsClient = pkgIVS.IvsClient;
    CreateChannelCommand = pkgIVS.CreateChannelCommand;
    GetChannelCommand = pkgIVS.GetChannelCommand;
    DeleteChannelCommand = pkgIVS.DeleteChannelCommand;
    CreateStreamKeyCommand = pkgIVS.CreateStreamKeyCommand;
    StopStreamCommand = pkgIVS.StopStreamCommand;
    ListStreamSessionsCommand = pkgIVS.ListStreamSessionsCommand;
    
    IvschatClient = pkgIVSChat.IvschatClient;
    CreateChatTokenCommand = pkgIVSChat.CreateChatTokenCommand;
    CreateRoomCommand = pkgIVSChat.CreateRoomCommand;
    DeleteRoomCommand = pkgIVSChat.DeleteRoomCommand;
    DisconnectUserCommand = pkgIVSChat.DisconnectUserCommand;
    SendMessageCommand = pkgIVSChat.SendMessageCommand;
    GetRoomCommand = pkgIVSChat.GetRoomCommand;
    
    ivsClient = new IvsClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    
    ivsChatClient = new IvschatClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    
    
    console.log('✅ AWS IVS clients initialized');
  } catch (error) {
    console.warn('⚠️ AWS IVS initialization failed:', error.message);
  }
} else {
  console.log('⚠️ AWS credentials missing - IVS features disabled');
}

let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  try {
    const nodemailer = await import('nodemailer');
    mailTransporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log('✅ SMTP transporter initialized for withdrawal-request emails');
  } catch (error) {
    console.warn('⚠️ SMTP initialization failed (is nodemailer installed?):', error.message);
  }
} else {
  console.log('⚠️ SMTP env vars missing — withdrawal requests will be saved but not emailed');
}


const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Firebase Cloud Messaging (push notifications) ─────────────────────────

let firebaseReady = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
    firebaseReady = true;
    console.log('✅ Firebase Admin initialized for push notifications');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
  }
} catch (err) {
  console.error('⚠️ Firebase Admin failed to initialize:', err.message);
}

// A server running with the built-in fallback secret would let anyone forge login tokens — refuse to start instead.
if ((process.env.NODE_ENV || '').toLowerCase() === 'production' || process.env.RENDER) {
  const js = process.env.SNAP_JWT_SECRET || process.env.JWT_SECRET || '';
  if (js.length < 16 || js === 'change-me') { console.error('FATAL: SNAP_JWT_SECRET is missing or too short (min 16 characters). Set it in Render → Environment.'); process.exit(1); }
}

const config = {
  port: parseInt(process.env.SNAP_PORT || '4040'),
  mongoUri: process.env.SNAP_MONGO_URI || process.env.MONGO_URI || '',
  jwtSecret: process.env.SNAP_JWT_SECRET || process.env.JWT_SECRET || 'change-me',
  
  
  zkChallengeSecret: process.env.SNAPSA_ZK_CHALLENGE_SECRET || process.env.ZK_CHALLENGE_SECRET || null,
  uploadDir: process.env.SNAP_UPLOAD_DIR || path.join(__dirname, 'uploads/snapsa'),
  origin: [...new Set([...(process.env.SNAP_ORIGIN ? process.env.SNAP_ORIGIN.split(',').map(x => x.trim()).filter(Boolean) : []), 'https://snapsat.github.io', 'https://localhost', 'http://localhost', 'capacitor://localhost'])],
  maxVideoMb: parseInt(process.env.SNAP_MAX_VIDEO_MB || '500'),
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  awsAccessKey: process.env.AWS_ACCESS_KEY_ID,
  awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,
  reservedUsernames: new Set(['admin', 'snapsa', 'werntjat', 'support', 'official', 'mod', 'staff', 'root', 'help'])
};

let snapsaIdentityVerifier = null;
let snapsaLoginVerifier = null;
const snapsaWasmPath = new URL('./zk_backend_verifier.cjs', import.meta.url);
try {
  const wasmFileExists = fs.existsSync(snapsaWasmPath);
  if (!wasmFileExists) {
    console.warn(`⚠️  Snapsa native ZK verifier: no file at ${snapsaWasmPath.pathname} — /snapsa/auth/signup and /snapsa/auth/verify will return 503 until this file is deployed alongside SnapServer.js.`);
  } else {
    const wasmPkg = await import('./zk_backend_verifier.cjs');
    const { IdentityVerifier, LoginVerifier } = wasmPkg.default || wasmPkg;
    snapsaIdentityVerifier = new IdentityVerifier();
    snapsaLoginVerifier = new LoginVerifier();
    console.log('✅ Snapsa native ZK verifiers initialized');
  }
} catch (err) {
  console.error(`⚠️  Snapsa native ZK verifier failed to initialize from ${snapsaWasmPath.pathname} — /snapsa/auth/* will return 503:`, err);
}
if (!config.zkChallengeSecret) {
  console.warn('⚠️  SNAPSA_ZK_CHALLENGE_SECRET / ZK_CHALLENGE_SECRET not set — /snapsa/auth/challenge and /snapsa/auth/verify (sign-in) will return 503');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log(`[startup] Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'configured' : 'MISSING — media uploads will fail'}`);

async function uploadToCloudinary(localPath, { resourceType = 'auto', folder = 'snapsa' } = {}) {
  return cloudinary.uploader.upload(localPath, {
    resource_type: resourceType,
    folder,
    overwrite: false,
  });
}

async function uploadBase64ToCloudinary(dataUri, { resourceType = 'image', folder = 'snapsa/avatars' } = {}) {
  return cloudinary.uploader.upload(dataUri, { resource_type: resourceType, folder });
}

function downloadToFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadToFile(response.headers.location, destPath, redirects + 1).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function cleanupTempFiles(...paths) {
  paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
}

let ffmpeg = null;
try {
  const { default: ff } = await import('fluent-ffmpeg');
  const { default: ffs } = await import('ffmpeg-static');
  
  
  
  
  try { fs.chmodSync(ffs, 0o755); } catch (chmodErr) {
    console.log('⚠️ Could not chmod ffmpeg binary:', chmodErr.message);
  }
  if (!fs.existsSync(ffs)) {
    throw new Error(`ffmpeg-static binary not found at expected path: ${ffs}`);
  }
  ff.setFfmpegPath(ffs);
  ffmpeg = ff;
  console.log(`✅ FFmpeg loaded (${ffs})`);
} catch (err) {
  
  
  
  console.log('⚠️ FFmpeg not available — watermarking and end-screens will be SKIPPED on all uploads/downloads until this is fixed:', err.message);
}

const uploadSubdirs = ['videos', 'audio', 'thumbs', 'watermarked', 'temp'];
uploadSubdirs.forEach(dir => {
  try {
    fs.mkdirSync(path.join(config.uploadDir, dir), { recursive: true });
  } catch (e) {
    console.error(`[startup] Could not create dir ${dir}:`, e.message);
  }
});
console.log(`[startup] Upload dir: ${config.uploadDir}`);

try {
  const videosDir = path.join(config.uploadDir, 'videos');
  const files = fs.existsSync(videosDir) ? fs.readdirSync(videosDir) : [];
  console.log(`[startup] Videos on disk: ${files.length}`);
} catch {}

const snapsaVideoSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, unique: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  videoFile: { type: String, required: true },
  watermarkedFile: { type: String },
  thumbFile: { type: String },
  song: { type: String, default: '' },
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaSound', default: null },
  topText: { type: String, default: '' },
  textPosX: { type: Number, default: 50 },
  textPosY: { type: Number, default: 12 },
  textStyle: { type: String, default: '' },
  soundCover: { type: String, default: '' },
  beautyFilter: { type: String, default: '' },
  series: { type: String, default: '' },
  brandFilter: { type: String, default: '' },
  duration: { type: Number, default: 0 },
  isLive: { type: Boolean, default: false },
  downloadCount: { type: Number, default: 0 },
  repostCount: { type: Number, default: 0 },
  sendCount: { type: Number, default: 0 },        // shared to chats
  views: { type: Number, default: 0 },
  giftScore: { type: Number, default: 0 },
  gifters: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String },
    weight: { type: Number, default: 0 },
  }],
   
  feedRandom: { type: Number, default: () => Math.random() },
  privacy: { type: mongoose.Schema.Types.Mixed, default: {} },
  
  snapInOf: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaVideo', default: null },
  snapInBubble: {
    x: { type: Number, default: 68 },      
    y: { type: Number, default: 22 },      
    size: { type: Number, default: 34 },   
  },
  
  featuredProducts: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaProduct', required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: '' },
    price: { type: Number, default: 0 },
    imageUrl: { type: String, default: '' },
    appearAt: { type: Number, default: 3, min: 0 },   // seconds
    commissionPct: { type: Number, default: 0 },
  }],
}, { timestamps: true, collection: 'snapsa_videos' });
snapsaVideoSchema.index({ snapInOf: 1 });

snapsaVideoSchema.index({ authorId: 1, createdAt: -1 });
snapsaVideoSchema.index({ createdAt: -1 });
snapsaVideoSchema.index({ feedRandom: 1 });

const snapsaSoundSchema = new mongoose.Schema({
  uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  artist: { type: String, default: 'Unknown' },
  audioFile: { type: String, required: true },
  thumbFile: { type: String },
  uses: { type: Number, default: 0 },
  downloads: { type: Number, default: 0 },
  royaltyPct: { type: Number, default: 0.15 }, 
}, { timestamps: true, collection: 'snapsa_sounds' });

snapsaSoundSchema.index({ title: 'text', artist: 'text' });
snapsaSoundSchema.index({ uses: -1 });

const snapsaLiveSchema = new mongoose.Schema({
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  hostName: { type: String, required: true },
  title: { type: String, default: 'Snapsa Live' },
  isLive: { type: Boolean, default: true },
  viewers: { type: Number, default: 0 },
  peakViewers: { type: Number, default: 0 },
  channelArn: { type: String },
  chatRoomArn: { type: String },
  totalRevenue: { type: Number, default: 0 },
  gifts: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: String,
    gift: String,
    giftIcon: String,
    amount: Number,
    payout: Number,
    at: Date
  }],
  blockedUsers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    blockedAt: Date,
    reason: String
  }],
  pinnedUser: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    pinnedAt: Date,
    pinnedUntil: Date,
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  pinnedTopic: {
    text: String,
    pinnedAt: Date,
    pinnedUntil: Date,
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null }
}, { timestamps: false, collection: 'snapsa_lives' });

snapsaLiveSchema.index({ isLive: 1, viewers: -1 });
snapsaLiveSchema.index({ hostId: 1, isLive: 1 });

const snapsaProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  bio: { type: String, default: '', maxlength: 150 },
  avatarUrl: { type: String, default: null },
  avatarPublicId: { type: String, default: null },
  displayName: { type: String, default: '', maxlength: 50 },
  isSystemAccount: { type: Boolean, default: false },
  suspendedUntil: { type: Date, default: null },
  suspendedReason: { type: String, default: '' },
  isBarred: { type: Boolean, default: false },
  barredReason: { type: String, default: '' },
  warningCount: { type: Number, default: 0 },
  lastWarningAt: { type: Date, default: null },
  countryCode: { type: String, default: null },
  countryName: { type: String, default: null },
  countrySetAt: { type: Date, default: null },
  countrySource: { type: String, default: null },   
  
  snapsaTier: { type: String, enum: ['', 'bronze', 'silver', 'gold', 'platinum'], default: '' },
  snapsaTierExpiresAt: { type: Date, default: null },
  officialLabel: { type: String, default: '' },     // '' | 'OFFICIAL' | 'GOVERNMENT' | … — pin-style label under the username + pink badge (granted by an admin)
  officialOrg: { type: String, default: '' },
  workCompany: { type: String, default: '' }, workPosition: { type: String, default: '' }, workStart: { type: String, default: '' },
  workStatus: { type: String, default: '' },      // '' | pending | approved | rejected (only Snapsa-company claims need approval)
  crewPosition: { type: String, default: '' },    // set only once an admin approves — makes the account SNAPSA CREW
  privacy: {
    privateAccount: { type: Boolean, default: false },
    hideLikedVideos: { type: Boolean, default: false },
    hideFollowingList: { type: Boolean, default: false },
    showActivityStatus: { type: Boolean, default: true },
    inCircle: { type: Boolean, default: false },
    contentFilter: { type: Boolean, default: true },
    dmSetting: { type: String, default: 'everyone' },
    commentSetting: { type: String, default: 'everyone' }
  },
  
  watchDay: { type: String, default: '' },        
  watchMsToday: { type: Number, default: 0 },
  watchClaimedDay: { type: String, default: '' }, 
  
  inventory: { type: mongoose.Schema.Types.Mixed, default: {} },
  
  store: {
    enabled: { type: Boolean, default: false },
    name: { type: String, default: '', maxlength: 60 },
    description: { type: String, default: '', maxlength: 300 },
    bannerUrl: { type: String, default: null },
    bannerPublicId: { type: String, default: null },
    avatarUrl: { type: String, default: null }, // shop profile picture — distinct from the cover/banner and from the user's global avatar
    avatarPublicId: { type: String, default: null },
    contact: { type: String, default: '', maxlength: 120 }, // free-text: phone/WhatsApp/email/social handle, whatever the seller wants shown
    location: { type: String, default: '', maxlength: 120 }, // e.g. "Gaborone, Broadhurst" — general area the store operates from
  },
  
  creatorProfiles: { type: mongoose.Schema.Types.Mixed, default: {} }, // per-section profiles awaiting/holding admin approval
  artistProfile: {
    enabled: { type: Boolean, default: false },
    accountType: { type: String, enum: ['artist','tv_channel','radio_station','podcast','news_channel'], default: 'artist' },
    artistName: { type: String, default: '', maxlength: 60 },
    country: { type: String, default: '', maxlength: 60 },
    genre: { type: String, default: '', maxlength: 60 },
    bio: { type: String, default: '', maxlength: 300 },
    avatarUrl: { type: String, default: null },
    avatarPublicId: { type: String, default: null },
    subscriptionPriceCoins: { type: Number, default: 0 },
  },
  lastActiveAt: { type: Date, default: null },  
  burnedAt: { type: Date, default: null },                      // last DEFCON 1 burn
  defconLevel: { type: Number, min: 1, max: 5, default: 5 },   // 5 normal · 4 restricted · 3 lockdown · 2 purge · 1 factory reset
  
  coins: { type: Number, default: 0 },
}, { timestamps: true, collection: 'snapsa_profiles' });
snapsaProfileSchema.plugin(snapsaFieldCrypto, { fields: ['countryCode', 'countryName'] }); // country is stored encrypted

const snapsaStorySchema = new mongoose.Schema({
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  type: { type: String, enum: ['photo','video','text','voice'], required: true },
  mediaFile: { type: String, default: '' },
  text: { type: String, default: '' },
  effect: { type: String, default: '' },      // '3d' = depth-tilt photo, or a voice effect id for voice stories
  burn: { type: Boolean, default: false },    // burn after view: each viewer gets exactly one look
  audience: { type: String, enum: ['public', 'followers'], default: 'public' },   // followers = only people who follow the author
  bgColor: { type: String, default: '#FF2055' },
  textColor: { type: String, default: '#ffffff' },
  fontStyle: { type: String, default: 'system' },
  qa: { type: String, default: '' },                       // "Ask me" question; viewers answer into the author's DMs
  flipText: { type: String, default: '' },                 // Flip Story: the back of the card
  song: { type: new mongoose.Schema({ title: String, artist: String, audioUrl: String }, { _id: false }), default: undefined },
  poll: { type: new mongoose.Schema({ question: String, options: [{ _id: false, text: String, votes: [mongoose.Schema.Types.ObjectId] }] }, { _id: false }), default: undefined },
  viewers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    viewedAt: { type: Date, default: Date.now },
  }],
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  
  
  repostOf: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaStory', default: null }, 
  repostAuthorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },  
  repostAuthorName: { type: String, default: null },                                     
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24*3600*1000) },
}, { timestamps: true, collection: 'snapsa_stories' });
snapsaStorySchema.index({ authorId: 1, expiresAt: 1 });
snapsaStorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });   // stories are removed 24h after posting
snapsaStorySchema.plugin(snapsaFieldCrypto, { fields: ['text', 'mediaFile'] }); // story content is stored encrypted
const SnapsaStory = mongoose.models.SnapsaStory || mongoose.model('SnapsaStory', snapsaStorySchema);

// ── Text posts ("Snapsa Post"): written updates with optional photo/video, mood, audience and burn-after-read
const snapsaPostSchema = new mongoose.Schema({
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  authorName: { type: String, required: true },
  text: { type: String, default: '' },
  mediaFile: { type: String, default: '' },
  mediaType: { type: String, enum: ['', 'photo', 'video'], default: '' },
  vibe: { type: String, default: 'authentic' },            // authentic | pro | creative | intimate | anon
  mood: { type: String, default: '' },
  visibility: { type: String, enum: ['everyone', 'followers', 'me'], default: 'everyone' },
  burned: { type: Boolean, default: false },               // author burned their identity (DEFCON 1): content gone, counts stay
  burn: { type: Boolean, default: false },                 // timed burn: the post deletes itself at expiresAt
  expiresAt: { type: Date, default: null },
  readers: [{ type: mongoose.Schema.Types.ObjectId }],
  feeling: { type: String, default: '' },                  // "happy"  → shown as "feeling happy"
  moodLevel: { type: String, default: '' },                // Peak | Calm | Focused | Hyped | Low
  place: { type: String, default: '' },                    // "Stellenbosch"  → shown as "in Stellenbosch"
  tags: [{ _id: false, userId: mongoose.Schema.Types.ObjectId, username: String }],
  qa: { type: String, default: '' },                       // question the author wants followers to answer
  song: { type: new mongoose.Schema({ title: String, artist: String }, { _id: false }), default: undefined },
  poll: { type: new mongoose.Schema({ question: String, endsAt: Date, options: [{ _id: false, text: String, votes: [mongoose.Schema.Types.ObjectId] }] }, { _id: false }), default: undefined },
  repostOf: { type: mongoose.Schema.Types.ObjectId, default: null },   // this post re-shares another post
  likes: [{ type: mongoose.Schema.Types.ObjectId }],
  viewers: [{ type: mongoose.Schema.Types.ObjectId }],   // everyone who saw it or scrolled past it (author excluded)
  viewCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },
  comments: [{ userId: mongoose.Schema.Types.ObjectId, authorName: String, anon: { type: Boolean, default: false }, direct: { type: Boolean, default: false }, text: String, createdAt: { type: Date, default: Date.now } }],
}, { timestamps: true, collection: 'snapsa_posts' });
snapsaPostSchema.index({ createdAt: -1 });
snapsaPostSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });   // burn time reached → the post is deleted
snapsaPostSchema.plugin(snapsaFieldCrypto, { fields: ['text', 'mediaFile'] });
const SnapsaPost = mongoose.models.SnapsaPost || mongoose.model('SnapsaPost', snapsaPostSchema);

const snapsaMessageSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['text','photo','video','voice','file','system'], default: 'text' },
  text: { type: String, default: '' },
  mediaFile: { type: String, default: '' },
  duration: { type: Number, default: 0 },
  fileName: { type: String, default: '' },     // type 'file': original name + size
  fileSize: { type: Number, default: 0 },
  burn: { type: Boolean, default: false },     // burn after read: the receiver can open it exactly once
  burnedAt: { type: Date, default: null },
  read: { type: Boolean, default: false }, 
  deliveredAt: { type: Date, default: null }, 
  readAt: { type: Date, default: null },      
  listenedAt: { type: Date, default: null },   // voice message: the receiver actually played it
  callInfo: { kind: { type: String, default: null }, callType: { type: String, default: null }, duration: { type: Number, default: 0 }, callId: { type: String, default: null } },   // call bubbles in the chat
  replyContext: {
    kind: { type: String, enum: ['story_reply','story_reaction','product_tag', null], default: null },
    storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaStory', default: null },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaProduct', default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaProductLead', default: null },
  },
  
  
  
  
  hideFromSender: { type: Boolean, default: false },
  deletedForUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deletedForEveryone: { type: Boolean, default: false },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  storySnapshot: {
    thumbUrl: { type: String, default: null },
    authorName: { type: String, default: null },
    caption: { type: String, default: null },
  },
   
  productSnapshot: {
    title: { type: String, default: null },
    price: { type: Number, default: null },
    imageUrl: { type: String, default: null },
  },
  
  reactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    emoji: { type: String, required: true },
    reactedAt: { type: Date, default: Date.now }, 
  }],
}, { timestamps: true, collection: 'snapsa_messages' });
snapsaMessageSchema.index({ chatId: 1, createdAt: 1 });
snapsaMessageSchema.plugin(snapsaFieldCrypto, { fields: ['text', 'mediaFile'] }); // DMs are stored encrypted (must stay ABOVE the post('save') below)
snapsaMessageSchema.post('save', function (doc) {
  snapsaDecryptDoc(doc, ['text', 'mediaFile']); // the live push below must carry readable text
  const forReceiver = doc.burn ? { ...(doc.toObject ? doc.toObject() : doc), text: '', mediaFile: '', mediaUrl: null } : doc; // burn messages never travel in the clear
  pushToSnapUser(doc.receiverId, { type: 'new_message', message: forReceiver, chatId: doc.chatId });
  pushToSnapUser(doc.senderId, { type: 'message_sent', message: doc, chatId: doc.chatId }); 
});
const SnapsaMessage = mongoose.models.SnapsaMessage || mongoose.model('SnapsaMessage', snapsaMessageSchema);
const buildSnapChatId = (a,b) => [a.toString(), b.toString()].sort().join('_');

const snapMsgStatus = (m) => (m.type === 'voice' && m.listenedAt) ? 'listened' : m.readAt ? 'read' : m.deliveredAt ? 'delivered' : 'sent';

const snapsaTrackSchema = new mongoose.Schema({
  title: { type: String, required: true },
  artist: { type: String, required: true },
  artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  album: { type: String, default: '' },
  albumId: { type: String, default: null }, 
  trackNumber: { type: Number, default: null }, 
  genre: { type: String, default: 'Other' },
  duration: { type: Number, default: 0 },
  isFree: { type: Boolean, default: false }, 
  price: { type: Number, default: 0 },
  audioFile: { type: String, default: '' },
  audioPublicId: { type: String, default: '' },
  previewFile: { type: String, default: '' },
  previewPublicId: { type: String, default: '' },
  videoFile: { type: String, default: '' },
  videoPublicId: { type: String, default: '' },
  coverArt: { type: String, default: '' },
  coverPublicId: { type: String, default: '' },
  isPublished: { type: Boolean, default: true },
  playCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  purchaseCount: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
    uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  adSupported: { type: Boolean, default: false },   // listeners may play the full track after watching an ad
  adPlayCount: { type: Number, default: 0 },
  isExplicit: { type: Boolean, default: false },

  tags: [String],
  
  copyrightAgreementAccepted: { type: Boolean, default: false },
  copyrightAgreementAcceptedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_tracks' });

snapsaTrackSchema.index({ title: 'text', artist: 'text', genre: 1 });
snapsaTrackSchema.index({ playCount: -1 });
snapsaTrackSchema.index({ purchaseCount: -1 });
snapsaTrackSchema.index({ artistId: 1, createdAt: -1 });
snapsaTrackSchema.index({ albumId: 1 });

const snapsaPurchaseSchema = new mongoose.Schema({
  trackId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaTrack', required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  price: { type: Number, required: true },
  transactionRef: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  platformFee: { type: Number, default: 0 },
  sellerPayout: { type: Number, default: 0 },
  completedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'snapsa_purchases' });

snapsaPurchaseSchema.index({ buyerId: 1, trackId: 1 });
snapsaPurchaseSchema.index({ transactionRef: 1 });

const snapsaTierPurchaseSchema = new mongoose.Schema({
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tier: { type: String, enum: ['bronze', 'silver', 'gold', 'platinum'], required: true },
  amountUsd: { type: Number, required: true },
  transactionRef: { type: String, required: true, unique: true },
  flwTransactionId: { type: String, default: null }, 
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  completedAt: { type: Date },
}, { timestamps: true, collection: 'snapsa_tier_purchases' });
snapsaTierPurchaseSchema.index({ buyerId: 1, createdAt: -1 });
snapsaTierPurchaseSchema.index({ transactionRef: 1 });
const SnapsaTierPurchase = mongoose.models.SnapsaTierPurchase || mongoose.model('SnapsaTierPurchase', snapsaTierPurchaseSchema);

const snapsaProductSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 80 },
  description: { type: String, default: '', maxlength: 500 },
  
  price: { type: Number, required: true, min: 0 },
  images: [{
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
  }],
  location: {
    text: { type: String, default: '' }, 
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  category: { type: String, default: 'general' },
  active: { type: Boolean, default: true }, 
  viewCount: { type: Number, default: 0 },
  tagCount: { type: Number, default: 0 },   
  salesCount: { type: Number, default: 0 },
  
  
  affiliateCommissionPct: { type: Number, default: 0.10, min: 0, max: 0.5 },
}, { timestamps: true, collection: 'snapsa_products' });

snapsaProductSchema.index({ sellerId: 1, active: 1, createdAt: -1 });
snapsaProductSchema.index({ title: 'text', description: 'text', category: 1 });

const snapsaProductLeadSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaProduct', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, default: '', maxlength: 500 },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaMessage', default: null }, 
  
  
  featuringVideoId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaVideo', default: null },
  featuringAuthorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  commissionPct: { type: Number, default: 0 },
  priceAtTag: { type: Number, default: 0 }, 
  status: { type: String, enum: ['new', 'sold', 'declined'], default: 'new' },
  coinsAwarded: { type: Number, default: 0 },
  soldAt: { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_product_leads' });

snapsaProductLeadSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
snapsaProductLeadSchema.index({ featuringAuthorId: 1, status: 1 });

const snapsaCoinLedgerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true }, 
  description: { type: String, default: '' },
  reference: { type: mongoose.Schema.Types.ObjectId, default: null },
  referenceModel: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'snapsa_coin_ledger' });

snapsaCoinLedgerSchema.index({ userId: 1, createdAt: -1 });

const snapsaSavedVideoSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaVideo', required: true },
}, { timestamps: true, collection: 'snapsa_saved_videos' });

snapsaSavedVideoSchema.index({ userId: 1, videoId: 1 }, { unique: true });
snapsaSavedVideoSchema.index({ userId: 1, createdAt: -1 });

const SnapsaProduct = mongoose.models.SnapsaProduct || mongoose.model('SnapsaProduct', snapsaProductSchema);
const SnapsaProductLead = mongoose.models.SnapsaProductLead || mongoose.model('SnapsaProductLead', snapsaProductLeadSchema);
const SnapsaCoinLedger = mongoose.models.SnapsaCoinLedger || mongoose.model('SnapsaCoinLedger', snapsaCoinLedgerSchema);
const SnapsaSavedVideo = mongoose.models.SnapsaSavedVideo || mongoose.model('SnapsaSavedVideo', snapsaSavedVideoSchema);

const SnapsaVideo = mongoose.models.SnapsaVideo || mongoose.model('SnapsaVideo', snapsaVideoSchema);
const SnapsaSound = mongoose.models.SnapsaSound || mongoose.model('SnapsaSound', snapsaSoundSchema);
const SnapsaLive = mongoose.models.SnapsaLive || mongoose.model('SnapsaLive', snapsaLiveSchema);
const SnapsaProfile = mongoose.models.SnapsaProfile || mongoose.model('SnapsaProfile', snapsaProfileSchema);

// ─── Moderation: reports, blocks, hidden users ─────────────────────
const REPORT_REASONS = {
  child_safety:    { label: 'Child safety',             weight: 10 },
  self_harm:       { label: 'Self-harm',                weight: 6 },
  violence_threat: { label: 'Violence or threats',      weight: 6 },
  hate_harassment: { label: 'Hate or harassment',       weight: 5 },
  nudity_sexual:   { label: 'Nudity or sexual content', weight: 5 },
  impersonation:   { label: 'Impersonation',            weight: 3 },
  scam_spam:       { label: 'Scam or spam',             weight: 3 },
  other:           { label: 'Something else',           weight: 1 },
};
const REPORT_TARGET_TYPES = ['video', 'user', 'comment', 'message'];

const snapsaReportSchema = new mongoose.Schema({
  reporterId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  targetType:   { type: String, enum: REPORT_TARGET_TYPES, required: true },
  targetId:     { type: mongoose.Schema.Types.ObjectId, required: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  reason:       { type: String, enum: Object.keys(REPORT_REASONS), required: true },
  description:  { type: String, default: '', maxlength: 500 },
  snapshot:     { type: mongoose.Schema.Types.Mixed, default: {} },
  weight:       { type: Number, default: 1 },
  status:       { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open' },
  resolution:   { type: String, default: '' },
  resolutionNote: { type: String, default: '' },
  resolvedBy:   { type: mongoose.Schema.Types.ObjectId, default: null },
  resolvedAt:   { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_reports' });
snapsaReportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true });
snapsaReportSchema.index({ status: 1, targetType: 1, targetId: 1 });

const snapsaBlockSchema = new mongoose.Schema({
  blockerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  blockedId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { timestamps: true, collection: 'snapsa_blocks' });
snapsaBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
snapsaBlockSchema.index({ blockedId: 1 });

const snapsaHideSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, required: true },
  hiddenUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { timestamps: true, collection: 'snapsa_hidden_users' });
snapsaHideSchema.index({ userId: 1, hiddenUserId: 1 }, { unique: true });

const SnapsaReport = mongoose.models.SnapsaReport || mongoose.model('SnapsaReport', snapsaReportSchema);
const SnapsaBlock = mongoose.models.SnapsaBlock || mongoose.model('SnapsaBlock', snapsaBlockSchema);
const SnapsaHide = mongoose.models.SnapsaHide || mongoose.model('SnapsaHide', snapsaHideSchema);

const _oid = (v) => (v && mongoose.Types.ObjectId.isValid(v)) ? new mongoose.Types.ObjectId(String(v)) : null;
async function getBlockerIds(userId) {   // people who have blocked this user
  const id = _oid(userId); if (!id) return [];
  return SnapsaBlock.find({ blockedId: id }).distinct('blockerId');
}
async function getHiddenIds(userId) {    // people this user has hidden from their feed
  const id = _oid(userId); if (!id) return [];
  return SnapsaHide.find({ userId: id }).distinct('hiddenUserId');
}
async function isBlockedBy(blockerId, blockedId) {  // has blockerId blocked blockedId?
  const a = _oid(blockerId), b = _oid(blockedId);
  if (!a || !b) return false;
  return !!(await SnapsaBlock.exists({ blockerId: a, blockedId: b }));
}
async function hasBlockBetween(x, y) {
  const [a, b] = await Promise.all([isBlockedBy(x, y), isBlockedBy(y, x)]);
  return a || b;
}

// Suspended / barred accounts are refused in snapAuth. Cached briefly so this
// isn't a database hit on every single request.
const restrictionCache = new Map();

let restrictedIds = [];
async function refreshRestrictedIds() {
  try {
    const rows = await SnapsaProfile.find({ $or: [{ isBarred: true }, { suspendedUntil: { $gt: new Date() } }] }).select('userId').lean();
    restrictedIds = rows.map(r => r.userId).filter(Boolean);
  } catch { /* keep the last known list */ }
}
refreshRestrictedIds();
setInterval(refreshRestrictedIds, 30000).unref?.();
async function getAccountRestriction(userId) {
  const key = String(userId);
  const cached = restrictionCache.get(key);
  if (cached && Date.now() - cached.ts < 30000) return cached.value;
  if (!mongoose.Types.ObjectId.isValid(key)) return null;
  try {
    const p = await SnapsaProfile.findOne({ userId: key }).select('suspendedUntil suspendedReason isBarred barredReason').lean();
    let value = null;
    if (p?.isBarred) {
      value = { code: 'ACCOUNT_BARRED', error: 'Your account has been barred from Snapsa', reason: p.barredReason || '' };
    } else if (p?.suspendedUntil && new Date(p.suspendedUntil) > new Date()) {
      value = { code: 'ACCOUNT_SUSPENDED', error: 'Your account is suspended', reason: p.suspendedReason || '', until: p.suspendedUntil };
    }
    if (restrictionCache.size > 5000) restrictionCache.clear();
    restrictionCache.set(key, { value, ts: Date.now() });
    return value;
  } catch { return null; }
}

// ─── Permanent country tag ───────────────────────────────────────────────

const geoipPromise = import('geoip-lite').then(m => m.default || m).catch(() => null);
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryAttempts = new Map(); // userId -> time before which we won't look again

function clientIpFrom(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
async function detectCountryCode(req) {
  const hdr = String(req.headers['cloudfront-viewer-country'] || req.headers['cf-ipcountry'] || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(hdr) && hdr !== 'XX' && hdr !== 'T1') return hdr;
  const geoip = await geoipPromise;
  const hit = geoip?.lookup(clientIpFrom(req));
  return hit?.country || null;
}
async function ensureProfileCountry(userId, req) {
  try {
    const key = String(userId);
    const until = countryAttempts.get(key);
    if (until && Date.now() < until) return;
    countryAttempts.set(key, Date.now() + 600000);
    if (!mongoose.Types.ObjectId.isValid(key)) return;
    const code = await detectCountryCode(req);
    if (!code) return;
    let name = code;
    try { name = regionNames?.of(code) || code; } catch {}
    const r = await SnapsaProfile.updateOne(
      { userId: key, countryCode: null },   // only ever fills an empty tag
      { $set: { countryCode: code, countryName: name, countrySetAt: new Date(), countrySource: 'auto' } }
    );
    if (r.modifiedCount) { countryAttempts.set(key, Date.now() + 6 * 3600000); return; }
    const p = await SnapsaProfile.findOne({ userId: key }).select('countryCode').lean();
    if (p?.countryCode) countryAttempts.set(key, Date.now() + 6 * 3600000);
  } catch { /* non-critical */ }
}

const snapsaIdentitySchema = new mongoose.Schema({
  zkCommitment: { type: String, required: true, unique: true, index: true },
  encryptedIdentity: { type: String, required: true },  
  identitySalt: { type: String, required: true },
  identityIv: { type: String, required: true },
  setupProof: { type: String, required: true },
  circuitVersion: { type: String, default: '1.0-ZT' },
  displayNameEncrypted: { type: String, default: null },
  displayNameIv: { type: String, default: null },
  avatarEncrypted: { type: String, default: null },
  avatarIv: { type: String, default: null },
  isAdmin: { type: Boolean, default: false },
founder: { type: Boolean, default: false },
  tier: { type: String, default: null },
  coins: { type: Number, default: 0 }
}, { timestamps: true, collection: 'snapsa_identities' });
const SnapsaIdentity = mongoose.models.SnapsaIdentity || mongoose.model('SnapsaIdentity', snapsaIdentitySchema);

async function getSnapAdminStatus(req) {
  if (!req.userId) {
    return { isAdmin: false, founder: false };
  }

  let account;

  if (req.jwtPayload?.identityType === 'snapsa') {
    account = await SnapsaIdentity.findById(req.userId)
      .select('isAdmin founder')
      .lean();
  } else {
    account = await User.findById(req.userId)
      .select('isAdmin founder')
      .lean();
  }

  return {
    isAdmin: !!account?.isAdmin,
    founder: !!account?.founder
  };
}

const snapsaNullifierSchema = new mongoose.Schema({
  nullifier: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, expires: 0 }, 
}, { collection: 'snapsa_nullifiers' });
const SnapsaNullifier = mongoose.models.SnapsaNullifier || mongoose.model('SnapsaNullifier', snapsaNullifierSchema);

const SnapsaTrack = mongoose.models.SnapsaTrack || mongoose.model('SnapsaTrack', snapsaTrackSchema);
const SnapsaPurchase = mongoose.models.SnapsaPurchase || mongoose.model('SnapsaPurchase', snapsaPurchaseSchema);

// ─── Snapsa TV — shows/episodes with channel subscriptions + pay-per-download ───
const TV_CATEGORIES = ['Soaps','Series','Movies','Shows'];

const snapsaShowSchema = new mongoose.Schema({
  title: { type: String, required: true },
  channelName: { type: String, required: true }, // creator profile's name at time of creation, kept in sync on update
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  description: { type: String, default: '', maxlength: 500 },
  // Which tab this show sits under on the channel's own profile page —
  // Movies are modelled as a Show with exactly one Episode, same structure
  // as a Soap/Series, just with a single item.
  category: { type: String, enum: TV_CATEGORIES, default: 'Series' },
  genre: { type: String, default: 'Other' },
  coverArt: { type: String, default: '' },
  coverPublicId: { type: String, default: '' },
  isPublished: { type: Boolean, default: true },
}, { timestamps: true, collection: 'snapsa_tv_shows' });
snapsaShowSchema.index({ title: 'text', channelName: 'text', genre: 1 });
snapsaShowSchema.index({ channelId: 1, category: 1, createdAt: -1 });

const snapsaEpisodeSchema = new mongoose.Schema({
  showId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaShow', required: true, index: true },
  title: { type: String, required: true },
  episodeNumber: { type: Number, default: null },
  description: { type: String, default: '', maxlength: 500 },
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  channelName: { type: String, required: true },
  duration: { type: Number, default: 0 },
  // Watching requires an active channel subscription — these fields only
  // govern the separate pay-per-item DOWNLOAD-for-offline action.
  downloadIsFree: { type: Boolean, default: false },
  downloadPrice: { type: Number, default: 0 },
  videoFile: { type: String, default: '' },
  videoPublicId: { type: String, default: '' },
  thumbnail: { type: String, default: '' },
  thumbnailPublicId: { type: String, default: '' },
  isPublished: { type: Boolean, default: true },
  viewCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  totalDownloadRevenue: { type: Number, default: 0 },
  isExplicit: { type: Boolean, default: false },
  copyrightAgreementAccepted: { type: Boolean, default: false },
  copyrightAgreementAcceptedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_tv_episodes' });
snapsaEpisodeSchema.index({ title: 'text', channelName: 'text' });
snapsaEpisodeSchema.index({ showId: 1, episodeNumber: 1 });
snapsaEpisodeSchema.index({ channelId: 1, createdAt: -1 });

// Paid, required-to-watch monthly subscription to a TV channel — one price,
// set by the channel owner (artistProfile.subscriptionPriceCoins).
const snapsaChannelSubscriptionSchema = new mongoose.Schema({
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  price: { type: Number, required: true },
  transactionRef: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  currentPeriodEnd: { type: Date, default: null },
  completedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'snapsa_tv_channel_subscriptions' });
snapsaChannelSubscriptionSchema.index({ channelId: 1, subscriberId: 1 });
snapsaChannelSubscriptionSchema.index({ transactionRef: 1 });

// Free "subscribe to show support" — used by Radio/Podcast channels (and
// available generally); never gates access, just a follow + a public count.
const snapsaChannelFollowSchema = new mongoose.Schema({
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, collection: 'snapsa_channel_follows' });
snapsaChannelFollowSchema.index({ channelId: 1, followerId: 1 }, { unique: true });

// Radio/Podcast content — a flat feed of posted videos/audio per channel,
// no show/season structure (mirrors how a page posts videos on Facebook).
// Free to stream for everyone; downloading for offline is the only paid action.
const snapsaChannelPostSchema = new mongoose.Schema({
  channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  channelName: { type: String, required: true },
  accountType: { type: String, enum: ['radio_station', 'podcast', 'news_channel'], required: true },
  // News channels can post either a video (same as Radio/Podcast) or an
  // "article" — a text body with one or more photos, no video/audio file.
  postType: { type: String, enum: ['video', 'article'], default: 'video' },
  title: { type: String, required: true },
  description: { type: String, default: '', maxlength: 500 },
  // Article body text — separate from `description` so a news post can
  // carry a full write-up while still keeping a short description/caption.
  body: { type: String, default: '', maxlength: 5000 },
  photos: [{ url: String, publicId: String }],
  mediaFile: { type: String, default: '' },
  mediaPublicId: { type: String, default: '' },
  mediaType: { type: String, enum: ['video', 'audio'], default: 'video' },
  thumbnail: { type: String, default: '' },
  thumbnailPublicId: { type: String, default: '' },
  duration: { type: Number, default: 0 },
  downloadIsFree: { type: Boolean, default: false },
  downloadPrice: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: true },
  viewCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  totalDownloadRevenue: { type: Number, default: 0 },
  copyrightAgreementAccepted: { type: Boolean, default: false },
  copyrightAgreementAcceptedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_channel_posts' });
snapsaChannelPostSchema.index({ title: 'text', channelName: 'text' });
snapsaChannelPostSchema.index({ channelId: 1, createdAt: -1 });
snapsaChannelPostSchema.index({ accountType: 1, createdAt: -1 });

const snapsaEpisodeDownloadSchema = new mongoose.Schema({
  episodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaEpisode', required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  price: { type: Number, required: true },
  transactionRef: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  platformFee: { type: Number, default: 0 },
  sellerPayout: { type: Number, default: 0 },
  completedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'snapsa_tv_downloads' });
snapsaEpisodeDownloadSchema.index({ buyerId: 1, episodeId: 1 });
snapsaEpisodeDownloadSchema.index({ transactionRef: 1 });

const snapsaPostDownloadSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'SnapsaChannelPost', required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  price: { type: Number, required: true },
  transactionRef: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  platformFee: { type: Number, default: 0 },
  sellerPayout: { type: Number, default: 0 },
  completedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'snapsa_channel_post_downloads' });
snapsaPostDownloadSchema.index({ buyerId: 1, postId: 1 });
snapsaPostDownloadSchema.index({ transactionRef: 1 });

const SnapsaShow = mongoose.models.SnapsaShow || mongoose.model('SnapsaShow', snapsaShowSchema);
const SnapsaEpisode = mongoose.models.SnapsaEpisode || mongoose.model('SnapsaEpisode', snapsaEpisodeSchema);
const SnapsaChannelSubscription = mongoose.models.SnapsaChannelSubscription || mongoose.model('SnapsaChannelSubscription', snapsaChannelSubscriptionSchema);
const SnapsaChannelFollow = mongoose.models.SnapsaChannelFollow || mongoose.model('SnapsaChannelFollow', snapsaChannelFollowSchema);
const SnapsaChannelPost = mongoose.models.SnapsaChannelPost || mongoose.model('SnapsaChannelPost', snapsaChannelPostSchema);
const SnapsaEpisodeDownload = mongoose.models.SnapsaEpisodeDownload || mongoose.model('SnapsaEpisodeDownload', snapsaEpisodeDownloadSchema);
const SnapsaPostDownload = mongoose.models.SnapsaPostDownload || mongoose.model('SnapsaPostDownload', snapsaPostDownloadSchema);

// ── Transparent field encryption (Mongoose plugin) ─────────────────────────────
// Add `schema.plugin(snapsaFieldCrypto, { fields: [...] })` to a schema and those
// top-level string fields are stored encrypted (enc:v1:…) in MongoDB and come back
// as normal text in the app, through find/findOne/findOneAndUpdate/aggregate/save/
// insertMany/updateOne/updateMany. Nobody reading Atlas sees the real values.
// Writes only encrypt once the start-up self-test (runCryptoSelfTest) has passed;
// reads ALWAYS decrypt, so turning it off never hides data.
let _cryptoWritesOn = false;
const _ENC_PREFIX = 'enc:v1:';
const _isEnc = (v) => typeof v === 'string' && v.startsWith(_ENC_PREFIX);
let _decFailLogged = false;
function _safeDec(v) {
  try { return decField(v); }
  catch (e) {
    if (!_decFailLogged) { _decFailLogged = true; console.error('[crypto] could not decrypt a stored value — is SNAPSA_FIELD_KEY the same key the data was encrypted with?'); }
    return v;
  }
}
function _wrapVal(v) {
  if (!_cryptoWritesOn || typeof v !== 'string' || v === '' || _isEnc(v)) return v;
  return encField(v);
}
function _deepDec(v, depth = 0) {
  if (typeof v === 'string') return _isEnc(v) ? _safeDec(v) : v;
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = _deepDec(v[i], depth + 1); return v; }
  if (Object.getPrototypeOf(v) === Object.prototype) { for (const k of Object.keys(v)) v[k] = _deepDec(v[k], depth + 1); }
  return v;
}
function snapsaDecryptDoc(doc, fields) {
  if (!doc || typeof doc !== 'object') return doc;
  const hydrated = typeof doc.get === 'function' && typeof doc.unmarkModified === 'function';
  for (const f of fields) {
    const cur = hydrated ? doc.get(f) : doc[f];
    if (!_isEnc(cur)) continue;
    const plain = _safeDec(cur);
    if (hydrated) { doc.set(f, plain); doc.unmarkModified(f); } else { doc[f] = plain; }
  }
  return doc;
}
function snapsaFieldCrypto(schema, { fields = [] } = {}) {
  const encryptUpdate = function () {
    if (!_cryptoWritesOn) return;
    const u = this.getUpdate && this.getUpdate();
    if (!u || Array.isArray(u)) return;
    for (const t of [u, u.$set, u.$setOnInsert]) {
      if (!t || typeof t !== 'object') continue;
      for (const f of fields) if (typeof t[f] === 'string') t[f] = _wrapVal(t[f]);
    }
  };
  schema.pre('save', function (next) {
    if (_cryptoWritesOn) {
      for (const f of fields) {
        if (!this.isNew && !this.isModified(f)) continue;
        const v = this.get(f), e = _wrapVal(v);
        if (e !== v) this.set(f, e);
      }
    }
    next();
  });
  schema.post('save', function (doc) { snapsaDecryptDoc(doc || this, fields); });
  schema.pre('insertMany', function (next, docs) {
    if (_cryptoWritesOn) {
      for (const d of (Array.isArray(docs) ? docs : [docs])) {
        if (d && typeof d === 'object') for (const f of fields) if (typeof d[f] === 'string') d[f] = _wrapVal(d[f]);
      }
    }
    next();
  });
  schema.post('insertMany', function (docs) { for (const d of (Array.isArray(docs) ? docs : [docs])) snapsaDecryptDoc(d, fields); });
  schema.pre('updateOne', encryptUpdate);
  schema.pre('updateMany', encryptUpdate);
  schema.pre('findOneAndUpdate', encryptUpdate);
  schema.post(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete'], function (res) {
    if (Array.isArray(res)) res.forEach(d => snapsaDecryptDoc(d, fields)); else snapsaDecryptDoc(res, fields);
  });
  schema.post('aggregate', function (res) { if (Array.isArray(res)) _deepDec(res); });
}

// Runs once at start-up: proves the plugin round-trips on a throw-away collection.
// If anything is off, encryption of NEW data stays switched off (nothing breaks).
async function runCryptoSelfTest() {
  _cryptoWritesOn = false;
  if (!_fieldKey) { console.warn('[crypto-selftest] SNAPSA_FIELD_KEY is not set — encryption stays OFF'); return false; }
  const col = mongoose.connection.collection('snapsa_crypto_selftest');
  try {
    const sch = new mongoose.Schema({ tag: String, secret: { type: String, default: '' }, other: String }, { collection: 'snapsa_crypto_selftest' });
    sch.plugin(snapsaFieldCrypto, { fields: ['secret'] });
    const M = mongoose.models.SnapsaCryptoSelfTest || mongoose.model('SnapsaCryptoSelfTest', sch);
    await col.deleteMany({});
    _cryptoWritesOn = true;
    const must = (cond, msg) => { if (!cond) throw new Error(msg); };
    const a = await M.create({ tag: 'a', secret: 'hello A' });
    must(a.secret === 'hello A', 'create() returned ciphertext');
    await M.insertMany([{ tag: 'b', secret: 'hello B' }]);
    await M.updateOne({ tag: 'b' }, { $set: { secret: 'hello B2' } });
    const c = await M.findOneAndUpdate({ tag: 'a' }, { $set: { secret: 'hello A2' } }, { new: true });
    must(c && c.secret === 'hello A2', 'findOneAndUpdate() returned ciphertext');
    const rawA = await col.findOne({ tag: 'a' }), rawB = await col.findOne({ tag: 'b' });
    must(_isEnc(rawA?.secret) && _isEnc(rawB?.secret), 'stored values are not encrypted');
    const lean = await M.find({}).sort({ tag: 1 }).lean();
    must(lean.length === 2 && lean[0].secret === 'hello A2' && lean[1].secret === 'hello B2', 'lean find() did not decrypt');
    const agg = await M.aggregate([{ $sort: { tag: 1 } }, { $group: { _id: null, first: { $first: '$secret' }, root: { $first: '$$ROOT' } } }]);
    must(agg[0]?.first === 'hello A2' && agg[0]?.root?.secret === 'hello A2', 'aggregate() did not decrypt');
    const doc = await M.findOne({ tag: 'a' });
    must(doc.secret === 'hello A2', 'findOne() did not decrypt');
    doc.other = 'x'; await doc.save();
    const rawA2 = await col.findOne({ tag: 'a' });
    must(_isEnc(rawA2?.secret) && _safeDec(rawA2.secret) === 'hello A2' && rawA2.other === 'x', 'save() of a loaded doc damaged the field');
    doc.secret = 'hello A3'; await doc.save();
    const rawA3 = await col.findOne({ tag: 'a' });
    must(_isEnc(rawA3?.secret) && _safeDec(rawA3.secret) === 'hello A3', 'save() of a changed field was not encrypted');
    await col.deleteMany({});
    _cryptoWritesOn = true;
    console.log('[crypto-selftest] PASS — encrypting messages, stories and country from now on');
    return true;
  } catch (e) {
    _cryptoWritesOn = false;
    console.error('[crypto-selftest] FAILED — encryption of new data stays OFF:', e.message);
    try { await col.deleteMany({}); } catch {}
    return false;
  }
}

// ── Field encryption at rest (AES-256-GCM). Needs SNAPSA_FIELD_KEY in Render's environment (any long random string).
const _fieldKey = process.env.SNAPSA_FIELD_KEY ? crypto.createHash('sha256').update(process.env.SNAPSA_FIELD_KEY).digest() : null;
if (!_fieldKey) console.warn('[security] SNAPSA_FIELD_KEY is not set — sensitive fields are NOT being encrypted');
function encField(value) {
  if (value == null || value === '' || !_fieldKey) return value;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _fieldKey, iv);
  const enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return 'enc:v1:' + [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decField(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:') || !_fieldKey) return value;
  const [iv, tag, enc] = value.slice(7).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', _fieldKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const snapsaWithdrawalRequestSchema = new mongoose.Schema({

  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accountHolderName: { type: String, required: true },
  bankName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  branchCode: { type: String, required: true },
  email: { type: String, required: true },
  coinsRequested: { type: Number, required: true },
  zarValue: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'paid', 'rejected'], default: 'pending' },
}, { timestamps: true, collection: 'snapsa_withdrawal_requests' });
const SnapsaWithdrawalRequest = mongoose.models.SnapsaWithdrawalRequest || mongoose.model('SnapsaWithdrawalRequest', snapsaWithdrawalRequestSchema);

// One row per device. A user can have several (phone + tablet).
const snapsaDeviceTokenSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  token:     { type: String, required: true, unique: true },
  platform:  { type: String, default: 'android' },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'snapsa_device_tokens', versionKey: false });
const SnapsaDeviceToken = mongoose.models.SnapsaDeviceToken || mongoose.model('SnapsaDeviceToken', snapsaDeviceTokenSchema);

// Sends a push to every device a user has registered. Dead tokens are removed.
async function sendPushToUser(userId, { title, body, data = {}, channelId, ttlMs }) {
  if (!firebaseReady) return;
  try {
    const rows = await SnapsaDeviceToken.find({ userId }).lean();
    if (!rows.length) return;
    const tokens = rows.map(r => r.token);
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: String(title || 'Snapsa'), body: String(body || '') },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])),
      android: { priority: 'high', ...(ttlMs ? { ttl: ttlMs } : {}), notification: { icon: 'ic_stat_snapsa', color: '#FF2D95', channelId: channelId || 'snapsa_alerts_v4', priority: 'max', defaultVibrateTimings: true, visibility: 'public' } },
    });
    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)) dead.push(tokens[i]);
    });
    if (dead.length) await SnapsaDeviceToken.deleteMany({ token: { $in: dead } });
  } catch (e) { console.error('[push]', e.message); }
}

const liveState = {
  channels: new Map(),
  streamKeys: new Map(),
  chatRooms: new Map(),
  viewerCounts: new Map(),
  userChannels: new Map(),
  chatConnections: new Map(),
  activePolls: new Map(),
  activeBattles: new Map()
};

if (!global.musicUploads) {
  global.musicUploads = new Map();
}

// ─── Cross-instance real-time layer (Redis pub/sub) ───────────────────────

const REDIS_URL = process.env.REDIS_URL || process.env.SNAP_REDIS_URL || '';
const REDIS_ENABLED = !!REDIS_URL;
const SNAP_INSTANCE_ID = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || uuidv4();

const SNAPSA_SYSTEM_ACCOUNT_ID = '000000000000000000000001';
const SNAP_BROADCAST_CHANNEL = 'snapsa:broadcast';
let redisPub = null;
let redisSub = null;

let lastRedisErrorLog = 0;
function logRedisError(tag, e) {
  if (Date.now() - lastRedisErrorLog < 60000) return;
  lastRedisErrorLog = Date.now();
  console.error(`[redis:${tag}] ${e.message} — real-time is running in single-instance mode until Redis is reachable (check REDIS_URL)`);
}

if (REDIS_ENABLED) {

  const redisOpts = {
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 2000, 30000),
  };
  redisPub = new Redis(REDIS_URL, { ...redisOpts, enableOfflineQueue: false });
  redisSub = new Redis(REDIS_URL, redisOpts);
  redisPub.on('error', (e) => logRedisError('pub', e));
  redisSub.on('error', (e) => logRedisError('sub', e));
  redisSub.subscribe(SNAP_BROADCAST_CHANNEL).catch((e) => logRedisError('subscribe', e));
  redisSub.on('message', (channel, raw) => {
    if (channel !== SNAP_BROADCAST_CHANNEL) return;
    try {
      const { userId, payload, originInstance } = JSON.parse(raw);
      if (originInstance === SNAP_INSTANCE_ID) return; // this instance already delivered locally when it published
      deliverToLocalSnapUser(userId, payload);
    } catch (e) { console.error('[redis:message]', e.message); }
  });
  console.log(`[redis] Cross-instance real-time enabled (instance ${SNAP_INSTANCE_ID})`);
} else {
  console.warn('[redis] REDIS_URL not set — Snapsa is running in single-instance real-time mode. DM delivery, reactions, notifications, and online status will only be correct with exactly one server instance. Set REDIS_URL (e.g. AWS ElastiCache for Redis) before scaling to more than one instance.');
}

function deliverToLocalSnapUser(userId, payload) {
  const sockets = liveState.snapRealtime?.get(String(userId));
  if (!sockets || sockets.size === 0) return false;
  const json = JSON.stringify(payload);
  let sent = false;
  sockets.forEach(ws => { if (ws.readyState === ws.OPEN) { ws.send(json); sent = true; } });
  return sent;
}

function deliverToSnapUser(userId, payload) {
  const sentLocally = deliverToLocalSnapUser(userId, payload);
  if (REDIS_ENABLED) {
    redisPub.publish(SNAP_BROADCAST_CHANNEL, JSON.stringify({ userId: String(userId), payload, originInstance: SNAP_INSTANCE_ID }))
      .catch((e) => logRedisError('publish', e));
  }
  return sentLocally;
}

async function markSnapUserOnline(userId, wsId) {
  if (!REDIS_ENABLED) return;
  try {
    const key = `snapsa:online:${userId}`;
    await redisPub.sadd(key, `${SNAP_INSTANCE_ID}:${wsId}`);
    await redisPub.expire(key, 60);
  } catch (e) { logRedisError('online:add', e); }
}
async function refreshSnapUserOnline(userId) {
  if (!REDIS_ENABLED) return;
  try { await redisPub.expire(`snapsa:online:${userId}`, 60); }
  catch (e) { logRedisError('online:refresh', e); }
}
async function markSnapUserOffline(userId, wsId) {
  if (!REDIS_ENABLED) return;
  try { await redisPub.srem(`snapsa:online:${userId}`, `${SNAP_INSTANCE_ID}:${wsId}`); }
  catch (e) { logRedisError('online:rem', e); }
}

const app = express();
// ── Snapsa Firewall: EVERY request passes through here first. Attacks are dropped (connection closed, no answer). ──
const fw = createSnapsaFirewall();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // exactly one proxy hop (Render) — visitors cannot fake their address with X-Forwarded-For
app.use(fw.gate);

// ── Snapsa Verified (pink check) for admin/founder Snapsa identities ──
// Marks them with tier "snapsa" in every JSON response, so the app shows the
// pink badge (and no WernTjat badge) next to their name everywhere.
let _verifiedIds = new Set(), _verifiedAt = 0, _officialMap = new Map(), _crewMap = new Map();
async function getSnapsaVerifiedIds() {
  if (Date.now() - _verifiedAt < 60000) return _verifiedIds;
  try {
        const rows = await SnapsaIdentity.find({ $or: [{ isAdmin: true }, { founder: true }] }).select('_id').lean();
    const paid = await SnapsaVerification.find({ expiresAt: { $gt: new Date() } }).select('userId').lean();
    const offs = await SnapsaProfile.find({ officialLabel: { $nin: ['', null] } }).select('userId officialLabel').lean();
    _officialMap = new Map(offs.map(o => [String(o.userId), o.officialLabel]));
    const crew = await SnapsaProfile.find({ crewPosition: { $nin: ['', null] } }).select('userId crewPosition').lean();
    _crewMap = new Map(crew.map(o => [String(o.userId), o.crewPosition]));
    _verifiedIds = new Set([...rows.map(r => String(r._id)), ...paid.map(r => String(r.userId)), ..._officialMap.keys()]);
    _verifiedAt = Date.now();
  } catch (e) { console.error('[verified-ids]', e.message); }
  return _verifiedIds;
}
function markSnapsaVerified(node, ids, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) markSnapsaVerified(x, ids, depth + 1); return; }
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) return; // skip ObjectId, Date, Buffer, mongoose docs
  const idOf = (v) => String(v && typeof v === 'object' && v._id ? v._id : (v ?? ''));
  if (_officialMap.size) {
    const oid = idOf(node.authorId ?? node.userId ?? (('username' in node) ? node._id : ''));
    if (oid && _officialMap.has(oid) && !node.official && (typeof node.userId !== 'object' || node.userId === null || oid)) node.official = _officialMap.get(oid);
  }
  if (_crewMap.size) {
    const cid = idOf(node.authorId ?? node.userId ?? (('username' in node) ? node._id : ''));
    if (cid && _crewMap.has(cid) && !node.crew) node.crew = _crewMap.get(cid);
  }
  if ('authorSnapsaTier' in node && !node.authorTier && ids.has(idOf(node.authorId))) node.authorTier = 'snapsa';
  if ('snapsaTier' in node && !node.tier && ids.has(idOf(node.userId ?? node.id ?? node._id))) node.tier = 'snapsa';
  if ('_snapsaTier' in node && node.userId && typeof node.userId === 'object'
      && Object.getPrototypeOf(node.userId) === Object.prototype
      && !node.userId.tier && ids.has(idOf(node.userId))) node.userId.tier = 'snapsa';
  for (const k of Object.keys(node)) markSnapsaVerified(node[k], ids, depth + 1);
}
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    getSnapsaVerifiedIds()
      .then(ids => { if (ids.size) markSnapsaVerified(body, ids); origJson(body); })
      .catch(() => origJson(body));
    return res;
  };
  next();
});

app.use((req, res, next) => { res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); next(); });
const server = http.createServer({ maxHeaderSize: 16384 }, app);
server.headersTimeout = 30000; server.keepAliveTimeout = 65000; server.maxHeadersCount = 100;   // slow-connection attacks
const wss = new WebSocketServer({ server, path: '/snapsa/live/ws', maxPayload: 2 * 1024 * 1024, verifyClient: (info) => fw.allowUpgrade(info.req) });

const apiLimiter = rateLimit({ windowMs: 60000, max: 200 });
const uploadLimiter = rateLimit({ windowMs: 60000, max: 12 });
const searchLimiter = rateLimit({ windowMs: 60000, max: 60 });

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || config.origin.includes(origin)),   // no Origin header = the app itself / server-to-server; other websites are refused
  credentials: true,
  exposedHeaders: ['Content-Length', 'Content-Range', 'Content-Type', 'X-Snapsa-Fallback', 'X-Snapsa-Watermark'],
}));
app.use((req, res, next) => {
  
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(fw.inspect);   // firewall, part 2: database-injection / prototype-pollution check on the parsed request
app.use(apiLimiter);

registerSnapsaWallet(app, {
  snapAuth, requireSnapAdmin, uploadLimiter, User,
  createSnapNotification, sendSnapsaSystemMessage, SNAPSA_SYSTEM_ACCOUNT_ID,
  getCoinDeps: () => ({ awardCoins, getSnapsaCoinBalance, logCoinTransaction, SnapsaProfile, SNAPSA_COIN_VALUE_USD, usdRateFor }),
});

registerSnapsaCrew(app, { snapAuth, requireSnapAdmin, uploadLimiter, SnapsaProfile, SnapsaIdentity, sendSnapsaSystemMessage, refreshCrewCache: () => { _verifiedAt = 0; } });

app.use('/snapsa/media', (req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
  
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Timing-Allow-Origin', origin);
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
}, (req, res, next) => {
  
  
  const requestedPath = req.path; 
  const fullPath = path.join(config.uploadDir, requestedPath);
  if (!fs.existsSync(fullPath) && requestedPath.startsWith('/watermarked/')) {
    
    const filename = path.basename(requestedPath);
    const originalPath = path.join(config.uploadDir, 'videos', filename);
    if (fs.existsSync(originalPath)) {
      console.log(`[media] Watermarked file missing, serving original: ${filename}`);
      res.setHeader('X-Snapsa-Fallback', 'original');
      return res.sendFile(originalPath);
    }
    
    return res.status(404).json({ error: 'Media file not found', path: requestedPath });
  }
  next();
}, express.static(config.uploadDir, {
  maxAge: '1d', 
  etag: true,
  lastModified: true,
  acceptRanges: true,
  cacheControl: true,
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// DEFCON 3 and below = lockdown: the account may only watch videos, read posts and use Snapsa Music.
const _defconCache = new Map();   // userId -> { level, at }
const DEFCON_ALLOW = [/^\/snapsa\/defcon/, /^\/snapsa\/auth/, /^\/snapsa\/me(\/|$)/, /^\/snapsa\/presence/, /^\/snapsa\/push/, /^\/snapsa\/music/, /^\/snapsa\/watch-progress/, /^\/snapsa\/videos\/[^/]+\/view$/, /^\/snapsa\/posts\/[^/]+\/(read|view)$/, /^\/snapsa\/posts\/views$/, /^\/snapsa\/visit/, /^\/snapsa\/sounds/];
const DEFCON_BLOCK_GET = [/^\/snapsa\/messages/, /^\/snapsa\/stories/, /^\/snapsa\/call/, /^\/snapsa\/live/];
async function getDefconLevel(uid) {
  const k = String(uid), hit = _defconCache.get(k);
  if (hit && Date.now() - hit.at < 8000) return hit.level;
  const p = await SnapsaProfile.findOne({ userId: uid }).select('defconLevel').lean().catch(() => null);
  const level = p?.defconLevel || 5;
  _defconCache.set(k, { level, at: Date.now() });
  return level;
}
async function defconLockdownBlocks(uid, req) {
  const url = req.originalUrl.split('?')[0];
  if (!url.startsWith('/snapsa/')) return false;
  if (await getDefconLevel(uid) > 3) return false;
  if (DEFCON_ALLOW.some(r => r.test(url))) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return DEFCON_BLOCK_GET.some(r => r.test(url));
  return true;
}
async function snapAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-snapsa-key'];

    
    if (!token) {
      req.userId = null;
      req.jwtPayload = null;
      return next();
    }

    const payload = jwt.verify(token, config.jwtSecret);
    const uid = payload.userId || payload.id || payload.sub;
    if (!uid) {
      
      req.userId = null;
      req.jwtPayload = null;
      return next();
    }

    req.userId = uid;
    req.jwtPayload = payload;
    const restriction = await getAccountRestriction(uid);
    if (restriction) return res.status(403).json(restriction);
    ensureProfileCountry(uid, req);
    if (await defconLockdownBlocks(uid, req)) return res.status(423).json({ error: 'DEFCON lockdown is on. You can only watch videos, read posts and use Snapsa Music. Lower your DEFCON level in Profile to continue.', code: 'DEFCON_LOCKDOWN' });
    next();
  } catch (error) {
    
    req.userId = null;
    req.jwtPayload = null;
    next();
  }
}

// Same as snapAuth, but a missing / invalid login is refused (401) instead of continuing as "nobody".
function snapAuthRequired(req, res, next) {
  return snapAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    next();
  });
}

async function requireSnapAdmin(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const adminStatus = await getSnapAdminStatus(req);

    if (!adminStatus.isAdmin && !adminStatus.founder) {
      return res.status(403).json({
        error: 'Admin access required'
      });
    }

    req.isSnapAdmin = true;
    req.isSnapFounder = adminStatus.founder;

    next();
  } catch (error) {
    console.error('[SNAPSA ADMIN]', error);

    res.status(500).json({
      error: 'Unable to verify admin access'
    });
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxVideoMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/video\/|audio\//.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported: ${file.mimetype}`));
  }
});

const BLOCKED_FILE_EXT = /\.(exe|msi|bat|cmd|scr|com|vbs|ps1|jar|dll)$/i;   // Windows/auto-run executables are not shared through chat
const uploadMessageMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxVideoMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (BLOCKED_FILE_EXT.test(file.originalname || '')) return cb(new Error('This file type cannot be sent'));
    cb(null, true);
  }
});

const uploadStory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxVideoMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/video\/|image\/|audio\//.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported: ${file.mimetype}`));
  }
});

const uploadTrackMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxVideoMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/audio\/|image\/|video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported: ${file.mimetype}`));
  }
});

function mediaUrl(req, relativePath) {
  if (!relativePath) return null;
  
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/snapsa/media/${relativePath}`;
}

function extractVideoFrame(inputPath, outputPath) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    try {
      ffmpeg(inputPath)
        .on('end', () => resolve(fs.existsSync(outputPath) ? outputPath : null))
        .on('error', (err) => { console.warn('[thumb] frame extraction failed:', err.message); resolve(null); })
        .screenshots({
          timestamps: ['1'],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
          size: '400x224',
        });
    } catch (e) {
      console.warn('[thumb] frame extraction threw:', e.message);
      resolve(null);
    }
  });
}

async function snapActorName(userId) {
  try {
    const profile = await SnapsaProfile.findOne({ userId }).lean();
    if (profile?.username) return profile.username;
    const user = await User.findById(userId).lean();
    return user?.firstName || 'Someone';
  } catch { return 'Someone'; }
}

const MAX_GIFTERS_RETURNED = 100;
function topGiftersOf(gifters, cap = MAX_GIFTERS_RETURNED) {
  if (!Array.isArray(gifters) || gifters.length === 0) return [];
  return gifters
    .filter(g => g && g.weight > 0)
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, cap)
    .map(g => ({ userId: g.userId, name: g.name, weight: g.weight }));
}

const SNAP_WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const SNAP_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function snapVideoTilesByIds(videoIds, viewerId) {
  if (!videoIds || !videoIds.length) return [];
  const rows = await SnapsaVideo.aggregate([
    { $match: { _id: { $in: videoIds.map(id => new mongoose.Types.ObjectId(id)) } } },
    { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
    { $unwind: '$post' },
    {
      $match: {
                'post.isActive': true, authorId: { $nin: [...restrictedIds, ...(await hiddenPrivateAuthorIds(viewerId))] },
        $or: [
          { 'privacy.visibility': { $ne: 'private' } },
          ...(viewerId ? [{ authorId: new mongoose.Types.ObjectId(viewerId) }] : []),
        ],
      }
    },
    { $lookup: { from: 'snapsa_profiles', localField: 'authorId', foreignField: 'userId', as: 'profile' } },
    { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'userDoc' } },
    {
      $project: {
        id: '$_id',
        postId: '$postId',
        authorId: '$authorId',
        authorName: { $ifNull: [{ $arrayElemAt: ['$profile.username', 0] }, '$authorName'] },
        authorAvatarUrl: { $ifNull: [{ $arrayElemAt: ['$profile.avatarUrl', 0] }, null] },
        authorTier: { $ifNull: [{ $arrayElemAt: ['$userDoc.tier', 0] }, ''] },
        authorSnapsaTier: { $ifNull: [{ $arrayElemAt: ['$profile.snapsaTier', 0] }, ''] }, authorDisplayName: { $ifNull: [{ $arrayElemAt: ['$profile.displayName', 0] }, ''] },
        allowDownload: { $ifNull: ['$privacy.allowDownload', true] },
        caption: '$post.content',
        videoUrl: '$videoFile',
        thumbUrl: '$thumbFile',
        likes: '$post.likeCount',
        comments: '$post.commentCount',
        shares: '$post.shareCount',
        isLive: '$isLive',
        visibility: { $ifNull: ['$privacy.visibility', 'public'] },
      }
    }
  ]);
  return rows;
}

function formatGiftNotifTime(date = new Date()) {
  const d = new Date(date);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${SNAP_WEEKDAYS[d.getDay()]} ${d.getDate()} ${SNAP_MONTHS[d.getMonth()]} @${hh}:${mm}`;
}
function pluralizeGiftName(name, qty) {
  const n = (name || 'gift').toLowerCase();
  if (qty <= 1) return n;
  return n.endsWith('s') ? n : `${n}s`;
}

async function createSnapNotification(payload) {
  const doc = await Notification.create(payload);
  pushToSnapUser(payload.recipientId, { type: 'new_notification', notification: doc });
  sendPushToUser(payload.recipientId, {
    title: payload.title,
    body: payload.body || '',
    data: { type: payload.type || '', notificationId: doc._id },
  });
  return doc;
}

async function makeThumb(outputPath, label = 'Snapsa') {
  try {
    const W = 400, H = 224;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1a0a2e'); g.addColorStop(1, '#3d0036');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.arc(W/2, H/2 - 16, 36, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(W/2-12, H/2-30); ctx.lineTo(W/2+20, H/2-16); ctx.lineTo(W/2-12, H/2-2);
    ctx.closePath(); ctx.fill();

    
    try {
      const logo = await loadImage(LOGO_PATH);
      ctx.save();
      ctx.beginPath(); ctx.arc(20, H-20, 12, 0, Math.PI*2); ctx.clip();
      ctx.drawImage(logo, 8, H-32, 24, 24);
      ctx.restore();
    } catch {  }

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font      = 'bold 16px sans-serif';
    ctx.fillText('Snapsa', 38, H-12);

    ctx.fillStyle = '#FF2055';
    const bw = ctx.measureText(label).width + 20;
    _roundRect(ctx, W-bw-8, H-30, bw, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font      = 'bold 11px sans-serif';
    ctx.fillText(label, W-bw+2, H-13);

  const buf = canvas.toBuffer('image/jpeg');
if (!buf || !buf.length) throw new Error('canvas produced empty buffer');
fs.writeFileSync(outputPath, buf);
return outputPath;
  } catch (e) {
    console.error('[thumb]', e.message);
    return null;
  }
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y); ctx.arcTo(x+w, y, x+w, y+r, r);
  ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
  ctx.lineTo(x+r, y+h); ctx.arcTo(x, y+h, x, y+h-r, r);
  ctx.lineTo(x, y+r); ctx.arcTo(x, y, x+r, y, r);
  ctx.closePath();
}

const guardId = (req, res) => {
  const id = req.params?.id;
  if (!id || id === 'null' || id === 'undefined') {
    res.status(400).json({ error: 'Invalid or missing id' });
    return false;
  }
  return true;
};

const END_SOUND_PATH = path.join(__dirname, './assets/snapsa-end.mp3');

const FONT_PATH = fs.existsSync('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
  ? '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
  : fs.existsSync('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf')
  ? '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
  : fs.existsSync('/System/Library/Fonts/Helvetica.ttc')
  ? '/System/Library/Fonts/Helvetica.ttc'
  : 'C:/Windows/Fonts/arial.ttf'; 

// ── Font-free watermark: the app draws the logo + "👤 username" into a PNG on the
// phone (where the fonts and emoji exist) and sends it with the upload. The server
// only has to lay that PNG over the video, so it needs no font files at all. ──
function buildOverlayFilters({ W, H, endStart, hasEnd, hasAudio, withSound, soundIndex, disc = false }) {
  // disc: the picture has the "DISCOVER ON SNAPSA" band in its bottom 17% — the corner mark crops it off, the end screen keeps it.
  const cornerCrop = disc ? 'crop=iw:ih*0.83:0:0,' : '';

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const wmW  = even(Math.min(Math.max(W * 0.40, 200), 720));
  const endW = even(Math.min(W * 0.86, 1000));
  const f = [];
  if (hasEnd) {
    f.push('[1:v]format=rgba,split=2[wa][wb]');
    f.push(`[wa]${cornerCrop}scale=${wmW}:-1[wm]`);
    f.push(`[wb]scale=${endW}:-1[wbig]`);
    f.push(`[0:v][wm]overlay=x=W*0.04:y=H-h-H*0.085:enable='lt(t\\,${endStart})'[v1]`);
    f.push(`[v1]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.92:t=fill:enable='gte(t\\,${endStart})'[v2]`);
    f.push(`[v2][wbig]overlay=x=(W-w)/2:y=(H-h)/2:enable='gte(t\\,${endStart})'[v3]`);
    f.push('[v3]scale=trunc(iw/2)*2:trunc(ih/2)*2[vout]');
  } else {
    f.push(`[1:v]format=rgba,${cornerCrop}scale=${wmW}:-1[wm]`);
    f.push('[0:v][wm]overlay=x=W*0.04:y=H-h-H*0.085[v1]');
    f.push('[v1]scale=trunc(iw/2)*2:trunc(ih/2)*2[vout]');
  }
  const outputs = ['[vout]'];
  if (hasAudio) {
    if (hasEnd && withSound) {
      const ms = Math.floor(endStart * 1000);
      f.push(`[${soundIndex}:a]adelay=${ms}|${ms},volume=10[end]`);
      f.push(`[0:a]volume='if(gte(t\\,${endStart})\\,0.5\\,1)'[orig]`);
      f.push('[orig][end]amix=inputs=2:duration=first:dropout_transition=0.3[aout]');
    } else {
      f.push('[0:a]anull[aout]');
    }
    outputs.push('[aout]');
  }
  return { filters: f, outputs };
}

function watermarkWithOverlay(inputPath, outputPath, overlayPath, { crf = 20, preset = 'veryfast', overlayHasDisc = false } = {}) {
  return new Promise((resolve) => {
    const fail = (why, stderr) => {
      console.error(`[watermark] overlay bake FAILED: ${why}`, stderr ? `\n${String(stderr).slice(-800)}` : '');
      resolve({ path: outputPath, watermarked: false, error: why });
    };
    try {
      ffmpeg.ffprobe(inputPath, (probeErr, metadata) => {
        if (probeErr) return fail(`ffprobe: ${probeErr.message}`);
        try {
          const vs = (metadata.streams || []).find(s => s.codec_type === 'video');
          if (!vs) return fail('no video stream');
          let W = vs.width || 720, H = vs.height || 1280;
          const rotRaw = vs.tags?.rotate ?? (vs.side_data_list || []).find(d => d.rotation != null)?.rotation ?? 0;
          if (Math.abs(Number(rotRaw)) % 180 === 90) [W, H] = [H, W];
          // Recorded .webm files often carry no duration — then skip the end-card and
          // keep the corner mark on for the whole clip.
          const duration = parseFloat(metadata.format?.duration) || parseFloat(vs.duration) || 0;
          const hasEnd = duration > 3;
          const endStart = hasEnd ? +(duration - 1.5).toFixed(2) : 0;
          const hasAudio = !!(metadata.streams || []).some(s => s.codec_type === 'audio');
          const withSound = hasAudio && hasEnd && fs.existsSync(END_SOUND_PATH);

          const { filters, outputs } = buildOverlayFilters({ W, H, endStart, hasEnd, hasAudio, withSound, soundIndex: 2, disc: overlayHasDisc });
          let cmd = ffmpeg(inputPath).input(overlayPath);
          if (withSound) cmd = cmd.input(END_SOUND_PATH);
          cmd.complexFilter(filters.join(';'), outputs)
            .videoCodec('libx264').audioCodec('aac').audioBitrate('160k')
            .outputOptions(['-preset', preset, '-crf', String(crf), '-movflags', '+faststart', '-pix_fmt', 'yuv420p'])
            .format('mp4')
            .output(outputPath)
            .on('start', (c) => console.log('[watermark] overlay bake started', c.slice(0, 160)))
            .on('error', (err, _o, stderr) => fail(err.message, stderr))
            .on('end', () => {
              try {
                const outSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
                if (outSize < 20 * 1024) return fail('output missing or too small');
                console.log('[watermark] ✅ overlay bake done');
                resolve({ path: outputPath, watermarked: true });
              } catch (e) { fail(e.message); }
            })
            .run();
        } catch (e) { fail(e.message); }
      });
    } catch (e) { fail(e.message); }
  });
}

async function watermarkVideo(inputPath, outputPath, authorName = 'snapsa', authorTier = '', options = {}) {

  const watermarkXPercent = options.watermarkXPercent || 6;
    const crf = options.crf || 20;
  const preset = options.preset || 'veryfast';
  if (options.overlayPath && ffmpeg && fs.existsSync(inputPath) && fs.existsSync(options.overlayPath)) {
    const viaOverlay = await watermarkWithOverlay(inputPath, outputPath, options.overlayPath, { crf, preset, overlayHasDisc: !!options.overlayHasDisc });
    if (viaOverlay.watermarked) return viaOverlay;
  }
  
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) return reject(new Error(`Input not found: ${inputPath}`));
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    if (!ffmpeg) {
      
      console.warn('[watermark] ffmpeg unavailable, serving RAW COPY (no watermark, no end-screen)');
      fs.copyFileSync(inputPath, outputPath);
      return resolve({ path: outputPath, watermarked: false });
    }

    const safeText = (authorName || 'snapsa').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 50) || 'snapsa';
    const fontPath = FONT_PATH.replace(/\\/g, '/');
    
    const boldCandidates = [
      fontPath.replace(/Sans-Regular/, 'Sans-Bold').replace(/DejaVuSans\./, 'DejaVuSans-Bold.').replace(/\.ttf$/i, 'bd.ttf'),
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      fontPath,
    ];
    const boldFontPath = boldCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || fontPath;
    
    const logoPath = path.join(__dirname, 'public', 'SnapsaLogo.png');
    const soundPath = END_SOUND_PATH;
    const logoExists = fs.existsSync(logoPath);
    const soundExists = fs.existsSync(soundPath);

    ffmpeg.ffprobe(inputPath, (probeErr, metadata) => {
      if (probeErr) {
        console.error('[watermark] ffprobe failed, falling back to RAW COPY (no watermark, no end-screen):', probeErr.message);
        try { fs.copyFileSync(inputPath, outputPath); return resolve({ path: outputPath, watermarked: false }); }
        catch (copyErr) { return reject(copyErr); }
      }

      try {
        const duration = parseFloat(metadata.format?.duration) || 30;
        const hasAudio = metadata.streams?.some(s => s.codec_type === 'audio');
        const endStart = duration - 1.5;

        let filters = [];
        let cmd = ffmpeg(inputPath);
        if (logoExists) cmd = cmd.input(logoPath);

        const centerX = `W*${watermarkXPercent / 100}`;

        if (logoExists) {
          filters.push('[1:v]split=3[logo_main][logo_top][logo_end]');
          filters.push('[logo_main]scale=76:76:flags=lanczos[logo_m]');
          filters.push('[logo_top]scale=34:34:flags=lanczos[logo_t]');
          filters.push('[logo_end]scale=110:110:flags=lanczos[logo_e]');

          // Corner watermark — the logo image already carries the "SNAPSA"
          // wordmark, so only the uploader's username prints below it now.
          filters.push(`[0:v][logo_m]overlay=${centerX}-38:H-186:enable='lt(t\\,${endStart})'[v1]`);
          filters.push(`[v1]drawtext=text='@${safeText}':fontfile='${fontPath}':fontsize=13:fontcolor=white@0.9:x=${centerX}-38+(76-text_w)/2:y=H-104:shadowx=1:shadowy=1:shadowcolor=black@0.7:enable='lt(t\\,${endStart})'[v2]`);

          // Small top-center logo mark — icon+wordmark is legible enough on
          // its own at this size, no separate text needed alongside it.
          filters.push(`[v2][logo_t]overlay=W/2-17:10:enable='lt(t\\,${endStart})'[v5]`);

          // End-screen — logo (with wordmark baked in) + username + tagline.
          filters.push(`[v5]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.92:t=fill:enable='gte(t\\,${endStart})'[v6]`);
          filters.push(`[v6][logo_e]overlay=(W-w)/2:(H/2)-110:enable='gte(t\\,${endStart})'[v7]`);
          filters.push(`[v7]drawtext=text='@${safeText}':fontfile='${fontPath}':fontsize=24:fontcolor=white@0.95:x=(w-text_w)/2:y=(h/2)+22:shadowx=2:shadowy=2:shadowcolor=black@0.9:enable='gte(t\\,${endStart})'[v8]`);
          filters.push(`[v8]drawtext=text='Watch on Snapsa':fontfile='${fontPath}':fontsize=16:fontcolor=white@0.80:x=(w-text_w)/2:y=(h/2)+64:enable='gte(t\\,${endStart})'[vout]`);
        } else {
          
          filters.push(`[0:v]drawtext=text='Snapsa':fontfile='${boldFontPath}':fontsize=36:fontcolor=white@0.92:x=${centerX}-text_w/2:y=H-159:shadowx=2:shadowy=2:shadowcolor=black@0.7:enable='lt(t\\,${endStart})'[v1]`);
          filters.push(`[v1]drawtext=text='@${safeText}':fontfile='${fontPath}':fontsize=15:fontcolor=white@0.85:x=${centerX}-text_w/2:y=H-125:shadowx=1:shadowy=1:shadowcolor=black@0.7:enable='lt(t\\,${endStart})'[v2]`);
          filters.push(`[v2]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.92:t=fill:enable='gte(t\\,${endStart})'[v3]`);
          filters.push(`[v3]drawtext=text='Snapsa':fontfile='${boldFontPath}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h/2)-45:enable='gte(t\\,${endStart})'[v4]`);
          filters.push(`[v4]drawtext=text='@${safeText}':fontfile='${fontPath}':fontsize=22:fontcolor=white@0.95:x=(w-text_w)/2:y=(h/2)+10:enable='gte(t\\,${endStart})'[v5]`);
          filters.push(`[v5]drawtext=text='Watch on Snapsa':fontfile='${fontPath}':fontsize=16:fontcolor=white@0.80:x=(w-text_w)/2:y=(h/2)+50:enable='gte(t\\,${endStart})'[vout]`);
        }

        
        if (hasAudio && soundExists) {
          const audioDelayMs = Math.floor(endStart * 1000);
          cmd = cmd.input(soundPath);
          const audioIndex = logoExists ? 2 : 1;
          filters.push(`[${audioIndex}:a]adelay=${audioDelayMs}|${audioDelayMs},volume=10[end]`);
          filters.push(`[0:a]volume='if(gte(t\\,${endStart})\\,0.5\\,1)'[orig]`);
          filters.push(`[orig][end]amix=inputs=2:duration=first:dropout_transition=0.3[aout]`);
        } else if (hasAudio) {
          filters.push(`[0:a]anull[aout]`);
        }

        let outputs = ['[vout]'];
        if (hasAudio) outputs.push('[aout]');

        cmd
          .complexFilter(filters.join(';'), outputs)
          .videoCodec('libx264')
          .audioCodec('aac')
          .audioBitrate('192k')
          .outputOptions([
            '-preset', preset,
            '-crf', crf.toString(),
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p'
          ])
          .output(outputPath)
          .on('start', () => console.log(`[FFMPEG] Start (center:${watermarkXPercent}%)`))
          .on('end', () => {
            if (!fs.existsSync(outputPath)) {
              console.error('[watermark] output missing, falling back to RAW COPY (no watermark, no end-screen)');
              try { fs.copyFileSync(inputPath, outputPath); } catch {}
              return resolve({ path: outputPath, watermarked: false });
            }
            
            const inSize  = fs.statSync(inputPath).size;
            const outSize = fs.statSync(outputPath).size;
            if (outSize < inSize * 0.1) {
              console.error('[watermark] output suspiciously small, falling back to RAW COPY (no watermark, no end-screen)');
              try { fs.copyFileSync(inputPath, outputPath); } catch {}
              
              
              
              return resolve({ path: outputPath, watermarked: false });
            }
            console.log('[watermark] ✅ DONE');
            resolve({ path: outputPath, watermarked: true });
          })
          .on('error', err => {
            console.error('[watermark] ffmpeg failed, falling back to RAW COPY (no watermark, no end-screen):', err.message);
            try { fs.copyFileSync(inputPath, outputPath); resolve({ path: outputPath, watermarked: false }); }
            catch (copyErr) { reject(copyErr); }
          })
          .run();

      } catch (err) {
        console.error('[watermark] filter build failed, falling back to RAW COPY (no watermark, no end-screen):', err.message);
        try { fs.copyFileSync(inputPath, outputPath); resolve({ path: outputPath, watermarked: false }); }
        catch (copyErr) { reject(copyErr); }
      }
    });
  });
}

function broadcastToChannel(channelArn, message, excludeUserId = null) {
  const data = JSON.stringify(message);
  liveState.chatConnections.forEach((conn, wsId) => {
    if (conn.channelArn === channelArn && conn.userId !== excludeUserId && conn.ws.readyState === conn.ws.OPEN) {
      try {
        conn.ws.send(data);
      } catch (error) { }
    }
  });
}

function pushToSnapUser(userId, payload) {
  try { return deliverToSnapUser(userId, payload); }
  catch { return false; }
}

async function isSnapUserOnline(userId) {
  const sockets = liveState.snapRealtime?.get(String(userId));
  if (sockets) { for (const ws of sockets) { if (ws.readyState === ws.OPEN) return true; } }
  if (!REDIS_ENABLED) return false; // single-instance mode — local check above is the whole answer
  try {
    const n = await Promise.race([
      redisPub.scard(`snapsa:online:${userId}`),
      new Promise(resolve => setTimeout(() => resolve(0), 1500)),   // never wait long on Redis
    ]);
    return n > 0;
  } catch (e) { logRedisError('online:check', e); return false; }
}

function touchLastActive(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return;
  SnapsaProfile.findOneAndUpdate({ userId }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
}

function broadcastToUser(userId, message) {
  deliverToSnapUser(userId, message);
}

async function markDeliveredOnConnect(userId) {
  try {
    const now = new Date();
    const pending = await SnapsaMessage.find({ receiverId: userId, deliveredAt: null }).select('_id senderId').lean();
    if (!pending.length) return;
    await SnapsaMessage.updateMany({ receiverId: userId, deliveredAt: null }, { deliveredAt: now });
    const bySender = new Map();
    for (const m of pending) {
      const sid = String(m.senderId);
      if (!bySender.has(sid)) bySender.set(sid, []);
      bySender.get(sid).push(String(m._id));
    }
    for (const [senderId, messageIds] of bySender) {
      broadcastToUser(senderId, { type: 'snapsa_dm_delivered', messageIds, deliveredAt: now });
    }
  } catch (error) { console.error('[markDeliveredOnConnect]', error.message); }
}

async function getOrCreateChannel(userId, username) {
  const existingArn = liveState.userChannels.get(userId);
  if (existingArn && liveState.channels.has(existingArn)) {
    return liveState.channels.get(existingArn);
  }

  const channelName = `snapsa-${username.slice(0, 20)}-${Date.now().toString(36)}`;

  const channelCmd = new CreateChannelCommand({
    name: channelName,
    type: 'STANDARD',
    latencyMode: 'LOW',
    authorized: false
  });

  const channelResponse = await ivsClient.send(channelCmd);
  const channelArn = channelResponse.channel.arn;

  const keyCmd = new CreateStreamKeyCommand({ channelArn });
  const keyResponse = await ivsClient.send(keyCmd);

  const roomCmd = new CreateRoomCommand({
    name: `${channelName}-chat`,
    maximumMessageRatePerSecond: 100,
    maximumMessageLength: 500
  });
  const roomResponse = await ivsChatClient.send(roomCmd);

  const channelData = {
    channelArn,
    channelName,
    streamKeyArn: keyResponse.streamKey.arn,
    streamKey: keyResponse.streamKey.value,
    ingestEndpoint: channelResponse.channel.ingestEndpoint,
    playbackUrl: channelResponse.channel.playbackUrl,
    chatRoomArn: roomResponse.arn,
    chatRoomId: roomResponse.id,
    hostId: userId,
    hostName: username,
    createdAt: new Date(),
    isLive: false
  };

  liveState.channels.set(channelArn, channelData);
  liveState.streamKeys.set(channelArn, keyResponse.streamKey.value);
  liveState.chatRooms.set(channelArn, roomResponse);
  liveState.userChannels.set(userId, channelArn);

  await SnapsaLive.create({
    hostId: userId,
    hostName: username,
    title: `${username}'s Live Stream`,
    isLive: true,
    viewers: 0,
    peakViewers: 0,
    channelArn,
    chatRoomArn: roomResponse.arn,
    startedAt: new Date()
  });

  return channelData;
}

async function cleanupChannel(channelArn) {
  try {
    const data = liveState.channels.get(channelArn);
    if (!data) return;

    try {
      await ivsClient.send(new StopStreamCommand({ channelArn }));
    } catch (error) { }

    if (data.chatRoomArn) {
      try {
        await ivsChatClient.send(new DeleteRoomCommand({ identifier: data.chatRoomArn }));
      } catch (error) { }
    }

    try {
      await ivsClient.send(new DeleteChannelCommand({ arn: channelArn }));
    } catch (error) { }

    liveState.channels.delete(channelArn);
    liveState.streamKeys.delete(channelArn);
    liveState.chatRooms.delete(channelArn);
    liveState.viewerCounts.delete(channelArn);

    if (data.hostId) {
      liveState.userChannels.delete(data.hostId);
    }
  } catch (error) {
    console.error('[cleanupChannel]', error);
  }
}

app.get('/snapsa/live/rooms', snapAuth, async (req, res) => {
  try {
    const liveRooms = await SnapsaLive.find({ isLive: true, hostId: { $nin: restrictedIds } })
      .sort({ viewers: -1 })
      .limit(20)
      .lean();

    res.json({
      rooms: liveRooms.map(r => ({
        id:       r._id,
        hostName: r.hostName,
        title:    r.title,
        viewers:  r.viewers,
        peakViewers: r.peakViewers,
        channelArn:  r.channelArn,
        startedAt:   r.startedAt,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SnapServer',
    version: '4.0.0',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    ffmpeg: !!ffmpeg,
    timestamp: Date.now()
  });
});

// Per-user chat state: "hide" removes a chat from my list until a newer message
// arrives; "delete" also wipes the history on MY side only (the other person
// keeps theirs).
const snapsaChatStateSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  chatId:    { type: String, required: true },
  hiddenAt:  Date,
  clearedAt: Date,
}, { timestamps: true, collection: 'snapsa_chat_state' });
snapsaChatStateSchema.index({ userId: 1, chatId: 1 }, { unique: true });
const SnapsaChatState = mongoose.models.SnapsaChatState || mongoose.model('SnapsaChatState', snapsaChatStateSchema);

async function setSnapsaChatState(req, res, wipe) {
  try {
    if (!req.userId || !mongoose.Types.ObjectId.isValid(req.userId)) return res.status(401).json({ error: 'Sign in required' });
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ error: 'Invalid chat partner' });
    const chatId = buildSnapChatId(req.userId, req.params.userId);
    const now = new Date();
    await SnapsaChatState.updateOne(
      { userId: req.userId, chatId },
      { $set: wipe ? { hiddenAt: now, clearedAt: now } : { hiddenAt: now } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.post('/snapsa/messages/:userId/hide', snapAuth, (req, res) => setSnapsaChatState(req, res, false));
app.post('/snapsa/messages/:userId/delete-chat', snapAuth, (req, res) => setSnapsaChatState(req, res, true));

app.get('/snapsa/messages/threads/list', snapAuth, async (req, res) => {
  
  try {
    if (!req.userId) return res.json({ threads: [] });
    if (!mongoose.Types.ObjectId.isValid(req.userId)) {
      
      
      
      console.warn('[threads/list] req.userId is not a valid ObjectId:', req.userId);
      return res.json({ threads: [] });
    }
    const uid = new mongoose.Types.ObjectId(req.userId);
    const threads = await SnapsaMessage.aggregate([
      {
        $match: {
          $or: [{ senderId: uid }, { receiverId: uid }],
          $nor: [{ hideFromSender: true, senderId: uid }],
        }
      },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$chatId', lastMessage: { $first: '$$ROOT' } } },
      { $sort: { 'lastMessage.createdAt': -1 } },
    ]);

    
    
    
    const latestReactionByChat = new Map();
    const reactionRows = await SnapsaMessage.aggregate([
      {
        $match: {
          $or: [{ senderId: uid }, { receiverId: uid }],
          'reactions.0': { $exists: true },
        }
      },
      { $unwind: '$reactions' },
      { $sort: { 'reactions.reactedAt': -1 } },
      { $group: {
          _id: '$chatId',
          messageId: { $first: '$_id' },
          senderId: { $first: '$senderId' },
          receiverId: { $first: '$receiverId' },
          type: { $first: '$type' },
          text: { $first: '$text' },
          reactorId: { $first: '$reactions.userId' },
          emoji: { $first: '$reactions.emoji' },
          reactedAt: { $first: '$reactions.reactedAt' },
      }},
    ]);
    for (const r of reactionRows) latestReactionByChat.set(String(r._id), r);

    
    
    const unreadByChat = new Map();
    const unreadRows = await SnapsaMessage.aggregate([
      { $match: { receiverId: uid, readAt: null } },
      { $group: { _id: '$chatId', count: { $sum: 1 } } },
    ]);
    for (const r of unreadRows) unreadByChat.set(String(r._id), r.count);

    const mapped = [];
    for (const t of threads) {
      try {
        const entry = {
          ...t,
          unreadCount: unreadByChat.get(String(t._id)) || 0,
          lastMessage: {
            ...t.lastMessage,
            mediaUrl: (t.lastMessage.deletedForEveryone || t.lastMessage.burn) ? null : mediaUrl(req, t.lastMessage.mediaFile),
            text: t.lastMessage.deletedForEveryone ? '' : t.lastMessage.burn ? '🔥 Burn message' : t.lastMessage.text,
            status: snapMsgStatus(t.lastMessage),
          },
        };
        const reaction = latestReactionByChat.get(String(t._id));
        
        
        if (reaction && new Date(reaction.reactedAt) > new Date(t.lastMessage.createdAt)) {
          entry.reactionPreview = {
            messageId: reaction.messageId,
            emoji: reaction.emoji,
            reactedAt: reaction.reactedAt,
            reactorId: reaction.reactorId,
            reactorIsMe: String(reaction.reactorId) === String(req.userId),
            targetIsMine: String(reaction.senderId) === String(req.userId),
            targetType: reaction.type,
            targetText: reaction.text,
          };
          entry.lastActivityAt = reaction.reactedAt;
        } else {
          entry.lastActivityAt = t.lastMessage.createdAt;
        }
        mapped.push(entry);
      } catch (perItemErr) {
        
        
        console.error('[threads/list] skipped malformed thread', t?._id, perItemErr.message);
      }
    }
    
    mapped.sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));
    if (threads.length > 0 && mapped.length === 0) {
      console.error(`[threads/list] all ${threads.length} thread(s) failed to map for user ${req.userId} — inbox will appear empty despite having messages`);
    }
    const chatStates = await SnapsaChatState.find({ userId: uid }).lean();
    const stateByChat = new Map(chatStates.map(s => [String(s.chatId), s]));
    const shown = mapped.filter(e => {
      const st = stateByChat.get(String(e._id));
      if (!st) return true;
      const cut = st.hiddenAt || st.clearedAt;
      return !cut || new Date(e.lastMessage.createdAt) > cut;   // a newer message brings a hidden chat back
    });
    res.json({ threads: shown });
    
  } catch (error) {
    console.error('[threads/list]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/messages/unread-count', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.json({ count: 0 });
    if (!mongoose.Types.ObjectId.isValid(req.userId)) return res.json({ count: 0 });
    
   const hiddenStates = await SnapsaChatState.find({ userId: req.userId }).lean();
    const unreadQuery = { receiverId: req.userId, readAt: null };
    const hiddenClauses = hiddenStates
      .filter(s => s.hiddenAt || s.clearedAt)
      .map(s => ({ chatId: s.chatId, createdAt: { $lte: s.hiddenAt || s.clearedAt } }));
    if (hiddenClauses.length) unreadQuery.$nor = hiddenClauses;
    const count = await SnapsaMessage.countDocuments(unreadQuery);
    
    res.json({ count });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

registerSnapsaGroups(app, { snapAuth, uploadLimiter, uploadMessageMedia, uploadToCloudinary, cleanupTempFiles, config, SnapsaProfile, sendPushToUser, broadcastToUser, mediaUrl, path, fs, uuidv4, isSnapUserOnline });

app.post('/snapsa/messages/:userId', snapAuth, uploadLimiter, uploadMessageMedia.single('media'), async (req, res) => {
  let tempPath = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid recipient' });
    }
    // The Snapsa system account only sends broadcast announcements — it
    // doesn't read replies, so block them here rather than let messages
    // pile up somewhere nobody's watching.
    if (String(req.params.userId) === SNAPSA_SYSTEM_ACCOUNT_ID) {
      return res.status(403).json({ error: "Snapsa doesn't accept replies to its announcements" });
    }
    if (await hasBlockBetween(req.userId, req.params.userId)) {
      return res.status(403).json({ error: "You can't message this user", code: 'BLOCKED' });
    }
    // IN CIRCLE: if the recipient has it on, only people they follow (or who
    // follow them) can start or continue a chat.
    const circleProfile = await SnapsaProfile.findOne({ userId: req.params.userId }).select('privacy.inCircle privacy.dmSetting defconLevel').lean();     const dmSetting = circleProfile?.privacy?.dmSetting || 'everyone';     if (dmSetting === 'nobody') return res.status(403).json({ error: 'This person is not accepting messages', code: 'DM_OFF' });     if (dmSetting === 'followers' && !(await Follower.exists({ followerId: req.userId, followingId: req.params.userId }))) {       return res.status(403).json({ error: 'Only people who follow this account can message them', code: 'DM_FOLLOWERS_ONLY' });     }
    if (circleProfile?.privacy?.inCircle || (circleProfile?.defconLevel || 5) <= 3) {
      const inCircle = await Follower.exists({ $or: [
        { followerId: req.userId, followingId: req.params.userId },
        { followerId: req.params.userId, followingId: req.userId },
      ] });
      if (!inCircle) return res.status(403).json({ error: 'This person only accepts messages from people in their circle', code: 'IN_CIRCLE' });
    }
    const chatId = buildSnapChatId(req.userId, req.params.userId);
    let mediaFile = '', type = 'text';
    if (req.file) {
      const asFile = req.body.asFile === '1' || !/^(video|audio|image)\//.test(req.file.mimetype);
      type = asFile ? 'file' : req.file.mimetype.startsWith('video/') ? 'video'
           : req.file.mimetype.startsWith('audio/') ? 'voice' : 'photo';

      const tempDir = path.join(config.uploadDir, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const ext = path.extname(req.file.originalname) || (type === 'voice' ? '.webm' : type === 'video' ? '.mp4' : type === 'file' ? '.bin' : '.jpg');
      tempPath = path.join(tempDir, `dm_${uuidv4()}${ext}`);
      fs.writeFileSync(tempPath, req.file.buffer);

      const resourceType = type === 'photo' ? 'image' : type === 'file' ? 'raw' : 'video'; 
      const uploaded = await uploadToCloudinary(tempPath, { resourceType, folder: 'snapsa/messages' });
      mediaFile = uploaded.secure_url;
      cleanupTempFiles(tempPath);
    }
    let replyContext, storySnapshot, hideFromSender = false;
    if (req.body.storyId && mongoose.Types.ObjectId.isValid(req.body.storyId)) {
      const kind = req.body.kind === 'story_reaction' ? 'story_reaction' : 'story_reply';
      replyContext = { kind, storyId: req.body.storyId };
      hideFromSender = kind === 'story_reaction';
      try {
        const story = await SnapsaStory.findById(req.body.storyId).select('mediaFile authorName type text qa').lean();
        if (story) {
          storySnapshot = {
            thumbUrl: story.type === 'photo' ? story.mediaFile : null, 
            authorName: story.authorName || null,
            caption: String(story.text || story.qa || '').slice(0, 80) || null,
          };
        }
      } catch {}
    }
    const msg = await SnapsaMessage.create({
      chatId, senderId: req.userId, receiverId: req.params.userId,
      type, text: req.body.text || '', mediaFile, duration: Number(req.body.duration) || 0,
      fileName: type === 'file' ? String(req.file.originalname || 'file').slice(0, 120) : '', fileSize: type === 'file' ? req.file.size : 0,
      burn: req.body.burn === 'true' || req.body.burn === '1',
      replyContext, storySnapshot, hideFromSender,
    });
    // If the recipient's socket is already open, don't wait for their next
    // reconnect/ping to backfill delivery — mark it delivered immediately
    // so the sender's checks flip to gray double-check right away.
    if (await isSnapUserOnline(req.params.userId)) {
      msg.deliveredAt = new Date();
      await msg.save();
    }
    const out = { ...msg.toObject(), mediaUrl: mediaUrl(req, mediaFile), status: snapMsgStatus(msg) };
        broadcastToUser(req.params.userId, { type: 'snapsa_dm', message: msg.burn ? { ...out, text: '', mediaFile: '', mediaUrl: null } : out });
    if (!msg.deliveredAt) {
      snapActorName(req.userId).then(name => sendPushToUser(req.params.userId, {
                title: `@${name} sent you a message`,
        body: msg.burn ? '🔥 Sent you a burn-after-read message' : type === 'text' ? `"${(req.body.text || '').slice(0, 100)}"` : ({ image: 'Sent you a photo', video: 'Sent you a video', audio: 'Sent you a voice message', voice: 'Sent you a voice message' }[type] || `Sent you a ${type}`),
        data: { type: 'new_message', chatId, senderId: req.userId },
      })).catch(() => {});
    }
    res.json({ success: true, message: out });
  } catch (error) {
    cleanupTempFiles(tempPath);
    console.error('[dm-send]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/messages/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid chat partner' });
    }
    const chatId = buildSnapChatId(req.userId, req.params.userId);
    
    
    
    
    await SnapsaMessage.updateMany(
      { chatId, receiverId: req.userId, deliveredAt: null },
      { deliveredAt: new Date() }
    );

    const chatState = await SnapsaChatState.findOne({ userId: req.userId, chatId }).lean();
    const msgQuery = chatState?.clearedAt ? { chatId, createdAt: { $gt: chatState.clearedAt } } : { chatId };
    // newest 200, then put back in reading order (it used to load the OLDEST 200)
    const messages = (await SnapsaMessage.find(msgQuery).sort({ createdAt: -1 }).limit(200).lean()).reverse();
    
    const visible = messages.filter(m => !(m.hideFromSender && String(m.senderId) === String(req.userId)));
    res.json({
      messages: visible.map(m => {
        const deletedForMe = (m.deletedForUserIds || []).some(id => String(id) === String(req.userId));
        const { deletedForUserIds, ...rest } = m;
        return {
          ...rest,
          deletedForMe,
          // Once deleted for everyone, don't keep serving the original content —
          // the client renders a placeholder off deletedForEveryone/deletedBy instead.
          ...(m.deletedForEveryone ? { text: '', mediaFile: '', mediaUrl: null } : { mediaUrl: mediaUrl(req, m.mediaFile) }),
          // burn after read: the receiver gets no content here — only POST …/open hands it over, once
          ...(m.burn && (m.burnedAt || String(m.receiverId) === String(req.userId)) ? { text: '', mediaFile: '', mediaUrl: null, burned: !!m.burnedAt, burnPending: !m.burnedAt } : {}),
          status: snapMsgStatus(m),
        };
      }),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});


// Burn after read: the receiver opens it ONCE. The content is handed over in this response and wiped from the server.
app.post('/snapsa/messages/message/:messageId/open', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    if (!mongoose.Types.ObjectId.isValid(req.params.messageId)) return res.status(400).json({ error: 'Invalid message' });
    const msg = await SnapsaMessage.findById(req.params.messageId);
    if (!msg || !msg.burn) return res.status(404).json({ error: 'Message not found' });
    if (String(msg.receiverId) !== String(req.userId)) return res.status(403).json({ error: 'Only the receiver can open this' });
    if (msg.burnedAt) return res.status(410).json({ error: 'This message has already been burned', burned: true });
    const payload = { type: msg.type, text: msg.text, mediaUrl: mediaUrl(req, msg.mediaFile), duration: msg.duration, fileName: msg.fileName };
    msg.burnedAt = new Date(); msg.text = ''; msg.mediaFile = '';
    if (!msg.readAt) { msg.readAt = new Date(); msg.read = true; }
    await msg.save();
    broadcastToUser(msg.senderId, { type: 'snapsa_dm_burned', messageId: String(msg._id), chatId: msg.chatId });
    res.json({ success: true, content: payload });
  } catch (e) { console.error('[dm-open]', e.message); res.status(500).json({ error: 'Could not open message' }); }
});

const MESSAGE_REACTION_EMOJIS = ['😍', '😆', '😲', '❤️', '💯', '🙏', '👍', '👎', '✌🏻', '🤷‍♂️', '😭', '😋'];

app.post('/snapsa/messages/message/:messageId/react', snapAuthRequired, async (req, res) => {
  try {
    const { emoji } = req.body;
    const msg = await SnapsaMessage.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const uid = String(req.userId);
    if (uid !== String(msg.senderId) && uid !== String(msg.receiverId)) {
      return res.status(403).json({ error: 'Not your conversation' });
    }

    const existingIdx = msg.reactions.findIndex(r => String(r.userId) === uid);
    if (emoji === null) {
      
      if (existingIdx !== -1) msg.reactions.splice(existingIdx, 1);
    } else {
      if (!MESSAGE_REACTION_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Not a supported reaction' });
      if (existingIdx !== -1) { msg.reactions[existingIdx].emoji = emoji; msg.reactions[existingIdx].reactedAt = new Date(); } 
      else msg.reactions.push({ userId: req.userId, emoji, reactedAt: new Date() });
    }
    await msg.save();

    const otherPartyId = uid === String(msg.senderId) ? msg.receiverId : msg.senderId;
    broadcastToUser(String(otherPartyId), { type: 'snapsa_dm_reaction', messageId: msg._id, reactions: msg.reactions, chatId: msg.chatId });
    if (emoji) {
      snapActorName(uid).then(n => sendPushToUser(otherPartyId, {
        title: `${n} reacted ${emoji}`, body: 'to your message',
        data: { type: 'new_message', chatId: String(msg.chatId || ''), senderId: uid },
      })).catch(() => {});
    }

    res.json({ success: true, reactions: msg.reactions });
  } catch (error) {
    console.error('[messages/react]', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/snapsa/messages/message/:messageId', snapAuthRequired, async (req, res) => {
  try {
    const msg = await SnapsaMessage.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const uid = String(req.userId);
    if (uid !== String(msg.senderId) && uid !== String(msg.receiverId)) {
      return res.status(403).json({ error: 'Not your message' });
    }
    const scope = req.query.scope === 'everyone' ? 'everyone' : 'me';
    if (scope === 'everyone') {
      if (uid !== String(msg.senderId)) {
        return res.status(403).json({ error: 'Only the sender can delete a message for everyone' });
      }
      msg.deletedForEveryone = true;
      msg.deletedBy = req.userId;
      await msg.save();
      const otherPartyId = uid === String(msg.senderId) ? msg.receiverId : msg.senderId;
      broadcastToUser(String(otherPartyId), { type: 'snapsa_dm_deleted', messageId: msg._id, chatId: msg.chatId, deletedBy: req.userId });
    } else {
      const already = (msg.deletedForUserIds || []).map(String);
      if (!already.includes(uid)) {
        msg.deletedForUserIds = [...(msg.deletedForUserIds || []), req.userId];
        await msg.save();
      }
    }
    res.json({ success: true, scope });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/messages/:userId/read', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid chat partner' });
    }
    const chatId = buildSnapChatId(req.userId, req.params.userId);
    const now = new Date();
    await SnapsaMessage.updateMany(
      { chatId, receiverId: req.userId, readAt: null },
      { readAt: now, deliveredAt: now, read: true }
    );
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/messages/:id/listened', snapAuth, async (req, res) => {
  try {
    if (!req.userId || !mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message' });
    const now = new Date();
    const m = await SnapsaMessage.findOneAndUpdate(
      { _id: req.params.id, receiverId: req.userId, type: 'voice', listenedAt: null },
      { $set: { listenedAt: now, deliveredAt: now, readAt: now, read: true } }, { new: true }).lean();
    if (m) pushToSnapUser(m.senderId, { type: 'message_listened', messageId: String(m._id), chatId: m.chatId, listenedAt: now });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const SNAPSA_COMMITMENT_PATTERN = /^(0x)?[0-9a-fA-F]{64,}$/;
const SNAPSA_NULLIFIER_PATTERN  = /^[0-9a-fA-F]{64}$/;

const snapsaZkUnavailable = (res, reason = 'Snapsa native sign-in is not configured on this server yet') =>
  res.status(503).json({ error: reason });

app.post('/snapsa/auth/signup', async (req, res) => {
  if (!snapsaIdentityVerifier) return snapsaZkUnavailable(res, 'Sign-up is not configured on this server yet — the ZK identity verifier failed to load. Contact support.');
  try {
    const {
      username, bio, avatarDataUrl,
      encryptedIdentity, identitySalt, identityIv, zkCommitment, setupProof,
      circuitVersion, displayNameEncrypted, displayNameIv, avatarEncrypted, avatarIv,
    } = req.body || {};

    if (!zkCommitment || !encryptedIdentity || !identitySalt || !identityIv || !setupProof) {
      return res.status(400).json({ error: 'Incomplete identity payload' });
    }
    if (!SNAPSA_COMMITMENT_PATTERN.test(zkCommitment)) {
      return res.status(400).json({ error: 'Invalid commitment format' });
    }
    const cleanUsername = String(username || '').toLowerCase().trim();
    if (!/^[a-z0-9_.]{3,30}$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (a-z, 0-9, _, .)' });
    }
    if (config.reservedUsernames.has(cleanUsername)) {
      return res.status(400).json({ error: 'Username reserved' });
    }
    
    
    const cleanProof = String(setupProof).replace(/^0x/, '').trim();
    const cleanCommitment = String(zkCommitment).replace(/^0x/, '').trim();
    let isIdentityValid = false;
    try {
      isIdentityValid = snapsaIdentityVerifier.verify_identity(cleanProof, cleanCommitment);
    } catch (zkErr) {
      console.error('[snapsa/auth/signup] ZK engine error:', zkErr.message);
      return res.status(401).json({ error: 'Identity proof verification failed' });
    }
    if (!isIdentityValid) {
      return res.status(401).json({ error: 'Identity proof verification failed' });
    }

    const existingCommitment = await SnapsaIdentity.findOne({ zkCommitment: cleanCommitment }).lean();
    if (existingCommitment) return res.status(409).json({ error: 'This seed is already registered' });

    const existingUsername = await SnapsaProfile.findOne({ username: cleanUsername }).lean();
    if (existingUsername) return res.status(409).json({ error: 'Username taken' });

    
    
    
    
    let avatarUrl = null, avatarPublicId = null;
    if (avatarDataUrl && String(avatarDataUrl).startsWith('data:image')) {
      try {
        const uploaded = await uploadBase64ToCloudinary(avatarDataUrl, { resourceType: 'image', folder: 'snapsa/avatars' });
        avatarUrl = uploaded.secure_url;
        avatarPublicId = uploaded.public_id;
      } catch (e) { console.error('[auth/signup] avatar upload failed', e); }
    }

    
    const identity = await SnapsaIdentity.create({
      zkCommitment: cleanCommitment, encryptedIdentity, identitySalt, identityIv, setupProof,
      circuitVersion: circuitVersion || '1.0-ZT',
      displayNameEncrypted: displayNameEncrypted || null, displayNameIv: displayNameIv || null,
      avatarEncrypted: avatarEncrypted || null, avatarIv: avatarIv || null,
    });

    const profile = await SnapsaProfile.create({
      userId: identity._id,
      username: cleanUsername,
      bio: (bio || '').slice(0, 150),
      avatarUrl, avatarPublicId,
    });

    const token = jwt.sign({ userId: identity._id.toString(), identityType: 'snapsa' }, config.jwtSecret, { expiresIn: '30d' });
    
    notifyAllAdmins({
      senderId: identity._id, type: 'report_update',
      title: '🎉 New Snapsa member', body: `@${profile.username} just joined`,
      data: { kind: 'new_signup', userId: String(identity._id) },
    });
    res.status(201).json({
      success: true,
      token,

      user: {
        _id: identity._id.toString(),
        username: profile.username,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        identityType: 'snapsa',
        tier: '', snapsaTier: '',
      },
    });
  } catch (error) {
    console.error('[snapsa/auth/signup]', error);
    res.status(500).json({ error: error.message || 'Signup failed' });
  }
});

app.post('/snapsa/auth/challenge', async (req, res) => {
  if (!config.zkChallengeSecret) return snapsaZkUnavailable(res, 'Sign-in is not configured on this server yet — the ZK challenge secret is missing. Contact support.');
  try {
    const { commitment } = req.body || {};
    if (!commitment) return res.status(400).json({ error: 'commitment required' });
    if (!SNAPSA_COMMITMENT_PATTERN.test(commitment)) {
      return res.status(400).json({ error: 'Invalid commitment format' });
    }

    const normalizedCommitment = commitment.toLowerCase().startsWith('0x') ? commitment.toLowerCase() : '0x' + commitment.toLowerCase();
    const domain = crypto.randomBytes(32).toString('hex');
    const epoch = Date.now() + 5 * 60 * 1000; 

    const challengePayload = `${normalizedCommitment}:${domain}:${epoch}`;
    const challenge = crypto.createHmac('sha256', config.zkChallengeSecret).update(challengePayload).digest('hex');

    res.json({ challenge, domain, epoch, commitment: normalizedCommitment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/auth/verify', async (req, res) => {
  if (!snapsaLoginVerifier || !config.zkChallengeSecret) {
    return snapsaZkUnavailable(res, !snapsaLoginVerifier
      ? 'Sign-in is not configured on this server yet — the ZK login verifier failed to load. Contact support.'
      : 'Sign-in is not configured on this server yet — the ZK challenge secret is missing. Contact support.');
  }
  try {
    const { commitment, challenge, domain, epoch, loginProof, nullifier } = req.body || {};
    if (!commitment || !challenge || !domain || !epoch || !loginProof || !nullifier) {
      return res.status(400).json({ error: 'Incomplete verification payload' });
    }
    if (!SNAPSA_COMMITMENT_PATTERN.test(commitment) || !SNAPSA_NULLIFIER_PATTERN.test(nullifier)) {
      return res.status(400).json({ error: 'Malformed verification payload' });
    }

    const normalizedCommitment = commitment.toLowerCase().startsWith('0x') ? commitment.toLowerCase() : '0x' + commitment.toLowerCase();

    
    const expectedPayload = `${normalizedCommitment}:${domain}:${epoch}`;
    const expectedChallenge = crypto.createHmac('sha256', config.zkChallengeSecret).update(expectedPayload).digest('hex');
    const challengeValid = challenge.length === expectedChallenge.length
      && crypto.timingSafeEqual(Buffer.from(challenge, 'hex'), Buffer.from(expectedChallenge, 'hex'));
    if (!challengeValid) return res.status(401).json({ error: 'Challenge mismatch' });
    if (Date.now() > parseInt(epoch)) return res.status(401).json({ error: 'Challenge expired — try again' });

    
    
    
    const nullifierKey = nullifier.toLowerCase();
    try {
      await SnapsaNullifier.create({ nullifier: nullifierKey, expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
    } catch (err) {
      if (err.code === 11000) return res.status(401).json({ error: 'This login attempt was already used' });
      throw err;
    }

    const identity = await SnapsaIdentity.findOne({ zkCommitment: normalizedCommitment.replace(/^0x/, '') });
    if (!identity) {
      return res.status(401).json({ error: 'No Snapsa identity found for this seed. Sign up first.' });
    }

    // ── Real ZK login proof verification ──
    let isValid = false;
    try {
      isValid = snapsaLoginVerifier.verify(loginProof, identity.zkCommitment, nullifierKey, domain, BigInt(epoch));
    } catch (zkErr) {
      console.error('[snapsa/auth/verify] ZK engine error:', zkErr.message);
      return res.status(401).json({ error: 'Proof verification failed' });
    }
    if (!isValid) return res.status(401).json({ error: 'Proof verification failed' });

    const profile = await SnapsaProfile.findOne({ userId: identity._id }).lean();
    const token = jwt.sign({ userId: identity._id.toString(), identityType: 'snapsa' }, config.jwtSecret, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      userId: identity._id.toString(),
      user: {
        _id: identity._id.toString(),
        username: profile?.username || '',
        bio: profile?.bio || '',
        avatarUrl: profile?.avatarUrl || null,
        identityType: 'snapsa',
        tier: '', snapsaTier: profile?.snapsaTier || '',
      },
      identity: {
        encryptedIdentity: identity.encryptedIdentity,
        identityIv: identity.identityIv,
        identitySalt: identity.identitySalt,
        setupProof: identity.setupProof,
        circuitVersion: identity.circuitVersion,
      },
    });
  } catch (error) {
    console.error('[snapsa/auth/verify]', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Profile Routes
// ============================================================================

app.get('/snapsa/me', snapAuth, async (req, res) => {
  try {
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    res.json({ profile: profile || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/me', snapAuthRequired, async (req, res) => {
  try {
    const { username, bio } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    if (config.reservedUsernames.has(username.toLowerCase())) {
      return res.status(400).json({ error: 'Username reserved' });
    }

    const conflict = await SnapsaProfile.findOne({
      username: username.toLowerCase(),
      userId: { $ne: req.userId }
    });
    if (conflict) return res.status(409).json({ error: 'Username taken' });

    const profile = await SnapsaProfile.findOneAndUpdate(
      { userId: req.userId },
      { username: username.toLowerCase(), bio: bio || '', updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/snapsa/me/name', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const displayName = String(req.body.displayName || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
    const r = await SnapsaProfile.updateOne({ userId: req.userId }, { $set: { displayName } });
    if (!r.matchedCount) return res.status(400).json({ error: 'Set a username first' });
    res.json({ success: true, displayName });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/username/check', snapAuth, async (req, res) => {
  try {
    const { username } = req.query;
    if (!username || username.length < 3) {
      return res.json({ available: false, reason: 'Too short (min 3 chars)' });
    }
    if (!/^[a-z0-9_.]+$/.test(username)) {
      return res.json({ available: false, reason: 'Only a-z 0-9 _ . allowed' });
    }
    if (config.reservedUsernames.has(username.toLowerCase())) {
      return res.json({ available: false, reason: 'Reserved username' });
    }

    const existing = await SnapsaProfile.findOne({ username: username.toLowerCase() });
    res.json({ available: !existing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/privacy', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const p = profile?.privacy || {};
    res.json({
      private:       p.privateAccount ?? false,
      hideLiked:      p.hideLikedVideos ?? false,
      hideFollowing:  p.hideFollowingList ?? false,
      activity:       p.showActivityStatus ?? true,
      contentFilter:  p.contentFilter ?? true,
      dms:            p.dmSetting ?? 'everyone',
      comments:       p.commentSetting ?? 'everyone',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/privacy', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { private: privateAccount, hideLiked, hideFollowing, activity, contentFilter, dms, comments } = req.body;

    const profile = await SnapsaProfile.findOneAndUpdate(
      { userId: req.userId },
      {
        $set: {
          'privacy.privateAccount':     !!privateAccount,
          'privacy.hideLikedVideos':    !!hideLiked,
          'privacy.hideFollowingList':  !!hideFollowing,
          'privacy.showActivityStatus': !!activity,
          'privacy.contentFilter':      !!contentFilter,
          'privacy.dmSetting':          ['everyone', 'followers', 'nobody'].includes(dms) ? dms : 'everyone',
          'privacy.commentSetting':     ['everyone', 'followers', 'nobody'].includes(comments) ? comments : 'everyone',
        },
      },
      { new: true }
    );

        if (!profile) return res.status(400).json({ error: 'Create a Snapsa username first' });
    _privateIdsCache.ts = 0; // take effect immediately
    if (!privateAccount) await approveAllPendingFollowRequests(req.userId); // going public approves waiting requests
    res.json({ success: true, privacy: profile.privacy });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/snapsa/privacy/in-circle', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const enabled = !!req.body.enabled;
    const r = await SnapsaProfile.updateOne({ userId: req.userId }, { $set: { 'privacy.inCircle': enabled } });
    if (!r.matchedCount) return res.status(400).json({ error: 'Create a Snapsa username first' });
    res.json({ success: true, inCircle: enabled });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/videos/upload', snapAuthRequired, uploadLimiter, upload.single('video'), async (req, res) => {
  let session = null;
  let tempVideoPath = null, tempThumbPath = null, tempWmarkPath = null, tempOverlayPath = null;
  let overlayHasDisc = false;


  try {
    if (!req.file) return res.status(400).json({ error: 'No video file' });

    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    let authorName = profile?.username || req.body.authorName;
    if (!authorName || authorName === 'unknown') {
      const userDoc = await User.findById(req.userId).lean();
      const first = userDoc?.firstName || userDoc?.displayName?.split(' ')[0] || '';
      const last = userDoc?.lastName || userDoc?.displayName?.split(' ').slice(1).join(' ') || '';
      authorName = profile?.username || (first ? `${first}${last ? '_'+last.split(' ')[0] : ''}`.toLowerCase().replace(/[^a-z0-9_]/g, '') : null) || req.body.authorName || 'snapsa_user';
    }

    const tempDir = path.join(config.uploadDir, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });

    const ext = path.extname(req.file.originalname) || '.mp4';
    const uid = uuidv4();
    tempVideoPath = path.join(tempDir, `${uid}_orig${ext}`);
    tempThumbPath = path.join(tempDir, `${uid}_thumb.jpg`);
    tempWmarkPath = path.join(tempDir, `${uid}_wmark.mp4`);

    
        fs.writeFileSync(tempVideoPath, req.file.buffer);

    // Watermark picture drawn by the app (logo + 👤 username) — see watermarkWithOverlay.
    try {
      const b64 = String(req.body.wmOverlay || '');
      if (b64 && b64.length < 900000) {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
          tempOverlayPath = path.join(tempDir, `${uid}_wm.png`);
          fs.writeFileSync(tempOverlayPath, buf);
          try { overlayHasDisc = buf.length > 24 && buf.readUInt32BE(16) === 728; } catch {}

        }
      }
    } catch { tempOverlayPath = null; }

    const [, wmarkResult] = await Promise.all([
      extractVideoFrame(tempVideoPath, tempThumbPath).then(async (framePath) => {
        if (!framePath) await makeThumb(tempThumbPath, authorName);
      }),
      watermarkVideo(tempVideoPath, tempWmarkPath, authorName, '', { overlayPath: tempOverlayPath, overlayHasDisc })
    ]);
    if (wmarkResult && wmarkResult.watermarked === false) {
      console.warn(`[upload] Video ${uid} was stored WITHOUT a watermark/end-screen — ffmpeg fell back to a raw copy. Check the FFmpeg startup log above.`);
    }

    
    const [videoUpload, wmarkUpload, thumbUpload] = await Promise.all([
      uploadToCloudinary(tempVideoPath, { resourceType: 'video', folder: 'snapsa/videos' }),
      fs.existsSync(tempWmarkPath)
        ? uploadToCloudinary(tempWmarkPath, { resourceType: 'video', folder: 'snapsa/watermarked' })
        : Promise.resolve(null),
      fs.existsSync(tempThumbPath)
        ? uploadToCloudinary(tempThumbPath, { resourceType: 'image', folder: 'snapsa/thumbs' })
        : Promise.resolve(null),
    ]);

    cleanupTempFiles(tempVideoPath, tempWmarkPath, tempThumbPath, tempOverlayPath);

    const videoUrl = videoUpload.secure_url;
    const wmarkUrl = wmarkUpload?.secure_url || videoUrl;
    const thumbUrl = thumbUpload?.secure_url || null;

    session = await mongoose.startSession();
    session.startTransaction();

    const [post] = await Post.create([{
      authorId: req.userId,
      authorSnapshot: { fullName: authorName, identityPic: null, verified: false, badge: null, tier: null },
      content: req.body.caption || '',
      video: videoUrl,
      videoPublicId: videoUpload.public_id,
      location: req.body.location || '',
      feeling: req.body.feeling || '',
      isActive: true,
      zkVerified: false
    }], { session });

    const [snapsaVideo] = await SnapsaVideo.create([{
      postId: post._id,
      authorId: req.userId,
      authorName,
      videoFile: videoUrl,
      watermarkedFile: wmarkUrl,
      thumbFile: thumbUrl,
      song: req.body.song || '',
      songId: (req.body.songId && req.body.songId !== 'null') ? req.body.songId : null,
      topText: req.body.topText || '',
      textPosX: req.body.textPosX != null ? Number(req.body.textPosX) : 50,
      textPosY: req.body.textPosY != null ? Number(req.body.textPosY) : 12,
      textStyle: String(req.body.textStyle || '').slice(0, 300),
      soundCover: (typeof req.body.soundCover === 'string' && /^data:image\/(jpeg|png);base64,/.test(req.body.soundCover) && req.body.soundCover.length < 60000) ? req.body.soundCover : '',
      beautyFilter: req.body.beautyFilter || '',
      series: req.body.series || '',
      privacy: { allowDownload: req.body.allowDownload !== 'false' },
      brandFilter: req.body.brandFilter || '',
      snapInOf: (req.body.snapInOf && mongoose.Types.ObjectId.isValid(req.body.snapInOf)) ? req.body.snapInOf : null,
      snapInBubble: req.body.snapInBubble ? (() => { try { return JSON.parse(req.body.snapInBubble); } catch { return undefined; } })() : undefined,
    }], { session });

    if (snapsaVideo.songId) {
      SnapsaSound.findByIdAndUpdate(snapsaVideo.songId, { $inc: { uses: 1 } }).catch(() => {});
    }
    if (snapsaVideo.snapInOf) {
      SnapsaVideo.findByIdAndUpdate(snapsaVideo.snapInOf, { $inc: { repostCount: 1 } }).catch(() => {});
    }

    await session.commitTransaction();
    (async () => {
      try {
        const fl = await Follower.find({ followingId: req.userId }).select('followerId').limit(500).lean();
        for (const f of fl) {
          sendPushToUser(f.followerId, {
            title: `${authorName} posted a new video 🎬`, body: post.content ? String(post.content).slice(0, 80) : 'Tap to watch',
            data: { type: 'new_video', videoId: String(snapsaVideo._id || ''), authorId: String(req.userId) },
          });
        }
        if (snapsaVideo.snapInOf) {
          const orig = await SnapsaVideo.findById(snapsaVideo.snapInOf).select('authorId').lean();
          if (orig && String(orig.authorId) !== String(req.userId)) {
            createSnapNotification({
              recipientId: orig.authorId, senderId: req.userId, type: 'story_repost',
              title: `${authorName} snapped in on your video`, body: '', data: { videoId: String(snapsaVideo._id || '') },
            }).catch(() => {});
          }
        }
      } catch (e) { console.error('[upload notify]', e.message); }
    })();

    notifyAllAdmins({
      senderId: req.userId, type: 'report_update',
      title: '🎬 New video', body: `@${authorName}${post.content ? ': ' + String(post.content).slice(0, 60) : ''}`,
      data: { kind: 'new_video', videoId: String(snapsaVideo._id || '') },
    }, req.userId);

      res.json({
      success: true,
      watermarkApplied: !!(wmarkResult && wmarkResult.watermarked),
      video: {
        id: post._id,
        postId: post._id,
        authorId: req.userId,
        authorName,
        caption: post.content,
        song: snapsaVideo.song,
        series: snapsaVideo.series,
        videoUrl,
        watermarkedUrl: wmarkUrl,
        thumbUrl,
        likes: 0, comments: 0, shares: 0,
        isLive: false, watermark: true,
        snapInOf: snapsaVideo.snapInOf || null,
        snapInBubble: snapsaVideo.snapInBubble,
        createdAt: post.createdAt
      }
    });
  } catch (error) {
    if (session && session.inTransaction()) await session.abortTransaction();
    cleanupTempFiles(tempVideoPath, tempWmarkPath, tempThumbPath, tempOverlayPath);
    console.error('[upload]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

app.post('/snapsa/videos/:id/view', snapAuth, async (req, res) => {
  try {
    const video = await SnapsaVideo.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    );
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json({ views: video.views });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/videos/feed', snapAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '100'));
    
    
    const skip = Number.isFinite(parseInt(req.query.skip)) ? Math.max(0, parseInt(req.query.skip)) : (page - 1) * limit;
    const sort = req.query.sort || 'random';
    
    
    const seed = Number.isFinite(parseFloat(req.query.seed)) ? parseFloat(req.query.seed) : Math.random();

    // Never show videos from people who've blocked this viewer, or from
    // accounts this viewer chose to hide.
    let excludedAuthors = [];
    if (req.userId && mongoose.Types.ObjectId.isValid(req.userId)) {
      const [blockers, hidden] = await Promise.all([getBlockerIds(req.userId), getHiddenIds(req.userId)]);
      excludedAuthors = [...blockers, ...hidden];
    }
    excludedAuthors = [...excludedAuthors, ...restrictedIds, ...(await hiddenPrivateAuthorIds(req.userId))];

    // PERF: filter + sort on the video's own fields FIRST. MongoDB pulls stages lazily, so the
    // posts join below now runs only for the few videos actually returned, not for every video.
    const pipeline = [
      { $match: {
          authorId: { $nin: excludedAuthors },
          $or: [
            { 'privacy.visibility': { $ne: 'private' } },
            { authorId: new mongoose.Types.ObjectId(req.userId) },
          ],
        }
      }
    ];
    const _postJoin = [
      { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
      { $unwind: { path: '$post', preserveNullAndEmptyArrays: false } },
      { $match: { 'post.isActive': true } },
    ];

    if (sort === 'random') {
      
      pipeline.push(
        { $addFields: {
          _feedRandomJitter: {
            $let: {
              vars: { mixed: { $add: [ { $multiply: ['$feedRandom', 999331] }, seed * 104729 ] } },
              in: { $subtract: ['$$mixed', { $floor: '$$mixed' }] }
            }
          },
        } },
        { $sort: { _feedRandomJitter: -1 } },
        ..._postJoin
      );
    } else if (sort === 'viral') {
      pipeline.push(
        ..._postJoin,
        {
          $addFields: {
            viralScore: {
              $add: [
                { $multiply: [{ $ifNull: ['$views', 0] }, 1] },
                { $multiply: [{ $ifNull: ['$post.likeCount', 0] }, 2] },
                { $multiply: [{ $ifNull: ['$post.shareCount', 0] }, 3] },
                { $multiply: [{ $ifNull: ['$post.commentCount', 0] }, 1.5] },
                { $multiply: [{ $ifNull: ['$giftScore', 0] }, 8] },
                {
                  $multiply: [
                    { $subtract: [1, { $min: [1, { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 604800000] }] }] },
                    100
                  ]
                }
              ]
            }
          }
        },
        { $sort: { viralScore: -1 } }
      );
    } else {
      pipeline.push({ $sort: { createdAt: -1 } }, ..._postJoin);
    }

    pipeline.push(
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'snapsa_profiles',
          localField: 'authorId',
          foreignField: 'userId',
          as: 'profile'
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'authorId',
          foreignField: '_id',
          as: 'userDoc'
        }
      },
      {
        $lookup: {
          from: 'snapsa_sounds',
          localField: 'songId',
          foreignField: '_id',
          as: 'soundDoc'
        }
      },
      {
        $lookup: {
          from: 'snapsa_profiles',
          localField: 'soundDoc.uploaderId',
          foreignField: 'userId',
          as: 'soundOwnerProfile'
        }
      },
      {
        $lookup: {
          from: 'snapsa_videos',
          localField: 'snapInOf',
          foreignField: '_id',
          as: 'snapInSourceDoc'
        }
      },
      {
        $project: {
          _id: 0,
          id: '$_id',
          postId: '$postId',
          authorId: '$authorId',
          authorName: {
            $cond: {
              if: { $and: [
                { $ne: [{ $arrayElemAt: ['$profile.username', 0] }, null] },
                { $ne: [{ $arrayElemAt: ['$profile.username', 0] }, ''] },
              ]},
              then: { $arrayElemAt: ['$profile.username', 0] },
              else: {
                $cond: {
                  if: { $and: [{ $ne: ['$authorName', null] }, { $ne: ['$authorName', 'unknown'] }] },
                  then: '$authorName',
                  else: 'snapsa_user'
                }
              }
            }
          },
          authorTier: { $ifNull: [{ $arrayElemAt: ['$userDoc.tier', 0] }, ''] },
          // Snapsa's own subscription/gifting tier lives on the Snapsa profile, not the shared User doc
          authorSnapsaTier: { $ifNull: [{ $arrayElemAt: ['$profile.snapsaTier', 0] }, ''] }, authorDisplayName: { $ifNull: [{ $arrayElemAt: ['$profile.displayName', 0] }, ''] },
          allowDownload: { $ifNull: ['$privacy.allowDownload', true] },
          authorVerified: { $ifNull: [{ $arrayElemAt: ['$userDoc.zkVerified', 0] }, false] },
          caption: '$post.content',
          song: '$song',
          songId: '$songId',
          soundOwnerName: { $ifNull: [{ $arrayElemAt: ['$soundOwnerProfile.username', 0] }, '$authorName'] },
          soundUsageCount: { $ifNull: [{ $arrayElemAt: ['$soundDoc.uses', 0] }, 0] },
          series: '$series',
          
          
          videoUrl: '$videoFile',
          originalVideoUrl: '$videoFile',
          watermarkedUrl: '$watermarkedFile',
          thumbUrl: '$thumbFile',
          topText: { $ifNull: ['$topText', ''] },
          textPosX: { $ifNull: ['$textPosX', 50] },
          textPosY: { $ifNull: ['$textPosY', 12] },
          textStyle: { $ifNull: ['$textStyle', ''] },
          soundCover: { $ifNull: ['$soundCover', ''] },

          likes: { $ifNull: ['$post.likeCount', 0] },
          comments: { $ifNull: ['$post.commentCount', 0] },
          shares: { $ifNull: ['$post.shareCount', 0] },
          views: { $ifNull: ['$views', 0] },
          giftScore: { $ifNull: ['$giftScore', 0] },
          gifters: { $ifNull: ['$gifters', []] },
          authorAvatarUrl: { $ifNull: [{ $arrayElemAt: ['$profile.avatarUrl', 0] }, null] },
          isLive: '$isLive',
          watermark: { $literal: true },
          createdAt: '$createdAt',
          snapInOf: { $ifNull: ['$snapInOf', null] },
          snapInBubble: { $ifNull: ['$snapInBubble', null] },
          featuredProducts: { $ifNull: ['$featuredProducts', []] },
          snapInSource: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$snapInSourceDoc', []] } }, 0] },
              {
                $let: {
                  vars: { src: { $arrayElemAt: ['$snapInSourceDoc', 0] } },
                  in: {
                    id: '$$src._id',
                    videoUrl: '$$src.videoFile',
                    thumbUrl: '$$src.thumbFile',
                    authorName: '$$src.authorName',
                  }
                }
              },
              null
            ]
          },
        }
      }
    );

    const videos = await SnapsaVideo.aggregate(pipeline).allowDiskUse(true);
    await enrichVideoCounts(videos, req.userId);
    for (const v of videos) {
      v.topGifters = topGiftersOf(v.gifters);
      delete v.gifters;
    }
    
    
    if (req.userId && videos.length) {
      const postIds = videos.map(v => v.postId).filter(Boolean);
      const videoIds = videos.map(v => v.id).filter(Boolean);
      const [likedPostIds, savedVideoIds] = await Promise.all([
        Like.find({ userId: req.userId, postId: { $in: postIds } }).select('postId').lean(),
        SnapsaSavedVideo.find({ userId: req.userId, videoId: { $in: videoIds } }).select('videoId').lean(),
      ]);
      const likedSet = new Set(likedPostIds.map(l => String(l.postId)));
      const savedSet = new Set(savedVideoIds.map(s => String(s.videoId)));
      for (const v of videos) {
        v.isLiked = likedSet.has(String(v.postId));
        v.isSaved = savedSet.has(String(v.id));
      }
    }

    const totalAgg = await SnapsaVideo.aggregate([
      { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
      { $unwind: { path: '$post', preserveNullAndEmptyArrays: false } },
      { $match: { 'post.isActive': true, authorId: { $nin: restrictedIds } } },
      { $count: 'n' }
    ]);
    const total = totalAgg[0]?.n ?? 0;

    res.json({ videos, total, page, limit, sort, seed });
  } catch (error) {
    console.error('[feed]', error);
    res.status(500).json({ error: error.message });
  }
});     
  
app.patch('/snapsa/videos/:id/privacy', snapAuthRequired, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id);
    if (!sv) return res.status(404).json({ error: 'Not found' });
    if (String(sv.authorId) !== String(req.userId)) return res.status(403).json({ error: 'Not your video' });
    const nextPrivacy = { ...(sv.privacy || {}) };
    if (req.body.visibility !== undefined) nextPrivacy.visibility = req.body.visibility === 'private' ? 'private' : 'public';
    if (req.body.allowDownload !== undefined) nextPrivacy.allowDownload = !!req.body.allowDownload;
    sv.privacy = nextPrivacy;
    sv.markModified('privacy');
    await sv.save();
    res.json({ success: true, visibility: nextPrivacy.visibility || 'public', allowDownload: nextPrivacy.allowDownload !== false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/snapsa/videos/:id', snapAuthRequired, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id);
    if (!sv) return res.status(404).json({ error: 'Not found' });
    if (String(sv.authorId) !== String(req.userId)) return res.status(403).json({ error: 'Not your video' });
    
    
    
    await Post.findByIdAndUpdate(sv.postId, { isActive: false });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/videos/:id', snapAuth, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });
    if (req.userId && String(sv.authorId) !== String(req.userId) && await isBlockedBy(sv.authorId, req.userId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (restrictedIds.some(id => String(id) === String(sv.authorId)) && String(sv.authorId) !== String(req.userId)) {
      return res.status(404).json({ error: 'Not found' });
    }
        if (String(sv.authorId) !== String(req.userId)) {
      if (sv.privacy?.visibility === 'private') return res.status(404).json({ error: 'Not found' });
      if (!(await canViewAccountContent(req.userId, sv.authorId))) return res.status(404).json({ error: 'Not found' });
    }
    const post = await Post.findById(sv.postId).lean();
    if (!post || !post.isActive) return res.status(404).json({ error: 'Not found' });
    res.json({
      ...sv,
      caption: post.content,
      likes: post.likeCount,
      comments: post.commentCount,
      shares: post.shareCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/videos/:id/like', snapAuthRequired, async (req, res) => {
  let session = null;

  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });

    session = await mongoose.startSession();
    session.startTransaction();

    const existing = await Like.findOne({ postId: sv.postId, userId: req.userId }).session(session);

    if (existing) {
      await Like.deleteOne({ _id: existing._id }).session(session);
      await Post.findByIdAndUpdate(sv.postId, { $inc: { likeCount: -1 } }, { session });
      await session.commitTransaction();
      return res.json({ liked: false, likes: Math.max(0, (await Post.findById(sv.postId).lean())?.likeCount ?? 0), videoId: req.params.id });
    }

    await Like.create([{ postId: sv.postId, userId: req.userId }], { session });
    const updated = await Post.findByIdAndUpdate(
      sv.postId,
      { $inc: { likeCount: 1 } },
      { new: true, session }
    ).lean();

    await session.commitTransaction();

    if (sv.authorId.toString() !== req.userId.toString()) {
      const likerName = await snapActorName(req.userId);
      createSnapNotification({
        recipientId: sv.authorId,
        senderId: req.userId,
        type: 'like',
        title: `@${likerName} liked your video`,
        body: '',
        data: { postId: sv.postId, videoId: sv._id, authorId: req.userId, thumbUrl: sv.thumbFile || null },
        priority: 'medium',
        expiresAt: new Date(Date.now() + 30 * 86400000)
      }).catch(() => { });
    }

    res.json({ liked: true, likes: updated?.likeCount ?? 0, videoId: req.params.id });
  } catch (error) {
    if (session && session.inTransaction()) await session.abortTransaction();
    console.error('[like]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

app.post('/snapsa/videos/:id/save', snapAuthRequired, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });

    const existing = await SnapsaSavedVideo.findOne({ userId: req.userId, videoId: sv._id });
    if (existing) {
      await SnapsaSavedVideo.deleteOne({ _id: existing._id });
      return res.json({ saved: false, videoId: req.params.id });
    }

    try {
      await SnapsaSavedVideo.create({ userId: req.userId, videoId: sv._id });
    } catch (err) {
      
      if (err.code !== 11000) throw err;
    }
        if (String(sv.authorId) !== String(req.userId)) {
      snapActorName(req.userId).then(n => sendPushToUser(sv.authorId, {
        title: `${n} saved your video`, body: '', data: { type: 'save', videoId: String(sv._id) },
      })).catch(() => {});
    }
    res.json({ saved: true, videoId: req.params.id });

  } catch (error) {
    console.error('[save]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/videos/saved/mine', snapAuthRequired, async (req, res) => {
  try {
    const saves = await SnapsaSavedVideo.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();
    const videoIds = saves.map(s => s.videoId);
    const videos = await snapVideoTilesByIds(videoIds, req.userId);
    
    const byId = new Map(videos.map(v => [String(v.id), v]));
    const ordered = videoIds.map(id => byId.get(String(id))).filter(Boolean);
    res.json({ videos: ordered });
  } catch (error) {
    console.error('[saved/mine]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/videos/liked/mine', snapAuthRequired, async (req, res) => {
  try {
    const likes = await Like.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();
    const postIds = likes.map(l => l.postId);
    const svs = await SnapsaVideo.find({ postId: { $in: postIds } }).select('_id postId').lean();
    const videoIds = svs.map(v => v._id);
    const videos = await snapVideoTilesByIds(videoIds, req.userId);
    const byPostId = new Map(svs.map(v => [String(v.postId), String(v._id)]));
    const byVideoId = new Map(videos.map(v => [String(v.id), v]));
    const ordered = postIds
      .map(pid => byVideoId.get(byPostId.get(String(pid))))
      .filter(Boolean);
    res.json({ videos: ordered });
  } catch (error) {
    console.error('[liked/mine]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/videos/:id/likers', snapAuth, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });

    const limit = Math.min(100, parseInt(req.query.limit || '50'));
    const likes = await Like.find({ postId: sv.postId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'firstName lastName displayName tier')
      .lean();

    const userIds = [...new Set(likes.map(l => l.userId?._id?.toString()).filter(Boolean))];
    const profiles = userIds.length
      ? await SnapsaProfile.find( { userId: { $in: userIds } }, 'userId username avatarUrl snapsaTier privacy.hideLikedVideos').lean()
      : [];
    const profileMap = {};
    for (const p of profiles) profileMap[p.userId.toString()] = p;

    const likers = likes.filter(l => {       const u = l.userId?._id?.toString();       return !u || u === String(req.userId) || !profileMap[u]?.privacy?.hideLikedVideos;     }).map(l => {
      const uid = l.userId?._id?.toString();
      const profile = uid ? profileMap[uid] : null;
      const name = profile?.username
        ? `@${profile.username}`
        : (l.userId?.firstName ? `${l.userId.firstName} ${l.userId.lastName||''}`.trim() : (l.userId?.displayName || 'User'));
      return {
        userId: uid,
        name,
        avatarUrl: profile?.avatarUrl || null,
        tier: l.userId?.tier || '',
        snapsaTier: profile?.snapsaTier || '',
        likedAt: l.createdAt,
      };
    });

    res.json({ likers, count: likers.length });
  } catch (error) {
    console.error('[likers]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/videos/:id/gift', snapAuth, async (req, res) => {
  let session = null;
  let responded = false;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    
        const { giftId, giftName, giftIcon } = req.body;
    if (!(await idemClaim(req, res, 'video-gift'))) return;
    const qty = Math.max(1, parseInt(req.body.qty) || 1);
    
    
    const priceInfo = STORE_ITEM_PRICES[giftId];
    if (!priceInfo) return res.status(400).json({ error: 'Unknown gift' });

    const sv = await SnapsaVideo.findById(req.params.id);
    if (!sv) return res.status(404).json({ error: 'Video not found' });
    if (sv.authorId.toString() === req.userId.toString()) {
      return res.status(400).json({ error: "Can't gift your own video" });
    }
    
    
    const gifterName = await snapActorName(req.userId);

    session = await mongoose.startSession();
    session.startTransaction();

    
    const legacyKey = STORE_ITEM_LEGACY_KEY[giftId];
    const spender = await User.findById(req.userId).select('giftInventory').session(session).lean();
    const spenderProfile = await SnapsaProfile.findOne({ userId: req.userId }).select('inventory').session(session).lean();
    const legacyOwned = legacyKey ? (spender?.giftInventory?.[legacyKey] || 0) : 0;
    const profileOwned = spenderProfile?.inventory?.[giftId] || 0;
    const totalOwned = legacyOwned + profileOwned;
    if (totalOwned < qty) {
      throw new Error(`You only have ${totalOwned} of this gift — buy more from the Store.`);
    }
    const fromLegacy = Math.min(legacyOwned, qty);
    const fromProfile = qty - fromLegacy;
    if (fromLegacy > 0 && legacyKey) {
      await User.findByIdAndUpdate(req.userId, { $inc: { [`giftInventory.${legacyKey}`]: -fromLegacy } }, { session });
    }
    if (fromProfile > 0) {
      await SnapsaProfile.findOneAndUpdate(
        { userId: req.userId },
        { $inc: { [`inventory.${giftId}`]: -fromProfile } },
        { session, upsert: true }
      );
    }
    
    let soundOwnerId = null, soundOwnerGiftQty = 0;
    let authorGiftQty = qty;
    if (sv.songId) {
      const sound = await SnapsaSound.findById(sv.songId).session(session).lean();
      if (sound && sound.uploaderId.toString() !== sv.authorId.toString()) {
        soundOwnerId = sound.uploaderId;
        soundOwnerGiftQty = Math.floor(qty * (sound.royaltyPct ?? 0.15));
        authorGiftQty = qty - soundOwnerGiftQty;
      }
    }

    await SnapsaProfile.findOneAndUpdate(
      { userId: sv.authorId },
      { $inc: { [`inventory.${giftId}`]: authorGiftQty } },
      { session, upsert: true }
    );

    if (soundOwnerId && soundOwnerGiftQty > 0) {
      await SnapsaProfile.findOneAndUpdate(
        { userId: soundOwnerId },
        { $inc: { [`inventory.${giftId}`]: soundOwnerGiftQty } },
        { session, upsert: true }
      );
    }

    const giftWeight = priceInfo.weight * qty;
    
    
    const bumpExisting = await SnapsaVideo.updateOne(
      { _id: sv._id, 'gifters.userId': req.userId },
      { $inc: { giftScore: giftWeight, 'gifters.$.weight': giftWeight } },
      { session }
    );
    if (!bumpExisting.matchedCount) {
      await SnapsaVideo.updateOne(
        { _id: sv._id },
        {
          $inc: { giftScore: giftWeight },
          $push: { gifters: { userId: req.userId, name: gifterName, weight: giftWeight } },
        },
        { session }
      );
    }

    await session.commitTransaction();

    
    req.idemCommitted = true;     const updatedSv = await SnapsaVideo.findById(sv._id).select('gifters').lean();
    const topGifters = topGiftersOf(updatedSv?.gifters);
 
    
    responded = true;
    const giftResult = { success: true, authorGiftQty, soundOwnerGiftQty, remainingOwned: totalOwned - qty, topGifters };     await idemDone(req, giftResult);     res.json(giftResult);

    try {
      const recipientName = await snapActorName(sv.authorId);
      const giftWhen = formatGiftNotifTime();
      const giftLabel = `${qty} ${pluralizeGiftName(giftName || giftId, qty)}`;

      createSnapNotification({
        recipientId: sv.authorId, senderId: req.userId, type: 'gift_received',
                title: `${giftIcon || '🎁'} @${gifterName} sent you ${giftLabel}`,
        body: `${giftWhen.replace(' @', ' · ')} — saved in your gifts. Keep them or convert to coins.`,

        data: { videoId: sv._id, giftId, giftIcon, authorId: req.userId, thumbUrl: sv.thumbFile || null }, priority: 'high',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      }).catch(() => {});

      
      createSnapNotification({
        recipientId: req.userId, senderId: req.userId, type: 'gift_sent',
        title: `@${recipientName} ${giftIcon || '🎁'}`,
        body: `You sent ${giftLabel} · ${giftWhen}`,
        data: { videoId: sv._id, giftId, giftIcon, authorId: sv.authorId, recipientId: sv.authorId, thumbUrl: sv.thumbFile || null }, priority: 'low',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      }).catch(() => {});

      if (soundOwnerId && soundOwnerGiftQty > 0) {
        createSnapNotification({
          recipientId: soundOwnerId, senderId: req.userId, type: 'gift_received',
          title: `@${gifterName} ${giftIcon || '🎁'}`,
          body: `Sound royalty: ${soundOwnerGiftQty} × ${giftName || giftId} from a gift on a video using your sound — in your gift inventory`,
          data: { videoId: sv._id, soundId: sv.songId, thumbUrl: sv.thumbFile || null }, priority: 'medium',
          expiresAt: new Date(Date.now() + 7 * 86400000),
        }).catch(() => {});
      }
    } catch (notifyErr) {
      
      
      console.error('[video-gift] post-commit notification error (gift itself succeeded):', notifyErr);
    }
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[video-gift]', error);     await idemRelease(req);
    if (!responded) {
      res.status(500).json({ error: error.message || 'Gift failed' });
      
      
      createSnapNotification({
        recipientId: req.userId, senderId: req.userId, type: 'gift_failed',
        title: `⚠️ Your gift didn't go through`,
        body: error.message || 'Something went wrong — please try again.',
        data: { videoId: req.params.id, giftId: req.body?.giftId || null }, priority: 'high',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      }).catch(() => {});
    }
  } finally {
    if (session) await session.endSession();
  }
});

const GIFT_TO_COIN_REFUND_RATE = 0.50;
app.post('/snapsa/gifts/convert-to-coins', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { giftId, giftName } = req.body;     if (!(await idemClaim(req, res, 'gift-convert'))) return;
    const qty = Math.max(1, parseInt(req.body.qty) || 1);
    const priceInfo = STORE_ITEM_PRICES[giftId];
    if (!priceInfo) return res.status(400).json({ error: 'Unknown gift' });

    session = await mongoose.startSession();
    session.startTransaction();

    const legacyKey = STORE_ITEM_LEGACY_KEY[giftId];
    const owner = await User.findById(req.userId).select('giftInventory').session(session).lean();
    const ownerProfile = await SnapsaProfile.findOne({ userId: req.userId }).select('inventory').session(session).lean();
    const legacyOwned = legacyKey ? (owner?.giftInventory?.[legacyKey] || 0) : 0;
    const profileOwned = ownerProfile?.inventory?.[giftId] || 0;
    const totalOwned = legacyOwned + profileOwned;
    if (totalOwned < qty) {
      throw new Error(`You only have ${totalOwned} of this gift.`);
    }

    const fromLegacy = Math.min(legacyOwned, qty);
    const fromProfile = qty - fromLegacy;
    if (fromLegacy > 0 && legacyKey) {
      await User.findByIdAndUpdate(req.userId, { $inc: { [`giftInventory.${legacyKey}`]: -fromLegacy } }, { session });
    }
    if (fromProfile > 0) {
      await SnapsaProfile.findOneAndUpdate(
        { userId: req.userId },
        { $inc: { [`inventory.${giftId}`]: -fromProfile } },
        { session, upsert: true }
      );
    }

    const coinsBack = Math.floor(priceInfo.coins * qty * GIFT_TO_COIN_REFUND_RATE);
    await awardCoins(req.userId, coinsBack, { session });
    await logCoinTransaction({
      userId: req.userId, type: 'credit', amount: coinsBack,
      description: `Converted ${qty} × ${giftName || giftId} back to coins`,
      metadata: { giftId, giftName, qty, refundRate: GIFT_TO_COIN_REFUND_RATE },
    }, { session });

        await session.commitTransaction();
    treasuryMove(-coinsBack, { kind: 'gift_refund', userId: req.userId, note: `${qty} x ${giftName || giftId}` });
    const convertResult = { success: true, coinsBack, remainingOwned: totalOwned - qty, refundRate: GIFT_TO_COIN_REFUND_RATE };     await idemDone(req, convertResult);     res.json(convertResult);
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[gift-convert]', error);     await idemRelease(req);
    res.status(400).json({ error: error.message || 'Conversion failed' });
  } finally {
    if (session) await session.endSession();
  }
});


// Public counts for a list of videos. shares = resnaps + sends to chat + downloads. Views are visible to the video's owner only.
async function enrichVideoCounts(videos, viewerId) {
  try {
    const ids = videos.map(v => v.id || v._id).filter(Boolean);
    if (!ids.length) return videos;
    const oid = ids.map(i => new mongoose.Types.ObjectId(String(i)));
    const [base, saves, snapIns] = await Promise.all([
      SnapsaVideo.find({ _id: { $in: oid } }).select('authorId sendCount downloadCount repostCount').lean(),
      SnapsaSavedVideo.aggregate([{ $match: { videoId: { $in: oid } } }, { $group: { _id: '$videoId', n: { $sum: 1 } } }]),
      SnapsaVideo.aggregate([{ $match: { snapInOf: { $in: oid } } }, { $group: { _id: '$snapInOf', n: { $sum: 1 } } }]),
    ]);
    const B = Object.fromEntries(base.map(b => [String(b._id), b]));
    const S = Object.fromEntries(saves.map(x => [String(x._id), x.n]));
    const N = Object.fromEntries(snapIns.map(x => [String(x._id), x.n]));
    for (const v of videos) {
      const k = String(v.id || v._id), b = B[k] || {};
      v.shares = (v.shares || 0) + (b.sendCount || 0) + (b.downloadCount || 0);
      v.sendCount = b.sendCount || 0; v.downloadCount = b.downloadCount || 0;
      v.saves = S[k] || 0; v.snapIns = N[k] || 0;
      if (!viewerId || String(b.authorId || v.authorId) !== String(viewerId)) delete v.views;
    }
  } catch (e) { console.error('[enrichVideoCounts]', e.message); }
  return videos;
}

app.post('/snapsa/videos/:id/shared', snapAuth, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    const n = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 20);
    await SnapsaVideo.updateOne({ _id: req.params.id }, { $inc: { sendCount: n } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/videos/:id/repost', snapAuthRequired, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });

    const existing = await Share.findOne({ postId: sv.postId, userId: req.userId });
    if (existing) return res.status(409).json({ error: 'Already reposted' });

    await Share.create({ postId: sv.postId, userId: req.userId, shareType: 'repost' });
    await Post.findByIdAndUpdate(sv.postId, { $inc: { shareCount: 1 } });
        await SnapsaVideo.findByIdAndUpdate(req.params.id, { $inc: { repostCount: 1 } });

    if (String(sv.authorId) !== String(req.userId)) {
      snapActorName(req.userId).then(n => createSnapNotification({
        recipientId: sv.authorId, senderId: req.userId, type: 'story_repost',
        title: `${n} reposted your video`, body: '', data: { videoId: String(sv._id) },
      })).catch(() => {});
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(['/snapsa/videos/:id/download', '/snapsa/videos/:id/offline'], snapAuth, async (req, res) => {
  let tempInputPath = null, tempOutputPath = null;

  try {
    if (!req.params.id || req.params.id === 'null' || req.params.id === 'undefined') {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Video not found' });
    const forOffline = req.path.endsWith('/offline');   
    if (!forOffline && sv.privacy?.allowDownload === false && String(sv.authorId) !== String(req.userId)) {
      return res.status(403).json({ error: 'The creator has turned off downloads for this video', code: 'DOWNLOAD_DISABLED' });
    }
    if (!sv.videoFile || !/^https?:\/\//i.test(sv.videoFile)) {
      return res.status(404).json({ error: 'Source video not available' });
    }

    const tempDir = path.join(config.uploadDir, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });

    const ext = path.extname(new URL(sv.videoFile).pathname) || '.mp4';
    const uid = uuidv4();
    tempInputPath = path.join(tempDir, `dl_in_${uid}${ext}`);
    tempOutputPath = path.join(tempDir, `dl_out_${uid}${ext}`);

    console.log(`[download] Fetching from Cloudinary: ${sv.videoFile}`);
        // Already baked at upload time? Then just hand that file over — no ffmpeg needed here.
    const bakedUrl = sv.watermarkedFile && sv.watermarkedFile !== sv.videoFile && /^https?:\/\//i.test(sv.watermarkedFile) ? sv.watermarkedFile : null;
    let wmarkResult;
    if (bakedUrl) {
      await downloadToFile(bakedUrl, tempOutputPath);
      wmarkResult = { path: tempOutputPath, watermarked: true };
    } else {
      await downloadToFile(sv.videoFile, tempInputPath);
      wmarkResult = await watermarkVideo(tempInputPath, tempOutputPath, sv.authorName);
    }

    if (!fs.existsSync(tempOutputPath)) throw new Error('Watermark output not created');
    if (!wmarkResult.watermarked) {
      console.warn(`[download] Serving video ${sv._id} WITHOUT watermark/end-screen — ffmpeg fell back to a raw copy. Check the FFmpeg startup log for why.`);
    }

    const filename = `snapsa_${sv.authorName}_${sv._id}${ext}`;
    if (!forOffline) SnapsaVideo.updateOne({ _id: sv._id }, { $inc: { downloadCount: 1 } }).catch(() => {});
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Snapsa-Watermark', wmarkResult.watermarked ? 'true' : 'false');

    res.sendFile(path.resolve(tempOutputPath), (err) => {
      cleanupTempFiles(tempInputPath, tempOutputPath);
      if (err && !res.headersSent) {
        console.error('[download] sendFile error:', err.message);
        res.status(500).json({ error: 'Failed to send file' });
      }
    });
  } catch (error) {
    cleanupTempFiles(tempInputPath, tempOutputPath);
    console.error('[download]', error);
    res.status(500).json({ error: error.message });
  }
});
app.post('/snapsa/push/register', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const token = String(req.body?.token || '').trim();
    if (!token || token.length > 4096) return res.status(400).json({ error: 'Invalid token' });
    await SnapsaDeviceToken.updateOne(
      { token },
      { $set: { userId: req.userId, platform: req.body?.platform || 'android', updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/push/unregister', snapAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (token) await SnapsaDeviceToken.deleteOne({ token, userId: req.userId });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
  
app.get('/snapsa/notifications', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.json({ notifications: [] });
        const notifications = await Notification.find({ recipientId: req.userId })
      .sort({ createdAt: -1 }).limit(200).lean();
    const senderIds = [...new Set(notifications.map(n => n.senderId && String(n.senderId)).filter(Boolean))];
    const profs = senderIds.length
      ? await SnapsaProfile.find({ userId: { $in: senderIds } }).select('userId avatarUrl burnedAt').lean()
      : [];
    const avatarOf = {};
    profs.forEach(p => { avatarOf[String(p.userId)] = p.avatarUrl || null; });
    const burnedAtOf = {};
    profs.forEach(p => { if (p.burnedAt) burnedAtOf[String(p.userId)] = new Date(p.burnedAt).getTime(); });
    notifications.forEach(n => {
      n.senderAvatar = n.senderId ? (avatarOf[String(n.senderId)] || null) : null;
      const b = n.senderId ? burnedAtOf[String(n.senderId)] : 0;
      if (b && new Date(n.createdAt).getTime() <= b) {   // sender burned their identity: keep the reason, drop every link to them
        n.burned = true; n.senderId = null; n.senderAvatar = null; n.data = {};
      }
    });
    res.json({ notifications });

  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/notifications/:id/read', snapAuth, async (req, res) => {
  try { await Notification.findByIdAndUpdate(req.params.id, { read: true }); res.json({ success: true }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/snapsa/notifications/:id', snapAuthRequired, async (req, res) => {
  try {
    const n = await Notification.findById(req.params.id);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (String(n.recipientId) !== String(req.userId)) return res.status(403).json({ error: 'Not yours' });
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/snapsa/notifications', snapAuthRequired, async (req, res) => {
  try {
    await Notification.deleteMany({ recipientId: req.userId });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/notifications/unread-count', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.json({ count: 0 });
    const count = await Notification.countDocuments({ recipientId: req.userId, read: false });
    res.json({ count });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/notifications/mark-all-read', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    await Notification.updateMany({ recipientId: req.userId, read: false }, { read: true });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/stories', snapAuthRequired, uploadLimiter, uploadStory.single('media'), async (req, res) => {
  let tempPath = null;
  try {
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const authorName = profile?.username || 'unknown';
    let mediaFile = '';
    if (req.file) {
      const tempDir = path.join(config.uploadDir, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const isAudio = req.file.mimetype.startsWith('audio/');
      const isVideo = req.file.mimetype.startsWith('video/') || isAudio; // Cloudinary stores audio under the 'video' resource type
      const ext = path.extname(req.file.originalname) || (isAudio ? '.wav' : isVideo ? '.mp4' : '.jpg');
      tempPath = path.join(tempDir, `story_${uuidv4()}${ext}`);
      fs.writeFileSync(tempPath, req.file.buffer);
      const uploaded = await uploadToCloudinary(tempPath, {
        resourceType: isVideo ? 'video' : 'image',
        folder: 'snapsa/stories',
      });
      mediaFile = uploaded.secure_url;
      cleanupTempFiles(tempPath);
    }
    const story = await SnapsaStory.create({
      authorId: req.userId, authorName,
      type: req.file ? (req.file.mimetype.startsWith('audio/') ? 'voice' : req.file.mimetype.startsWith('video/') ? 'video' : 'photo') : 'text',
      effect: String(req.body.effect || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24),
      burn: req.body.burn === 'true' || req.body.burn === '1',
      audience: req.body.audience === 'followers' ? 'followers' : 'public',
      mediaFile, text: String(req.body.text || '').slice(0, 1000), bgColor: req.body.bgColor || '#FF2055',
      textColor: req.body.textColor || '#ffffff',
      fontStyle: req.body.fontStyle || 'system',
      ...(() => {
        const j = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
        const c = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
        const out = { qa: c(req.body.qa, 200), flipText: c(req.body.flipText, 500) };
        const pj = j(req.body.poll);
        if (pj && c(pj.question, 200)) {
          const options = (Array.isArray(pj.options) ? pj.options : []).map(o => c(o, 60)).filter(Boolean).slice(0, 4);
          if (options.length >= 2) out.poll = { question: c(pj.question, 200), options: options.map(text => ({ text, votes: [] })) };
        }
        const sj = j(req.body.song);
        if (sj && c(sj.title, 100)) { const au = String(sj.audioUrl || ''); out.song = { title: c(sj.title, 100), artist: c(sj.artist, 100), audioUrl: /^(https:\/\/|\/)/.test(au) ? au.slice(0, 500) : '' }; }
        return out;
      })(),
    });

    const followers = await Follower.find({ followingId: req.userId }).lean();
    if (followers.length) {
      Notification.insertMany(followers.map(f => ({
        recipientId: f.followerId, senderId: req.userId, type: 'story',
        title: `${authorName} added a new Snap-Story ✨`, body: 'Tap to view',
        data: { storyId: story._id, authorId: req.userId, thumbUrl: mediaFile || null }, priority: 'medium',
        expiresAt: new Date(Date.now() + 86400000)
      }))).catch(() => {});
    }
        for (const f of followers.slice(0, 500)) {
      sendPushToUser(f.followerId, {
        title: `${authorName} added a new story ✨`, body: 'Tap to view',
        data: { type: 'story', storyId: String(story._id), authorId: String(req.userId) },
      });
    }
    res.json({ success: true, story });

  } catch (error) {
    cleanupTempFiles(tempPath);
    console.error('[story-upload]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/stories/feed', snapAuthRequired, async (req, res) => {
  try {
    const myFollowing = req.userId ? (await Follower.find({ followerId: req.userId }).select('followingId').lean()).map(f => String(f.followingId)) : [];
    const stories = await SnapsaStory.find({
      expiresAt: { $gt: new Date() }, authorId: { $nin: [...restrictedIds, ...(await hiddenPrivateAuthorIds(req.userId))] },
      $or: [{ audience: { $ne: 'followers' } }, { authorId: req.userId }, { authorId: { $in: myFollowing } }],
    }).sort({ createdAt: -1 }).limit(100).lean();
    const grouped = {};
    const authorIds = [...new Set(stories.map(s => s.authorId.toString()))];
    
    const profiles = await SnapsaProfile.find({ userId: { $in: authorIds } }).lean();
    const avatarMap = {}, nameOf = {}, tierOf = {};
    for (const p of profiles) { avatarMap[p.userId.toString()] = p.avatarUrl || null; nameOf[p.userId.toString()] = p.displayName || ''; tierOf[p.userId.toString()] = p.snapsaTier || ''; }

    for (const s of stories) {
      const key = s.authorId.toString();
      // Burn-after-view: once someone else has opened it, it is gone for them
      if (s.burn && key !== String(req.userId) && (s.viewers || []).some(v => String(v.userId || v) === String(req.userId))) continue;
      if (!grouped[key]) grouped[key] = {
        authorId: s.authorId,
        authorName: s.authorName,
        authorDisplayName: nameOf[key] || '',
        authorSnapsaTier: tierOf[key] || '',
        avatarUrl: avatarMap[key] || null,
        stories: [],
      };
      const viewedByMe = (s.viewers || []).some(v => String(v.userId || v) === String(req.userId));
      const poll = s.poll && s.poll.question ? (() => {
        const opts = (s.poll.options || []).map(o => ({ text: o.text, count: (o.votes || []).length }));
        const mv = (s.poll.options || []).findIndex(o => (o.votes || []).some(v => String(v) === String(req.userId)));
        return { question: s.poll.question, options: opts, total: opts.reduce((a, o) => a + o.count, 0), myVote: mv >= 0 ? mv : null };
      })() : null;
      grouped[key].stories.push({ ...s, poll, mediaUrl: s.mediaFile || null, viewedByMe });
    }
    
    
    
    const groups = Object.values(grouped).map(g => ({
      ...g,
      allViewedByMe: g.stories.every(s => s.viewedByMe),
    }));
    res.json({ users: groups });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/stories/:id/vote', snapAuth, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    if (!req.userId) return res.status(401).json({ error: 'Sign in to vote' });
    const idx = Number(req.body.option);
    const st = await SnapsaStory.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } }).select('poll').lean();
    if (!st || !st.poll || !st.poll.question) return res.status(404).json({ error: 'No poll on this story' });
    if (!Number.isInteger(idx) || idx < 0 || idx >= st.poll.options.length) return res.status(400).json({ error: 'Pick one of the options' });
    const r = await SnapsaStory.updateOne({ _id: req.params.id, 'poll.options.votes': { $ne: req.userId } }, { $addToSet: { [`poll.options.${idx}.votes`]: req.userId } });
    if (!r.matchedCount) return res.status(409).json({ error: 'You already voted' });
    const f = await SnapsaStory.findById(req.params.id).select('poll').lean();
    const opts = f.poll.options.map(o => ({ text: o.text, count: (o.votes || []).length }));
    res.json({ success: true, poll: { question: f.poll.question, options: opts, total: opts.reduce((a, o) => a + o.count, 0), myVote: idx } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/stories/:id/view', snapAuth, async (req, res) => {
  try {
    const story = await SnapsaStory.findById(req.params.id).select('authorId').lean();
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (String(story.authorId) === String(req.userId)) {
      return res.json({ success: true, ownStory: true }); 
    }
    
    await SnapsaStory.findByIdAndUpdate(req.params.id, {
      $push: {
        viewers: {
          $each: [{ userId: req.userId, viewedAt: new Date() }],
          $position: 0,
        }
      }
    });
    
    
    SnapsaStory.findById(req.params.id).then(story => {
      if (!story) return;
      const seen = new Set();
      const deduped = story.viewers.filter(v => {
        const key = (v.userId||v).toString();
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      if (deduped.length !== story.viewers.length) {
        SnapsaStory.findByIdAndUpdate(req.params.id, { $set: { viewers: deduped } }).catch(()=>{});
      }
    }).catch(()=>{});
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/stories/:id/viewers', snapAuthRequired, async (req, res) => {
  try {
    const story = await SnapsaStory.findById(req.params.id).lean();
    if (!story) return res.status(404).json({ error: 'Not found' });
    if (story.authorId.toString() !== req.userId) return res.status(403).json({ error: 'Not your story' });
    const viewerIds = (story.viewers || []).map(v => v.userId || v);
    const profiles = await SnapsaProfile.find({ userId: { $in: viewerIds } }).lean();
    const profileMap = {};
    const full = {};
    for (const p of profiles) { profileMap[p.userId.toString()] = p.username; full[p.userId.toString()] = p; }
    const viewers = (story.viewers || []).map(v => ({
      userId: v.userId || v,
      username: profileMap[(v.userId || v).toString()] || 'User',
      displayName: full[(v.userId || v).toString()]?.displayName || '',
      avatarUrl: full[(v.userId || v).toString()]?.avatarUrl || null,
      authorSnapsaTier: full[(v.userId || v).toString()]?.snapsaTier || '',
      viewedAt: v.viewedAt || null,
    }));
    res.json({ viewers });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/stories/:id/like', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!guardId(req, res)) return;

    const story = await SnapsaStory.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });

    const alreadyLiked = (story.likes || []).some(id => id.toString() === req.userId.toString());
    if (alreadyLiked) {
      return res.json({ success: true, liked: true, likes: story.likes.length });
    }

    story.likes = [...(story.likes || []), req.userId];
    await story.save();

    if (story.authorId.toString() !== req.userId.toString()) {
      const likerName = await snapActorName(req.userId);
      createSnapNotification({
        recipientId: story.authorId,
        senderId: req.userId,
        type: 'story_like',
        title: `@${likerName} liked your story`,
        body: '',
        data: { storyId: story._id, authorId: req.userId, thumbUrl: story.mediaFile || null },
        priority: 'medium',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      }).catch(() => {});
    }

    res.json({ success: true, liked: true, likes: story.likes.length });
  } catch (error) {
    console.error('[story-like]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/stories/:id/repost', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!guardId(req, res)) return;

    const original = await SnapsaStory.findById(req.params.id).lean();
    if (!original) return res.status(404).json({ error: 'Story not found' });
    if (String(original.authorId) === String(req.userId)) {
      return res.status(400).json({ error: "You can't repost your own story" });
    }
    if (original.burn) return res.status(400).json({ error: "Burn-after-view stories can't be reposted" });

    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const authorName = profile?.username || 'unknown';

    
    
    const creditAuthorId = original.repostAuthorId || original.authorId;
    const creditAuthorName = original.repostAuthorName || original.authorName;

    const repost = await SnapsaStory.create({
      authorId: req.userId, authorName,
      type: original.type, mediaFile: original.mediaFile, text: original.text, effect: original.effect || '',
      bgColor: original.bgColor, textColor: original.textColor, fontStyle: original.fontStyle,
      repostOf: original._id,
      repostAuthorId: creditAuthorId,
      repostAuthorName: creditAuthorName,
    });

    if (String(creditAuthorId) !== String(req.userId)) {
      createSnapNotification({
        recipientId: creditAuthorId,
        senderId: req.userId,
        type: 'story_repost',
        title: `@${authorName} reposted your story`,
        body: '',
        data: { storyId: repost._id, authorId: req.userId, thumbUrl: original.mediaFile || null },
        priority: 'medium',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      }).catch(() => {});
    }

    res.json({ success: true, story: repost });
  } catch (error) {
    console.error('[story-repost]', error);
    res.status(500).json({ error: error.message });
  }
});


// ───────── Snapsa Posts ─────────
const POST_MOODS = ['Peak', 'Calm', 'Focused', 'Hyped', 'Low'];
const shapePoll = (poll, me) => {
  if (!poll || !poll.question) return null;
  const opts = (poll.options || []).map(o => ({ text: o.text, count: (o.votes || []).length }));
  const myVote = (poll.options || []).findIndex(o => (o.votes || []).some(v => String(v) === String(me)));
  return { question: poll.question, options: opts, total: opts.reduce((a, o) => a + o.count, 0), endsAt: poll.endsAt, ended: !!(poll.endsAt && new Date(poll.endsAt) <= new Date()), myVote: myVote >= 0 ? myVote : null };
};
// nameMap values are either an avatar url (old callers) or { avatarUrl, snapsaTier, official }
const shapePost = (p, me, nameMap, reposts) => {
  const own = String(p.authorId) === String(me);
  const burned = !!p.burned;
  const anon = (p.vibe === 'anon' && !own) || burned;
  const pr = nameMap[String(p.authorId)];
  const prof = pr && typeof pr === 'object' ? pr : { avatarUrl: pr || null };
  return {
    _id: p._id, authorId: anon ? null : p.authorId, authorName: burned ? '' : (anon ? 'Anonymous' : p.authorName), burned, avatarUrl: anon ? null : (prof.avatarUrl || null),
    authorDisplayName: anon ? '' : (prof.displayName || ''), authorSnapsaTier: anon ? '' : (prof.snapsaTier || ''), authorOfficial: anon ? null : (prof.officialLabel || null),
    feeling: p.feeling || '', moodLevel: p.moodLevel || '', place: p.place || '', tags: (p.tags || []).map(t => ({ userId: t.userId, username: t.username })),
    qa: p.qa || '', song: p.song && p.song.title ? { title: p.song.title, artist: p.song.artist || '' } : null, poll: shapePoll(p.poll, me), expiresAt: p.expiresAt || null,
    text: p.text, mediaUrl: p.mediaFile || null, mediaType: p.mediaType || '', vibe: p.vibe, visibility: p.visibility, burn: !!p.expiresAt,
    likeCount: (p.likes || []).length, likedByMe: (p.likes || []).some(x => String(x) === String(me)),
    commentCount: (p.comments || []).length, viewCount: p.viewCount || 0, shareCount: p.shareCount || 0, own, createdAt: p.createdAt,
    repost: p.repostOf ? ((reposts && reposts[String(p.repostOf)]) || { gone: true }) : null,
  };
};

app.get('/snapsa/posts', snapAuth, async (req, res) => {
  try {
    const me = String(req.userId || '');
    const mineOnly = req.query.mine === '1';
    let allowedAuthors = [];
    if (!mineOnly && me) allowedAuthors = (await Follower.find({ followerId: me }).lean()).map(f => String(f.followingId));
    const hidden = me ? await hiddenPrivateAuthorIds(me) : [];
    const q = mineOnly ? { authorId: me } : {
      authorId: { $nin: [...restrictedIds, ...hidden] },
      $or: [{ visibility: 'everyone' }, { authorId: me }, { visibility: 'followers', authorId: { $in: allowedAuthors } }],
    };
    const posts = await SnapsaPost.find(q).sort({ createdAt: -1 }).limit(60).lean();
    const nowD = new Date();
    const out = posts.filter(p => !(p.expiresAt && new Date(p.expiresAt) <= nowD));   // burned already (the TTL sweep runs once a minute)
    const profiles = await SnapsaProfile.find({ userId: { $in: [...new Set(out.map(p => String(p.authorId)))] } }, 'userId avatarUrl snapsaTier officialLabel displayName').lean();
    const nameMap = {}; profiles.forEach(p => { nameMap[String(p.userId)] = { displayName: p.displayName || '', avatarUrl: p.avatarUrl, snapsaTier: p.snapsaTier, officialLabel: p.officialLabel || null }; });
    const rIds = [...new Set(out.filter(p => p.repostOf).map(p => String(p.repostOf)))];
    const reposts = {};
    if (rIds.length) {
      const origs = await SnapsaPost.find({ _id: { $in: rIds } }).lean();
      for (const o of origs) {
        if ((o.expiresAt && new Date(o.expiresAt) <= nowD) || o.vibe === 'anon' || o.burned) continue;
        reposts[String(o._id)] = { _id: o._id, authorName: o.authorName, text: o.text || '', mediaUrl: o.mediaFile || null, mediaType: o.mediaType || '' };
      }
    }
    res.json({ posts: out.map(p => shapePost(p, me, nameMap, reposts)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/posts', snapAuth, uploadLimiter, uploadStory.single('media'), async (req, res) => {
  let tempPath = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to post' });
    const text = String(req.body.text || '').trim().slice(0, 2000);
    if (!text && !req.file) return res.status(400).json({ error: 'Write something or add media' });
    if (req.file && req.file.mimetype.startsWith('audio/')) return res.status(400).json({ error: 'Audio is not supported in posts' });
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    let mediaFile = '', mediaType = '';
    if (req.file) {
      const isVideo = req.file.mimetype.startsWith('video/');
      const tempDir = path.join(config.uploadDir, 'temp'); fs.mkdirSync(tempDir, { recursive: true });
      tempPath = path.join(tempDir, `post_${uuidv4()}${path.extname(req.file.originalname) || (isVideo ? '.mp4' : '.jpg')}`);
      fs.writeFileSync(tempPath, req.file.buffer);
      const up = await uploadToCloudinary(tempPath, { resourceType: isVideo ? 'video' : 'image', folder: 'snapsa/posts' });
      mediaFile = up.secure_url; mediaType = isVideo ? 'video' : 'photo'; cleanupTempFiles(tempPath);
    }
    const vibes = ['authentic', 'pro', 'creative', 'intimate', 'anon'];
    const jparse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
    const clean = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
    // timed burn: the post deletes itself after burnMs (1 minute … 30 days)
    let expiresAt = null;
    const burnMs = Number(req.body.burnMs);
    if (Number.isFinite(burnMs) && burnMs > 0) expiresAt = new Date(Date.now() + Math.min(Math.max(burnMs, 60000), 30 * 86400000));
    // poll
    let poll;
    const pj = jparse(req.body.poll);
    if (pj && clean(pj.question, 200)) {
      const options = (Array.isArray(pj.options) ? pj.options : []).map(o => clean(o, 80)).filter(Boolean).slice(0, 6);
      if (options.length < 2) return res.status(400).json({ error: 'A poll needs a question and at least 2 options' });
      const hrs = [1, 6, 24, 72].includes(Number(pj.hours)) ? Number(pj.hours) : 24;
      poll = { question: clean(pj.question, 200), endsAt: new Date(Date.now() + hrs * 3600000), options: options.map(text => ({ text, votes: [] })) };
    }
    // tags (usernames) → real accounts only
    let tags = [];
    const tj = jparse(req.body.tags);
    if (Array.isArray(tj) && tj.length) {
      const names = [...new Set(tj.map(x => clean(x, 40).replace(/^@/, '').toLowerCase()).filter(Boolean))].slice(0, 10);
      const found = await SnapsaProfile.find({ username: { $in: names.map(n => new RegExp('^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')) } }, 'userId username').lean();
      tags = found.map(f => ({ userId: f.userId, username: f.username }));
    }
    const sj = jparse(req.body.song);
    const post = await SnapsaPost.create({
      authorId: req.userId, authorName: profile?.username || 'unknown', text, mediaFile, mediaType,
      vibe: vibes.includes(req.body.vibe) ? req.body.vibe : 'authentic',
      moodLevel: POST_MOODS.includes(req.body.moodLevel) ? req.body.moodLevel : '',
      feeling: clean(req.body.feeling, 30), place: clean(req.body.place, 80), qa: clean(req.body.qa, 200), tags, poll,
      song: sj && clean(sj.title, 100) ? { title: clean(sj.title, 100), artist: clean(sj.artist, 100) } : undefined,
      visibility: ['everyone', 'followers', 'me'].includes(req.body.visibility) ? req.body.visibility : 'everyone',
      burn: !!expiresAt, expiresAt,
    });
    // tell followers about the new post (not for anonymous / only-me posts)
    if (post.visibility !== 'me' && post.vibe !== 'anon') {
      Follower.find({ followingId: req.userId }).select('followerId').limit(500).lean().then(fs => {
        const taggedIds = new Set(tags.map(t => String(t.userId)));
        const who = profile?.displayName || profile?.username || 'Someone';
        for (const f of fs) {
          if (taggedIds.has(String(f.followerId))) continue;
          createSnapNotification({ recipientId: f.followerId, senderId: req.userId, type: 'new_post', title: `${who} shared a new post`, body: (text || (post.mediaType ? 'Photo/video post' : '')).slice(0, 80), data: { postId: post._id, authorId: req.userId }, priority: 'medium', expiresAt: new Date(Date.now() + 14 * 86400000) }).catch(() => {});
        }
      }).catch(() => {});
    }
    for (const t of tags) {
      if (String(t.userId) === String(req.userId)) continue;
      createSnapNotification({ recipientId: t.userId, senderId: req.userId, type: 'post_tag', title: `@${profile?.username || 'someone'} tagged you in a post`, body: text.slice(0, 80), data: { postId: post._id, authorId: req.userId }, priority: 'medium', expiresAt: new Date(Date.now() + 30 * 86400000) }).catch(() => {});
    }
    res.json({ success: true, post: shapePost(post.toObject(), req.userId, { [String(req.userId)]: { displayName: profile?.displayName || '', avatarUrl: profile?.avatarUrl, snapsaTier: profile?.snapsaTier, officialLabel: profile?.officialLabel || null } }) });
  } catch (e) { cleanupTempFiles(tempPath); console.error('[post-create]', e.message); res.status(500).json({ error: e.message }); }
});

// Views: a post counts once per person when it scrolls into view (so scrolling past it counts). Visible to everyone.
app.post('/snapsa/posts/views', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.json({ success: true });
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(i => mongoose.Types.ObjectId.isValid(i)).slice(0, 40);
    if (ids.length) await SnapsaPost.bulkWrite(ids.map(id => ({ updateOne: { filter: { _id: id, authorId: { $ne: req.userId }, viewers: { $ne: req.userId } }, update: { $addToSet: { viewers: req.userId }, $inc: { viewCount: 1 } } } })), { ordered: false });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Repost: put someone's post on your own feed (optionally with a comment of your own)
app.post('/snapsa/posts/:id/repost', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to repost' });
    if (!guardId(req, res)) return;
    let orig = await SnapsaPost.findById(req.params.id).lean();
    if (!orig || (orig.expiresAt && new Date(orig.expiresAt) <= new Date())) return res.status(404).json({ error: 'This post is no longer available' });
    if (orig.repostOf) { const root = await SnapsaPost.findById(orig.repostOf).lean(); if (!root) return res.status(404).json({ error: 'The original post is gone' }); orig = root; }
    if (orig.vibe === 'anon' || orig.visibility !== 'everyone') return res.status(403).json({ error: 'This post cannot be reposted' });
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const text = String(req.body.text || '').replace(/[<>]/g, '').trim().slice(0, 500);
    const post = await SnapsaPost.create({ authorId: req.userId, authorName: profile?.username || 'unknown', text, repostOf: orig._id, vibe: 'authentic', visibility: 'everyone' });
    await SnapsaPost.updateOne({ _id: orig._id }, { $inc: { shareCount: 1 } });
    if (String(orig.authorId) !== String(req.userId)) createSnapNotification({ recipientId: orig.authorId, senderId: req.userId, type: 'post_repost', title: `@${profile?.username || 'someone'} reposted your post`, body: (orig.text || '').slice(0, 80), data: { postId: orig._id }, priority: 'medium', expiresAt: new Date(Date.now() + 14 * 86400000) }).catch(() => {});
    const reposts = { [String(orig._id)]: { _id: orig._id, authorName: orig.authorName, text: orig.text || '', mediaUrl: orig.mediaFile || null, mediaType: orig.mediaType || '' } };
    res.json({ success: true, post: shapePost(post.toObject(), req.userId, { [String(req.userId)]: { displayName: profile?.displayName || '', avatarUrl: profile?.avatarUrl, snapsaTier: profile?.snapsaTier, officialLabel: profile?.officialLabel || null } }, reposts) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/posts/:id/share', snapAuth, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    await SnapsaPost.updateOne({ _id: req.params.id }, { $inc: { shareCount: 1 } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Opening a burn post counts as the reader's one look
app.post('/snapsa/posts/:id/read', snapAuth, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    await SnapsaPost.updateOne({ _id: req.params.id, burn: true, authorId: { $ne: req.userId } }, { $addToSet: { readers: req.userId } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poll vote: one vote per person, only while the poll is open
app.post('/snapsa/posts/:id/vote', snapAuth, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    if (!req.userId) return res.status(401).json({ error: 'Sign in to vote' });
    const idx = Number(req.body.option);
    const p = await SnapsaPost.findById(req.params.id).select('poll authorId vibe').lean();
    if (!p || !p.poll || !p.poll.question) return res.status(404).json({ error: 'No poll on this post' });
    if (!Number.isInteger(idx) || idx < 0 || idx >= (p.poll.options || []).length) return res.status(400).json({ error: 'Pick one of the options' });
    if (p.poll.endsAt && new Date(p.poll.endsAt) <= new Date()) return res.status(400).json({ error: 'This poll has ended' });
    const r = await SnapsaPost.updateOne({ _id: req.params.id, 'poll.options.votes': { $ne: req.userId } }, { $addToSet: { [`poll.options.${idx}.votes`]: req.userId } });
    if (!r.matchedCount) return res.status(409).json({ error: 'You already voted' });
    const fresh = await SnapsaPost.findById(req.params.id).select('poll').lean();
    res.json({ success: true, poll: shapePoll(fresh.poll, req.userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/posts/:id/like', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to like' });
    const p = await SnapsaPost.findById(req.params.id).select('likes').lean();
    if (!p) return res.status(404).json({ error: 'Post not found' });
    const liked = (p.likes || []).some(x => String(x) === String(req.userId));
    await SnapsaPost.updateOne({ _id: req.params.id }, liked ? { $pull: { likes: req.userId } } : { $addToSet: { likes: req.userId } });
    res.json({ success: true, liked: !liked, likeCount: (p.likes || []).length + (liked ? -1 : 1) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/snapsa/posts/:id/comments', snapAuth, async (req, res) => {
  try {
    const p = await SnapsaPost.findById(req.params.id).select('comments authorId').lean();
    if (!p) return res.status(404).json({ error: 'Post not found' });
    const isAuthor = String(p.authorId) === String(req.userId);
    const cl = (p.comments || []).slice(-100);
    const cprofs = await SnapsaProfile.find({ userId: { $in: [...new Set(cl.filter(c => !c.anon).map(c => String(c.userId)))] } }, 'userId displayName avatarUrl').lean();
    const dnMap = {}, avMap = {}; cprofs.forEach(x => { dnMap[String(x.userId)] = x.displayName || ''; avMap[String(x.userId)] = x.avatarUrl || null; });
    res.json({ comments: cl.map(c => (c.direct && !isAuthor && String(c.userId) !== String(req.userId)) ? { _id: c._id, direct: true, hidden: true, authorName: '', text: '', createdAt: c.createdAt, mine: false } : c.anon ? { _id: c._id, authorName: 'Anonymous', anon: true, direct: !!c.direct, text: c.text, createdAt: c.createdAt, mine: String(c.userId) === String(req.userId) } : { _id: c._id, userId: c.userId, authorName: c.authorName, authorDisplayName: dnMap[String(c.userId)] || '', avatarUrl: avMap[String(c.userId)] || null, direct: !!c.direct, text: c.text, createdAt: c.createdAt, mine: String(c.userId) === String(req.userId) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/posts/:id/comments', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to comment' });
    const text = String(req.body.text || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'Empty comment' });
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const direct = req.body.direct === true || req.body.direct === 'true';
    const anon = !direct && (req.body.anon === true || req.body.anon === 'true');
    const c = { userId: req.userId, authorName: anon ? 'Anonymous' : (profile?.username || 'unknown'), anon, direct, text, createdAt: new Date() };
    const r = await SnapsaPost.updateOne({ _id: req.params.id, 'comments.199': { $exists: false } }, { $push: { comments: c } });
    if (!r.matchedCount) return res.status(400).json({ error: 'Comments are closed on this post' });
    res.json({ success: true, comment: { userId: anon ? undefined : req.userId, authorName: c.authorName, authorDisplayName: anon ? '' : (profile?.displayName || ''), avatarUrl: anon ? null : (profile?.avatarUrl || null), anon, direct, text, createdAt: c.createdAt, mine: true } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/snapsa/posts/:id', snapAuthRequired, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    const r = await SnapsaPost.deleteOne({ _id: req.params.id, authorId: req.userId });
    res.json({ success: !!r.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/snapsa/videos/:id/comments', snapAuth, async (req, res) => {
  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });
    if (!(await canViewAccountContent(req.userId, sv.authorId))) return res.json({ comments: [] });     const comments = await Comment.find({ postId: sv.postId, isActive: true, userId: { $nin: restrictedIds } })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('userId', 'firstName lastName displayName tier zkCommitment')
      .lean();

    
    const authorIds = [...new Set(comments.map(c => c.userId?._id?.toString()).filter(Boolean))];
    const profiles = authorIds.length
      ? await SnapsaProfile.find({ userId: { $in: authorIds } }, 'userId username displayName avatarUrl snapsaTier').lean()
      : [];
    const profileMap = {};
    for (const p of profiles) profileMap[p.userId.toString()] = p;

    const enriched = comments.map(c => {
      const uid = c.userId?._id?.toString();
      const profile = uid ? profileMap[uid] : null;
      return {
        ...c,
        _displayName: (profile?.displayName || profile?.username)
          ? (profile.displayName || profile.username)
          : (c.userId?.firstName ? `${c.userId.firstName} ${c.userId.lastName||''}`.trim() : (c.userId?.displayName || null)),
        _avatarUrl: profile?.avatarUrl || null,
        _snapsaTier: profile?.snapsaTier || '',
      };
    });

    res.json({ comments: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/videos/:id/comments', snapAuthRequired, async (req, res) => {
  let session = null;

  try {
    const sv = await SnapsaVideo.findById(req.params.id).lean();
    if (!sv) return res.status(404).json({ error: 'Not found' });
    if (req.userId && String(sv.authorId) !== String(req.userId) && await isBlockedBy(sv.authorId, req.userId)) {
      return res.status(403).json({ error: "You can't interact with this account" });
    }
    if (req.userId && String(sv.authorId) !== String(req.userId)) {     
      const ap = await SnapsaProfile.findOne({ userId: sv.authorId }).select('privacy.commentSetting privacy.privateAccount').lean();   
      const setting = ap?.privacy?.commentSetting || 'everyone';     
      if (setting === 'nobody') return res.status(403).json({ error: 'Comments are turned off for this account', code: 'COMMENTS_OFF' });    
      if ((setting === 'followers' || ap?.privacy?.privateAccount) && !(await Follower.exists({ followerId: req.userId, followingId: sv.authorId }))) {      
        return res.status(403).json({ error: 'Only followers can comment on this account', code: 'COMMENTS_FOLLOWERS_ONLY' });   
      }     
    }    
    if (!req.body.content?.trim()) return res.status(400).json({ error: 'Content required' });

    session = await mongoose.startSession();
    session.startTransaction();

    const [comment] = await Comment.create([{
      postId: sv.postId,
      userId: req.userId,
      content: req.body.content.trim(),
      parentId: req.body.parentId || null
    }], { session });

    await Post.findByIdAndUpdate(sv.postId, { $inc: { commentCount: 1 } }, { session });
    await session.commitTransaction();

    if (sv.authorId.toString() !== req.userId.toString()) {
      const commenterName = await snapActorName(req.userId);
      createSnapNotification({
        recipientId: sv.authorId, senderId: req.userId, type: 'comment',
        title: `@${commenterName} commented on your video`,
        body: req.body.content.trim().slice(0, 80),
        data: { postId: sv.postId, videoId: sv._id, authorId: req.userId, thumbUrl: sv.thumbFile || null }, priority: 'medium',
        expiresAt: new Date(Date.now() + 30 * 86400000)
      }).catch(() => {});
    }

    const mine = await SnapsaProfile.findOne({ userId: req.userId }, 'username displayName avatarUrl snapsaTier').lean();
    res.json({ success: true, comment: { ...(comment.toObject ? comment.toObject() : comment), _displayName: mine?.displayName || mine?.username || null, _avatarUrl: mine?.avatarUrl || null, _snapsaTier: mine?.snapsaTier || '' } });
  } catch (error) {
    if (session && session.inTransaction()) await session.abortTransaction();
    console.error('[comment]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

app.post('/snapsa/sounds/upload', snapAuthRequired, uploadLimiter, upload.single('audio'), async (req, res) => {
  let tempAudioPath = null, tempThumbPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    const tempDir = path.join(config.uploadDir, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const uid = uuidv4();
    const ext = path.extname(req.file.originalname) || '.mp3';

    tempAudioPath = path.join(tempDir, `sound_${uid}${ext}`);
    fs.writeFileSync(tempAudioPath, req.file.buffer);

    tempThumbPath = path.join(tempDir, `sound_thumb_${uid}.jpg`);
    await makeThumb(tempThumbPath, '♪ ' + (req.body.title || 'Sound'));

    const [audioUpload, thumbUpload] = await Promise.all([
      uploadToCloudinary(tempAudioPath, { resourceType: 'video', folder: 'snapsa/sounds' }), 
      fs.existsSync(tempThumbPath)
        ? uploadToCloudinary(tempThumbPath, { resourceType: 'image', folder: 'snapsa/thumbs' })
        : Promise.resolve(null),
    ]);
    cleanupTempFiles(tempAudioPath, tempThumbPath);

    const sound = await SnapsaSound.create({
      uploaderId: req.userId,
      title: req.body.title || req.file.originalname,
      artist: req.body.artist || 'Unknown',
      audioFile: audioUpload.secure_url,
      thumbFile: thumbUpload?.secure_url || null,
    });

    res.json({
      success: true,
      sound: {
        id: sound._id,
        title: sound.title,
        artist: sound.artist,
        audioUrl: sound.audioFile,
        thumbUrl: sound.thumbFile,
        uses: 0
      }
    });
  } catch (error) {
    cleanupTempFiles(tempAudioPath, tempThumbPath);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/sounds/:id', snapAuth, async (req, res) => {
  try {
    const s = await SnapsaSound.findById(req.params.id).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({
      ...s,
      audioUrl: mediaUrl(req, s.audioFile),
      thumbUrl: mediaUrl(req, s.thumbFile)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/sounds/:id/use', snapAuth, async (req, res) => {
  try {
    const s = await SnapsaSound.findById(req.params.id).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ uses: s.uses });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/sounds/:id/download', snapAuth, async (req, res) => {
  try {
    const s = await SnapsaSound.findByIdAndUpdate(
      req.params.id,
      { $inc: { downloads: 1 } },
      { new: true }
    ).lean();
    if (!s || !s.audioFile) return res.status(404).json({ error: 'Not found' });

    res.setHeader('X-Snapsa-Thumb', s.thumbFile || '');
    res.setHeader('X-Snapsa-Brand', 'Snapsa');
    
    const downloadUrl = s.audioFile.replace('/upload/', '/upload/fl_attachment/');
    res.redirect(downloadUrl);
  } catch (error) {
    console.error('[sound-download]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/sounds/:id/videos', snapAuth, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid sound id' });
    }
    const limit = Math.min(50, parseInt(req.query.limit || '24'));

    const videos = await SnapsaVideo.aggregate([
      { $match: { songId: new mongoose.Types.ObjectId(req.params.id) } },
      {
        $lookup: {
          from: 'posts',
          localField: 'postId',
          foreignField: '_id',
          as: 'post'
        }
      },
      { $unwind: { path: '$post', preserveNullAndEmptyArrays: false } },
            { $match: { 'post.isActive': true, 'privacy.visibility': { $ne: 'private' }, authorId: { $nin: [...restrictedIds, ...(await hiddenPrivateAuthorIds(req.userId))] } } },
      { $sort: { 'post.likeCount': -1, createdAt: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          id: '$_id',
          authorId: '$authorId',
          authorName: '$authorName',
          videoUrl: '$videoFile',
          thumbUrl: '$thumbFile',
          caption: '$post.content',
          likes: { $ifNull: ['$post.likeCount', 0] },
          comments: { $ifNull: ['$post.commentCount', 0] },
          shares: { $ifNull: ['$post.shareCount', 0] },
        }
      }
    ]);

    res.json({ videos, count: videos.length });
  } catch (error) {
    console.error('[sounds/:id/videos]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/music/tracks', snapAuth, async (req, res) => {
  try {
    const { search, genre, limit = 20, page = 1, sort = 'popular' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { isPublished: true, artistId: { $nin: restrictedIds } };
    
    if (search && search.trim().length > 0) {
      query.$text = { $search: search.trim() };
    }
    
    if (genre && genre !== 'All') {
      query.genre = genre;
    }

    let sortOption = {};
    switch (sort) {
      case 'popular':
        sortOption = { purchaseCount: -1, playCount: -1 };
        break;
      case 'recent':
        sortOption = { createdAt: -1 };
        break;
      case 'price-low':
        sortOption = { price: 1 };
        break;
      case 'price-high':
        sortOption = { price: -1 };
        break;
      default:
        sortOption = { playCount: -1 };
    }

    const [tracks, total] = await Promise.all([
      SnapsaTrack.find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SnapsaTrack.countDocuments(query)
    ]);

    let purchasedMap = {};
    if (req.userId) {
      const purchases = await SnapsaPurchase.find({
        buyerId: req.userId,
        trackId: { $in: tracks.map(t => t._id) },
        status: 'completed'
      }).lean();
      purchasedMap = purchases.reduce((acc, p) => {
        acc[p.trackId.toString()] = true;
        return acc;
      }, {});
    }

    const artistIds = [...new Set(tracks.map(t => t.artistId.toString()))];
    const profiles = await SnapsaProfile.find({ userId: { $in: artistIds } }).lean();
    const profileMap = profiles.reduce((acc, p) => {
      acc[p.userId.toString()] = p.avatarUrl || null;
      return acc;
    }, {});

    const tracksWithMetadata = tracks.map(track => {
      const isOwnTrack = req.userId && track.artistId.toString() === req.userId.toString();
      return {
        ...track,
        id: track._id,
        artistName: track.artist,
        coverUrl: track.coverArt || null,
        audioUrl: track.audioFile,
        isPurchased: !!purchasedMap[track._id.toString()],
        
        
        
        
        owned: !!purchasedMap[track._id.toString()] || track.isFree || track.price === 0 || isOwnTrack,
        isOwnTrack,
        artistAvatar: profileMap[track.artistId.toString()] || null,
        
        
        
        
        previewUrl: (track.price === 0 || isOwnTrack) ? track.audioFile : (track.previewFile || ''),
        priceUsd: (track.price || 0) / 100,
      };
    });

    res.json({
      tracks: tracksWithMetadata,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[music/search]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /snapsa/music/library - User's purchased tracks

app.get('/snapsa/music/library', snapAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { limit = 50, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const purchases = await SnapsaPurchase.find({
      buyerId: req.userId,
      status: 'completed'
    })
    .sort({ completedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

    const trackIds = purchases.map(p => p.trackId);
    const tracks = await SnapsaTrack.find({
      _id: { $in: trackIds },
      isPublished: true
    }).lean();

    const purchaseMap = purchases.reduce((acc, p) => {
      acc[p.trackId.toString()] = p;
      return acc;
    }, {});

    const library = tracks.map(track => ({
      ...track,
      id: track._id,
      artistName: track.artist,
      coverUrl: track.coverArt || null,
      audioUrl: track.audioFile,
      priceUsd: (track.price || 0) / 100,
      purchasedAt: purchaseMap[track._id.toString()]?.completedAt,
      purchasePrice: purchaseMap[track._id.toString()]?.price,
    }));

    res.json({
      tracks: library,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: purchases.length
      }
    });
  } catch (error) {
    console.error('[music/library]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/music/purchase/init', snapAuth, async (req, res) => {
  let session = null;

  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { trackId } = req.body;
    if (!trackId) {
      return res.status(400).json({ error: 'Track ID required' });
    }

    const existingPurchase = await SnapsaPurchase.findOne({
      trackId,
      buyerId: req.userId,
      status: 'completed'
    });

    if (existingPurchase) {
      return res.status(409).json({ error: 'Track already purchased' });
    }

    const track = await SnapsaTrack.findById(trackId).lean();
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    if (track.price === 0) {
      return res.status(400).json({ error: 'Track is free' });
    }

    if (!track.isPublished) {
      return res.status(403).json({ error: 'Track is not available' });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const balance = await getSnapsaCoinBalance(req.userId, { session });

    if (balance < track.price) {
      throw new Error(`Insufficient coins. Balance: ${balance}, Price: ${track.price}`);
    }

    const txRef = `MUSIC_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const purchase = await SnapsaPurchase.create([{
      trackId: track._id,
      buyerId: req.userId,
      sellerId: track.artistId,
      price: track.price,
      transactionRef: txRef,
      status: 'pending',
      platformFee: Math.floor(track.price * 0.2),
      sellerPayout: Math.floor(track.price * 0.8),
      metadata: { trackTitle: track.title },
    }], { session });

    await session.commitTransaction();

    res.json({
      success: true,
      purchaseId: purchase[0]._id,
      transactionRef: txRef,
      amount: track.price,
      trackTitle: track.title,
      artist: track.artist,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[music/purchase/init]', error);
    res.status(500).json({ error: error.message || 'Purchase initialization failed' });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/music/purchase/status/:txRef', snapAuth, async (req, res) => {
  let session = null;

  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { txRef } = req.params;
    const purchase = await SnapsaPurchase.findOne({ transactionRef: txRef });

    if (!purchase) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    if (purchase.buyerId.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: 'Not your purchase' });
    }

    if (purchase.status === 'completed') {
      const track = await SnapsaTrack.findById(purchase.trackId).lean();
      return res.json({
        status: 'completed',
        purchase,
        track: {
          ...track,
          audioUrl: track.audioFile,
          coverUrl: track.coverArt || null,
        }
      });
    }

    if (purchase.status === 'pending') {
      session = await mongoose.startSession();
      session.startTransaction();

      const balance = await getSnapsaCoinBalance(req.userId, { session });
      
      if (balance < purchase.price) {
        purchase.status = 'failed';
        await purchase.save({ session });
        await session.commitTransaction();
        return res.status(400).json({ 
          status: 'failed', 
          error: 'Insufficient balance. Purchase cancelled.' 
        });
      }

      await awardCoins(req.userId, -purchase.price, { session });
      await logCoinTransaction({
        userId: req.userId,
        type: 'debit',
        amount: -purchase.price,
        description: `Music purchase: ${purchase.transactionRef}`,
        reference: purchase._id,
        referenceModel: 'SnapsaPurchase',
        metadata: { trackId: purchase.trackId, txRef }
      }, { session });

      await awardCoins(purchase.sellerId, purchase.sellerPayout, { session });
      await logCoinTransaction({
        userId: purchase.sellerId,
        type: 'credit',
        amount: purchase.sellerPayout,
        description: `Music sale: ${purchase.transactionRef}`,
        reference: purchase._id,
        referenceModel: 'SnapsaPurchase',
        metadata: { trackId: purchase.trackId, txRef }
      }, { session });

      purchase.status = 'completed';
      purchase.completedAt = new Date();
      await purchase.save({ session });

      await SnapsaTrack.findByIdAndUpdate(
        purchase.trackId,
        {
          $inc: { 
            purchaseCount: 1,
            totalRevenue: purchase.sellerPayout 
          }
        },
        { session }
      );

      await session.commitTransaction();

            treasuryMove(purchase.price - purchase.sellerPayout, { kind: 'music_fee', userId: purchase.sellerId, note: `Music sale ${purchase.transactionRef}` }).catch(() => {});
      createSnapNotification({
        recipientId: purchase.sellerId,
        senderId: req.userId,
        type: 'music_sale',
        title: '🎵 Your track was purchased!',
        body: `Someone purchased "${purchase.metadata?.trackTitle || 'your track'}" for ${purchase.price} coins`,
        data: { trackId: purchase.trackId, purchaseId: purchase._id },
        priority: 'medium',
        expiresAt: new Date(Date.now() + 30 * 86400000)
      }).catch(() => {});

      const track = await SnapsaTrack.findById(purchase.trackId).lean();
      res.json({
        status: 'completed',
        purchase,
        track: {
          ...track,
          audioUrl: track.audioFile,
          coverUrl: track.coverArt || null,
        }
      });
    } else {
      res.json({ status: purchase.status, purchase });
    }
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[music/purchase/status]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

const SNAPSA_TIER_PRICES_USD = { bronze: 4.99, silver: 9.99, gold: 19.99, platinum: 49.99 };

app.post('/snapsa/subscriptions/purchase/init', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const tier = String(req.body?.tier || '').toLowerCase();
    const amountUsd = SNAPSA_TIER_PRICES_USD[tier];
    if (!amountUsd) return res.status(400).json({ error: 'Unknown tier' });

    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    if (profile?.snapsaTier === tier && profile?.snapsaTierExpiresAt && new Date(profile.snapsaTierExpiresAt) > new Date()) {
      return res.status(409).json({ error: `You already have an active ${tier} badge` });
    }

    const txRef = `SNAPSA_TIER_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await SnapsaTierPurchase.create({
      buyerId: req.userId, tier, amountUsd, transactionRef: txRef, status: 'pending',
    });

    res.json({ success: true, txRef, amount: amountUsd, tier });
  } catch (error) {
    console.error('[subscriptions/purchase/init]', error);
    res.status(500).json({ error: error.message || 'Could not start checkout' });
  }
});

app.get('/snapsa/subscriptions/purchase/status/:txRef', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

    const purchase = await SnapsaTierPurchase.findOne({ transactionRef: req.params.txRef });
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.buyerId.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: 'Not your purchase' });
    }

    if (purchase.status === 'pending') {
      
      
      purchase.status = 'completed';
      purchase.completedAt = new Date();
      if (req.query.flwTransactionId) purchase.flwTransactionId = String(req.query.flwTransactionId);
      await purchase.save();

      const expiresAt = new Date(Date.now() + 30 * 86400000); 
      await SnapsaProfile.findOneAndUpdate(
        { userId: req.userId },
        { $set: { snapsaTier: purchase.tier, snapsaTierExpiresAt: expiresAt } }
      );

      res.json({ status: 'completed', tier: purchase.tier, expiresAt });
    } else {
      res.json({ status: purchase.status });
    }
  } catch (error) {
    console.error('[subscriptions/purchase/status]', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Music: "Play with ads" — listeners can hear a for-sale track in full after watching one ad ─────────────
const MUSIC_AD_MIN_SECONDS = 8;                    // the ad must have been on screen at least this long
const _adSign = (s) => crypto.createHmac('sha256', String(config.jwtSecret) + ':music-ad').update(s).digest('hex');
function makeAdToken(kind, userId, trackId, ts) { return `${kind}.${ts}.${_adSign(`${kind}.${userId}.${trackId}.${ts}`)}`; }
function checkAdToken(token, kind, userId, trackId) {
  const [k, ts, sig] = String(token || '').split('.');
  if (k !== kind || !ts || !sig) return null;
  const expect = _adSign(`${kind}.${userId}.${trackId}.${ts}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return Number(ts);
}
function hasValidAdPass(token, userId, trackId) {
  const ts = checkAdToken(token, 'pass', userId, trackId);
  return !!ts && Date.now() - ts < 30 * 60 * 1000;   // a pass lasts 30 minutes
}

// 1) listener taps "Play with ads" → server notes when the ad started
app.post('/snapsa/music/tracks/:trackId/ad-start', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to play with ads' });
    const track = await SnapsaTrack.findById(req.params.trackId).select('adSupported isPublished').lean();
    if (!track || !track.isPublished) return res.status(404).json({ error: 'Track not found' });
    if (!track.adSupported) return res.status(403).json({ error: 'This track is not available with ads' });
    const ts = Date.now();
    res.json({ adId: 'snapsa', minSeconds: MUSIC_AD_MIN_SECONDS, token: makeAdToken('start', req.userId, req.params.trackId, ts) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2) the ad finished → if enough time passed, hand back a 30-minute pass for this track
app.post('/snapsa/music/tracks/:trackId/ad-complete', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const startedAt = checkAdToken(req.body?.token, 'start', req.userId, req.params.trackId);
    if (!startedAt) return res.status(400).json({ error: 'Invalid ad session' });
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < MUSIC_AD_MIN_SECONDS) return res.status(400).json({ error: 'Ad not finished', wait: Math.ceil(MUSIC_AD_MIN_SECONDS - elapsed) });
    if (elapsed > 15 * 60) return res.status(400).json({ error: 'Ad session expired' });
    await SnapsaTrack.findByIdAndUpdate(req.params.trackId, { $inc: { adPlayCount: 1 } });
    res.json({ success: true, adToken: makeAdToken('pass', req.userId, req.params.trackId, Date.now()) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/music/tracks/:trackId/play-full', snapAuth, async (req, res) => {
  try {
    const { trackId } = req.params;
    
    const track = await SnapsaTrack.findById(trackId).lean();
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    if (!track.isPublished) {
      return res.status(403).json({ error: 'Track not available' });
    }

        const isOwnTrack = req.userId && track.artistId.toString() === req.userId.toString();
    const adPass = !!(track.adSupported && req.userId && hasValidAdPass(req.query.adToken, req.userId, trackId));

    if (track.price > 0 && req.userId && !isOwnTrack && !adPass) {

      const purchase = await SnapsaPurchase.findOne({
        trackId: track._id,
        buyerId: req.userId,
        status: 'completed'
      });

      if (!purchase) {
        return res.status(403).json({ 
          error: 'Track not purchased',
          price: track.price,
          requirePurchase: true
        });
      }
    } else if (track.price > 0 && !req.userId) {
      return res.status(401).json({ 
        error: 'Authentication required to play this track',
        price: track.price,
        requirePurchase: true
      });
    }

    await SnapsaTrack.findByIdAndUpdate(trackId, { $inc: { playCount: 1 } });

    res.json({
      success: true,
      audioUrl: track.audioFile || null,
      videoUrl: track.videoFile || null,
      coverUrl: track.coverArt || null,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      isPurchased: track.price === 0 || !!await SnapsaPurchase.findOne({
        trackId: track._id,
        buyerId: req.userId,
        status: 'completed'
      })
    });
  } catch (error) {
    console.error('[music/play]', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/snapsa/music/tracks/:trackId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const track = await SnapsaTrack.findById(req.params.trackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    if (track.artistId.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: 'Not your track' });
    }

    const publicIds = [track.audioPublicId, track.previewPublicId, track.videoPublicId, track.coverPublicId].filter(Boolean);
    for (const publicId of publicIds) {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: publicId === track.coverPublicId ? 'image' : 'video' });
      } catch (e) {
        console.warn('[music/delete-track] Could not delete Cloudinary asset', publicId, ':', e.message);
      }
    }

    await SnapsaTrack.findByIdAndDelete(req.params.trackId);
    await SnapsaPurchase.deleteMany({ trackId: track._id }); 

    res.json({ success: true });
  } catch (error) {
    console.error('[music/delete-track]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/music/tracks/:trackId/download', snapAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { trackId } = req.params;
    
    const track = await SnapsaTrack.findById(trackId).lean();
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const purchase = await SnapsaPurchase.findOne({
      trackId: track._id,
      buyerId: req.userId,
      status: 'completed'
    });

    const isOwnTrack = track.artistId.toString() === req.userId.toString();
    if (!purchase && track.price > 0 && !isOwnTrack) {
      return res.status(403).json({ error: 'Track not purchased' });
    }

    await SnapsaTrack.findByIdAndUpdate(trackId, { $inc: { downloadCount: 1 } });

    const downloadUrl = track.audioFile.replace('/upload/', '/upload/fl_attachment/');
    
    res.json({
      success: true,
      downloadUrl: downloadUrl,
      title: track.title,
      artist: track.artist
    });
  } catch (error) {
    console.error('[music/download]', error);
    res.status(500).json({ error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATOR PROFILES — one profile per section (music/artist, TV channel, radio,
// podcast, news), each needing admin approval. Stored in
// snapsa_profiles.creatorProfiles.<type>. Old profiles in artistProfile keep
// working (treated as approved) until their owner edits them.
// ════════════════════════════════════════════════════════════════════════════
const CREATOR_TYPES = ['artist', 'tv_channel', 'radio_station', 'podcast', 'news_channel'];
const CHANNEL_CREATOR_TYPES = ['radio_station', 'podcast', 'news_channel'];
const CREATOR_LABELS = { artist: 'Music artist', tv_channel: 'TV channel', radio_station: 'Radio station', podcast: 'Podcast', news_channel: 'News channel' };

// artistProfile-shaped object for one type, or null. Pending/rejected entries
// come back with enabled:false so every existing gate (`!artistProfile.enabled`) keeps blocking them.
function creatorEntry(profile, type) {
  if (!profile) return null;
  const cp = profile.creatorProfiles && profile.creatorProfiles[type];
  if (cp && cp.artistName) {
    const status = cp.status || 'approved';
    return { ...cp, accountType: type, status, enabled: status === 'approved' };
  }
  const ap = profile.artistProfile;
  if (ap && ap.enabled && (ap.accountType || 'artist') === type) return { ...ap, accountType: type, status: 'approved', enabled: true };
  return null;
}

// Swap `artistProfile` for the requested type(s) so the existing route code
// (`profile.artistProfile.enabled`, `.artistName`, `.accountType` ...) works unchanged.
function creatorSwap(profile, types) {
  if (!profile) return profile;
  const list = [].concat(types);
  for (const t of list) {
    const e = creatorEntry(profile, t);
    if (e && e.enabled) return { ...profile, artistProfile: e };
  }
  return { ...profile, artistProfile: { enabled: false, accountType: list[0] } };
}
async function loadCreatorProfile(userId, types) {
  return creatorSwap(await SnapsaProfile.findOne({ userId }).lean(), types);
}
function channelTypesFromReq(req) {
  return CHANNEL_CREATOR_TYPES.includes(req.query && req.query.type) ? [req.query.type] : CHANNEL_CREATOR_TYPES;
}

app.get('/snapsa/music/artist-profile/mine', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const type = CREATOR_TYPES.includes(req.query.type) ? req.query.type : 'artist';
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).select('artistProfile creatorProfiles').lean();
    const e = creatorEntry(profile, type);
    if (!e) return res.json({ artistProfile: null });
    const trackCount = type === 'artist' ? await SnapsaTrack.countDocuments({ artistId: req.userId }) : 0;
    res.json({ artistProfile: { ...e, trackCount } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/music/artist-profile', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const artistName = (req.body.artistName || '').trim();
    const country = (req.body.country || '').trim();
    if (!artistName) return res.status(400).json({ error: 'Name is required' });
    if (!country) return res.status(400).json({ error: 'Country is required' });
    const type = CREATOR_TYPES.includes(req.body.accountType) ? req.body.accountType : 'artist';

    const current = await SnapsaProfile.findOne({ userId: req.userId }).select('artistProfile creatorProfiles username').lean();
    const prev = creatorEntry(current, type);
    const wasApproved = !!(prev && prev.enabled);

    const next = {
      status: wasApproved ? 'approved' : 'pending',
      artistName: artistName.slice(0, 60),
      country: country.slice(0, 60),
      genre: type === 'artist' ? (req.body.genre || '').trim().slice(0, 60) : '',   // genre only exists on music profiles
      bio: (req.body.bio || '').slice(0, 300),
      avatarUrl: prev?.avatarUrl || null,
      avatarPublicId: prev?.avatarPublicId || null,
      subscriptionPriceCoins: prev?.subscriptionPriceCoins || 0,
      requestedAt: wasApproved ? (prev.requestedAt || null) : new Date(),
      reviewedAt: wasApproved ? (prev.reviewedAt || null) : null,
      reviewNote: wasApproved ? (prev.reviewNote || '') : '',
    };
    if (req.body.avatarBase64) {
      const uploaded = await uploadBase64ToCloudinary(req.body.avatarBase64, { resourceType: 'image', folder: 'snapsa/artist_avatars' });
      next.avatarUrl = uploaded.secure_url;
      next.avatarPublicId = uploaded.public_id;
    }
    if (type === 'tv_channel' && req.body.subscriptionPriceCoins != null) {
      next.subscriptionPriceCoins = Math.max(0, Math.round(Number(req.body.subscriptionPriceCoins) || 0));
    }

    await SnapsaProfile.findOneAndUpdate(
      { userId: req.userId }, { $set: { [`creatorProfiles.${type}`]: next } }, { upsert: true, new: true }
    );
    const saved = await SnapsaProfile.findOne({ userId: req.userId }).select('creatorProfiles').lean();
    if (saved?.creatorProfiles?.[type]?.artistName !== next.artistName) {
      console.error('[creator-profile] write did not persist for user', req.userId, type);
      return res.status(500).json({ error: "Your profile didn't save properly. Please try again." });
    }

    if (!wasApproved) {
      const who = current?.username ? `@${current.username}` : `user ${req.userId}`;
      notifyAllAdmins({
        senderId: req.userId, type: 'report_update', priority: 'high',
        title: `🆕 ${CREATOR_LABELS[type]} profile request`,
        body: `${who} wants to create "${next.artistName}" (${country}) · user ID ${req.userId}`,
        data: { kind: 'creator_request', userId: String(req.userId), accountType: type },
      }, req.userId);
    }
    const trackCount = type === 'artist' ? await SnapsaTrack.countDocuments({ artistId: req.userId }) : 0;
    res.json({
      success: true, status: next.status,
      artistProfile: { ...next, accountType: type, enabled: next.status === 'approved', trackCount },
    });
  } catch (error) {
    console.error('[creator-profile]', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Admin: review creator profile requests ───────────────────────────────────
// ── Official accounts: governments, companies and professional accounts granted the pin-style OFFICIAL label + the pink badge ──
const OFFICIAL_LABELS = ['OFFICIAL', 'GOVERNMENT', 'COMPANY', 'PROFESSIONAL', 'MEDIA', 'NGO'];
app.get('/snapsa/admin/official', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const rows = await SnapsaProfile.find({ officialLabel: { $nin: ['', null] } }).select('userId username avatarUrl officialLabel officialOrg').lean();
    res.json({ labels: OFFICIAL_LABELS, accounts: rows.map(r => ({ userId: r.userId, username: r.username, avatarUrl: r.avatarUrl || null, label: r.officialLabel, org: r.officialOrg || '' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/snapsa/admin/official', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const uname = String(req.body.username || '').trim().replace(/^@/, '');
    if (!uname) return res.status(400).json({ error: 'Enter a username' });
    const prof = await SnapsaProfile.findOne({ username: new RegExp('^' + uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
    if (!prof) return res.status(404).json({ error: 'No Snapsa account with that username' });
    const on = req.body.on !== false;
    const label = on ? (OFFICIAL_LABELS.includes(String(req.body.label || '').toUpperCase()) ? String(req.body.label).toUpperCase() : 'OFFICIAL') : '';
    prof.officialLabel = label;
    prof.officialOrg = on ? String(req.body.org || '').replace(/[<>]/g, '').trim().slice(0, 80) : '';
    await prof.save();
    _verifiedAt = 0;   // refresh the pink-badge cache straight away
    if (on) createSnapNotification({ recipientId: prof.userId, senderId: req.userId, type: 'official_granted', title: `Your account is now ${label}`, body: 'The official label and pink badge now show on your profile and posts.', data: {}, priority: 'high', expiresAt: new Date(Date.now() + 30 * 86400000) }).catch(() => {});
    res.json({ success: true, username: prof.username, label });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/snapsa/admin/creator-profiles', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const view = ['pending', 'approved', 'rejected'].includes(req.query.view) ? req.query.view : 'pending';
    const docs = await SnapsaProfile.find({ creatorProfiles: { $exists: true, $ne: {} } })
      .select('userId username creatorProfiles').lean();
    const counts = { pending: 0, approved: 0, rejected: 0 };
    const items = [];
    for (const d of docs) {
      for (const type of CREATOR_TYPES) {
        const cp = d.creatorProfiles && d.creatorProfiles[type];
        if (!cp || !cp.artistName) continue;
        const status = cp.status || 'approved';
        counts[status] = (counts[status] || 0) + 1;
        if (status !== view) continue;
        items.push({
          userId: String(d.userId), username: d.username || '', accountType: type, label: CREATOR_LABELS[type],
          artistName: cp.artistName, country: cp.country, genre: cp.genre || '', bio: cp.bio || '',
          avatarUrl: cp.avatarUrl || null, status, requestedAt: cp.requestedAt || null,
          reviewedAt: cp.reviewedAt || null, reviewNote: cp.reviewNote || '',
        });
      }
    }
    items.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
    res.json({ items, counts });
  } catch (error) {
    console.error('[admin/creator-profiles]', error);
    res.status(500).json({ error: error.message });
  }
});

async function decideCreatorProfile(req, res, decision) {
  try {
    const { userId, type } = req.params;
    if (!CREATOR_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown profile type' });
    const profile = await SnapsaProfile.findOne({ userId }).select('creatorProfiles').lean();
    const cp = profile?.creatorProfiles?.[type];
    if (!cp || !cp.artistName) return res.status(404).json({ error: 'Request not found' });
    const note = decision === 'rejected' ? String(req.body?.reason || '').trim().slice(0, 200) : '';
    await SnapsaProfile.updateOne({ userId }, { $set: {
      [`creatorProfiles.${type}.status`]: decision,
      [`creatorProfiles.${type}.reviewedAt`]: new Date(),
      [`creatorProfiles.${type}.reviewedBy`]: req.userId,
      [`creatorProfiles.${type}.reviewNote`]: note,
    } });
    createSnapNotification({
      recipientId: userId, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type: 'report_update', priority: 'high',
      title: decision === 'approved' ? `✅ Your ${CREATOR_LABELS[type]} profile is approved` : `Your ${CREATOR_LABELS[type]} profile was not approved`,
      body: decision === 'approved' ? `"${cp.artistName}" is live — you can start posting.` : (note || 'You can edit the details and apply again.'),
      data: { kind: 'creator_decision', accountType: type, status: decision },
    }).catch(() => {});
    res.json({ success: true, status: decision });
  } catch (error) {
    console.error('[admin/creator-profiles/decide]', error);
    res.status(500).json({ error: error.message });
  }
}
app.post('/snapsa/admin/creator-profiles/:userId/:type/approve', snapAuth, requireSnapAdmin, (req, res) => decideCreatorProfile(req, res, 'approved'));
app.post('/snapsa/admin/creator-profiles/:userId/:type/reject', snapAuth, requireSnapAdmin, (req, res) => decideCreatorProfile(req, res, 'rejected'));

app.get('/snapsa/music/artist/mine/stats', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const tracks = await SnapsaTrack.find({ artistId: req.userId })
      .select('title album coverArt price playCount downloadCount purchaseCount totalRevenue createdAt')
      .sort({ playCount: -1 })
      .lean();

    const totals = tracks.reduce((acc, t) => ({
      streams: acc.streams + (t.playCount || 0),
      purchases: acc.purchases + (t.purchaseCount || 0),
      downloads: acc.downloads + (t.downloadCount || 0),
      revenueCents: acc.revenueCents + (t.totalRevenue || 0),
    }), { streams: 0, purchases: 0, downloads: 0, revenueCents: 0 });

    res.json({
      totals,
      tracks: tracks.map(t => ({
        id: t._id,
        title: t.title,
        album: t.album,
        coverUrl: t.coverArt || null,
        priceCents: t.price,
        streams: t.playCount || 0,
        purchases: t.purchaseCount || 0,
        downloads: t.downloadCount || 0,
        revenueCents: t.totalRevenue || 0,
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    console.error('[music/artist/stats]', error);
    res.status(500).json({ error: error.message });
  }
});

function parsePriceToCents(rawPrice, fallbackCents = 100) {
  const dollars = parseFloat(rawPrice);
  if (!Number.isFinite(dollars) || dollars < 0) return fallbackCents;
  return Math.round(dollars * 100);
}

app.post('/snapsa/music/tracks/upload', snapAuth, uploadLimiter,
  uploadTrackMedia.fields([{ name: 'audio', maxCount: 1 }, { name: 'preview', maxCount: 1 }, { name: 'musicVideo', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]),
  async (req, res) => {
    let tempAudioPath, tempPreviewPath, tempVideoPath, tempThumbPath;
    try {
      if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

      
      const profile = await loadCreatorProfile(req.userId, 'artist');
      if (!profile?.artistProfile?.enabled || !profile.artistProfile.artistName?.trim()) {
        return res.status(403).json({ error: 'Create an artist profile before uploading music', code: 'ARTIST_PROFILE_REQUIRED' });
      }

      const title = (req.body.title || '').trim();
      const audioFile = req.files?.audio?.[0];
      const previewFile = req.files?.preview?.[0]; // optional
      const musicVideoFile = req.files?.musicVideo?.[0]; // optional
      const thumbnailFile = req.files?.thumbnail?.[0];
      const agreementAccepted = req.body.copyrightAgreementAccepted === 'true' || req.body.copyrightAgreementAccepted === true;

      if (!title) return res.status(400).json({ error: 'Title is required' });
      if (!audioFile && !musicVideoFile) return res.status(400).json({ error: 'Upload a full track or a music video' });
      if (!agreementAccepted) {
        return res.status(400).json({ error: 'You must accept the copyright agreement before uploading' });
      }

      const artist = profile.artistProfile.artistName.trim();

      const tempDir = path.join(config.uploadDir, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const uid = uuidv4();
      let audioUploadPromise = Promise.resolve(null);
      if (audioFile) {
        tempAudioPath = path.join(tempDir, `${uid}_audio${path.extname(audioFile.originalname || '') || '.mp3'}`);
        fs.writeFileSync(tempAudioPath, audioFile.buffer);
        audioUploadPromise = uploadToCloudinary(tempAudioPath, { resourceType: 'video', folder: 'snapsa/tracks/full' });
      }

      let previewUploadPromise = Promise.resolve(null);
      if (previewFile) {
        tempPreviewPath = path.join(tempDir, `${uid}_preview${path.extname(previewFile.originalname || '') || '.mp3'}`);
        fs.writeFileSync(tempPreviewPath, previewFile.buffer);
        previewUploadPromise = uploadToCloudinary(tempPreviewPath, { resourceType: 'video', folder: 'snapsa/tracks/preview' });
      }

      let videoUploadPromise = Promise.resolve(null);
      if (musicVideoFile) {
        tempVideoPath = path.join(tempDir, `${uid}_video${path.extname(musicVideoFile.originalname || '') || '.mp4'}`);
        fs.writeFileSync(tempVideoPath, musicVideoFile.buffer);
        videoUploadPromise = uploadToCloudinary(tempVideoPath, { resourceType: 'video', folder: 'snapsa/tracks/videos' });
      }

      let thumbUploadPromise = Promise.resolve(null);
      if (thumbnailFile) {
        tempThumbPath = path.join(tempDir, `${uid}_thumb${path.extname(thumbnailFile.originalname || '') || '.jpg'}`);
        fs.writeFileSync(tempThumbPath, thumbnailFile.buffer);
        thumbUploadPromise = uploadToCloudinary(tempThumbPath, { resourceType: 'image', folder: 'snapsa/tracks/covers' });
      }

      const [audioUpload, previewUpload, videoUpload, coverUpload] = await Promise.all([
        audioUploadPromise, previewUploadPromise, videoUploadPromise, thumbUploadPromise,
      ]);

      const track = await SnapsaTrack.create({
        title,
        artist,
        artistId: req.userId,
        genre: req.body.genre || 'Other',
        album: req.body.album || '',
        isFree: req.body.isFree === 'true' || req.body.isFree === true,
        adSupported: req.body.adSupported === 'true' || req.body.adSupported === true,
        price: (req.body.isFree === 'true' || req.body.isFree === true) ? 0 : parsePriceToCents(req.body.price),
        isExplicit: req.body.isExplicit === 'true',
        tags: req.body.tags ? String(req.body.tags).split(',').map(t=>t.trim()).filter(Boolean) : [],
        audioFile: audioUpload?.secure_url || '',
        audioPublicId: audioUpload?.public_id || '',
        previewFile: previewUpload?.secure_url || '',
        previewPublicId: previewUpload?.public_id || '',
        videoFile: videoUpload?.secure_url || '',
        videoPublicId: videoUpload?.public_id || '',
        coverArt: coverUpload?.secure_url || '',
        coverPublicId: coverUpload?.public_id || '',
        duration: Math.round((audioUpload || videoUpload)?.duration || 0),
        isPublished: true,
        uploaderId: req.userId,
        copyrightAgreementAccepted: true,
        copyrightAgreementAcceptedAt: new Date(),
      });

      res.json({
        success: true,
        track: {
          id: track._id,
          title: track.title,
          artist: track.artist,
          price: track.price,
          coverUrl: track.coverArt,
          audioUrl: track.audioFile,
          previewUrl: track.previewFile,
          videoUrl: track.videoFile,
          duration: track.duration,
        }
      });
    } catch (error) {
      console.error('[music/upload]', error);
      res.status(500).json({ error: error.message });
    } finally {
      cleanupTempFiles(tempAudioPath, tempPreviewPath, tempVideoPath, tempThumbPath);
    }
  }
);

// POST /snapsa/music/tracks/upload-album — several full tracks uploaded in
// one flow, sharing an artist, thumbnail, genre and price, grouped by a
// shared albumId. `audio` and `preview` are repeated fields matched
// pairwise by upload order; `titles` is a JSON array of per-track titles in
// that same order.
app.post('/snapsa/music/tracks/upload-album', snapAuth, uploadLimiter,
  uploadTrackMedia.fields([{ name: 'audio', maxCount: 20 }, { name: 'preview', maxCount: 20 }, { name: 'musicVideo', maxCount: 20 }, { name: 'thumbnail', maxCount: 1 }]),
  async (req, res) => {
    const tempPaths = [];
    try {
      if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

      const profile = await loadCreatorProfile(req.userId, 'artist');
      if (!profile?.artistProfile?.enabled || !profile.artistProfile.artistName?.trim()) {
        return res.status(403).json({ error: 'Create an artist profile before uploading music', code: 'ARTIST_PROFILE_REQUIRED' });
      }

      const albumTitle = (req.body.albumTitle || '').trim();
      const audioFiles = req.files?.audio || [];
      const previewFiles = req.files?.preview || []; // optional, matched via previewIndexes
      const musicVideoFiles = req.files?.musicVideo || []; // optional, matched via videoIndexes
      const thumbnailFile = req.files?.thumbnail?.[0];
      const agreementAccepted = req.body.copyrightAgreementAccepted === 'true' || req.body.copyrightAgreementAccepted === true;
      let titles = [];
      try { titles = JSON.parse(req.body.titles || '[]'); } catch { titles = []; }

      
      
      
      
      let previewIndexes = [];
      try { previewIndexes = JSON.parse(req.body.previewIndexes || '[]'); } catch { previewIndexes = []; }
      let videoIndexes = [];
      try { videoIndexes = JSON.parse(req.body.videoIndexes || '[]'); } catch { videoIndexes = []; }
      const previewByTrackIndex = {};
      previewIndexes.forEach((trackIdx, i) => { if (previewFiles[i]) previewByTrackIndex[trackIdx] = previewFiles[i]; });
      const videoByTrackIndex = {};
      videoIndexes.forEach((trackIdx, i) => { if (musicVideoFiles[i]) videoByTrackIndex[trackIdx] = musicVideoFiles[i]; });

      if (!albumTitle) return res.status(400).json({ error: 'Album title is required' });
      if (audioFiles.length < 2) return res.status(400).json({ error: 'An album needs at least 2 tracks — use single upload for one track' });
      if (!agreementAccepted) return res.status(400).json({ error: 'You must accept the copyright agreement before uploading' });

      const artist = profile.artistProfile.artistName.trim();
      const tempDir = path.join(config.uploadDir, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const batchId = uuidv4();
      const albumId = uuidv4();
      const priceCents = parsePriceToCents(req.body.price);
      const albumIsFree = req.body.isFree === 'true' || req.body.isFree === true;

      let coverUpload = null;
      if (thumbnailFile) {
        const tempThumbPath = path.join(tempDir, `${batchId}_thumb${path.extname(thumbnailFile.originalname || '') || '.jpg'}`);
        fs.writeFileSync(tempThumbPath, thumbnailFile.buffer);
        tempPaths.push(tempThumbPath);
        coverUpload = await uploadToCloudinary(tempThumbPath, { resourceType: 'image', folder: 'snapsa/tracks/covers' });
      }

      const tracks = [];
      for (let i = 0; i < audioFiles.length; i++) {
        const audioFile = audioFiles[i];
        const previewFile = previewByTrackIndex[i]; 
        const musicVideoFile = videoByTrackIndex[i]; 
        const tempAudioPath = path.join(tempDir, `${batchId}_${i}_audio${path.extname(audioFile.originalname || '') || '.mp3'}`);
        fs.writeFileSync(tempAudioPath, audioFile.buffer);
        tempPaths.push(tempAudioPath);
        const audioUploadPromise = uploadToCloudinary(tempAudioPath, { resourceType: 'video', folder: 'snapsa/tracks/full' });

        let previewUploadPromise = Promise.resolve(null);
        if (previewFile) {
          const tempPreviewPath = path.join(tempDir, `${batchId}_${i}_preview${path.extname(previewFile.originalname || '') || '.mp3'}`);
          fs.writeFileSync(tempPreviewPath, previewFile.buffer);
          tempPaths.push(tempPreviewPath);
          previewUploadPromise = uploadToCloudinary(tempPreviewPath, { resourceType: 'video', folder: 'snapsa/tracks/preview' });
        }

        let videoUploadPromise = Promise.resolve(null);
        if (musicVideoFile) {
          const tempVideoPath = path.join(tempDir, `${batchId}_${i}_video${path.extname(musicVideoFile.originalname || '') || '.mp4'}`);
          fs.writeFileSync(tempVideoPath, musicVideoFile.buffer);
          tempPaths.push(tempVideoPath);
          videoUploadPromise = uploadToCloudinary(tempVideoPath, { resourceType: 'video', folder: 'snapsa/tracks/videos' });
        }

        const [audioUpload, previewUpload, videoUpload] = await Promise.all([
          audioUploadPromise, previewUploadPromise, videoUploadPromise,
        ]);

        const track = await SnapsaTrack.create({
          title: (titles[i] || audioFile.originalname || `Track ${i + 1}`).toString().trim(),
          artist,
          artistId: req.userId,
          genre: req.body.genre || 'Other',
          album: albumTitle,
          albumId,
          trackNumber: i + 1,
          isFree: albumIsFree,
          adSupported: req.body.adSupported === 'true' || req.body.adSupported === true,

          price: albumIsFree ? 0 : priceCents,
          audioFile: audioUpload.secure_url,
          audioPublicId: audioUpload.public_id,
          previewFile: previewUpload?.secure_url || '',
          previewPublicId: previewUpload?.public_id || '',
          videoFile: videoUpload?.secure_url || '',
          videoPublicId: videoUpload?.public_id || '',
          coverArt: coverUpload?.secure_url || '',
          coverPublicId: coverUpload?.public_id || '',
          duration: Math.round(audioUpload.duration || 0),
          isPublished: true,
          uploaderId: req.userId,
          copyrightAgreementAccepted: true,
          copyrightAgreementAcceptedAt: new Date(),
        });
        tracks.push({ id: track._id, title: track.title, trackNumber: track.trackNumber });
      }

      res.json({ success: true, albumId, album: albumTitle, trackCount: tracks.length, tracks });
    } catch (error) {
      console.error('[music/upload-album]', error);
      res.status(500).json({ error: error.message });
    } finally {
      cleanupTempFiles(...tempPaths);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /snapsa/music/tracks/init-upload - Initialize track upload
// ─────────────────────────────────────────────────────────────────────────────
app.post('/snapsa/music/tracks/init-upload', snapAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const {
      title,
      artist,
      genre,
      album,
      price,
      isExplicit,
      tags,
      coverArt
    } = req.body;

    if (!title || !artist) {
      return res.status(400).json({ error: 'Title and artist are required' });
    }

    const uploadId = `UPLOAD_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    
    global.musicUploads.set(uploadId, {
      userId: req.userId,
      title,
      artist,
      genre: genre || 'Other',
      album: album || '',
      price: parseInt(price) || 0,
      isExplicit: !!isExplicit,
      tags: tags || [],
      coverArt: coverArt || null,
      status: 'pending',
      createdAt: Date.now()
    });

    res.json({
      success: true,
      uploadId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      presignedUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload`,
      uploadParams: {
        upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET || 'snapsa_music',
        resource_type: 'video',
        folder: 'snapsa/tracks',
        public_id: `track_${uploadId}`,
      }
    });
  } catch (error) {
    console.error('[music/init-upload]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/music/tracks/:trackId/confirm-upload', snapAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { trackId } = req.params;
    const { cloudinaryPublicId, cloudinaryUrl, duration, coverPublicId, coverUrl } = req.body;

    if (!cloudinaryPublicId || !cloudinaryUrl) {
      return res.status(400).json({ error: 'Cloudinary public ID and URL are required' });
    }

    if (!global.musicUploads || !global.musicUploads.has(trackId)) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }

    const uploadData = global.musicUploads.get(trackId);
    
    if (uploadData.userId.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: 'Not your upload session' });
    }

    const track = await SnapsaTrack.create({
      title: uploadData.title,
      artist: uploadData.artist,
      artistId: req.userId,
      album: uploadData.album,
      genre: uploadData.genre,
      duration: parseInt(duration) || 0,
      price: uploadData.price,
      audioFile: cloudinaryUrl,
      audioPublicId: cloudinaryPublicId,
      coverArt: coverUrl || uploadData.coverArt || '',
      coverPublicId: coverPublicId || '',
      isPublished: true,
      isExplicit: uploadData.isExplicit,
      tags: uploadData.tags,
      uploaderId: req.userId,
    });

    global.musicUploads.delete(trackId);

    res.json({
      success: true,
      track: {
        id: track._id,
        title: track.title,
        artist: track.artist,
        price: track.price,
        audioUrl: track.audioFile,
        coverUrl: track.coverArt || null,
        duration: track.duration,
        genre: track.genre,
        isExplicit: track.isExplicit,
      }
    });
  } catch (error) {
    console.error('[music/confirm-upload]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /snapsa/music/genres - List available genres
// ─────────────────────────────────────────────────────────────────────────────
app.get('/snapsa/music/genres', snapAuth, async (req, res) => {
  try {
    const genres = await SnapsaTrack.distinct('genre', { isPublished: true });
    res.json({ genres: ['All', ...genres.sort()] });
  } catch (error) {
    console.error('[music/genres]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/music/artist/:artistId', snapAuth, async (req, res) => {
  try {
    const { artistId } = req.params;
    const { limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    if (restrictedIds.some(id => String(id) === String(artistId))) return res.json({ tracks: [], total: 0 });
    const query = { artistId, isPublished: true };
    const sortOption = { purchaseCount: -1, createdAt: -1 };

    const [tracks, total] = await Promise.all([
      SnapsaTrack.find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SnapsaTrack.countDocuments(query)
    ]);

    const profile = await SnapsaProfile.findOne({ userId: artistId }).lean();
    const user = await User.findById(artistId).lean();

    let purchasedMap = {};
    if (req.userId) {
      const purchases = await SnapsaPurchase.find({
        buyerId: req.userId,
        trackId: { $in: tracks.map(t => t._id) },
        status: 'completed'
      }).lean();
      purchasedMap = purchases.reduce((acc, p) => {
        acc[p.trackId.toString()] = true;
        return acc;
      }, {});
    }

    const tracksWithMetadata = tracks.map(track => ({
      ...track,
      coverUrl: track.coverArt || null,
      audioUrl: track.audioFile,
      isPurchased: !!purchasedMap[track._id.toString()],
      previewUrl: track.price === 0 ? track.audioFile : null,
    }));

    res.json({
      artist: {
        id: artistId,
        username: profile?.username || user?.displayName || 'Unknown Artist',
        avatarUrl: profile?.avatarUrl || null,
        bio: profile?.bio || '',
        trackCount: total,
      },
      tracks: tracksWithMetadata,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[music/artist]', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Snapsa TV — channel-subscription-gated shows/episodes, categorized by tab
// inside each channel's own profile (Soaps / Series / Movies / Shows).
// Watching requires an active paid subscription to the channel; downloading
// a specific episode for offline viewing is a separate, always-available
// pay-per-item action regardless of subscription status.
// ============================================================================

app.get('/snapsa/tv/categories', snapAuth, async (req, res) => res.json({ categories: TV_CATEGORIES }));

async function hasActiveChannelSubscription(userId, channelId) {
  if (!userId) return false;
  if (String(userId) === String(channelId)) return true; // channel owner always has access to their own content
  const sub = await SnapsaChannelSubscription.findOne({
    channelId, subscriberId: userId, status: 'completed', currentPeriodEnd: { $gt: new Date() },
  }).lean();
  return !!sub;
}

// Browse channels that have published TV content — the discovery surface
// before drilling into one channel's own categorized profile.
app.get('/snapsa/tv/channels', snapAuth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = { isPublished: true, channelId: { $nin: restrictedIds } };
    if (search) query.$text = { $search: search };
    const shows = await SnapsaShow.find(query).lean();
    const channelMap = new Map();
    for (const s of shows) {
      const key = s.channelId.toString();
      if (!channelMap.has(key)) channelMap.set(key, { channelId: s.channelId, channelName: s.channelName, showCount: 0, coverUrl: null });
      const entry = channelMap.get(key);
      entry.showCount += 1;
      if (!entry.coverUrl && s.coverArt) entry.coverUrl = s.coverArt;
    }
    const channelIds = [...channelMap.keys()];
    const profiles = (await SnapsaProfile.find({ userId: { $in: channelIds } }).lean()).map(p => creatorSwap(p, 'tv_channel'));
    const profileMap = profiles.reduce((acc, p) => { acc[p.userId.toString()] = p; return acc; }, {});
    res.json({
      channels: channelIds.map(id => ({
        ...channelMap.get(id),
        avatarUrl: profileMap[id]?.artistProfile?.avatarUrl || null,
        subscriptionPriceCoins: profileMap[id]?.artistProfile?.subscriptionPriceCoins || 0,
      })),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// A channel's own profile page — shows grouped into category tabs, plus
// this viewer's subscription status.
app.get('/snapsa/tv/channel/:channelId', snapAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const profile = creatorSwap(await SnapsaProfile.findOne({ userId: channelId }).lean(), 'tv_channel');
    if (!profile?.artistProfile?.enabled || profile.artistProfile.accountType !== 'tv_channel') {

      return res.status(404).json({ error: 'Channel not found' });
    }
    const shows = await SnapsaShow.find({ channelId, isPublished: true }).sort({ createdAt: -1 }).lean();
    const showIds = shows.map(s => s._id);
    const episodeCounts = await SnapsaEpisode.aggregate([
      { $match: { showId: { $in: showIds }, isPublished: true } },
      { $group: { _id: '$showId', count: { $sum: 1 } } },
    ]);
    const countMap = episodeCounts.reduce((acc, c) => { acc[c._id.toString()] = c.count; return acc; }, {});
    const subscribed = await hasActiveChannelSubscription(req.userId, channelId);
    const activeSub = req.userId ? await SnapsaChannelSubscription.findOne({ channelId, subscriberId: req.userId, status:'completed', currentPeriodEnd:{ $gt:new Date() } }).lean() : null;

    res.json({
      channel: {
        channelId,
        channelName: profile.artistProfile.artistName,
        bio: profile.artistProfile.bio,
        avatarUrl: profile.artistProfile.avatarUrl,
        subscriptionPriceCoins: profile.artistProfile.subscriptionPriceCoins || 0,
      },
      subscribed,
      subscriptionExpiresAt: activeSub?.currentPeriodEnd || null,
      showsByCategory: TV_CATEGORIES.reduce((acc, cat) => {
        acc[cat] = shows.filter(s => s.category === cat).map(s => ({
          ...s, id: s._id, coverUrl: s.coverArt || null, episodeCount: countMap[s._id.toString()] || 0,
        }));
        return acc;
      }, {}),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/tv/channel/mine/shows', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const shows = await SnapsaShow.find({ channelId: req.userId }).sort({ createdAt: -1 }).lean();
    const episodeCounts = await SnapsaEpisode.aggregate([
      { $match: { channelId: new mongoose.Types.ObjectId(req.userId) } },
      { $group: { _id: '$showId', count: { $sum: 1 } } },
    ]);
    const countMap = episodeCounts.reduce((acc, c) => { acc[c._id.toString()] = c.count; return acc; }, {});
    res.json({ shows: shows.map(s => ({ ...s, id: s._id, coverUrl: s.coverArt || null, episodeCount: countMap[s._id.toString()] || 0 })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/tv/shows', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const profile = creatorSwap(await SnapsaProfile.findOne({ userId: req.userId }).lean(), 'tv_channel');
    if (!profile?.artistProfile?.enabled || profile.artistProfile.accountType !== 'tv_channel') {

      return res.status(403).json({ error: 'Create a TV Channel profile before adding a show', code: 'CHANNEL_PROFILE_REQUIRED' });
    }
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Show title is required' });
    const category = TV_CATEGORIES.includes(req.body.category) ? req.body.category : 'Series';

    let coverUpload = null;
    if (req.body.coverBase64) {
      coverUpload = await uploadBase64ToCloudinary(req.body.coverBase64, { resourceType: 'image', folder: 'snapsa/tv/covers' });
    }

    const show = await SnapsaShow.create({
      title,
      category,
      channelName: profile.artistProfile.artistName,
      channelId: req.userId,
      description: (req.body.description || '').slice(0, 500),
      genre: req.body.genre || 'Other',
      coverArt: coverUpload?.secure_url || '',
      coverPublicId: coverUpload?.public_id || '',
    });
    res.json({ success: true, show: { ...show.toObject(), id: show._id, coverUrl: show.coverArt || null } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// A show's episode list — video URLs are only included for episodes the
// viewer can actually watch (active subscription or channel owner).
app.get('/snapsa/tv/shows/:showId', snapAuth, async (req, res) => {
  try {
    const show = await SnapsaShow.findById(req.params.showId).lean();
    if (!show) return res.status(404).json({ error: 'Show not found' });
    const episodes = await SnapsaEpisode.find({ showId: show._id, isPublished: true }).sort({ episodeNumber: 1, createdAt: 1 }).lean();
    const canWatch = await hasActiveChannelSubscription(req.userId, show.channelId);

    let downloadedMap = {};
    if (req.userId) {
      const downloads = await SnapsaEpisodeDownload.find({
        buyerId: req.userId, episodeId: { $in: episodes.map(e => e._id) }, status: 'completed'
      }).lean();
      downloadedMap = downloads.reduce((acc, d) => { acc[d.episodeId.toString()] = true; return acc; }, {});
    }

    res.json({
      show: { ...show, id: show._id, coverUrl: show.coverArt || null },
      canWatch,
      episodes: episodes.map(ep => ({
        ...ep,
        id: ep._id,
        thumbUrl: ep.thumbnail || show.coverArt || null,
        videoFile: canWatch ? ep.videoFile : null, // withheld unless subscribed
        canDownload: ep.downloadIsFree || !!downloadedMap[ep._id.toString()],
        downloaded: !!downloadedMap[ep._id.toString()],
      })),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/tv/episodes/upload', snapAuth, uploadLimiter,
  uploadTrackMedia.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]),
  async (req, res) => {
    let tempVideoPath, tempThumbPath;
    try {
      if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
      const profile = await loadCreatorProfile(req.userId, 'tv_channel');
      if (!profile?.artistProfile?.enabled || profile.artistProfile.accountType !== 'tv_channel') {
        return res.status(403).json({ error: 'Create a TV Channel profile before uploading episodes', code: 'CHANNEL_PROFILE_REQUIRED' });
      }

      const show = await SnapsaShow.findOne({ _id: req.body.showId, channelId: req.userId });
      if (!show) return res.status(404).json({ error: 'Show not found' });

      const title = (req.body.title || '').trim();
      const videoFile = req.files?.video?.[0];
      const thumbnailFile = req.files?.thumbnail?.[0];
      const agreementAccepted = req.body.copyrightAgreementAccepted === 'true' || req.body.copyrightAgreementAccepted === true;
      const downloadIsFree = req.body.downloadIsFree === 'true' || req.body.downloadIsFree === true;

      if (!title) return res.status(400).json({ error: 'Episode title is required' });
      if (!videoFile) return res.status(400).json({ error: 'Upload an episode video' });
      if (!agreementAccepted) return res.status(400).json({ error: 'You must accept the copyright agreement before uploading' });

      const tempDir = path.join(config.uploadDir, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const uid = uuidv4();

      tempVideoPath = path.join(tempDir, `${uid}_episode${path.extname(videoFile.originalname || '') || '.mp4'}`);
      fs.writeFileSync(tempVideoPath, videoFile.buffer);
      const videoUploadPromise = uploadToCloudinary(tempVideoPath, { resourceType: 'video', folder: 'snapsa/tv/episodes' });

      let thumbUploadPromise = Promise.resolve(null);
      if (thumbnailFile) {
        tempThumbPath = path.join(tempDir, `${uid}_thumb${path.extname(thumbnailFile.originalname || '') || '.jpg'}`);
        fs.writeFileSync(tempThumbPath, thumbnailFile.buffer);
        thumbUploadPromise = uploadToCloudinary(tempThumbPath, { resourceType: 'image', folder: 'snapsa/tv/thumbnails' });
      }

      const [videoUpload, thumbUpload] = await Promise.all([videoUploadPromise, thumbUploadPromise]);

      const episodeNumber = await SnapsaEpisode.countDocuments({ showId: show._id }) + 1;
      const episode = await SnapsaEpisode.create({
        showId: show._id,
        title,
        episodeNumber,
        description: (req.body.description || '').slice(0, 500),
        channelId: req.userId,
        channelName: profile.artistProfile.artistName,
        downloadIsFree,
        downloadPrice: downloadIsFree ? 0 : parsePriceToCents(req.body.price),
        videoFile: videoUpload.secure_url,
        videoPublicId: videoUpload.public_id,
        thumbnail: thumbUpload?.secure_url || '',
        thumbnailPublicId: thumbUpload?.public_id || '',
        duration: Math.round(videoUpload?.duration || 0),
        isExplicit: req.body.isExplicit === 'true',
        copyrightAgreementAccepted: true,
        copyrightAgreementAcceptedAt: new Date(),
      });

      res.json({ success: true, episode: { ...episode.toObject(), id: episode._id } });
    } catch (error) {
      console.error('[tv/episodes/upload]', error);
      res.status(500).json({ error: error.message });
    } finally {
      try { if (tempVideoPath) fs.unlinkSync(tempVideoPath); } catch {}
      try { if (tempThumbPath) fs.unlinkSync(tempThumbPath); } catch {}
    }
  });

app.post('/snapsa/tv/episodes/:episodeId/view', snapAuth, async (req, res) => {
  try {
    const episode = await SnapsaEpisode.findById(req.params.episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    const canWatch = await hasActiveChannelSubscription(req.userId, episode.channelId);
    if (!canWatch) return res.status(403).json({ error: 'Subscribe to this channel to watch' });
    episode.viewCount += 1;
    await episode.save();
    res.json({ success: true, viewCount: episode.viewCount });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── TV channel subscriptions (required to watch, one price per channel) ───
app.post('/snapsa/tv/subscribe/init', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'Channel ID required' });
    if (String(channelId) === String(req.userId)) return res.status(400).json({ error: "You can't subscribe to your own channel" });

    const alreadySubscribed = await hasActiveChannelSubscription(req.userId, channelId);
    if (alreadySubscribed) return res.status(409).json({ error: 'Already subscribed' });

    const profile = await SnapsaProfile.findOne({ userId: channelId }).lean();
    if (!profile?.artistProfile?.enabled || profile.artistProfile.accountType !== 'tv_channel') {
      return res.status(404).json({ error: 'Channel not found' });
    }
    const price = profile.artistProfile.subscriptionPriceCoins || 0;
    if (price <= 0) return res.status(400).json({ error: 'This channel has not set a subscription price yet' });

    session = await mongoose.startSession();
    session.startTransaction();

    const balance = await getSnapsaCoinBalance(req.userId, { session });
    if (balance < price) throw new Error(`Insufficient coins. Balance: ${balance}, Price: ${price}`);

    const txRef = `TVSUB_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const sub = await SnapsaChannelSubscription.create([{
      channelId, subscriberId: req.userId, price, transactionRef: txRef, status: 'pending',
      metadata: { channelName: profile.artistProfile.artistName },
    }], { session });

    await session.commitTransaction();
    res.json({ success: true, transactionRef: txRef, amount: price, channelName: profile.artistProfile.artistName });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[tv/subscribe/init]', error);
    res.status(500).json({ error: error.message || 'Subscription initialization failed' });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/tv/subscribe/status/:txRef', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const sub = await SnapsaChannelSubscription.findOne({ transactionRef: req.params.txRef });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    if (sub.subscriberId.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not your subscription' });

    if (sub.status === 'completed') return res.json({ status: 'completed', currentPeriodEnd: sub.currentPeriodEnd });

    if (sub.status === 'pending') {
      session = await mongoose.startSession();
      session.startTransaction();
      const balance = await getSnapsaCoinBalance(req.userId, { session });
      if (balance < sub.price) {
        sub.status = 'failed';
        await sub.save({ session });
        await session.commitTransaction();
        return res.status(400).json({ status: 'failed', error: 'Insufficient balance. Subscription cancelled.' });
      }

      await awardCoins(req.userId, -sub.price, { session });
      await logCoinTransaction({
        userId: req.userId, type: 'debit', amount: -sub.price,
        description: `TV channel subscription: ${sub.transactionRef}`,
        reference: sub._id, referenceModel: 'SnapsaChannelSubscription',
        metadata: { channelId: sub.channelId },
      }, { session });

      await awardCoins(sub.channelId, sub.price, { session });
      await logCoinTransaction({
        userId: sub.channelId, type: 'credit', amount: sub.price,
        description: `New channel subscriber: ${sub.transactionRef}`,
        reference: sub._id, referenceModel: 'SnapsaChannelSubscription',
        metadata: { subscriberId: req.userId },
      }, { session });

      sub.status = 'completed';
      sub.completedAt = new Date();
      sub.currentPeriodEnd = new Date(Date.now() + 30 * 86400000); // 30-day period, renew by subscribing again
      await sub.save({ session });
      await session.commitTransaction();

      createSnapNotification({
        recipientId: sub.channelId, senderId: req.userId, type: 'tv_subscription',
        title: '📺 New channel subscriber!',
        body: `Someone subscribed to ${sub.metadata?.channelName || 'your channel'} for ${sub.price} coins`,
        data: { subscriptionId: sub._id }, priority: 'medium', expiresAt: new Date(Date.now() + 30 * 86400000),
      }).catch(() => {});

      res.json({ status: 'completed', currentPeriodEnd: sub.currentPeriodEnd });
    } else {
      res.json({ status: sub.status });
    }
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[tv/subscribe/status]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

// ─── Pay-per-download (TV episodes) — independent of subscription status ───
app.post('/snapsa/tv/episodes/:episodeId/download/init', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const episode = await SnapsaEpisode.findById(req.params.episodeId).lean();
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.downloadIsFree) return res.status(400).json({ error: 'This download is free' });

    const existing = await SnapsaEpisodeDownload.findOne({ episodeId: episode._id, buyerId: req.userId, status: 'completed' });
    if (existing) return res.status(409).json({ error: 'Already purchased' });

    session = await mongoose.startSession();
    session.startTransaction();
    const balance = await getSnapsaCoinBalance(req.userId, { session });
    if (balance < episode.downloadPrice) throw new Error(`Insufficient coins. Balance: ${balance}, Price: ${episode.downloadPrice}`);

    const txRef = `TVDL_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const purchase = await SnapsaEpisodeDownload.create([{
      episodeId: episode._id, buyerId: req.userId, sellerId: episode.channelId, price: episode.downloadPrice,
      transactionRef: txRef, status: 'pending',
      platformFee: Math.floor(episode.downloadPrice * 0.2), sellerPayout: Math.floor(episode.downloadPrice * 0.8),
      metadata: { episodeTitle: episode.title },
    }], { session });

    await session.commitTransaction();
    res.json({ success: true, transactionRef: txRef, amount: episode.downloadPrice, episodeTitle: episode.title });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[tv/episodes/download/init]', error);
    res.status(500).json({ error: error.message || 'Purchase initialization failed' });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/tv/download/status/:txRef', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const purchase = await SnapsaEpisodeDownload.findOne({ transactionRef: req.params.txRef });
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.buyerId.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not your purchase' });

    if (purchase.status === 'completed') {
      const episode = await SnapsaEpisode.findById(purchase.episodeId).lean();
      return res.json({ status: 'completed', downloadUrl: episode.videoFile });
    }

    if (purchase.status === 'pending') {
      session = await mongoose.startSession();
      session.startTransaction();
      const balance = await getSnapsaCoinBalance(req.userId, { session });
      if (balance < purchase.price) {
        purchase.status = 'failed';
        await purchase.save({ session });
        await session.commitTransaction();
        return res.status(400).json({ status: 'failed', error: 'Insufficient balance. Purchase cancelled.' });
      }

      await awardCoins(req.userId, -purchase.price, { session });
      await logCoinTransaction({
        userId: req.userId, type: 'debit', amount: -purchase.price,
        description: `TV download: ${purchase.transactionRef}`,
        reference: purchase._id, referenceModel: 'SnapsaEpisodeDownload', metadata: { episodeId: purchase.episodeId },
      }, { session });

      await awardCoins(purchase.sellerId, purchase.sellerPayout, { session });
      await logCoinTransaction({
        userId: purchase.sellerId, type: 'credit', amount: purchase.sellerPayout,
        description: `TV download sale: ${purchase.transactionRef}`,
        reference: purchase._id, referenceModel: 'SnapsaEpisodeDownload', metadata: { episodeId: purchase.episodeId },
      }, { session });

      purchase.status = 'completed';
      purchase.completedAt = new Date();
      await purchase.save({ session });

      await SnapsaEpisode.findByIdAndUpdate(purchase.episodeId, {
        $inc: { downloadCount: 1, totalDownloadRevenue: purchase.sellerPayout },
      }, { session });

      await session.commitTransaction();
      const episode = await SnapsaEpisode.findById(purchase.episodeId).lean();
      treasuryMove(purchase.price - purchase.sellerPayout, { kind: 'tv_fee', userId: purchase.sellerId, note: `TV sale ${purchase.transactionRef}` }).catch(() => {});   
      res.json({ status: 'completed', downloadUrl: episode.videoFile });
    } else {
      res.json({ status: purchase.status });
    }
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[tv/download/status]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

// ============================================================================
// Snapsa Radio & Podcasts — flat, free-to-stream post feeds per channel
// (like a Facebook page posting videos). Subscribing is free and optional,
// just a "support this creator" follow. Downloading for offline is the
// only paid action, always available regardless of follow status.
// ============================================================================

app.get('/snapsa/channel/posts', snapAuth, async (req, res) => {
  try {
    const { accountType, search, channelId } = req.query;
    const query = { isPublished: true, channelId: { $nin: restrictedIds } };
    if (accountType && ['radio_station','podcast','news_channel'].includes(accountType)) query.accountType = accountType;
    if (channelId) query.channelId = restrictedIds.some(id => String(id) === String(channelId)) ? { $in: [] } : channelId;
    if (search) query.$text = { $search: search };
    const posts = await SnapsaChannelPost.find(query).sort({ createdAt: -1 }).limit(100).lean();

    let downloadedMap = {};
    if (req.userId) {
      const downloads = await SnapsaPostDownload.find({
        buyerId: req.userId, postId: { $in: posts.map(p => p._id) }, status: 'completed'
      }).lean();
      downloadedMap = downloads.reduce((acc, d) => { acc[d.postId.toString()] = true; return acc; }, {});
    }

    res.json({
      posts: posts.map(p => ({
        ...p, id: p._id, thumbUrl: p.thumbnail || null,
        canDownload: p.downloadIsFree || !!downloadedMap[p._id.toString()],
        downloaded: !!downloadedMap[p._id.toString()],
      })),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/channel/:channelId/profile', snapAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const profile = creatorSwap(await SnapsaProfile.findOne({ userId: channelId }).lean(), channelTypesFromReq(req));
    if (!profile?.artistProfile?.enabled || !['radio_station','podcast','news_channel'].includes(profile.artistProfile.accountType)) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    const followerCount = await SnapsaChannelFollow.countDocuments({ channelId });
    const following = req.userId ? !!(await SnapsaChannelFollow.findOne({ channelId, followerId: req.userId }).lean()) : false;
    res.json({
      channel: {
        channelId, accountType: profile.artistProfile.accountType,
        channelName: profile.artistProfile.artistName, bio: profile.artistProfile.bio,
        avatarUrl: profile.artistProfile.avatarUrl, followerCount,
      },
      following,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/channel/:channelId/follow', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const { channelId } = req.params;
    const existing = await SnapsaChannelFollow.findOne({ channelId, followerId: req.userId });
    if (existing) {
      await existing.deleteOne();
      return res.json({ following: false });
    }
    await SnapsaChannelFollow.create({ channelId, followerId: req.userId });
    res.json({ following: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/channel/mine/posts', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    const posts = await SnapsaChannelPost.find({ channelId: req.userId }).sort({ createdAt: -1 }).lean();
    res.json({ posts: posts.map(p => ({ ...p, id: p._id, thumbUrl: p.thumbnail || null })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/channel/posts/upload', snapAuth, uploadLimiter,
  uploadTrackMedia.fields([{ name: 'media', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'photos', maxCount: 10 }]),
  async (req, res) => {
    let tempMediaPath, tempThumbPath;
    const tempPhotoPaths = [];
    try {
      if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
      const profile = await loadCreatorProfile(req.userId, channelTypesFromReq(req));
      const accountType = profile?.artistProfile?.accountType;
      if (!profile?.artistProfile?.enabled || !['radio_station','podcast','news_channel'].includes(accountType)) {
        return res.status(403).json({ error: 'Create a Radio Station, Podcast, or News Channel profile before posting', code: 'CHANNEL_PROFILE_REQUIRED' });
      }

      const title = (req.body.title || '').trim();
      const postType = req.body.postType === 'article' && accountType === 'news_channel' ? 'article' : 'video';
      const agreementAccepted = req.body.copyrightAgreementAccepted === 'true' || req.body.copyrightAgreementAccepted === true;
      const downloadIsFree = req.body.downloadIsFree === 'true' || req.body.downloadIsFree === true;

      if (!title) return res.status(400).json({ error: 'Title is required' });
      if (!agreementAccepted) return res.status(400).json({ error: 'You must accept the copyright agreement before uploading' });

      const tempDir = path.join(config.uploadDir, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const uid = uuidv4();

      if (postType === 'article') {
        // Text + photos — no video/audio file needed. At least one photo
        // or some body text is required so the post isn't completely empty.
        const photoFiles = req.files?.photos || [];
        const body = (req.body.body || '').slice(0, 5000);
        if (photoFiles.length === 0 && !body.trim()) {
          return res.status(400).json({ error: 'Add some text or at least one photo' });
        }
        const photoUploads = await Promise.all(photoFiles.map((file, i) => {
          const p = path.join(tempDir, `${uid}_photo${i}${path.extname(file.originalname || '') || '.jpg'}`);
          fs.writeFileSync(p, file.buffer);
          tempPhotoPaths.push(p);
          return uploadToCloudinary(p, { resourceType: 'image', folder: 'snapsa/channel-posts/photos' });
        }));

        const post = await SnapsaChannelPost.create({
          channelId: req.userId,
          channelName: profile.artistProfile.artistName,
          accountType,
          postType: 'article',
          title,
          description: (req.body.description || '').slice(0, 500),
          body,
          photos: photoUploads.map(u => ({ url: u.secure_url, publicId: u.public_id })),
          downloadIsFree: true, // article posts are just text/photos — nothing paid to download
          copyrightAgreementAccepted: true,
          copyrightAgreementAcceptedAt: new Date(),
        });
        return res.json({ success: true, post: { ...post.toObject(), id: post._id } });
      }

      const mediaFile = req.files?.media?.[0];
      const thumbnailFile = req.files?.thumbnail?.[0];
      if (!mediaFile) return res.status(400).json({ error: 'Upload a video or audio file' });

      const mediaType = /^audio\//.test(mediaFile.mimetype) ? 'audio' : 'video';

      tempMediaPath = path.join(tempDir, `${uid}_post${path.extname(mediaFile.originalname || '') || (mediaType==='audio'?'.mp3':'.mp4')}`);
      fs.writeFileSync(tempMediaPath, mediaFile.buffer);
      const mediaUploadPromise = uploadToCloudinary(tempMediaPath, { resourceType: 'video', folder: 'snapsa/channel-posts' });

      let thumbUploadPromise = Promise.resolve(null);
      if (thumbnailFile) {
        tempThumbPath = path.join(tempDir, `${uid}_thumb${path.extname(thumbnailFile.originalname || '') || '.jpg'}`);
        fs.writeFileSync(tempThumbPath, thumbnailFile.buffer);
        thumbUploadPromise = uploadToCloudinary(tempThumbPath, { resourceType: 'image', folder: 'snapsa/channel-posts/thumbnails' });
      }

      const [mediaUpload, thumbUpload] = await Promise.all([mediaUploadPromise, thumbUploadPromise]);

      const post = await SnapsaChannelPost.create({
        channelId: req.userId,
        channelName: profile.artistProfile.artistName,
        accountType,
        postType: 'video',
        title,
        description: (req.body.description || '').slice(0, 500),
        mediaFile: mediaUpload.secure_url,
        mediaPublicId: mediaUpload.public_id,
        mediaType,
        thumbnail: thumbUpload?.secure_url || '',
        thumbnailPublicId: thumbUpload?.public_id || '',
        duration: Math.round(mediaUpload?.duration || 0),
        downloadIsFree,
        downloadPrice: downloadIsFree ? 0 : parsePriceToCents(req.body.price),
        copyrightAgreementAccepted: true,
        copyrightAgreementAcceptedAt: new Date(),
      });

      res.json({ success: true, post: { ...post.toObject(), id: post._id } });
    } catch (error) {
      console.error('[channel/posts/upload]', error);
      res.status(500).json({ error: error.message });
    } finally {
      try { if (tempMediaPath) fs.unlinkSync(tempMediaPath); } catch {}
      try { if (tempThumbPath) fs.unlinkSync(tempThumbPath); } catch {}
      for (const p of tempPhotoPaths) { try { fs.unlinkSync(p); } catch {} }
    }
  });

app.post('/snapsa/channel/posts/:postId/view', snapAuth, async (req, res) => {
  try {
    const post = await SnapsaChannelPost.findByIdAndUpdate(req.params.postId, { $inc: { viewCount: 1 } }, { new: true }).lean();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true, viewCount: post.viewCount });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/channel/posts/:postId/download/init', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const post = await SnapsaChannelPost.findById(req.params.postId).lean();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.downloadIsFree) return res.status(400).json({ error: 'This download is free' });

    const existing = await SnapsaPostDownload.findOne({ postId: post._id, buyerId: req.userId, status: 'completed' });
    if (existing) return res.status(409).json({ error: 'Already purchased' });

    session = await mongoose.startSession();
    session.startTransaction();
    const balance = await getSnapsaCoinBalance(req.userId, { session });
    if (balance < post.downloadPrice) throw new Error(`Insufficient coins. Balance: ${balance}, Price: ${post.downloadPrice}`);

    const txRef = `POSTDL_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await SnapsaPostDownload.create([{
      postId: post._id, buyerId: req.userId, sellerId: post.channelId, price: post.downloadPrice,
      transactionRef: txRef, status: 'pending',
      platformFee: Math.floor(post.downloadPrice * 0.2), sellerPayout: Math.floor(post.downloadPrice * 0.8),
      metadata: { postTitle: post.title },
    }], { session });

    await session.commitTransaction();
    res.json({ success: true, transactionRef: txRef, amount: post.downloadPrice, postTitle: post.title });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[channel/posts/download/init]', error);
    res.status(500).json({ error: error.message || 'Purchase initialization failed' });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/channel/posts/download/status/:txRef', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
    const purchase = await SnapsaPostDownload.findOne({ transactionRef: req.params.txRef });
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.buyerId.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not your purchase' });

    if (purchase.status === 'completed') {
      const post = await SnapsaChannelPost.findById(purchase.postId).lean();
      return res.json({ status: 'completed', downloadUrl: post.mediaFile });
    }

    if (purchase.status === 'pending') {
      session = await mongoose.startSession();
      session.startTransaction();
      const balance = await getSnapsaCoinBalance(req.userId, { session });
      if (balance < purchase.price) {
        purchase.status = 'failed';
        await purchase.save({ session });
        await session.commitTransaction();
        return res.status(400).json({ status: 'failed', error: 'Insufficient balance. Purchase cancelled.' });
      }

      await awardCoins(req.userId, -purchase.price, { session });
      await logCoinTransaction({
        userId: req.userId, type: 'debit', amount: -purchase.price,
        description: `Download: ${purchase.transactionRef}`,
        reference: purchase._id, referenceModel: 'SnapsaPostDownload', metadata: { postId: purchase.postId },
      }, { session });

      await awardCoins(purchase.sellerId, purchase.sellerPayout, { session });
      await logCoinTransaction({
        userId: purchase.sellerId, type: 'credit', amount: purchase.sellerPayout,
        description: `Download sale: ${purchase.transactionRef}`,
        reference: purchase._id, referenceModel: 'SnapsaPostDownload', metadata: { postId: purchase.postId },
      }, { session });

      purchase.status = 'completed';
      purchase.completedAt = new Date();
      await purchase.save({ session });

      await SnapsaChannelPost.findByIdAndUpdate(purchase.postId, {
        $inc: { downloadCount: 1, totalDownloadRevenue: purchase.sellerPayout },
      }, { session });

      await session.commitTransaction();
      const post = await SnapsaChannelPost.findById(purchase.postId).lean();
      treasuryMove(purchase.price - purchase.sellerPayout, { kind: 'channel_fee', userId: purchase.sellerId, note: `Channel sale ${purchase.transactionRef}` }).catch(() => {});    
      res.json({ status: 'completed', downloadUrl: post.mediaFile });
    } else {
      res.json({ status: purchase.status });
    }
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[channel/posts/download/status]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

// ============================================================================
// Report / Block / Hide (user-facing)
// ============================================================================

app.post('/snapsa/reports', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to report' });
    const { targetType, targetId, reason } = req.body;
    const description = String(req.body.description || '').trim().slice(0, 500);
    if (!REPORT_TARGET_TYPES.includes(targetType) || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ error: 'Invalid report' });
    }
    if (!REPORT_REASONS[reason]) return res.status(400).json({ error: 'Choose a reason' });

    const recent = await SnapsaReport.countDocuments({ reporterId: req.userId, createdAt: { $gte: new Date(Date.now() - 3600000) } });
    if (recent >= 20) return res.status(429).json({ error: 'Too many reports — try again later' });

    let targetUserId = null;
    let snapshot = {};
    if (targetType === 'user') {
      const p = await SnapsaProfile.findOne({ userId: targetId }).select('username bio').lean();
      if (!p) return res.status(404).json({ error: 'User not found' });
      targetUserId = targetId;
      snapshot = { username: p.username, bio: p.bio };
    } else if (targetType === 'video') {
      const sv = await SnapsaVideo.findById(targetId).lean();
      if (!sv) return res.status(404).json({ error: 'Video not found' });
      const post = await Post.findById(sv.postId).select('content').lean();
      targetUserId = sv.authorId;
      snapshot = { caption: post?.content || '', thumbUrl: sv.thumbFile || '', videoUrl: sv.videoFile || '', authorName: sv.authorName || '' };
    } else if (targetType === 'comment') {
      const c = await Comment.findById(targetId).lean();
      if (!c) return res.status(404).json({ error: 'Comment not found' });
      targetUserId = c.userId;
      snapshot = { text: c.content };
    } else {
      const m = await SnapsaMessage.findById(targetId).lean();
      if (!m || String(m.receiverId) !== String(req.userId)) return res.status(404).json({ error: 'Message not found' });
      targetUserId = m.senderId;
      snapshot = { text: m.text || '', type: m.type, mediaUrl: m.mediaFile ? mediaUrl(req, m.mediaFile) : null };
    }
    if (String(targetUserId) === String(req.userId)) return res.status(400).json({ error: "You can't report yourself" });
    if (String(targetUserId) === SNAPSA_SYSTEM_ACCOUNT_ID) return res.status(400).json({ error: "This can't be reported" });

    try {
      await SnapsaReport.create({
        reporterId: req.userId, targetType, targetId, targetUserId, reason, description,
        snapshot, weight: REPORT_REASONS[reason].weight,
      });
    } catch (e) {
      if (e.code === 11000) return res.json({ success: true, alreadyReported: true });
      throw e;
    }
        notifyAllAdmins({
      senderId: req.userId, type: 'report_update', priority: 'high',
      title: `🚩 New report: ${targetType}`,
      body: `${REPORT_REASONS[reason].label || reason}${description ? ' — ' + description.slice(0, 80) : ''}`,
      data: { kind: 'new_report', targetType, targetId: String(targetId) },
    }, req.userId);
    res.json({ success: true });
  } catch (error) {
    console.error('[report]', error);

    res.status(500).json({ error: error.message });
  }
});

// Block is one-way: the blocked person can no longer see the blocker's videos
// or profile, message them, comment, or follow them. The blocker still sees them.
app.post('/snapsa/blocks/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const target = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(target)) return res.status(400).json({ error: 'Invalid user' });
    if (String(target) === String(req.userId)) return res.status(400).json({ error: "You can't block yourself" });
    if (String(target) === SNAPSA_SYSTEM_ACCOUNT_ID) return res.status(400).json({ error: "You can't block Snapsa" });
    try { await SnapsaBlock.create({ blockerId: req.userId, blockedId: target }); }
    catch (e) { if (e.code !== 11000) throw e; }
    // They can't keep following someone who blocked them.
    const removed = await Follower.deleteMany({ followerId: target, followingId: req.userId });
    if (removed.deletedCount) {
      await User.findByIdAndUpdate(req.userId, { $inc: { followerCount: -removed.deletedCount } });
      await User.findByIdAndUpdate(target, { $inc: { followingCount: -removed.deletedCount } });
    }
    res.json({ success: true, blocked: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/snapsa/blocks/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    await SnapsaBlock.deleteOne({ blockerId: req.userId, blockedId: req.params.userId });
    res.json({ success: true, blocked: false });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Hide = "I don't want to see this person's posts" — only affects the hider's feed.
app.post('/snapsa/hides/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const target = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(target) || String(target) === String(req.userId)) {
      return res.status(400).json({ error: 'Invalid user' });
    }
    try { await SnapsaHide.create({ userId: req.userId, hiddenUserId: target }); }
    catch (e) { if (e.code !== 11000) throw e; }
    res.json({ success: true, hidden: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/snapsa/hides/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    await SnapsaHide.deleteOne({ userId: req.userId, hiddenUserId: req.params.userId });
    res.json({ success: true, hidden: false });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/safety/status/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId || !mongoose.Types.ObjectId.isValid(req.params.userId)) return res.json({ blockedByMe: false, blockedByThem: false, hiddenByMe: false });
    const [blockedByMe, blockedByThem, hidden] = await Promise.all([
      isBlockedBy(req.userId, req.params.userId),
      isBlockedBy(req.params.userId, req.userId),
      SnapsaHide.exists({ userId: _oid(req.userId), hiddenUserId: _oid(req.params.userId) }),
    ]);
    res.json({ blockedByMe, blockedByThem, hiddenByMe: !!hidden });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/safety/lists', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.json({ blocked: [], hidden: [] });
    const [blocks, hides] = await Promise.all([
      SnapsaBlock.find({ blockerId: req.userId }).sort({ createdAt: -1 }).lean(),
      SnapsaHide.find({ userId: req.userId }).sort({ createdAt: -1 }).lean(),
    ]);
    const ids = [...blocks.map(b => b.blockedId), ...hides.map(h => h.hiddenUserId)];
    const profiles = await SnapsaProfile.find({ userId: { $in: ids } }).select('userId username avatarUrl').lean();
    const pmap = new Map(profiles.map(p => [String(p.userId), p]));
    const shape = (id, at) => ({ userId: id, username: pmap.get(String(id))?.username || 'Unknown', avatarUrl: pmap.get(String(id))?.avatarUrl || null, at });
    res.json({
      blocked: blocks.map(b => shape(b.blockedId, b.createdAt)),
      hidden: hides.map(h => shape(h.hiddenUserId, h.createdAt)),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================================
// Developer/Admin 
// ============================================================================

async function countOnlineUsersGlobal() {
  if (!REDIS_ENABLED) return liveState.snapRealtime?.size || 0;
  try {
    let cursor = '0', count = 0;
    do {
      const [nextCursor, keys] = await redisPub.scan(cursor, 'MATCH', 'snapsa:online:*', 'COUNT', 200);
      count += keys.length;
      cursor = nextCursor;
    } while (cursor !== '0');
    return count;
  } catch (e) {
    logRedisError('online:scan', e);
    return liveState.snapRealtime?.size || 0;
  }
}

async function ensureSnapsaSystemAccount() {
  const existing = await SnapsaProfile.findOne({ userId: SNAPSA_SYSTEM_ACCOUNT_ID }).lean();
  if (existing) return existing;
  return SnapsaProfile.create({
    userId: SNAPSA_SYSTEM_ACCOUNT_ID,
    username: 'Snapsa',
    bio: 'Official Snapsa updates',
    isSystemAccount: true,
  });
}
// Founder-only: how many coins the platform holds and the latest movements.
app.get('/snapsa/admin/treasury', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    if (!req.isSnapFounder) return res.status(403).json({ error: 'Founder access only' });
    const t = await SnapsaTreasury.findOne({ key: 'main' }).lean();
    const byKind = await SnapsaTreasuryEntry.aggregate([{ $group: { _id: '$kind', coins: { $sum: '$amount' }, count: { $sum: 1 } } }]);
    const recent = await SnapsaTreasuryEntry.find().sort({ at: -1 }).limit(50).lean();
    res.json({
      balance: t?.balance || 0, totalIn: t?.totalIn || 0, totalOut: t?.totalOut || 0,
      coinValueUsd: SNAPSA_COIN_VALUE_USD, coinValueZar: SNAPSA_COIN_VALUE_ZAR, balanceUsd: +((t?.balance || 0) * SNAPSA_COIN_VALUE_USD).toFixed(2), balanceZar: +((t?.balance || 0) * SNAPSA_COIN_VALUE_ZAR).toFixed(2),
      byKind, recent,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/snapsa/admin/check', snapAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({
        isAdmin: false,
        error: 'Authentication required'
      });
    }

    const status = await getSnapAdminStatus(req);

    return res.json({
      isAdmin: status.isAdmin || status.founder,
      founder: status.founder
    });
  } catch (error) {
    console.error('[SNAPSA ADMIN CHECK]', error);

    return res.status(500).json({
      isAdmin: false,
      error: 'Unable to check admin status'
    });
  }
});
        
app.get('/snapsa/admin/stats', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const [totalAccounts, onlineNow, activeToday, activeThisWeek, activeThisMonth] = await Promise.all([
      SnapsaProfile.countDocuments({ isSystemAccount: { $ne: true }, userId: { $ne: null } }),
      countOnlineUsersGlobal(),
      SnapsaProfile.countDocuments({ lastActiveAt: { $gte: new Date(now - day) } }),
      SnapsaProfile.countDocuments({ lastActiveAt: { $gte: new Date(now - 7 * day), $lt: new Date(now - day) } }),
      SnapsaProfile.countDocuments({ lastActiveAt: { $gte: new Date(now - 30 * day), $lt: new Date(now - 7 * day) } }),
    ]);
    const inactive = Math.max(0, totalAccounts - activeToday - activeThisWeek - activeThisMonth);
    const openReports = await SnapsaReport.countDocuments({ status: 'open' });
    const pendingApplications = await SnapsaWalletApplication.countDocuments({ status: 'pending' });
    const pendingVerifications = await SnapsaVerification.countDocuments({ requestStatus: 'pending' });    
    const payoutsQueued = await SnapsaWalletPayout.countDocuments({ status: 'queued' });
        // Country is stored encrypted, so it can't be grouped inside MongoDB — count it here instead.
    const countryProfiles = await SnapsaProfile.find({ isSystemAccount: { $ne: true }, userId: { $ne: null } }).select('countryCode countryName').lean();
    const countryMap = new Map();
    for (const p of countryProfiles) {
      const k = p.countryCode || '';
      const cur = countryMap.get(k) || { code: p.countryCode || null, name: p.countryCode ? (p.countryName || p.countryCode) : 'Unknown', count: 0 };
      cur.count++;
      countryMap.set(k, cur);
    }
    const countries = [...countryMap.values()].sort((a, b) => b.count - a.count);

    res.json({
      totalAccounts,
      onlineNow,
      breakdown: { activeToday, activeThisWeek, activeThisMonth, inactive },
      openReports,
      pendingApplications, payoutsQueued, pendingVerifications,
      countries,
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error('[admin/stats]', error);
    res.status(500).json({ error: error.message });
  }
});
// ── Ads: likes on the Snapsa ad, with notifications to every admin ──────────
const SNAPSA_ADS = new Set(['snapsa']);
const snapsaAdLikeSchema = new mongoose.Schema({
  adId:   { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { timestamps: true, collection: 'snapsa_ad_likes' });
snapsaAdLikeSchema.index({ adId: 1, userId: 1 }, { unique: true });
const SnapsaAdLike = mongoose.models.SnapsaAdLike || mongoose.model('SnapsaAdLike', snapsaAdLikeSchema);

// Everyone who is an admin or founder (Snapsa accounts and WernTjat accounts).
async function getSnapAdminIds() {
  const ids = new Set();
  try { (await SnapsaIdentity.find({ $or: [{ isAdmin: true }, { founder: true }] }).select('_id').lean()).forEach(r => ids.add(String(r._id))); } catch {}
  try { (await User.find({ $or: [{ isAdmin: true }, { founder: true }] }).select('_id').lean()).forEach(r => ids.add(String(r._id))); } catch {}
  return [...ids];
}
// In-app notification + push to every admin (skips the person who did the action).
async function notifyAllAdmins(payload, exceptUserId) {
  for (const id of await getSnapAdminIds()) {
    if (exceptUserId && String(id) === String(exceptUserId)) continue;
    createSnapNotification({ ...payload, recipientId: id }).catch(() => {});
  }
}


// ── Paid promotions ("Ads" tab in Profile): users buy a run of N days with coins; an admin approves before it goes live ──
const PROMO_PLANS = [
  { days: 1, coins: 5 }, { days: 3, coins: 14 }, { days: 7, coins: 30 }, { days: 14, coins: 55 }, { days: 30, coins: 100 },
];
const snapsaPromoSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  ownerName: { type: String, default: '' },
  title: { type: String, required: true },
  text: { type: String, default: '' },
  mediaFile: { type: String, default: '' },
  mediaType: { type: String, enum: ['', 'photo', 'video'], default: '' },
  placement: { type: String, enum: ['story', 'post', 'video'], default: 'video' },   // where the ad shows: between stories / in the Posts feed / in the video feed
  ctaLabel: { type: String, default: 'Learn more' },
  ctaUrl: { type: String, default: '' },
  days: { type: Number, required: true },
  coinsPaid: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'active', 'rejected', 'cancelled', 'expired'], default: 'pending', index: true },
  rejectReason: { type: String, default: '' },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
}, { timestamps: true, collection: 'snapsa_promos' });
snapsaPromoSchema.index({ status: 1, endsAt: 1 });
const SnapsaPromo = mongoose.models.SnapsaPromo || mongoose.model('SnapsaPromo', snapsaPromoSchema);
const shapePromo = (a, mine) => ({
  id: a._id, title: a.title, text: a.text, mediaUrl: a.mediaFile || null, mediaType: a.mediaType, placement: a.placement || 'video', ctaLabel: a.ctaLabel, ctaUrl: a.ctaUrl, ownerName: a.ownerName,
  ...(mine ? { days: a.days, coinsPaid: a.coinsPaid, status: a.status, rejectReason: a.rejectReason, startsAt: a.startsAt, endsAt: a.endsAt, impressions: a.impressions, clicks: a.clicks, createdAt: a.createdAt } : {}),
});
async function expirePromos() { await SnapsaPromo.updateMany({ status: 'active', endsAt: { $lte: new Date() } }, { $set: { status: 'expired' } }).catch(() => {}); }

app.get('/snapsa/promo/options', snapAuth, (req, res) => res.json({ plans: PROMO_PLANS.map(p => ({ ...p, usd: +(p.coins * SNAPSA_COIN_VALUE_USD).toFixed(2) })) }));

app.get('/snapsa/promo/mine', snapAuthRequired, async (req, res) => {
  try {
    await expirePromos();
    const rows = await SnapsaPromo.find({ ownerId: req.userId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ ads: rows.map(a => shapePromo(a, true)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/snapsa/promo', snapAuth, uploadLimiter, uploadStory.single('media'), async (req, res) => {
  let tempPath = null, charged = 0;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to create an ad' });
    const plan = PROMO_PLANS.find(p => p.days === parseInt(req.body.days));
    if (!plan) return res.status(400).json({ error: 'Choose how long the ad should run' });
    const title = String(req.body.title || '').trim().slice(0, 80);
    const text = String(req.body.text || '').trim().slice(0, 300);
    const placement = ['story', 'post', 'video'].includes(req.body.placement) ? req.body.placement : 'video';
    if (title.length < 3) return res.status(400).json({ error: 'Add a headline' });
    let ctaUrl = String(req.body.ctaUrl || '').trim().slice(0, 300);
    if (ctaUrl && !/^https:\/\//i.test(ctaUrl)) return res.status(400).json({ error: 'The link must start with https://' });
    const ctaLabel = String(req.body.ctaLabel || 'Learn more').trim().slice(0, 24) || 'Learn more';
    if (req.file && req.file.mimetype.startsWith('audio/')) return res.status(400).json({ error: 'Use a photo or a video' });
    if (await SnapsaPromo.countDocuments({ ownerId: req.userId, status: { $in: ['pending', 'active'] } }) >= 5) return res.status(400).json({ error: 'You can have up to 5 ads running or waiting at a time' });
    const balance = await getSnapsaCoinBalance(req.userId);
    if (balance < plan.coins) return res.status(402).json({ error: `This plan costs ${plan.coins} coins. You have ${balance}.`, code: 'NOT_ENOUGH_COINS' });
    let mediaFile = '', mediaType = '';
    if (req.file) {
      const isVideo = req.file.mimetype.startsWith('video/');
      const tempDir = path.join(config.uploadDir, 'temp'); fs.mkdirSync(tempDir, { recursive: true });
      tempPath = path.join(tempDir, `promo_${uuidv4()}${path.extname(req.file.originalname) || (isVideo ? '.mp4' : '.jpg')}`);
      fs.writeFileSync(tempPath, req.file.buffer);
      const up = await uploadToCloudinary(tempPath, { resourceType: isVideo ? 'video' : 'image', folder: 'snapsa/promos' });
      mediaFile = up.secure_url; mediaType = isVideo ? 'video' : 'photo'; cleanupTempFiles(tempPath);
    }
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).select('username').lean();
    await awardCoins(req.userId, -plan.coins); charged = plan.coins;
    const ad = await SnapsaPromo.create({ ownerId: req.userId, ownerName: profile?.username || '', title, text, mediaFile, mediaType, placement, ctaLabel, ctaUrl, days: plan.days, coinsPaid: plan.coins });
    await logCoinTransaction({ userId: req.userId, type: 'debit', amount: -plan.coins, description: `Ad: ${plan.days} day${plan.days > 1 ? 's' : ''}`, metadata: { promoId: String(ad._id) } }).catch(() => {});
    notifyAllAdmins({ senderId: req.userId, type: 'promo_review', title: 'New ad to review', body: `${title} · ${plan.days} days`, data: { promoId: String(ad._id) } }, req.userId);
    res.json({ success: true, ad: shapePromo(ad.toObject(), true), newBalance: balance - plan.coins });
  } catch (e) {
    cleanupTempFiles(tempPath);
    if (charged) await awardCoins(req.userId, charged).catch(() => {});
    console.error('[promo-create]', e.message); res.status(500).json({ error: e.message });
  }
});

// Cancel: a waiting ad is refunded in full. A running ad stops without a refund.
app.post('/snapsa/promo/:id/cancel', snapAuthRequired, async (req, res) => {
  try {
    if (!guardId(req, res)) return;
    const ad = await SnapsaPromo.findOneAndUpdate({ _id: req.params.id, ownerId: req.userId, status: { $in: ['pending', 'active'] } }, { $set: { status: 'cancelled' } });
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    let refunded = 0;
    if (ad.status === 'pending') { refunded = ad.coinsPaid; await awardCoins(req.userId, refunded); }
    res.json({ success: true, refunded });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One live ad for an ad slot. Never your own.
app.get('/snapsa/promo/serve', snapAuth, async (req, res) => {
  try {
    const now = new Date();
    const hidden = req.userId ? await hiddenPrivateAuthorIds(req.userId).catch(() => []) : [];
    const want = ['story', 'post', 'video'].includes(req.query.placement) ? req.query.placement : null;   // older ads have no placement and still show everywhere
    const rows = await SnapsaPromo.aggregate([{ $match: { status: 'active', ...(want ? { placement: { $in: [want, null] } } : {}), startsAt: { $lte: now }, endsAt: { $gt: now }, ownerId: { $nin: [req.userId ? new mongoose.Types.ObjectId(String(req.userId)) : null, ...hidden.map(h => new mongoose.Types.ObjectId(String(h)))] } } }, { $sample: { size: 1 } }]);
    res.json({ ad: rows[0] ? shapePromo(rows[0], false) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/snapsa/promo/:id/impression', snapAuth, async (req, res) => { try { if (!guardId(req, res)) return; await SnapsaPromo.updateOne({ _id: req.params.id, status: 'active' }, { $inc: { impressions: 1 } }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/snapsa/promo/:id/click', snapAuth, async (req, res) => { try { if (!guardId(req, res)) return; await SnapsaPromo.updateOne({ _id: req.params.id, status: 'active' }, { $inc: { clicks: 1 } }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/snapsa/admin/promo', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    await expirePromos();
    const status = ['pending', 'active', 'rejected', 'expired', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await SnapsaPromo.find({ status }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ ads: rows.map(a => ({ ...shapePromo(a, true), ownerName: a.ownerName, ownerId: a.ownerId })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/snapsa/admin/promo/:id/approve', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const ad = await SnapsaPromo.findOne({ _id: req.params.id, status: 'pending' });
    if (!ad) return res.status(409).json({ error: 'This ad is not waiting for review' });
    ad.status = 'active'; ad.startsAt = new Date(); ad.endsAt = new Date(Date.now() + ad.days * 86400000); await ad.save();
    sendSnapsaSystemMessage(ad.ownerId, `✅ Your ad "${ad.title}" is live for ${ad.days} day${ad.days > 1 ? 's' : ''}.`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/snapsa/admin/promo/:id/reject', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 200) || 'It does not follow our ad rules';
    const ad = await SnapsaPromo.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'rejected', rejectReason: reason } });
    if (!ad) return res.status(409).json({ error: 'This ad is not waiting for review' });
    await awardCoins(ad.ownerId, ad.coinsPaid);
    sendSnapsaSystemMessage(ad.ownerId, `Your ad "${ad.title}" was not approved: ${reason}. Your ${ad.coinsPaid} coins were returned.`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/snapsa/ads/:adId', snapAuth, async (req, res) => {
  try {
    const adId = req.params.adId;
    if (!SNAPSA_ADS.has(adId)) return res.status(404).json({ error: 'Ad not found' });
    const [likes, mine] = await Promise.all([
      SnapsaAdLike.countDocuments({ adId }),
      SnapsaAdLike.exists({ adId, userId: req.userId }),
    ]);
    res.json({ adId, likes, liked: !!mine });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/ads/:adId/like', snapAuthRequired, async (req, res) => {
  try {
    const adId = req.params.adId;
    if (!SNAPSA_ADS.has(adId)) return res.status(404).json({ error: 'Ad not found' });
    const removed = await SnapsaAdLike.findOneAndDelete({ adId, userId: req.userId });
    let liked = false;
    if (!removed) {
      try { await SnapsaAdLike.create({ adId, userId: req.userId }); } catch (e) { if (e.code !== 11000) throw e; }
      liked = true;
      const p = await SnapsaProfile.findOne({ userId: req.userId }).select('username').lean();
      const name = p?.username ? `@${p.username}` : 'Someone';
      notifyAllAdmins({
        senderId: req.userId, type: 'like',
        title: `❤️ ${name} liked the Snapsa ad`, body: '',
        data: { kind: 'ad', adId },
      }, req.userId);
    }
    const likes = await SnapsaAdLike.countDocuments({ adId });
    res.json({ success: true, liked, likes });
  } catch (error) {
    console.error('[ads/like]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/admin/ads', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const ads = [];
    for (const adId of SNAPSA_ADS) {
      const [likes, recent] = await Promise.all([
        SnapsaAdLike.countDocuments({ adId }),
        SnapsaAdLike.find({ adId }).sort({ createdAt: -1 }).limit(20).lean(),
      ]);
      const profiles = await SnapsaProfile.find({ userId: { $in: recent.map(r => r.userId) } }).select('userId username').lean();
      const byId = Object.fromEntries(profiles.map(p => [String(p.userId), p]));
      ads.push({
        adId, likes,
        recent: recent.map(r => ({ userId: r.userId, username: byId[String(r.userId)]?.username || null, likedAt: r.createdAt })),
      });
    }
    res.json({ ads });
  } catch (error) {
    console.error('[admin/ads]', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Get Verified: users request the pink Snapsa badge for a period; admins approve ──
const VERIFIED_PRICE_USD_PER_MONTH = 30;
const VERIFIED_MONTH_OPTIONS = [1, 3, 6, 12];
const VERIFIED_DAYS_PER_MONTH = 30;
const DAY_MS = 86400000;

const snapsaVerificationSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  requestStatus:   { type: String, enum: ['none', 'pending', 'rejected'], default: 'none' },
  requestedMonths: { type: Number, default: 0 },
  priceUsd:        { type: Number, default: 0 },
  requestedAt:     { type: Date },
  paymentStatus:   { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
  paymentRef:      { type: String, default: '' },   // PayFast payment id, once PayFast is connected
  startedAt:       { type: Date },
  expiresAt:       { type: Date, default: null },   // badge is active while this is in the future
  adminNote:       { type: String, default: '' },
  reviewedBy:      { type: mongoose.Schema.Types.ObjectId },
  reviewedAt:      { type: Date },
  warned3d:        { type: Boolean, default: false },
  expiredNotified: { type: Boolean, default: false },
}, { timestamps: true, collection: 'snapsa_verifications' });
const SnapsaVerification = mongoose.models.SnapsaVerification || mongoose.model('SnapsaVerification', snapsaVerificationSchema);

const isVerifiedActive = (v) => !!(v && v.expiresAt && new Date(v.expiresAt) > new Date());
const daysLeftOf = (d) => (d ? Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / DAY_MS)) : 0);
const refreshVerifiedCache = () => { if (typeof _verifiedAt !== 'undefined') _verifiedAt = 0; };
const snapsaUserLabel = async (userId) => {
  const p = await SnapsaProfile.findOne({ userId }).select('username').lean().catch(() => null);
  return p?.username ? `@${p.username}` : 'A user';
};
const notifyVerifyUser = (userId, title, body, kind) => createSnapNotification({
  recipientId: userId, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type: 'report_update',
  title, body, data: { kind }, priority: 'high',
}).catch(() => {});

// User: my status, price and the choices
app.get('/snapsa/verification/me', snapAuthRequired, async (req, res) => {
  try {
    const v = await SnapsaVerification.findOne({ userId: req.userId }).lean();
    const permanent = (await getSnapAdminIds()).includes(String(req.userId));
    res.json({
      pricePerMonthUsd: VERIFIED_PRICE_USD_PER_MONTH,
      options: VERIFIED_MONTH_OPTIONS,
      permanent,                                   // admins and founders always have the badge
      active: permanent || isVerifiedActive(v),
      daysLeft: isVerifiedActive(v) ? daysLeftOf(v.expiresAt) : 0,
      expiresAt: v?.expiresAt || null,
      requestStatus: v?.requestStatus || 'none',
      requestedMonths: v?.requestedMonths || 0,
      adminNote: v?.requestStatus === 'rejected' ? (v.adminNote || '') : '',
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// User: ask admin for the badge for 1, 3, 6 or 12 months
app.post('/snapsa/verification/request', snapAuthRequired, async (req, res) => {
  try {
    const months = parseInt(req.body?.months, 10);
    if (!VERIFIED_MONTH_OPTIONS.includes(months)) return res.status(400).json({ error: 'Choose 1, 3, 6 or 12 months' });
    let v = await SnapsaVerification.findOne({ userId: req.userId });
    if (v?.requestStatus === 'pending') return res.status(409).json({ error: 'You already have a request waiting for review' });
    if (!v) v = new SnapsaVerification({ userId: req.userId });
    v.requestStatus = 'pending';
    v.requestedMonths = months;
    v.priceUsd = months * VERIFIED_PRICE_USD_PER_MONTH;
    v.requestedAt = new Date();
    v.paymentStatus = 'unpaid';
    v.adminNote = '';
    await v.save();
    const name = await snapsaUserLabel(req.userId);
    notifyAllAdmins({
      senderId: req.userId, type: 'report_update', priority: 'high',
      title: `✅ ${name} requested Verified`,
      body: `${months} month${months > 1 ? 's' : ''} · $${v.priceUsd} · user ID ${req.userId}`,
      data: { kind: 'verified_request', userId: String(req.userId), months },
    }, req.userId);
    res.json({ success: true, requestStatus: 'pending', months, priceUsd: v.priceUsd });
  } catch (error) {
    console.error('[verification/request]', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: requests and verified users (with days left)
app.get('/snapsa/admin/verification', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const view = ['pending', 'active', 'expired'].includes(req.query.view) ? req.query.view : 'pending';
    const now = new Date();
    const filters = {
      pending: { requestStatus: 'pending' },
      active:  { expiresAt: { $gt: now } },
      expired: { expiresAt: { $ne: null, $lte: now } },
    };
    const sorts = { pending: { requestedAt: 1 }, active: { expiresAt: 1 }, expired: { expiresAt: -1 } };
    const [rows, pending, active, expired] = await Promise.all([
      SnapsaVerification.find(filters[view]).sort(sorts[view]).limit(200).lean(),
      SnapsaVerification.countDocuments(filters.pending),
      SnapsaVerification.countDocuments(filters.active),
      SnapsaVerification.countDocuments(filters.expired),
    ]);
    const profiles = await SnapsaProfile.find({ userId: { $in: rows.map(r => r.userId) } }).select('userId username displayName').lean();
    const byId = Object.fromEntries(profiles.map(p => [String(p.userId), p]));
    res.json({
      view, counts: { pending, active, expired }, pricePerMonthUsd: VERIFIED_PRICE_USD_PER_MONTH, options: VERIFIED_MONTH_OPTIONS,
      items: rows.map(r => ({
        userId: r.userId,
        username: byId[String(r.userId)]?.username || null,
        displayName: byId[String(r.userId)]?.displayName || '',
        requestStatus: r.requestStatus, requestedMonths: r.requestedMonths, priceUsd: r.priceUsd,
        paymentStatus: r.paymentStatus, requestedAt: r.requestedAt,
        expiresAt: r.expiresAt, active: isVerifiedActive(r), daysLeft: isVerifiedActive(r) ? daysLeftOf(r.expiresAt) : 0,
      })),
    });
  } catch (error) {
    console.error('[admin/verification]', error);
    res.status(500).json({ error: error.message });
  }
});

const loadVerification = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.userId)) { res.status(400).json({ error: 'Invalid user' }); return null; }
  const v = await SnapsaVerification.findOne({ userId: req.params.userId });
  if (!v) { res.status(404).json({ error: 'No verification record for this user' }); return null; }
  return v;
};

// Admin: approve (starts, or renews by adding to the days left)
app.post('/snapsa/admin/verification/:userId/approve', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const v = await loadVerification(req, res); if (!v) return;
    const asked = parseInt(req.body?.months, 10);
    const months = VERIFIED_MONTH_OPTIONS.includes(asked) ? asked : (v.requestedMonths || 1);
    const wasActive = isVerifiedActive(v);
    const base = wasActive ? new Date(v.expiresAt) : new Date();
    if (!wasActive) v.startedAt = base;
    v.expiresAt = new Date(base.getTime() + months * VERIFIED_DAYS_PER_MONTH * DAY_MS);
    v.requestStatus = 'none';
    if (req.body?.markPaid !== false) v.paymentStatus = 'paid';
    v.reviewedBy = req.userId; v.reviewedAt = new Date(); v.adminNote = '';
    v.warned3d = false; v.expiredNotified = false;
    await v.save();
    refreshVerifiedCache();
    notifyVerifyUser(v.userId, '✅ You are now Snapsa Verified',
      `Your pink badge is active for ${daysLeftOf(v.expiresAt)} days, until ${v.expiresAt.toISOString().slice(0, 10)}.`, 'verified_approved');
    res.json({ success: true, expiresAt: v.expiresAt, daysLeft: daysLeftOf(v.expiresAt) });
  } catch (error) {
    console.error('[admin/verification/approve]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/admin/verification/:userId/reject', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const v = await loadVerification(req, res); if (!v) return;
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    v.requestStatus = 'rejected'; v.adminNote = reason; v.reviewedBy = req.userId; v.reviewedAt = new Date();
    await v.save();
    notifyVerifyUser(v.userId, 'Verification request not approved', reason || 'Your Get Verified request was not approved this time.', 'verified_rejected');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/admin/verification/:userId/extend', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const v = await loadVerification(req, res); if (!v) return;
    const days = Math.min(365, Math.max(1, parseInt(req.body?.days, 10) || 30));
    const base = isVerifiedActive(v) ? new Date(v.expiresAt) : new Date();
    if (!isVerifiedActive(v)) v.startedAt = base;
    v.expiresAt = new Date(base.getTime() + days * DAY_MS);
    v.warned3d = false; v.expiredNotified = false;
    await v.save();
    refreshVerifiedCache();
    notifyVerifyUser(v.userId, '✅ Your Snapsa Verified badge was extended', `Active until ${v.expiresAt.toISOString().slice(0, 10)}.`, 'verified_extended');
    res.json({ success: true, expiresAt: v.expiresAt, daysLeft: daysLeftOf(v.expiresAt) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/admin/verification/:userId/revoke', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const v = await loadVerification(req, res); if (!v) return;
    v.expiresAt = new Date(); v.expiredNotified = true; v.reviewedBy = req.userId; v.reviewedAt = new Date();
    await v.save();
    refreshVerifiedCache();
    notifyVerifyUser(v.userId, 'Your Snapsa Verified badge was removed', 'Contact Snapsa support if you think this is a mistake.', 'verified_revoked');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Hourly: warn 3 days before the badge ends, and tell people when it has ended.
setInterval(async () => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * DAY_MS);
    const warn = await SnapsaVerification.find({ expiresAt: { $gt: now, $lte: soon }, warned3d: false }).limit(200);
    for (const v of warn) {
      v.warned3d = true; await v.save();
      notifyVerifyUser(v.userId, 'Your Verified badge ends soon', `${daysLeftOf(v.expiresAt)} day(s) left. Request again in Privacy → Get Verified to keep it.`, 'verified_expiring');
    }
    const gone = await SnapsaVerification.find({ expiresAt: { $ne: null, $lte: now }, expiredNotified: false }).limit(200);
    for (const v of gone) {
      v.expiredNotified = true; await v.save();
      notifyVerifyUser(v.userId, 'Your Verified badge has ended', 'Request again in Privacy → Get Verified to get the pink badge back.', 'verified_expired');
    }
    if (gone.length) refreshVerifiedCache();
  } catch (e) { console.error('[verification/expiry]', e.message); }
}, 60 * 60 * 1000);


// ── Visitors: everyone who opens Snapsa, with or without an account ─────────

const snapsaVisitSchema = new mongoose.Schema({
  vid:         { type: String, required: true },
  day:         { type: String, required: true },
  firstSeen:   { type: Date, default: Date.now },
  lastSeen:    { type: Date, default: Date.now },
  hits:        { type: Number, default: 1 },
  countryCode: { type: String, default: null },
  countryName: { type: String, default: null },
  device:      { type: String, default: 'unknown' },
  browser:     { type: String, default: 'other' },
  referrer:    { type: String, default: 'direct' },
  inviteCode:  { type: String, default: '' },
  hasAccount:  { type: Boolean, default: false },
  expireAt:    { type: Date, required: true },
}, { collection: 'snapsa_visits', versionKey: false });
snapsaVisitSchema.index({ vid: 1, day: 1 }, { unique: true });
snapsaVisitSchema.index({ day: 1 });
snapsaVisitSchema.index({ lastSeen: 1 });
snapsaVisitSchema.index({ firstSeen: 1 });
snapsaVisitSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const SnapsaVisit = mongoose.models.SnapsaVisit || mongoose.model('SnapsaVisit', snapsaVisitSchema);

const visitLimiter = rateLimit({ windowMs: 60000, max: 20 });
const VISIT_BOT_UA = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|lighthouse|facebookexternalhit/i;

function parseVisitUA(ua) {
  const s = String(ua || '');
  const device = /iPad|Tablet/i.test(s) ? 'tablet' : /Mobi|Android|iPhone|iPod/i.test(s) ? 'mobile' : 'desktop';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : 'Other';
  return { device, browser };
}

// Works for guests: snapAuth lets requests without a token through.
app.post('/snapsa/visit', visitLimiter, snapAuth, async (req, res) => {
  try {
    const vid = String(req.body?.vid || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(vid)) return res.status(400).json({ error: 'Invalid visitor id' });
    const ua = String(req.headers['user-agent'] || '');
    if (VISIT_BOT_UA.test(ua)) return res.status(204).end();

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const { device, browser } = parseVisitUA(ua);
    let referrer = String(req.body?.referrer || '').toLowerCase().replace(/^www\./, '').slice(0, 60);
    if (!/^[a-z0-9.-]+$/.test(referrer)) referrer = 'direct';
    let inviteCode = String(req.body?.invite || '').slice(0, 40);
    if (!/^[A-Za-z0-9_.-]+$/.test(inviteCode)) inviteCode = '';
    const hasAccount = !!req.userId;

    const code = await detectCountryCode(req);
    let countryName = null;
    if (code) { try { countryName = regionNames?.of(code) || code; } catch { countryName = code; } }

    const setOnInsert = {
      firstSeen: now, countryCode: code || null, countryName, device, browser, referrer, inviteCode,
      expireAt: new Date(now.getTime() + 90 * 86400000),
      ...(hasAccount ? {} : { hasAccount: false }),
    };
    const update = {
      $setOnInsert: setOnInsert,
      $set: { lastSeen: now, ...(hasAccount ? { hasAccount: true } : {}) },
      $inc: { hits: 1 },
    };
    try {
      await SnapsaVisit.updateOne({ vid, day }, update, { upsert: true, setDefaultsOnInsert: false });
    } catch (e) {
      if (e?.code === 11000) await SnapsaVisit.updateOne({ vid, day }, { $set: update.$set, $inc: update.$inc });
      else throw e;
    }
    res.status(204).end();
  } catch (error) {
    console.error('[visit]', error.message);
    res.status(204).end();
  }
});

// One day of visitors (day = the admin's local day, sent as from/to).
app.get('/snapsa/admin/visitors/day', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const from = new Date(String(req.query.from || ''));
    const to = new Date(String(req.query.to || ''));
    if (isNaN(from) || isNaN(to) || to <= from || to - from > 36 * 3600000) {
      return res.status(400).json({ error: 'Invalid day' });
    }
    const rows = await SnapsaVisit.aggregate([
      { $match: { firstSeen: { $gte: from, $lt: to } } },
      { $sort: { firstSeen: 1 } },
      { $group: {
          _id: '$vid',
          firstSeen: { $first: '$firstSeen' },
          countryCode: { $first: '$countryCode' },
          countryName: { $first: '$countryName' },
          hasAccount: { $max: '$hasAccount' },
      } },
      { $sort: { firstSeen: -1 } },
      { $limit: 5000 },
    ]);
    const byCountry = new Map();
    for (const r of rows) {
      const key = r.countryCode || '??';
      const cur = byCountry.get(key) || { code: r.countryCode || null, name: r.countryCode ? (r.countryName || r.countryCode) : 'Unknown', count: 0 };
      cur.count += 1;
      byCountry.set(key, cur);
    }
    res.json({
      from, to,
      total: rows.length,
      withAccount: rows.filter(r => r.hasAccount).length,
      countries: [...byCountry.values()].sort((a, b) => b.count - a.count),
      visitors: rows.map(r => ({
        at: r.firstSeen,
        code: r.countryCode || null,
        name: r.countryCode ? (r.countryName || r.countryCode) : 'Unknown',
        hasAccount: !!r.hasAccount,
      })),
    });
  } catch (error) {
    console.error('[admin/visitors/day]', error);
    res.status(500).json({ error: error.message });
  }
});

// Shared by the manual "Send Announcement" button and the automatic release

// notes below — one message from the Snapsa account to every user's inbox.
async function broadcastSnapsaSystemMessage(text) {
  await ensureSnapsaSystemAccount();

  const recipients = (await SnapsaProfile.find({
    isSystemAccount: { $ne: true },
    userId: { $nin: [null, SNAPSA_SYSTEM_ACCOUNT_ID] },
  }).select('userId').lean()).filter(r => r.userId);
  if (recipients.length === 0) return 0;

  const now = new Date();
  const docs = recipients.map(r => ({
    chatId: buildSnapChatId(SNAPSA_SYSTEM_ACCOUNT_ID, r.userId),
    senderId: SNAPSA_SYSTEM_ACCOUNT_ID,
    receiverId: r.userId,
    type: 'text',
    text,
    createdAt: now,
  }));
  const inserted = await SnapsaMessage.insertMany(docs, { ordered: false });

  inserted.forEach(msg => {
    pushToSnapUser(msg.receiverId, { type: 'new_message', message: msg, chatId: msg.chatId });
  });
  return inserted.length;
}

app.post('/snapsa/admin/broadcast', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Message text is required' });
    const sentTo = await broadcastSnapsaSystemMessage(text);
    res.json({ success: true, sentTo });
  } catch (error) {
    console.error('[admin/broadcast]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Automatic "what's new" broadcast ────────────────────────────────────
const SNAPSA_RELEASE = {
  version: '2026.10.5',
  notes: [
    'Snapsa Wallet is on its way — apply for your account in your profile under Snapsa Wallet (you’ll need your ID and a proof of address). We’ll message you here once you’re approved.',
  ],
};

const snapsaReleaseLogSchema = new mongoose.Schema({
  version: { type: String, required: true, unique: true },
  notes:   [String],
  sentTo:  { type: Number, default: 0 },
}, { timestamps: true, collection: 'snapsa_release_log' });
const SnapsaReleaseLog = mongoose.models.SnapsaReleaseLog || mongoose.model('SnapsaReleaseLog', snapsaReleaseLogSchema);

const SNAPSA_RELEASE_NEXT = {
  version: '2026.11.10',
  notes: [
    'New Snapsa Wallet look, see your balance in your favourite currency, hide it with one tap, and manage your card from the Card tab.',
    'Messages: press and hold a chat to hide or delete it.',
    'Follower, following and likes numbers on profiles are now always up to date.',
  ],
};
async function autoBroadcastRelease() {
  if (process.env.DISABLE_RELEASE_BROADCAST === 'true') { console.log('[release] skipped — DISABLE_RELEASE_BROADCAST is true'); return; }
  const { version, notes } = SNAPSA_RELEASE_NEXT;
  try {
    if (!version || !notes?.length) return;
    try { await SnapsaReleaseLog.create({ version, notes }); }   // claim it — only one instance wins
    catch (e) {
      if (e.code === 11000) { console.log(`[release] v${version} was already sent — change the version in SNAPSA_RELEASE_NEXT to send a new announcement`); return; }
      throw e;
    }
    try {
      const text = `📣 What's new on Snapsa (v${version})\n\n${notes.map(n => `• ${n}`).join('\n')}`;
      const sentTo = await broadcastSnapsaSystemMessage(text);
      await SnapsaReleaseLog.updateOne({ version }, { $set: { sentTo } });
      console.log(`[release] Broadcast v${version} to ${sentTo} user(s)`);
    } catch (e) {
      // Nothing was delivered → release the claim so the next start retries
      // (previously a failed send burned the version and it never went out).
      const partial = (e.insertedDocs && e.insertedDocs.length) || e?.result?.insertedCount;
      if (!partial) await SnapsaReleaseLog.deleteOne({ version }).catch(() => {});
      throw e;
    }
  } catch (e) { console.error('[release-broadcast]', e.message); }
}
async function _autoBroadcastReleaseOld() {
  
  if (process.env.DISABLE_RELEASE_BROADCAST === 'true') return;
  try {
    const { version, notes } = SNAPSA_RELEASE;
    if (!version || !notes?.length) return;
    try { await SnapsaReleaseLog.create({ version, notes }); }   // claim it — only one instance wins
    catch (e) { if (e.code === 11000) return; throw e; }
    const text = `📣 What's new on Snapsa (v${version})\n\n${notes.map(n => `• ${n}`).join('\n')}`;
    const sentTo = await broadcastSnapsaSystemMessage(text);
    await SnapsaReleaseLog.updateOne({ version }, { $set: { sentTo } });
    console.log(`[release] Broadcast v${version} to ${sentTo} user(s)`);
  } catch (e) { console.error('[release-broadcast]', e.message); }
}

// ============================================================================
// Moderation (admin): review reports, remove content, warn / suspend / bar
// ============================================================================

async function sendSnapsaSystemMessage(userId, text) {
  try {
    await ensureSnapsaSystemAccount();
    await SnapsaMessage.create({
      chatId: buildSnapChatId(SNAPSA_SYSTEM_ACCOUNT_ID, userId),
      senderId: SNAPSA_SYSTEM_ACCOUNT_ID, receiverId: userId, type: 'text', text,
    });
  } catch (e) { console.error('[system-dm]', e.message); }
}

async function removeReportedContent(targetType, targetId, adminId) {
  if (targetType === 'video') {
    const sv = await SnapsaVideo.findById(targetId).select('postId').lean();
    if (sv?.postId) await Post.findByIdAndUpdate(sv.postId, { $set: { isActive: false, deletedAt: new Date() } });
    return !!sv;
  }
  if (targetType === 'comment') {
    const c = await Comment.findOneAndUpdate({ _id: targetId, isActive: { $ne: false } }, { $set: { isActive: false, deletedAt: new Date() } });
    if (c) await Post.findByIdAndUpdate(c.postId, { $inc: { commentCount: -1 } });
    return !!c;
  }
  if (targetType === 'message') {
    const m = await SnapsaMessage.findByIdAndUpdate(targetId, { $set: { deletedForEveryone: true, deletedBy: adminId } });
    return !!m;
  }
  return false;
}

app.get('/snapsa/admin/moderation', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const showResolved = req.query.status === 'resolved';
    const reports = await SnapsaReport.find({ status: showResolved ? { $ne: 'open' } : 'open' })
      .sort({ createdAt: -1 }).limit(1000).lean();

    const groups = new Map();
    for (const r of reports) {
      const key = `${r.targetType}:${r.targetId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key, targetType: r.targetType, targetId: r.targetId, targetUserId: r.targetUserId,
          snapshot: r.snapshot, count: 0, weight: 0, reasons: {}, reports: [],
          status: r.status, resolution: r.resolution, resolutionNote: r.resolutionNote, resolvedAt: r.resolvedAt,
          latestAt: r.createdAt,
        });
      }
      const g = groups.get(key);
      g.count += 1;
      g.weight += r.weight || 0;
      g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
      if (g.reports.length < 25) g.reports.push({ reporterId: r.reporterId, reason: r.reason, description: r.description, createdAt: r.createdAt });
    }

    const blocks = await SnapsaBlock.find().sort({ createdAt: -1 }).limit(200).lean();
    const totalBlocks = await SnapsaBlock.countDocuments();
    const restricted = await SnapsaProfile.find({ $or: [{ isBarred: true }, { suspendedUntil: { $gt: new Date() } }] })
      .select('userId username suspendedUntil suspendedReason isBarred barredReason').lean();

    const idSet = new Set();
    groups.forEach(g => { idSet.add(String(g.targetUserId)); g.reports.forEach(x => idSet.add(String(x.reporterId))); });
    blocks.forEach(b => { idSet.add(String(b.blockerId)); idSet.add(String(b.blockedId)); });
    const profiles = await SnapsaProfile.find({ userId: { $in: [...idSet] } }).select('userId username suspendedUntil isBarred warningCount').lean();
    const pmap = new Map(profiles.map(p => [String(p.userId), p]));
    const nameOf = (id) => pmap.get(String(id))?.username || 'Unknown';

    res.json({
      reports: [...groups.values()].map(g => {
        const tp = pmap.get(String(g.targetUserId));
        return {
          ...g,
          targetUsername: nameOf(g.targetUserId),
          targetState: { suspendedUntil: tp?.suspendedUntil || null, isBarred: !!tp?.isBarred, warningCount: tp?.warningCount || 0 },
          reports: g.reports.map(x => ({
            reporter: nameOf(x.reporterId), reason: x.reason,
            reasonLabel: REPORT_REASONS[x.reason]?.label || x.reason,
            description: x.description, createdAt: x.createdAt,
          })),
        };
      }).sort((a, b) => b.weight - a.weight || b.count - a.count),
      blocks: blocks.map(b => ({ blocker: nameOf(b.blockerId), blocked: nameOf(b.blockedId), createdAt: b.createdAt })),
      totalBlocks,
      restricted: restricted.map(p => ({
        userId: p.userId, username: p.username, isBarred: !!p.isBarred,
        reason: p.isBarred ? p.barredReason : p.suspendedReason, until: p.suspendedUntil,
      })),
    });
  } catch (error) {
    console.error('[admin/moderation]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/admin/moderation/resolve', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const { targetType, targetId, action } = req.body;
    if (!REPORT_TARGET_TYPES.includes(targetType) || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ error: 'Invalid target' });
    }
    const open = await SnapsaReport.find({ targetType, targetId, status: 'open' });
    if (!open.length) return res.status(404).json({ error: 'No open reports for this item' });

    const isDismiss = action === 'dismiss';
    const doRemove = !isDismiss && !!req.body.removeContent && targetType !== 'user';
    const userAction = (!isDismiss && ['warn', 'suspend', 'bar'].includes(req.body.userAction)) ? req.body.userAction : 'none';
    if (!isDismiss && !doRemove && userAction === 'none') return res.status(400).json({ error: 'Choose at least one action' });

    const targetUserId = String(open[0].targetUserId);
    const note = String(req.body.note || '').trim().slice(0, 300);
    const days = Math.min(365, Math.max(1, parseInt(req.body.suspendDays) || 7));
    const topReason = open.reduce((best, r) => (REPORT_REASONS[r.reason]?.weight || 0) > (REPORT_REASONS[best]?.weight || 0) ? r.reason : best, open[0].reason);
    const reasonLabel = REPORT_REASONS[topReason]?.label || 'a guideline violation';
    const noun = { video: 'video', user: 'account', comment: 'comment', message: 'message' }[targetType];

    if (userAction !== 'none') {
      const target = await User.findById(targetUserId).select('isAdmin founder').lean().catch(() => null);
      if (target?.isAdmin || target?.founder || targetUserId === SNAPSA_SYSTEM_ACCOUNT_ID) {
        return res.status(400).json({ error: "You can't apply a warning, suspension or bar to an admin account" });
      }
    }

    if (doRemove) await removeReportedContent(targetType, targetId, req.userId);

    let suspendedUntil = null;
    if (userAction !== 'none') {
      const now = new Date();
      const reasonText = `${reasonLabel}${note ? ` — ${note}` : ''}`;
      let update;
      if (userAction === 'warn') update = { $inc: { warningCount: 1 }, $set: { lastWarningAt: now } };
      else if (userAction === 'suspend') { suspendedUntil = new Date(now.getTime() + days * 86400000); update = { $set: { suspendedUntil, suspendedReason: reasonText } }; }
      else update = { $set: { isBarred: true, barredReason: reasonText } };
      const updated = await SnapsaProfile.findOneAndUpdate({ userId: targetUserId }, update);
      if (!updated) return res.status(404).json({ error: 'That account has no Snapsa profile to apply this to' });
      restrictionCache.delete(targetUserId); refreshRestrictedIds();
      if (userAction !== 'warn') {
        liveState.snapRealtime?.get(targetUserId)?.forEach(ws => { try { ws.close(4003, 'Account restricted'); } catch {} });
      }
    }

    const parts = [];
    if (doRemove) parts.push('removed');
    if (userAction === 'warn') parts.push('warned');
    if (userAction === 'suspend') parts.push(`suspended_${days}d`);
    if (userAction === 'bar') parts.push('barred');
    const resolution = isDismiss ? 'dismissed' : parts.join('+');

    await SnapsaReport.updateMany(
      { targetType, targetId, status: 'open' },
      { $set: { status: isDismiss ? 'dismissed' : 'actioned', resolution, resolutionNote: note, resolvedBy: req.userId, resolvedAt: new Date() } }
    );

    const expiresAt = new Date(Date.now() + 30 * 86400000);

    // Tell every reporter the outcome.
    const reporterIds = [...new Set(open.map(r => String(r.reporterId)))];
    const reporterBody = isDismiss
      ? `We reviewed your report about this ${noun} and found it doesn't break our guidelines. Thanks for looking out for the community.`
      : `We reviewed your report about this ${noun} and took action. Thank you for helping keep Snapsa safe.`;
    reporterIds.forEach(rid => {
      createSnapNotification({
        recipientId: rid, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type: 'report_update',
        title: isDismiss ? 'Update on your report' : 'Action taken on your report',
        body: reporterBody, data: { targetType, outcome: isDismiss ? 'dismissed' : 'actioned' },
        priority: 'medium', expiresAt,
      }).catch(() => {});
    });

    // Tell the person who was reported.
    if (!isDismiss && targetUserId) {
      const msg = [];
      if (doRemove) msg.push(`Your ${noun} was removed for ${reasonLabel.toLowerCase()}.`);
      if (userAction === 'warn') msg.push(`⚠️ This is an official warning from Snapsa. Your ${targetType === 'user' ? 'account' : noun} was reported for ${reasonLabel.toLowerCase()}. Further violations may lead to suspension or removal from Snapsa.`);
      if (userAction === 'suspend') msg.push(`Your account has been suspended for ${days} day${days === 1 ? '' : 's'}, until ${suspendedUntil.toISOString().slice(0, 10)}.`);
      if (userAction === 'bar') msg.push('Your account has been permanently barred from Snapsa for repeated or serious violations.');
      if (note) msg.push(`Note from the Snapsa team: ${note}`);
      const text = msg.join('\n\n');
      sendSnapsaSystemMessage(targetUserId, text);
      createSnapNotification({
        recipientId: targetUserId, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type: 'account_warning',
        title: userAction === 'bar' ? 'Your account has been barred' : userAction === 'suspend' ? 'Your account has been suspended' : userAction === 'warn' ? 'Warning from Snapsa' : 'Content removed',
        body: text.slice(0, 300), data: { targetType, userAction, removed: doRemove },
        priority: 'high', expiresAt,
      }).catch(() => {});
    }

    res.json({ success: true, resolution, notifiedReporters: reporterIds.length });
  } catch (error) {
    console.error('[admin/moderation/resolve]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/admin/moderation/restore', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'Invalid user' });
    const p = await SnapsaProfile.findOneAndUpdate({ userId }, { $set: { suspendedUntil: null, suspendedReason: '', isBarred: false, barredReason: '' } });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    restrictionCache.delete(String(userId)); refreshRestrictedIds();
    sendSnapsaSystemMessage(userId, 'Your Snapsa account access has been restored. Please follow the community guidelines so this doesn\'t happen again.');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Admin: look up a user and override their country tag ───────────────

app.get('/snapsa/admin/users/lookup', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 2) return res.json({ users: [] });
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const users = await SnapsaProfile.find({ username: new RegExp(safe, 'i'), isSystemAccount: { $ne: true } })
      .select('userId username countryCode countryName countrySource').limit(15).lean();
    res.json({ users: users.map(u => ({
      userId: u.userId, username: u.username,
      countryCode: u.countryCode || null, countryName: u.countryName || null, countrySource: u.countrySource || null,
    })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/snapsa/admin/users/:userId/country', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'Invalid user' });
    const code = String(req.body.countryCode || '').trim().toUpperCase();
    let update;
    if (!code) {
      update = { $set: { countryCode: null, countryName: null, countrySetAt: null, countrySource: null } };
    } else {
      if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') return res.status(400).json({ error: 'Use a valid 2-letter country code' });
      let name = code;
      try { name = regionNames?.of(code) || code; } catch { return res.status(400).json({ error: 'Unknown country code' }); }
      if (regionNames && name === code) return res.status(400).json({ error: 'Unknown country code' });
      update = { $set: { countryCode: code, countryName: name, countrySetAt: new Date(), countrySource: 'admin' } };
    }
    const p = await SnapsaProfile.findOneAndUpdate({ userId }, update, { new: true })
      .select('username countryCode countryName countrySource').lean();
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    countryAttempts.delete(String(userId));
    res.json({ success: true, user: { userId, username: p.username, countryCode: p.countryCode, countryName: p.countryName, countrySource: p.countrySource } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Admin: browse users and warn / suspend / bar them with a reason ────
app.get('/snapsa/admin/users', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const filter = { isSystemAccount: { $ne: true }, userId: { $ne: null } };
    if (q) {
      const safe = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ username: safe }, { displayName: safe }];
    }
    const [users, total] = await Promise.all([
      SnapsaProfile.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .select('userId username displayName countryCode countryName createdAt lastActiveAt suspendedUntil suspendedReason isBarred barredReason warningCount').lean(),
      SnapsaProfile.countDocuments(filter),
    ]);
    const now = new Date();
    res.json({
      users: users.map(u => {
        const suspended = u.suspendedUntil && new Date(u.suspendedUntil) > now;
        return {
          userId: u.userId, username: u.username, displayName: u.displayName || '',
          countryCode: u.countryCode || null, countryName: u.countryName || null,
          createdAt: u.createdAt, lastActiveAt: u.lastActiveAt || null, warningCount: u.warningCount || 0,
          status: u.isBarred ? 'barred' : suspended ? 'suspended' : 'active',
          until: suspended ? u.suspendedUntil : null,
          reason: u.isBarred ? u.barredReason : suspended ? u.suspendedReason : '',
        };
      }),
      total, page, pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/admin/users/:userId/sanction', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'Invalid user' });
    const action = req.body.action;
    if (!['warn', 'suspend', 'bar'].includes(action)) return res.status(400).json({ error: 'Choose warn, suspend or bar' });
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'Give a reason — the user is told why' });
    const days = Math.min(365, Math.max(1, parseInt(req.body.days) || 7));
    if (String(userId) === String(req.userId) || userId === SNAPSA_SYSTEM_ACCOUNT_ID) {
      return res.status(400).json({ error: "You can't do that to this account" });
    }
    const target = await User.findById(userId).select('isAdmin founder').lean().catch(() => null);
    if (target?.isAdmin || target?.founder) return res.status(400).json({ error: "You can't warn, suspend or bar an admin account" });

    const now = new Date();
    let update, suspendedUntil = null;
    if (action === 'warn') update = { $inc: { warningCount: 1 }, $set: { lastWarningAt: now } };
    else if (action === 'suspend') { suspendedUntil = new Date(now.getTime() + days * 86400000); update = { $set: { suspendedUntil, suspendedReason: reason } }; }
    else update = { $set: { isBarred: true, barredReason: reason } };

    const p = await SnapsaProfile.findOneAndUpdate({ userId }, update, { new: true }).select('username').lean();
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    restrictionCache.delete(String(userId)); refreshRestrictedIds();
    if (action !== 'warn') {
      liveState.snapRealtime?.get(String(userId))?.forEach(ws => { try { ws.close(4003, 'Account restricted'); } catch {} });
    }

    const text = action === 'warn'
      ? `⚠️ This is an official warning from Snapsa.\n\nReason: ${reason}\n\nFurther violations may lead to suspension or removal from Snapsa.`
      : action === 'suspend'
        ? `Your Snapsa account has been suspended for ${days} day${days === 1 ? '' : 's'}, until ${suspendedUntil.toISOString().slice(0, 10)}.\n\nReason: ${reason}`
        : `Your Snapsa account has been permanently barred.\n\nReason: ${reason}`;
    sendSnapsaSystemMessage(userId, text);
    createSnapNotification({
      recipientId: userId, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type: 'account_warning',
      title: action === 'bar' ? 'Your account has been barred' : action === 'suspend' ? 'Your account has been suspended' : 'Warning from Snapsa',
      body: text.slice(0, 300), data: { action }, priority: 'high', expiresAt: new Date(Date.now() + 30 * 86400000),
    }).catch(() => {});
    res.json({ success: true, action, username: p.username });
  } catch (error) {
    console.error('[admin/users/sanction]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Permanently erase a Snapsa account ───────────

const snapsaDeletionLogSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId },
  username:  { type: String },
  deletedBy: { type: mongoose.Schema.Types.ObjectId },
  counts:    { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'snapsa_deletion_log' });
const SnapsaDeletionLog = mongoose.models.SnapsaDeletionLog || mongoose.model('SnapsaDeletionLog', snapsaDeletionLogSchema);

function cloudinaryAssetFromUrl(url) {
  const u = String(url || '');
  const i = u.indexOf('res.cloudinary.com');
  const j = u.indexOf('/upload/');
  if (i < 0 || j < 0) return null;
  const resourceType = (/\/(image|video|raw)\/upload\//.exec(u) || [])[1] || 'image';
  let parts = u.slice(j + 8).split('?')[0].split('/');
  const v = parts.findIndex(x => /^v\d+$/.test(x));
  if (v >= 0) parts = parts.slice(v + 1);
  else while (parts.length > 1 && /^[a-z]{1,3}_[^/]*$/i.test(parts[0])) parts.shift();
  if (!parts.length) return null;
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.[a-z0-9]+$/i, '');
  try { return { publicId: decodeURIComponent(parts.join('/')), resourceType }; } catch { return null; }
}

// Fire-and-forget: the account is already gone, the media clean-up can take a while.
function destroyCloudinaryAssets(assets) {
  const unique = [...new Map(assets.map(a => [`${a.type || 'upload'}:${a.resourceType}:${a.publicId}`, a])).values()];
  (async () => {
    for (const a of unique) {
      try { await cloudinary.uploader.destroy(a.publicId, { resource_type: a.resourceType, type: a.type || 'upload' }); } catch { /* best effort */ }
    }
    if (unique.length) console.log(`[erase] removed ${unique.length} media file(s) from Cloudinary`);
  })();
  return unique.length;
}

// Likes / comments / shares this user left on other people's Snapsa videos —
// removed, with the post counters brought back down. WernTjat posts are skipped.
async function removeSnapsaInteractions(Model, uid, countField) {
  const docs = await Model.find({ userId: uid }).select('postId').lean();
  if (!docs.length) return 0;
  const postIds = [...new Set(docs.map(d => String(d.postId)))];
  const snapIds = new Set((await SnapsaVideo.find({ postId: { $in: postIds } }).distinct('postId')).map(String));
  const per = {};
  docs.forEach(d => { const k = String(d.postId); if (snapIds.has(k)) per[k] = (per[k] || 0) + 1; });
  const ids = Object.keys(per);
  if (!ids.length) return 0;
  await Model.deleteMany({ userId: uid, postId: { $in: ids } });
  await Post.bulkWrite(ids.map(id => ({ updateOne: { filter: { _id: id }, update: { $inc: { [countField]: -per[id] } } } })));
  return ids.reduce((n, id) => n + per[id], 0);
}

async function eraseSnapsaUser(userId, profile) {
  const uid = _oid(userId);
  const counts = {};
  const assets = [];
  const addUrl = (u) => { const a = cloudinaryAssetFromUrl(u); if (a) assets.push(a); };
  const addId = (id, resourceType) => { if (id) assets.push({ publicId: id, resourceType }); };

  // Videos, plus the post / likes / comments / shares / saves hanging off them
  const videos = await SnapsaVideo.find({ authorId: uid }).select('postId videoFile watermarkedFile thumbFile').lean();
  videos.forEach(v => { addUrl(v.videoFile); addUrl(v.watermarkedFile); addUrl(v.thumbFile); });
  const postIds = videos.map(v => v.postId).filter(Boolean);
  if (postIds.length) {
    await Promise.all([
      Like.deleteMany({ postId: { $in: postIds } }),
      Comment.deleteMany({ postId: { $in: postIds } }),
      Share.deleteMany({ postId: { $in: postIds } }),
    ]);
    await Post.deleteMany({ _id: { $in: postIds } });
  }
  await SnapsaSavedVideo.deleteMany({ videoId: { $in: videos.map(v => v._id) } });
  counts.videos = (await SnapsaVideo.deleteMany({ authorId: uid })).deletedCount;

  counts.likes = await removeSnapsaInteractions(Like, uid, 'likeCount');
  counts.comments = await removeSnapsaInteractions(Comment, uid, 'commentCount');
  counts.shares = await removeSnapsaInteractions(Share, uid, 'shareCount');
  await SnapsaSavedVideo.deleteMany({ userId: uid });

  const stories = await SnapsaStory.find({ authorId: uid }).select('mediaFile').lean();
  stories.forEach(st => addUrl(st.mediaFile));
  counts.stories = (await SnapsaStory.deleteMany({ authorId: uid })).deletedCount;

  const sounds = await SnapsaSound.find({ uploaderId: uid }).select('audioFile thumbFile').lean();
  sounds.forEach(so => { addUrl(so.audioFile); addUrl(so.thumbFile); });
  counts.sounds = (await SnapsaSound.deleteMany({ uploaderId: uid })).deletedCount;

  const tracks = await SnapsaTrack.find({ $or: [{ artistId: uid }, { uploaderId: uid }] }).select('audioPublicId previewPublicId coverPublicId videoPublicId').lean();
  tracks.forEach(t => { addId(t.audioPublicId, 'video'); addId(t.previewPublicId, 'video'); addId(t.videoPublicId, 'video'); addId(t.coverPublicId, 'image'); });
  counts.tracks = (await SnapsaTrack.deleteMany({ $or: [{ artistId: uid }, { uploaderId: uid }] })).deletedCount;

  const shows = await SnapsaShow.find({ channelId: uid }).select('coverPublicId').lean();
  shows.forEach(sh => addId(sh.coverPublicId, 'image'));
  const episodes = await SnapsaEpisode.find({ channelId: uid }).select('videoPublicId thumbnailPublicId').lean();
  episodes.forEach(ep => { addId(ep.videoPublicId, 'video'); addId(ep.thumbnailPublicId, 'image'); });
  counts.tvShows = (await SnapsaShow.deleteMany({ channelId: uid })).deletedCount;
  counts.tvEpisodes = (await SnapsaEpisode.deleteMany({ channelId: uid })).deletedCount;

  const channelPosts = await SnapsaChannelPost.find({ channelId: uid }).select('mediaPublicId thumbnailPublicId photos').lean();
  channelPosts.forEach(cp => { addId(cp.mediaPublicId, 'video'); addId(cp.thumbnailPublicId, 'image'); (cp.photos || []).forEach(ph => addId(ph.publicId, 'image')); });
  counts.channelPosts = (await SnapsaChannelPost.deleteMany({ channelId: uid })).deletedCount;
  await SnapsaChannelFollow.deleteMany({ $or: [{ followerId: uid }, { channelId: uid }] });

  counts.products = (await SnapsaProduct.deleteMany({ sellerId: uid })).deletedCount;
  await SnapsaLive.deleteMany({ hostId: uid });

  counts.messages = (await SnapsaMessage.deleteMany({ $or: [{ senderId: uid }, { receiverId: uid }] })).deletedCount;

  await Promise.all([
    SnapsaBlock.deleteMany({ $or: [{ blockerId: uid }, { blockedId: uid }] }),
    SnapsaHide.deleteMany({ $or: [{ userId: uid }, { hiddenUserId: uid }] }),
    SnapsaReport.deleteMany({ $or: [{ reporterId: uid }, { targetUserId: uid }] }),
  ]);

    const walletApp = await SnapsaWalletApplication.findOne({ userId: uid }).select('idDoc addressDoc').lean();
  if (walletApp) {
    [walletApp.idDoc, walletApp.addressDoc].forEach(d => { if (d?.publicId) assets.push({ publicId: d.publicId, resourceType: d.resourceType || 'image', type: 'authenticated' }); });
    await SnapsaWalletApplication.deleteOne({ userId: uid });
    counts.walletApplication = 1;
  }
  
  const walletCard = await SnapsaWallet.findOne({ userId: uid }).select('_id').lean();
  if (walletCard) {
    await SnapsaWallet.deleteOne({ _id: walletCard._id });
    counts.walletCard = 1;
  }

  addId(profile?.avatarPublicId, 'image');
  await SnapsaProfile.deleteOne({ userId: uid });
  await SnapsaIdentity.deleteOne({ _id: uid });   // native Snapsa logins only; WernTjat accounts have no row here

  restrictionCache.delete(String(userId));
  countryAttempts.delete(String(userId));
  refreshRestrictedIds();
  liveState.snapRealtime?.get(String(userId))?.forEach(ws => { try { ws.close(4003, 'Account removed'); } catch {} });

  return { counts, mediaFiles: destroyCloudinaryAssets(assets) };
}

app.post('/snapsa/admin/users/:userId/erase', snapAuth, requireSnapAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'Invalid user' });
    if (String(userId) === String(req.userId) || userId === SNAPSA_SYSTEM_ACCOUNT_ID) {
      return res.status(400).json({ error: "You can't erase this account" });
    }
    const profile = await SnapsaProfile.findOne({ userId }).select('username avatarPublicId').lean();
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const target = await User.findById(userId).select('isAdmin founder').lean().catch(() => null);
    if (target?.isAdmin || target?.founder) return res.status(400).json({ error: "You can't erase an admin account" });

    const typed = String(req.body.confirmUsername || '').trim().replace(/^@/, '').toLowerCase();
    if (typed !== String(profile.username || '').toLowerCase()) {
      return res.status(400).json({ error: 'Type the username exactly to confirm' });
    }
    if (await SnapsaWithdrawalRequest.exists({ userId, status: 'pending' })) {
      return res.status(409).json({ error: 'This user has a pending withdrawal — pay or reject it first' });
    }
    
    const { counts, mediaFiles } = await eraseSnapsaUser(userId, profile);
    await SnapsaDeletionLog.create({ userId, username: profile.username, deletedBy: req.userId, counts });
    res.json({ success: true, username: profile.username, counts, mediaFiles });
  } catch (error) {
    console.error('[admin/users/erase]', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Live Stream Routes
// ============================================================================

app.get('/snapsa/live/channel/:channelName/credentials', snapAuthRequired, async (req, res) => {
  try {
    const profile = await SnapsaProfile.findOne({ userId: req.userId });
    const username = profile?.username || req.jwtPayload?.name || req.userId.slice(-8);
    const channelData = await getOrCreateChannel(req.userId, username);

    res.json({
      streamKey: channelData.streamKey,
      ingestEndpoint: channelData.ingestEndpoint,
      channelArn: channelData.channelArn,
      webrtcEnabled: true,
      resolution: '1280x720',
      frameRate: 30,
      bitrate: 3500000,
      rtmpUrl: `${channelData.ingestEndpoint}/app/${channelData.streamKey}`
    });
  } catch (error) {
    console.error('[live/credentials]', error);
    res.status(500).json({ error: 'Failed to create streaming channel', message: error.message });
  }
});

app.get('/snapsa/live/channel/:channelName/playback', snapAuth, async (req, res) => {
  try {
    const { channelName } = req.params;

    let channelData = null;
    for (const [arn, data] of liveState.channels) {
      if (data.channelName === channelName || data.hostId === channelName) {
        channelData = data;
        break;
      }
    }

    if (!channelData) {
      const liveRoom = await SnapsaLive.findOne({
        $or: [{ channelArn: { $regex: channelName } }, { hostId: channelName }],
        isLive: true
      });

      if (!liveRoom) {
        return res.status(404).json({ error: 'Stream not found or ended' });
      }

      try {
        const getChannelCmd = new GetChannelCommand({ arn: liveRoom.channelArn });
        const channelInfo = await ivsClient.send(getChannelCmd);
        channelData = {
          channelArn: liveRoom.channelArn,
          playbackUrl: channelInfo.channel.playbackUrl,
          hostId: liveRoom.hostId
        };
      } catch (error) {
        return res.status(404).json({ error: 'Stream no longer available' });
      }
    }

    if (!liveState.viewerCounts.has(channelData.channelArn)) {
      liveState.viewerCounts.set(channelData.channelArn, new Set());
    }
    liveState.viewerCounts.get(channelData.channelArn).add(req.userId);

    const viewerCount = liveState.viewerCounts.get(channelData.channelArn).size;
    await SnapsaLive.findOneAndUpdate(
      { channelArn: channelData.channelArn },
      { viewers: viewerCount, $max: { peakViewers: viewerCount } }
    );

    res.json({
      playbackUrl: channelData.playbackUrl,
      channelArn: channelData.channelArn,
      type: 'hls',
      latencyMode: 'low',
      viewerCount
    });
  } catch (error) {
    console.error('[live/playback]', error);
    res.status(500).json({ error: 'Failed to get playback URL' });
  }
});

app.post('/snapsa/live/chat/token', snapAuthRequired, async (req, res) => {
  try {
    const { channelName, userId, userName } = req.body;

    let channelData = null;
    for (const data of liveState.channels.values()) {
      if (data.channelName === channelName || data.hostId === channelName) {
        channelData = data;
        break;
      }
    }

    if (!channelData?.chatRoomArn) {
      return res.status(404).json({ error: 'Chat room not found' });
    }

    const profile = await SnapsaProfile.findOne({ userId: req.userId });

    const tokenCmd = new CreateChatTokenCommand({
      roomIdentifier: channelData.chatRoomArn,
      userId: userId || req.userId,
      attributes: {
        username: userName || profile?.username || req.userId.slice(-8),
        avatar: profile?.avatarUrl || '',
        level: '1',
        userId: userId || req.userId
      },
      capabilities: ['SEND_MESSAGE', 'DISCONNECT_USER'],
      durationInMinutes: 180
    });

    const tokenResponse = await ivsChatClient.send(tokenCmd);

    res.json({
      token: tokenResponse.token,
      endpoint: `wss://edge.ivschat.${config.awsRegion}.amazonaws.com`,
      region: config.awsRegion,
      expiration: new Date(Date.now() + 180 * 60 * 1000),
      roomArn: channelData.chatRoomArn
    });
  } catch (error) {
    console.error('[live/chat/token]', error);
    res.status(500).json({ error: 'Failed to create chat token', message: error.message });
  }
});

app.post('/snapsa/live/gift', snapAuth, async (req, res) => {
  let session = null;

  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

    const { giftType, giftName, giftIcon, rarity, animation, channelName } = req.body;     if (!(await idemClaim(req, res, 'live-gift'))) return;

       
    
    const priceInfo = STORE_ITEM_PRICES[giftType];
    if (!priceInfo) {
      return res.status(400).json({ error: 'Unknown gift' });
    }
    const cost = priceInfo.coins;
    const weight = priceInfo.weight;
    const senderId = req.userId;
    const sender = await snapActorName(senderId);

    let targetChannel = null;
    for (const data of liveState.channels.values()) {
      if (data.channelName === channelName || data.hostId === channelName) {
        targetChannel = data;
        break;
      }
    }

    if (!targetChannel) {
      const liveRoom = await SnapsaLive.findOne({
        $or: [{ channelArn: { $regex: channelName } }, { hostId: channelName }],
        isLive: true
      });

      if (!liveRoom) {
        return res.status(404).json({ error: 'Target stream not live' });
      }

      targetChannel = {
        channelArn: liveRoom.channelArn,
        hostId: liveRoom.hostId,
        hostName: liveRoom.hostName
      };
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const balance = await getSnapsaCoinBalance(senderId, { session });
    
    if (balance < cost) {
      throw new Error(`Insufficient coins. Balance: ${balance}, Cost: ${cost}`);
    }

    await awardCoins(senderId, -cost, { session });
    await logCoinTransaction({
      userId: senderId,
      type: 'debit',
      amount: -cost,
      description: `Gift: ${giftName}`,
      reference: targetChannel.channelArn,
      referenceModel: 'SnapsaLive',
      metadata: { giftType, giftName, channelName }
    }, { session });

    const hostPayout = Math.floor(cost * 0.6);
    await awardCoins(targetChannel.hostId, hostPayout, { session });
    await logCoinTransaction({
      userId: targetChannel.hostId,
      type: 'credit',
      amount: hostPayout,
      description: `Gift received: ${giftName} from ${sender}`,
      reference: targetChannel.channelArn,
      referenceModel: 'SnapsaLive',
      metadata: { giftType, giftName, sender, senderId, amount: cost }
    }, { session });

    await SnapsaLive.findOneAndUpdate(
      { channelArn: targetChannel.channelArn },
      {
        $push: {
          gifts: {
            userId: senderId,
            username: sender,
            gift: giftName,
            giftIcon,
            amount: cost,
            payout: hostPayout,
            at: new Date()
          }
        },
        $inc: { totalRevenue: hostPayout }
      },
      { session }
    );

    await Notification.create([{
      recipientId: targetChannel.hostId,
      senderId: senderId,
      type: 'gift_received',
      title: '🎁 New Gift Received!',
      body: `${sender} sent you a ${giftName} worth ${cost} coins!`,
      data: { giftType, giftName, giftIcon, amount: cost, sender, channelArn: targetChannel.channelArn },
      priority: 'high',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000)
    }], { session });

        await session.commitTransaction();
    treasuryMove(cost - hostPayout, { kind: 'live_gift_cut', userId: senderId, note: String(giftName || '') });

    broadcastToChannel(targetChannel.channelArn, {

      type: 'gift_received',
      gift: {
        id: `gift_${Date.now()}`,
        giftType,
        giftName,
        giftIcon,
        cost,
        rarity,
        animation,
        weight,
        sender,
        senderId,
        timestamp: Date.now()
      }
    });

    res.json({ success: true, giftId: `gift_${Date.now()}`, newBalance: balance - cost });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
     console.error('[live/gift]', error);     await idemRelease(req);
    res.status(500).json({ error: error.message || 'Gift processing failed' });
  } finally {
    if (session) await session.endSession();
  }
});

app.post('/snapsa/live/channel/:channelName/end', snapAuthRequired, async (req, res) => {
  let session = null;

  try {
    const { channelName } = req.params;
    const stats = req.body.stats || {};

    const userChannelArn = liveState.userChannels.get(req.userId);
    if (!userChannelArn) {
      return res.status(404).json({ error: 'No active stream found' });
    }

    const channelData = liveState.channels.get(userChannelArn);
    if (!channelData) {
      return res.status(404).json({ error: 'Channel data not found' });
    }

    const viewerCount = liveState.viewerCounts.get(userChannelArn)?.size || 0;

    session = await mongoose.startSession();
    session.startTransaction();

    const updatedLive = await SnapsaLive.findOneAndUpdate(
      { channelArn: userChannelArn, hostId: req.userId },
      {
        isLive: false,
        endedAt: new Date(),
        viewers: viewerCount,
        peakViewers: stats.peakViewers || viewerCount,
        totalRevenue: stats.totalRevenue || 0,
        finalDuration: stats.duration || 0
      },
      { session, new: true }
    );

    if (!updatedLive) {
      throw new Error('Live stream record not found');
    }

    await session.commitTransaction();

    broadcastToChannel(userChannelArn, {
      type: 'stream_ended',
      channelArn: userChannelArn,
      hostId: req.userId,
      stats: {
        duration: stats.duration,
        peakViewers: stats.peakViewers || viewerCount,
        totalRevenue: stats.totalRevenue
      }
    });

    await cleanupChannel(userChannelArn);

    res.json({
      success: true,
      streamArn: userChannelArn,
      stats: {
        duration: stats.duration,
        peakViewers: stats.peakViewers || viewerCount,
        totalRevenue: stats.totalRevenue,
        totalGifts: updatedLive.gifts?.length || 0
      }
    });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[live/end]', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/search', snapAuth, searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ videos: [], sounds: [], query: q });

        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [videoResults, soundResults, userResults] = await Promise.all([
      SnapsaVideo.aggregate([
        {
          $lookup: {
            from: 'posts',
            localField: 'postId',
            foreignField: '_id',
            as: 'post'
          }
        },
        { $unwind: '$post' },
        {
          $match: {
                        'post.isActive': true, 'privacy.visibility': { $ne: 'private' },
            authorId: { $nin: [...restrictedIds, ...(await hiddenPrivateAuthorIds(req.userId))] },
            $or: [
              { 'post.content': regex },
              { authorName: regex },
              { series: regex },
              { song: regex }
            ]
          }
        },
        { $sort: { 'post.likeCount': -1 } },
        { $limit: 20 },
        {
          $lookup: {
            from: 'snapsa_profiles',
            localField: 'authorId',
            foreignField: 'userId',
            as: 'profile'
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            as: 'userDoc'
          }
        },
        {
          $project: {
            id: '$_id',
            authorId: '$authorId',
            authorName: { $ifNull: [{ $arrayElemAt: ['$profile.username', 0] }, '$authorName'] },
            authorTier: { $ifNull: [{ $arrayElemAt: ['$userDoc.tier', 0] }, ''] },
            authorSnapsaTier: { $ifNull: [{ $arrayElemAt: ['$profile.snapsaTier', 0] }, ''] }, authorDisplayName: { $ifNull: [{ $arrayElemAt: ['$profile.displayName', 0] }, ''] },
            allowDownload: { $ifNull: ['$privacy.allowDownload', true] },
            authorAvatarUrl: { $ifNull: [{ $arrayElemAt: ['$profile.avatarUrl', 0] }, null] },
            caption: '$post.content',
            song: '$song',
            videoUrl: '$videoFile',
            thumbUrl: '$thumbFile',
            views: { $ifNull: ['$views', 0] },
            likes: '$post.likeCount'
          }
        }
      ]),
      SnapsaSound.find({ $or: [{ title: regex }, { artist: regex }] })
        .sort({ uses: -1 })
        .limit(10)
        .lean()
        .then(docs => docs.map(s => ({
          id: s._id,
          title: s.title,
          artist: s.artist,
          thumbUrl: s.thumbFile,
          uses: s.uses
        }))),
      SnapsaProfile.aggregate([
        { $match: { username: regex } },
        { $limit: 20 },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'userDoc'
          }
        },
        {
          $project: {
            id: '$userId',
            userId: '$userId',
            username: '$username',
            bio: '$bio',
            avatarUrl: '$avatarUrl',
            snapsaTier: { $ifNull: ['$snapsaTier', ''] },
            tier: { $ifNull: [{ $arrayElemAt: ['$userDoc.tier', 0] }, ''] },
            followerCount: { $ifNull: [{ $arrayElemAt: ['$userDoc.followerCount', 0] }, 0] }
          }
        },
        { $sort: { followerCount: -1 } }
      ])
    ]);

        
    if (userResults.length === 0) {
      try {
        const qs = q.toLowerCase();
        const lev = (a, b) => {
          let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
          for (let i = 1; i <= a.length; i++) {
            const cur = [i];
            for (let j = 1; j <= b.length; j++) {
              cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = cur;
          }
          return prev[b.length];
        };
        const maxD = Math.max(2, Math.ceil(qs.length * 0.4));
        const pool = await SnapsaProfile.find({ username: { $nin: [null, ''] } }, 'userId username displayName avatarUrl snapsaTier').limit(5000).lean();
        const close = pool
          .map(p => {
            const names = [String(p.username || ''), String(p.displayName || '')].map(x => x.toLowerCase()).filter(Boolean);
            return { p, d: Math.min(...names.map(x => lev(qs, x))) };
          })
          .filter(x => x.d <= maxD)
          .sort((a, b) => a.d - b.d)
          .slice(0, 15);
        for (const { p } of close) {
          userResults.push({ id: p.userId, userId: p.userId, username: p.username, bio: '', avatarUrl: p.avatarUrl || null, snapsaTier: p.snapsaTier || '', tier: '', followerCount: 0, similar: true });
        }
      } catch (e) { console.warn('[search] similar-name fallback failed:', e.message); }
    }
    const blockerSet = new Set([...(await getBlockerIds(req.userId)).map(String), ...restrictedIds.map(String)]);
    
    res.json({
      videos: videoResults.filter(v => !blockerSet.has(String(v.authorId))),
      sounds: soundResults,
      users: userResults.filter(u => !blockerSet.has(String(u.userId))),
      query: q,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/trending', snapAuth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000);
    const trending = await SnapsaVideo.aggregate([
      {
        $lookup: {
          from: 'posts',
          localField: 'postId',
          foreignField: '_id',
          as: 'post'
        }
      },
      { $unwind: '$post' },
      {
        $match: {
                   'post.isActive': true, authorId: { $nin: [...restrictedIds, ...(await hiddenPrivateAuthorIds(req.userId))] },
          createdAt: { $gte: cutoff },
          'privacy.visibility': { $ne: 'private' },
        }
      },
      {
        $addFields: {
          trendingScore: {
            $add: [
              { $multiply: [{ $ifNull: ['$views', 0] }, 1] },
              { $multiply: ['$post.likeCount', 3] },
              { $multiply: ['$post.shareCount', 5] },
            ]
          }
        }
      },
      { $sort: { trendingScore: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'snapsa_profiles',
          localField: 'authorId',
          foreignField: 'userId',
          as: 'profile'
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'authorId',
          foreignField: '_id',
          as: 'userDoc'
        }
      },
      {
        $project: {
          id: '$_id',
          authorId: '$authorId',
          authorName: { $ifNull: [{ $arrayElemAt: ['$profile.username', 0] }, '$authorName'] },
          authorTier: { $ifNull: [{ $arrayElemAt: ['$userDoc.tier', 0] }, ''] },
          authorSnapsaTier: { $ifNull: [{ $arrayElemAt: ['$profile.snapsaTier', 0] }, ''] }, authorDisplayName: { $ifNull: [{ $arrayElemAt: ['$profile.displayName', 0] }, ''] },
          allowDownload: { $ifNull: ['$privacy.allowDownload', true] },
          authorAvatarUrl: { $ifNull: [{ $arrayElemAt: ['$profile.avatarUrl', 0] }, null] },
          caption: '$post.content',
          thumbUrl: '$thumbFile',
          videoUrl: '$videoFile',
          views: { $ifNull: ['$views', 0] },
          likes: '$post.likeCount',
          shares: '$post.shareCount'
        }
      }
    ]);

    res.json({ trending, videos: trending });
  } catch (error) {
    console.error('[trending]', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Simple 1-to-1 calls: the server relays signalling (offer / answer / ice / end).
// If the other person's app is closed, the offer is kept for 45 s, a high-priority push rings their phone,
// and the offer is replayed the moment their app reconnects (see replayPendingCall in the realtime socket handler).
const pendingCalls = new Map();            // calleeId -> { callId, from, fromName, callType, sdp, ice:[], ts }
const PENDING_CALL_MS = 45000;
setInterval(() => { const now = Date.now(); for (const [k, v] of pendingCalls) if (now - v.ts > PENDING_CALL_MS + 15000) pendingCalls.delete(k); }, 30000).unref?.();

function replayPendingCall(userId, ws) {
  const key = String(userId);
  const p = pendingCalls.get(key);
  if (!p) return;
  pendingCalls.delete(key);
  if (Date.now() - p.ts > PENDING_CALL_MS) return;
  const out = (o) => { try { ws.send(JSON.stringify({ type: 'call_signal', callId: p.callId, callType: p.callType, from: p.from, ...o })); } catch {} };
  out({ signal: 'offer', fromName: p.fromName, fromAvatar: p.fromAvatar, sdp: p.sdp });
  p.ice.forEach(c => out({ signal: 'ice', candidate: c }));
}

// ICE servers for calls. Best: Cloudflare Realtime TURN (set CF_TURN_KEY_ID + CF_TURN_API_TOKEN on Render) — short-lived credentials are made here.
// Or any fixed TURN: TURN_URL (comma separated), TURN_USERNAME, TURN_CREDENTIAL.
let _cfIce = null, _cfIceAt = 0;
async function getCloudflareIce() {
  if (!process.env.CF_TURN_KEY_ID || !process.env.CF_TURN_API_TOKEN) return null;
  if (_cfIce && Date.now() - _cfIceAt < 6 * 3600 * 1000) return _cfIce;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) { console.error('[turn] cloudflare', r.status); return _cfIce; }
    const d = await r.json();
    const list = Array.isArray(d.iceServers) ? d.iceServers : (d.iceServers ? [d.iceServers] : []);
    // Cloudflare's :53 URLs are blocked by browsers — drop them
    _cfIce = list.map(x => ({ ...x, urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter(u => !/:53(\?|$)/.test(u)) })).filter(x => x.urls.length);
    _cfIceAt = Date.now();
  } catch (e) { console.error('[turn] cloudflare', e.message); }
  return _cfIce;
}
// Metered.ca (free 20 GB/month, no server needed): set METERED_APP (the name before .metered.live) and METERED_API_KEY
let _mtIce = null, _mtIceAt = 0;
async function getMeteredIce() {
  if (!process.env.METERED_APP || !process.env.METERED_API_KEY) return null;
  if (_mtIce && Date.now() - _mtIceAt < 3600 * 1000) return _mtIce;
  try {
    const r = await fetch(`https://${encodeURIComponent(process.env.METERED_APP)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`);
    if (!r.ok) { console.error('[turn] metered', r.status); return _mtIce; }
    const d = await r.json();
    const list = Array.isArray(d) ? d : (Array.isArray(d.iceServers) ? d.iceServers : []);
    if (list.length) { _mtIce = list; _mtIceAt = Date.now(); }
  } catch (e) { console.error('[turn] metered', e.message); }
  return _mtIce;
}
app.get('/snapsa/call/ice', snapAuth, async (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const cf = (await getCloudflareIce()) || (await getMeteredIce());
  if (cf?.length) iceServers.push(...cf);
  else if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  }
  res.json({ iceServers, relay: !!(cf?.length || process.env.TURN_URL) });
});

// ── Calls leave a bubble in the chat (missed / declined / finished with length / attempt made while the caller was offline)
const callLog = new Map();   // callId -> { caller, callee, callType, answeredAt }
setInterval(() => { const cut = Date.now() - 2 * 3600 * 1000; for (const [k, v] of callLog) if (v.startedAt < cut) callLog.delete(k); }, 600000).unref?.();
async function writeCallBubble({ caller, callee, callType, kind, duration = 0, callId = null }) {
  try {
    const label = { completed: 'Call', missed: 'Missed call', declined: 'Declined call', attempt: 'Call attempt' }[kind] || 'Call';
    const now = new Date();
    const seen = kind === 'completed' || kind === 'declined';   // only missed calls / attempts count as unread
    const doc = await SnapsaMessage.create({
      chatId: buildSnapChatId(caller, callee), senderId: caller, receiverId: callee, type: 'system',
      text: `${callType === 'video' ? 'Video' : 'Voice'} ${label.toLowerCase()}`,
      callInfo: { kind, callType, duration, callId },
      deliveredAt: now, ...(seen ? { readAt: now, read: true } : {}),
    });
    broadcastToUser(String(callee), { type: 'snapsa_dm', message: { ...doc.toObject(), status: snapMsgStatus(doc) } });
  } catch (e) { console.error('[call-bubble]', e.message); }
}
// Caller had no connection: the app rings for 10 s, ends, and sends this when the connection is back.
app.post('/snapsa/call/attempt', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in' });
    const to = String(req.body.to || '');
    if (!/^[a-f0-9]{24}$/i.test(to) || to === String(req.userId)) return res.status(400).json({ error: 'Invalid recipient' });
    const callId = String(req.body.callId || '').slice(0, 64) || null;
    if (callId && await SnapsaMessage.exists({ 'callInfo.callId': callId })) return res.json({ success: true, duplicate: true });
    if (await isBlockedBy(to, req.userId)) return res.json({ success: true });
    const callType = req.body.callType === 'video' ? 'video' : 'audio';
    await writeCallBubble({ caller: req.userId, callee: to, callType, kind: 'attempt', callId });
    snapActorName(req.userId).then(name => sendPushToUser(to, {
      title: `Missed ${callType === 'video' ? 'video' : 'voice'} call`, body: `${name} tried to call you but they were offline`,
      data: { type: 'missed_call', senderId: req.userId },
    })).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const callSignalLimiter = rateLimit({ windowMs: 60000, max: 600 });
app.post('/snapsa/call/signal', snapAuth, callSignalLimiter, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to call' });
    const me = String(req.userId);
    const to = String(req.body.to || '');
    const type = String(req.body.type || '');
    const callId = String(req.body.callId || '').slice(0, 64);
    const callType = req.body.callType === 'video' ? 'video' : 'audio';
    if (!/^[a-f0-9]{24}$/i.test(to) || to === me) return res.status(400).json({ error: 'Invalid recipient' });
    if (!['offer', 'answer', 'ice', 'decline', 'end', 'busy'].includes(type) || !callId) return res.status(400).json({ error: 'Invalid signal' });
    const sdp = typeof req.body.sdp === 'string' ? req.body.sdp.slice(0, 20000) : undefined;
    const candidate = req.body.candidate && typeof req.body.candidate === 'object' ? {
      candidate: String(req.body.candidate.candidate || '').slice(0, 600),
      sdpMid: req.body.candidate.sdpMid ?? null,
      sdpMLineIndex: req.body.candidate.sdpMLineIndex ?? null,
    } : undefined;

    if (type === 'offer') {
      if (await isBlockedBy(to, me) || await isBlockedBy(me, to)) return res.json({ success: true, delivered: false });
      if (await getAccountRestriction(to)) return res.json({ success: true, delivered: false });
      const toDef = (await SnapsaProfile.findOne({ userId: to }).select('defconLevel').lean())?.defconLevel || 5;
      if (toDef <= 3 && !(await Follower.exists({ followerId: to, followingId: me }))) return res.json({ success: true, delivered: false });
      callLog.set(callId, { caller: me, callee: to, callType, startedAt: Date.now(), answeredAt: null });
    }
    {
      const L = callLog.get(callId);
      if (L && type === 'answer' && !L.answeredAt) L.answeredAt = Date.now();
      if (L && ['end', 'decline', 'busy'].includes(type)) {
        callLog.delete(callId);
        const duration = L.answeredAt ? Math.max(1, Math.round((Date.now() - L.answeredAt) / 1000)) : 0;
        const kind = L.answeredAt ? 'completed' : type === 'decline' ? 'declined' : 'missed';
        writeCallBubble({ caller: L.caller, callee: L.callee, callType: L.callType, kind, duration, callId });
      }
    }
    const fromName = type === 'offer' ? await snapActorName(me) : undefined;
    const fromAvatar = type === 'offer' ? ((await SnapsaProfile.findOne({ userId: me }, 'avatarUrl').lean().catch(() => null))?.avatarUrl || '') : undefined;
    const online = await isSnapUserOnline(to);

    if (online) {
      pendingCalls.delete(to);
      deliverToSnapUser(to, { type: 'call_signal', signal: type, callId, callType, from: me, fromName, fromAvatar, sdp, candidate });
      return res.json({ success: true, delivered: true });
    }

    // Callee's app is closed
    if (type === 'offer') {
      const hasDevice = firebaseReady && (await SnapsaDeviceToken.countDocuments({ userId: to })) > 0;
      if (!hasDevice) return res.json({ success: true, delivered: false });
      pendingCalls.set(to, { callId, from: me, fromName, fromAvatar, callType, sdp, ice: [], ts: Date.now() });
      sendPushToUser(to, {
        title: `Incoming ${callType} call`, body: `@${fromName} is calling you on Snapsa`,
        data: { type: 'incoming_call', callId, senderId: me, callType },
        channelId: 'snapsa_calls_v2', ttlMs: PENDING_CALL_MS,
      });
      return res.json({ success: true, delivered: false, queued: true });
    }
    const p = pendingCalls.get(to);
    if (p && p.callId === callId && p.from === me) {
      if (type === 'ice' && candidate) { if (p.ice.length < 50) p.ice.push(candidate); }
      else if (type === 'end') {
        pendingCalls.delete(to);
        const nm = await snapActorName(me);
        sendPushToUser(to, { title: `Missed ${p.callType} call`, body: `@${nm} tried to call you`, data: { type: 'missed_call', senderId: me } });
      }
    }
    res.json({ success: true, delivered: false });
  } catch (e) {
    console.error('[call/signal]', e.message);
    res.status(500).json({ error: 'Could not place the call' });
  }
});

app.post('/snapsa/presence/ping', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
    touchLastActive(req.userId);
    markDeliveredOnConnect(req.userId);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});


// Notifications are kept for a year (raises any shorter TTL index the notification model may have)
(function keepNotificationsAYear() {
  const run = async () => {
    try {
      const col = Notification.collection;
      for (const i of await col.indexes()) {
        if (typeof i.expireAfterSeconds === 'number' && i.expireAfterSeconds < 31536000) {
          await mongoose.connection.db.command({ collMod: col.collectionName, index: { name: i.name, expireAfterSeconds: 31536000 } });
          console.log('[notif-ttl] raised', i.name, 'to 1 year');
        }
      }
    } catch (e) { console.error('[notif-ttl]', e.message); }
  };
  if (mongoose.connection.readyState === 1) run(); else mongoose.connection.once('open', run);
})();

// ───────── DEFCON: the user's own threat level ─────────
const DEFCON_INFO = {
  5: 'Normal operation.',
  4: 'Restricted: your online status and last-seen are hidden from everyone.',
  3: 'Lockdown: you cannot call, message, post, post stories or upload. You can only watch videos, read posts and use Snapsa Music.',
  2: 'Purge cache: caches and temporary data on this device are cleared.',
  1: 'Factory reset: stories, posts and chats are permanently burned. All gifts are converted to coins and sent to your Snapsa Wallet. Your identity and Snapsa Wallet are kept.',
};
app.get('/snapsa/defcon', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in' });
    const p = await SnapsaProfile.findOne({ userId: req.userId }).select('defconLevel').lean();
    res.json({ level: p?.defconLevel || 5, info: DEFCON_INFO });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/snapsa/defcon/level', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in' });
    const level = parseInt(req.body.level, 10);
    if (![2, 3, 4, 5].includes(level)) return res.status(400).json({ error: 'Level 1 needs the burn confirmation' });
    // 2 (purge) is an action on the device; the stored level then returns to what it was (never below 3 for 2)
    await SnapsaProfile.updateOne({ userId: req.userId }, { $set: { defconLevel: level } });
    _defconCache.delete(String(req.userId));
    res.json({ success: true, level });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/snapsa/defcon/burn', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in' });
    if (req.body.confirmation !== 'BURN') return res.status(400).json({ error: 'Type BURN to confirm' });
    const me = req.userId;
    // gifts → coins (same rate as manual conversion) → straight into the Snapsa Wallet, which is never touched otherwise
    let giftCoins = 0, toWallet = false;
    try {
      const u = await User.findById(me).select('giftInventory').lean();
      const pr = await SnapsaProfile.findOne({ userId: me }).select('inventory').lean();
      const inv = pr?.inventory ? (typeof pr.inventory.toObject === 'function' ? pr.inventory.toObject() : pr.inventory) : {};
      const legacyMap = Object.fromEntries(Object.entries(STORE_ITEM_LEGACY_KEY).map(([id, k]) => [k, id]));
      const counts = {};
      for (const [id, n] of Object.entries(inv)) counts[id] = (counts[id] || 0) + (Number(n) || 0);
      for (const [k, n] of Object.entries(u?.giftInventory || {})) { const id = legacyMap[k]; if (id) counts[id] = (counts[id] || 0) + (Number(n) || 0); }
      for (const [id, n] of Object.entries(counts)) if (n > 0 && STORE_ITEM_PRICES[id]) giftCoins += Math.floor(STORE_ITEM_PRICES[id].coins * n * GIFT_TO_COIN_REFUND_RATE);
      if (giftCoins > 0) {
        await SnapsaProfile.updateOne({ userId: me }, { $set: { inventory: {} } });
        await User.updateOne({ _id: me }, { $set: { 'giftInventory.flowers': 0, 'giftInventory.diamonds': 0, 'giftInventory.rockets': 0, 'giftInventory.crowns': 0 } });
        const wallet = await SnapsaWallet.findOne({ userId: me }).lean();
        const minor = wallet && wallet.status === 'active' ? coinsToWalletMinor(wallet, giftCoins) : 0;
        if (minor > 0) {
          await SnapsaWalletEntry.create({ txId: crypto.randomUUID(), walletId: wallet._id, amountMinor: minor, kind: 'transfer_in', status: 'posted', partnerRef: `defcon1:${me}:${Date.now()}`, description: `DEFCON 1: gifts converted to coins (${giftCoins} coins)` });
          toWallet = true;
        } else {
          await awardCoins(me, giftCoins);   // no active wallet: keep the value as coins instead of losing it
        }
        await logCoinTransaction({ userId: me, type: 'credit', amount: giftCoins, description: 'DEFCON 1: gifts converted to coins', metadata: { toWallet } }).catch(() => {});
      }
    } catch (e) { console.error('[defcon/gifts]', e.message); }
    // ── everything is removed BEFORE we answer, so the app's "burning…" screen only ends when it is all gone
    const meOid = new mongoose.Types.ObjectId(String(me));
    // videos: the feed card (post) goes inactive, the video + saved copies are deleted
    const vids = await SnapsaVideo.find({ authorId: me }).select('_id postId').lean();
    const vidIds = vids.map(v => v._id), vidPostIds = vids.map(v => v.postId).filter(Boolean);
    if (vidPostIds.length) await Post.updateMany({ _id: { $in: vidPostIds } }, { $set: { isActive: false, deletedAt: new Date() } }).catch(() => {});
    const vd = await SnapsaVideo.deleteMany({ authorId: me });
    if (vidIds.length) await SnapsaSavedVideo.deleteMany({ videoId: { $in: vidIds } }).catch(() => {});
    await SnapsaSavedVideo.deleteMany({ userId: me }).catch(() => {});
    // chats: all messages go; the other person keeps an empty chat with a "burned identity" notice
    const chats = await SnapsaMessage.aggregate([
      { $match: { $or: [{ senderId: meOid }, { receiverId: meOid }] } },
      { $group: { _id: '$chatId', other: { $first: { $cond: [{ $eq: ['$senderId', meOid] }, '$receiverId', '$senderId'] } } } },
    ]);
    const ms = await SnapsaMessage.deleteMany({ $or: [{ senderId: me }, { receiverId: me }] });
    if (chats.length) {
      await SnapsaMessage.insertMany(chats.map(c => ({
        chatId: c._id, senderId: me, receiverId: c.other, type: 'system',
        text: 'THE USER BURNED THEIR IDENTITY', hideFromSender: true,
      }))).catch(e => console.error('[defcon/notice]', e.message));
    }
    // posts: the content goes, the shell (time, likes, comments, shares) stays with a DEFCON 1 pill
    const po = await SnapsaPost.updateMany({ authorId: me }, { $set: { burned: true, text: '', mediaFile: '', mediaType: '', feeling: '', place: '', mood: '', moodLevel: '', qa: '', tags: [] }, $unset: { poll: 1, song: 1 } });
    const st = await SnapsaStory.deleteMany({ authorId: me });
    // notifications: only the ones in THEIR inbox are removed; what they sent to others stays (shown without any link to them)
    const nt = await Notification.deleteMany({ recipientId: me }).catch(() => ({ deletedCount: 0 }));
    await SnapsaProfile.updateOne({ userId: me }, { $set: { defconLevel: 5, burnedAt: new Date() } });
    _defconCache.delete(String(me));
    res.json({ success: true, giftCoins, toWallet, burned: { videos: vd.deletedCount, stories: st.deletedCount, posts: po.modifiedCount || 0, chats: chats.length, messages: ms.deletedCount, notifications: nt.deletedCount || 0 } });
  } catch (e) { console.error('[defcon/burn]', e.message); res.status(500).json({ error: 'Burn failed' }); }
});

app.get('/snapsa/profile-by-username/:username', snapAuth, async (req, res) => {
  try {
    const u = String(req.params.username || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
    if (!u) return res.status(400).json({ error: 'Bad username' });
    const p = await SnapsaProfile.findOne({ username: u.toLowerCase() }).select('userId username').lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ id: String(p.userId), username: p.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/snapsa/users/:userId/presence', snapAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ error: 'Invalid user' });
    const profile = await SnapsaProfile.findOne({ userId: req.params.userId }).select('lastActiveAt privacy.showActivityStatus defconLevel').lean();
    const isSelf = String(req.userId) === String(req.params.userId);
    const sharingStatus = isSelf || profile?.privacy?.showActivityStatus !== false;
    if (!sharingStatus || (!isSelf && (profile?.defconLevel || 5) <= 4)) return res.json({ online: false, lastActiveAt: null });
    res.json({ online: await isSnapUserOnline(req.params.userId), lastActiveAt: profile?.lastActiveAt || null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/users/:userId', snapAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).lean().catch(() => null);
    const profile = await SnapsaProfile.findOne({ userId: req.params.userId }).lean();
    if (!user && !profile) return res.status(404).json({ error: 'User not found' });

    const viewerId = req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? String(req.userId) : null;
    let blockedByThem = false, blockedByMe = false, hiddenByMe = false;
    if (viewerId && viewerId !== String(req.params.userId)) {
      [blockedByThem, blockedByMe, hiddenByMe] = await Promise.all([
        isBlockedBy(req.params.userId, viewerId),
        isBlockedBy(viewerId, req.params.userId),
        SnapsaHide.exists({ userId: _oid(viewerId), hiddenUserId: _oid(req.params.userId) }).then(Boolean),
      ]);
    }
    const PROFILE_VIDEOS_PAGE_SIZE = 24;
    const ownerIsPrivate = !!profile?.privacy?.privateAccount;     const viewerIsOwner = !!viewerId && viewerId === String(req.params.userId);     const viewerFollows = ownerIsPrivate && !viewerIsOwner && viewerId       ? !!(await Follower.exists({ followerId: viewerId, followingId: req.params.userId }))       : false;     const privateLocked = ownerIsPrivate && !viewerIsOwner && !viewerFollows;     const followRequested = privateLocked && viewerId       ? !!(await FollowRequest.exists({ fromUserId: viewerId, toUserId: req.params.userId, status: 'pending' }))       : false;     const videos = (blockedByThem || privateLocked) ? [] : await SnapsaVideo.aggregate([
      { $match: { authorId: new mongoose.Types.ObjectId(req.params.userId) } },
      {
        $lookup: {
          from: 'posts',
          localField: 'postId',
          foreignField: '_id',
          as: 'post'
        }
      },
      { $unwind: '$post' },
      {
        $match: {
          'post.isActive': true, authorId: { $nin: restrictedIds },
          $or: [
            { 'privacy.visibility': { $ne: 'private' } },

            
            ...(String(req.userId) === String(req.params.userId) ? [{}] : []),
          ],
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: PROFILE_VIDEOS_PAGE_SIZE },
      {
        $project: {
          id: '$_id',
          authorName: '$authorName',
          caption: '$post.content',
          videoUrl: '$videoFile',
          thumbUrl: '$thumbFile',
          likes: '$post.likeCount',
          isLive: '$isLive',
          visibility: { $ifNull: ['$privacy.visibility', 'public'] },
          allowDownload: { $ifNull: ['$privacy.allowDownload', true] },
          createdAt: '$createdAt',
        }
      }
    ]);
    const nextCursor = videos.length === PROFILE_VIDEOS_PAGE_SIZE ? videos[videos.length - 1].createdAt : null;

    const isFollowing = !!(await Follower.findOne({
      followerId: req.userId,
      followingId: req.params.userId
    }).lean());

    const isSelf = String(req.userId) === String(req.params.userId);
    const sharingStatus = isSelf || profile?.privacy?.showActivityStatus !== false;

    res.json({
      user: {
        id: req.params.userId,
        username: profile?.username || null,
        bio: profile?.bio || '',
        avatarUrl: profile?.avatarUrl || null,
        followerCount: await Follower.countDocuments({ followingId: req.params.userId }),
        followingCount: (String(req.userId) !== String(req.params.userId) && profile?.privacy?.hideFollowingList) ? null : await Follower.countDocuments({ followerId: req.params.userId }),         followingHidden: String(req.userId) !== String(req.params.userId) && !!profile?.privacy?.hideFollowingList,
        totalLikes: await snapsaTotalLikes(req.params.userId),
        tier: user?.tier || '',
        snapsaTier: profile?.snapsaTier || '',
        rank: user?.rank || null,
        online: sharingStatus ? await isSnapUserOnline(req.params.userId) : false,
        lastActiveAt: sharingStatus ? (profile?.lastActiveAt || null) : null,
        isSystemAccount: profile?.isSystemAccount || false,
        displayName: profile?.displayName || '',
        countryCode: profile?.countryCode || null,
        countryName: profile?.countryName || null,
        inCircle: String(req.userId) === String(req.params.userId) ? !!profile?.privacy?.inCircle : undefined,
        work: profile?.workCompany ? { company: profile.workCompany, position: profile.workPosition || '', start: profile.workStart || '', status: (profile.workStatus === 'approved' || String(req.userId) === String(req.params.userId)) ? profile.workStatus : '' } : null,
        crew: profile?.crewPosition || '',
        official: profile?.officialLabel || '',
      },
      videos,
      nextCursor,
      isFollowing,
      blockedByMe, blockedByThem, hiddenByMe, privateLocked, isPrivate: ownerIsPrivate, followRequested
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Subsequent pages for a profile's video grid — cursor-based (keyset) on
// createdAt so pagination stays correct even as new videos get uploaded
// in between page loads, unlike an offset/skip approach.
app.get('/snapsa/users/:userId/videos', snapAuth, async (req, res) => {
  try {
    const PROFILE_VIDEOS_PAGE_SIZE = 24;
        const { before } = req.query;
    if (!(await canViewAccountContent(req.userId, req.params.userId))) return res.json({ videos: [], nextCursor: null });
    if (req.userId && String(req.userId) !== String(req.params.userId) && await isBlockedBy(req.params.userId, req.userId)) {
      return res.json({ videos: [], nextCursor: null });
    }
    const pipeline = [
      { $match: { authorId: new mongoose.Types.ObjectId(req.params.userId) } },
      {
        $lookup: {
          from: 'posts',
          localField: 'postId',
          foreignField: '_id',
          as: 'post'
        }
      },
      { $unwind: '$post' },
      {
        $match: {
          'post.isActive': true, authorId: { $nin: restrictedIds },
          $or: [
            { 'privacy.visibility': { $ne: 'private' } },
            ...(String(req.userId) === String(req.params.userId) ? [{}] : []),
          ],
        }
      },
    ];
    if (before) pipeline.push({ $match: { createdAt: { $lt: new Date(before) } } });
    pipeline.push({ $sort: { createdAt: -1 } });
    pipeline.push({ $limit: PROFILE_VIDEOS_PAGE_SIZE });
    pipeline.push({
      $project: {
        id: '$_id',
        authorName: '$authorName',
        caption: '$post.content',
        videoUrl: '$videoFile',
        thumbUrl: '$thumbFile',
        likes: '$post.likeCount',
        isLive: '$isLive',
        visibility: { $ifNull: ['$privacy.visibility', 'public'] },
        allowDownload: { $ifNull: ['$privacy.allowDownload', true] },
        createdAt: '$createdAt',
      }
    });
    const videos = await SnapsaVideo.aggregate(pipeline);
    await enrichVideoCounts(videos, req.userId);
    const nextCursor = videos.length === PROFILE_VIDEOS_PAGE_SIZE ? videos[videos.length - 1].createdAt : null;
    res.json({ videos, nextCursor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ── Follow / Unfollow a Snapsa user (private accounts use follow requests) ───
app.post('/snapsa/users/:userId/follow', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const targetId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(targetId)) return res.status(400).json({ error: 'Invalid user' });
    if (String(targetId) === String(req.userId)) return res.status(400).json({ error: 'Cannot follow yourself' });
    if (await isBlockedBy(targetId, req.userId)) return res.status(403).json({ error: "You can't follow this account" });

    if (await Follower.exists({ followerId: req.userId, followingId: targetId })) {
      return res.status(409).json({ error: 'Already following' });
    }
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const followerName = profile?.username || 'Someone';
    const targetProfile = await SnapsaProfile.findOne({ userId: targetId }).select('privacy.privateAccount').lean();

    if (targetProfile?.privacy?.privateAccount) {
      const prev = await FollowRequest.findOne({ fromUserId: req.userId, toUserId: targetId }).lean();
      if (prev?.status === 'pending') return res.json({ success: true, requested: true });
      await FollowRequest.findOneAndUpdate(
        { fromUserId: req.userId, toUserId: targetId },
        { $set: { status: 'pending' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      createSnapNotification({
        recipientId: targetId, senderId: req.userId, type: 'follow',
        title: `@${followerName} requested to follow you`,
        body: 'Open your Followers list to approve or deny',
        data: { authorId: req.userId, kind: 'follow_request' }, priority: 'medium',
        expiresAt: new Date(Date.now() + 30 * 86400000),
      }).catch(() => {});
      return res.json({ success: true, requested: true });
    }

    const created = await createFollowEdge(req.userId, targetId);
    if (!created) return res.status(409).json({ error: 'Already following' });
    createSnapNotification({
      recipientId: targetId, senderId: req.userId, type: 'follow',
      title: `@${followerName} started following you`, body: '',
      data: { authorId: req.userId }, priority: 'medium',
      expiresAt: new Date(Date.now() + 30 * 86400000),
    }).catch(() => {});
    const target = await User.findById(targetId).lean();
    res.json({ success: true, followerCount: await Follower.countDocuments({ followingId: targetId }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/snapsa/users/:userId/follow', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const removed = await Follower.deleteOne({ followerId: req.userId, followingId: req.params.userId });
    await FollowRequest.deleteOne({ fromUserId: req.userId, toUserId: req.params.userId, status: 'pending' });
    if (removed.deletedCount) {
      await User.findByIdAndUpdate(req.params.userId, { $inc: { followerCount: -1 } });
      await User.findByIdAndUpdate(req.userId, { $inc: { followingCount: -1 } });
    }
    const target = await User.findById(req.params.userId).lean();
    const tp = await SnapsaProfile.findOne({ userId: req.params.userId }).select('privacy.privateAccount').lean();
    res.json({ success: true, followerCount: await Follower.countDocuments({ followingId: req.params.userId }), private: !!tp?.privacy?.privateAccount });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Incoming follow requests for my private account
app.get('/snapsa/follow-requests', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const rows = await FollowRequest.find({ toUserId: req.userId, status: 'pending' }).sort({ createdAt: -1 }).limit(100).lean();
    const ids = rows.map(r => r.fromUserId);
    const profiles = await SnapsaProfile.find({ userId: { $in: ids } }).lean();
    const byId = Object.fromEntries(profiles.map(p => [String(p.userId), p]));
    res.json({ requests: rows.map(r => {
      const p = byId[String(r.fromUserId)] || {};
      return { userId: r.fromUserId, username: p.username || '', displayName: p.displayName || '', avatarUrl: p.avatarUrl || null, snapsaTier: p.snapsaTier || '' };
    }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/follow-requests/:userId/approve', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const r = await FollowRequest.findOneAndUpdate(
      { fromUserId: req.params.userId, toUserId: req.userId, status: 'pending' },
      { $set: { status: 'accepted' } }, { new: true }
    );
    if (!r) return res.status(404).json({ error: 'No pending request from this user' });
    await createFollowEdge(req.params.userId, req.userId);
    const me = await SnapsaProfile.findOne({ userId: req.userId }).select('username').lean();
    createSnapNotification({
      recipientId: req.params.userId, senderId: req.userId, type: 'follow',
      title: `@${me?.username || 'Someone'} accepted your follow request`, body: '',
      data: { authorId: req.userId }, priority: 'medium',
      expiresAt: new Date(Date.now() + 30 * 86400000),
    }).catch(() => {});
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/follow-requests/:userId/deny', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    await FollowRequest.updateOne(
      { fromUserId: req.params.userId, toUserId: req.userId, status: 'pending' },
      { $set: { status: 'rejected' } }
    );
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Follow lists, and removing a follower ───────────────────────────────────
app.get('/snapsa/users/me/follows', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const type = req.query.type === 'followers' ? 'followers' : 'following';
    const rows = await Follower.find(
      type === 'followers' ? { followingId: req.userId } : { followerId: req.userId }
    ).sort({ createdAt: -1 }).limit(200).lean();
    const otherIds = rows.map(r => (type === 'followers' ? r.followerId : r.followingId));
    const profiles = await SnapsaProfile.find({ userId: { $in: otherIds } }).lean();
    const byId = Object.fromEntries(profiles.map(p => [String(p.userId), p]));
    res.json({ type, users: otherIds.map(id => {
      const p = byId[String(id)] || {};
      return {
        userId: id,
        username: p.username || '',
        displayName: p.displayName || '',
        avatarUrl: p.avatarUrl || null,
        snapsaTier: p.snapsaTier || '',
      };
    }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/snapsa/users/me/followers/:userId', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const removed = await Follower.deleteOne({ followerId: req.params.userId, followingId: req.userId });
    if (removed.deletedCount) {
      await User.findByIdAndUpdate(req.userId, { $inc: { followerCount: -1 } });
      await User.findByIdAndUpdate(req.params.userId, { $inc: { followingCount: -1 } });
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const WATCH_REWARD_THRESHOLD_MS = 2 * 60 * 60 * 1000; 

// ── The coin is pegged to USD: 1 Snapsa Coin = exactly $0.60. Wallet money = coins × 0.60 × the USD rate of the wallet's currency.
const SNAPSA_COIN_VALUE_USD = 0.60;
const WALLET_COUNTRY_CURRENCY = { BW: 'BWP', NA: 'NAD', ZW: 'USD', ZA: 'ZAR', LS: 'LSL' };   // the only countries that can hold a Snapsa Wallet
const USD_RATES = (() => {                                    // how much of each currency $1 buys; override with env SNAPSA_USD_RATES='{"ZAR":18.2,"BWP":13.6}'
  const base = { USD: 1, ZAR: 18.5, BWP: 13.7, NAD: 18.5, LSL: 18.5 };
  try { return { ...base, ...JSON.parse(process.env.SNAPSA_USD_RATES || '{}') }; } catch { return base; }
})();
const usdRateFor = (cur) => Number(USD_RATES[String(cur || 'USD').toUpperCase()]) || 1;
const SNAPSA_COIN_VALUE_ZAR = +(SNAPSA_COIN_VALUE_USD * usdRateFor('ZAR')).toFixed(4);   // kept so older code paths keep working
const coinsToZar = (coins) => +(Number(coins || 0) * SNAPSA_COIN_VALUE_ZAR).toFixed(2);
const zarToCoins = (zar) => +(Number(zar || 0) / SNAPSA_COIN_VALUE_ZAR).toFixed(4);

const WATCH_REWARD_AMOUNT = zarToCoins(0.05); 
const todayStr = () => new Date().toISOString().slice(0, 10);

const STORE_ITEM_PRICES = {
  clap:         { priceUsd: 1.2,  coins: 2,    weight: 1   },
  heart:        { priceUsd: 1.8,  coins: 3,    weight: 1   },
  star:         { priceUsd: 3.0,  coins: 5,    weight: 1   },
  rose:         { priceUsd: 4.8,  coins: 8,   weight: 2   },
  fire:         { priceUsd: 7.8,  coins: 13,   weight: 5   },
  rocket:       { priceUsd: 10.2,  coins:  17,   weight: 10  },
  crown:        { priceUsd: 19.8, coins: 33,   weight: 20  },
  unicorn:      { priceUsd: 34.8, coins: 58,  weight: 30  },
  diamond:      { priceUsd: 60.0, coins: 100,  weight: 100 },
  dragon:       { priceUsd: 120.0,coins: 200,  weight: 200 },
  galaxy:       { priceUsd: 250.2,coins: 417, weight: 500 },
  african_drum: { priceUsd: 3.6,  coins: 6,    weight: 3   },
  elephant:     { priceUsd: 7.2,  coins: 12,    weight: 8   },
  lion:         { priceUsd: 9.0,  coins: 15,   weight: 10  },
  samba:        { priceUsd: 4.2,  coins: 7,    weight: 3   },
  lantern:      { priceUsd: 4.2,  coins: 7,    weight: 4   },
  sakura:       { priceUsd: 6.6,  coins: 11,    weight: 6   },
  eiffel:       { priceUsd: 7.2,  coins: 12,    weight: 8   },
  pyramid:      { priceUsd: 8.4,  coins: 14,    weight: 9   },
  maple:        { priceUsd: 3.0,  coins: 5,    weight: 2   },
  kangaroo:     { priceUsd: 7.2,  coins: 12,    weight: 7   },
  mystery_box:  { priceUsd: 4.8,  coins: 8,    weight: 0   },
};
const BULK5_DISCOUNT = 0.9; 

const STORE_ITEM_LEGACY_KEY = {
  rose: 'flowers', diamond: 'diamonds', rocket: 'rockets', crown: 'crowns',
};

// Everything that moved your coins: gifts you sent and received, coin packs you bought, transfers to Snapsa Wallet, ad payments, refunds…
app.get('/snapsa/wallet/coin-history', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in' });
    const rows = await SnapsaCoinLedger.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(300).lean();
    res.json({
      coinValueUsd: SNAPSA_COIN_VALUE_USD,
      transactions: rows.map(r => ({ id: String(r._id), direction: r.type, coins: Math.abs(r.amount), description: r.description || (r.type === 'credit' ? 'Coins received' : 'Coins spent'), kind: (r.metadata && (r.metadata.kind || r.metadata.source)) || '', at: r.createdAt })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/snapsa/wallet/balance', snapAuthRequired, async (req, res) => {
  try {
    
    
    
    const user = await User.findById(req.userId).select('coins earnings reservedBalance giftInventory').lean();
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).select('inventory coins').lean();
    res.json({
      coins: Math.max(0, user?.coins || 0) + (profile?.coins || 0),
      coinValueUsd: SNAPSA_COIN_VALUE_USD, coinValueZar: SNAPSA_COIN_VALUE_ZAR, 
      earnings: user?.earnings || 0,
      reserved: user?.reservedBalance || 0,
      flowers: user?.giftInventory?.flowers || 0,
      diamonds: user?.giftInventory?.diamonds || 0,
      rockets: user?.giftInventory?.rockets || 0,
      crowns: user?.giftInventory?.crowns || 0,
      inventory: profile?.inventory || {}, 
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Snapsa Coins → Snapsa Wallet ────────────────────────────────────────────
function coinsToWalletMinor(wallet, coins) {
  return Math.floor(+(coins * SNAPSA_COIN_VALUE_USD * usdRateFor(wallet.currency) * 100).toFixed(6));
}

app.get('/snapsa/wallet/transfer-from-coins/quote', snapAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const coins = Number(req.query.coins);
    if (!Number.isInteger(coins) || coins < 1) return res.status(400).json({ error: 'Enter a whole number of coins' });
    const wallet = await SnapsaWallet.findOne({ userId: req.userId }).lean();
    if (!wallet) return res.status(404).json({ error: 'You need a Snapsa Wallet first', code: 'NO_WALLET' });
    res.json({ coins, amount: coinsToWalletMinor(wallet, coins) / 100, currency: wallet.currency });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/snapsa/wallet/transfer-from-coins', snapAuth, async (req, res) => {
  return res.status(410).json({ error: 'Coins are now moved with a transfer request. Open Transfer to Snapsa Wallet and send a request.', code: 'USE_REQUEST' });
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const coins = Number(req.body.coins);
    if (!Number.isInteger(coins) || coins < 1) return res.status(400).json({ error: 'Enter a whole number of coins to transfer' });
    const wallet = await SnapsaWallet.findOne({ userId: req.userId }).lean();
    if (!wallet) return res.status(404).json({ error: 'You need a Snapsa Wallet first — apply for one in Snapsa Wallet', code: 'NO_WALLET' });
    if (wallet.status !== 'active') return res.status(403).json({ error: 'Your Snapsa Wallet is not active' });
    const amountMinor = coinsToWalletMinor(wallet, coins);
    if (amountMinor < 1) return res.status(400).json({ error: 'Amount too small to transfer' });
    if (!(await idemClaim(req, res, 'coins-to-wallet'))) return;

    session = await mongoose.startSession();
    session.startTransaction();
    const balance = await getSnapsaCoinBalance(req.userId, { session });
    if (balance < coins) throw new Error(`You only have ${balance} coins available.`);

    await SnapsaWallet.updateOne({ _id: wallet._id }, { $inc: { ledgerVersion: 1 } }, { session }); // row lock
    await awardCoins(req.userId, -coins, { session });
    await SnapsaWalletEntry.create([{
      txId: crypto.randomUUID(), walletId: wallet._id, amountMinor, kind: 'transfer_in', status: 'posted',
      partnerRef: `coins:${req.userId}:${req.idem.key}`,
      description: `Transfer from Snapsa Coins (${coins} coins)`,
    }], { session });
    await logCoinTransaction({
      userId: req.userId, type: 'debit', amount: -coins,
      description: 'Transferred to Snapsa Wallet',
      metadata: { walletId: String(wallet._id), amountMinor, currency: wallet.currency },
    }, { session });
    await session.commitTransaction();

    const result = { success: true, coins, amount: amountMinor / 100, currency: wallet.currency, newBalance: balance - coins };
    await idemDone(req, result);
    res.json(result);
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    await idemRelease(req);
    console.error('[coins-to-wallet]', error);
    res.status(error.status || 400).json({ error: error.message || 'Transfer failed' });
  } finally {
    if (session) await session.endSession();
  }
});

const MIN_WITHDRAWAL_COINS = 10;

app.post('/snapsa/wallet/withdraw-request', snapAuthRequired, async (req, res) => {
  let session = null;
  try {
    const { accountHolderName, bankName, accountNumber, branchCode, email, amount } = req.body || {};
    if (![accountHolderName, bankName, accountNumber, branchCode, email].every(v => typeof v === 'string' && v.trim())) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const user = await User.findById(req.userId).select('username email reservedBalance').session(session);
    if (!user) throw new Error('User not found');
    const availableCoins = await getSnapsaCoinBalance(req.userId, { session });

    
    
    let coinsRequested = availableCoins;
    if (amount !== undefined && amount !== null && amount !== '') {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || !Number.isInteger(parsedAmount) || parsedAmount <= 0) {
        throw new Error('Enter a valid whole number of coins to withdraw');
      }
      coinsRequested = parsedAmount;
    }

    if (coinsRequested < MIN_WITHDRAWAL_COINS) {
      throw new Error(`You need at least ${MIN_WITHDRAWAL_COINS} coins to withdraw — you have ${availableCoins}.`);
    }
    if (coinsRequested > availableCoins) {
      throw new Error(`You only have ${availableCoins} coins available to withdraw.`);
    }
    const zarValue = coinsRequested * SNAPSA_COIN_VALUE_ZAR;

    
    
    await awardCoins(req.userId, -coinsRequested, { session });
    user.reservedBalance = (user.reservedBalance || 0) + zarValue;
    await user.save({ session });

    const [request] = await SnapsaWithdrawalRequest.create([{
      userId: req.userId,
            accountHolderName: encField(accountHolderName.trim()),
      bankName: encField(bankName.trim()),
      accountNumber: encField(accountNumber.trim()),
      branchCode: encField(branchCode.trim()),
      email: encField(email.trim()),
      coinsRequested,
      zarValue,
      status: 'pending',
    }], { session });

    await session.commitTransaction();
    
    if (mailTransporter) {
      mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: 'snapsa.client@gmail.com',
        subject: `Withdrawal request — ${coinsRequested.toLocaleString()} coins (R${zarValue.toLocaleString()})`,
        text: [
          `User: @${user.username || req.userId} (${user.email || 'no email on file'})`,
          `Coins requested: ${coinsRequested} (≈ R${zarValue})`,
          '',
          `Account holder: ${accountHolderName.trim()}`,
          `Bank: ${bankName.trim()}`,
          `Account number: ${accountNumber.trim()}`,
          `Branch code: ${branchCode.trim()}`,
          `Contact email: ${email.trim()}`,
          '',
          `Request ID: ${request._id}`,
        ].join('\n'),
      }).catch(err => console.error('[withdraw-request] email failed:', err.message));
    } else {
      console.log(`[withdraw-request] SMTP not configured — request ${request._id} saved but not emailed to snapsa.client@gmail.com`);
    }
    notifyAllAdmins({
      senderId: req.userId, type: 'report_update', priority: 'high',
      title: '💸 Withdrawal request',
      body: `@${user.username || req.userId} · ${coinsRequested} coins (≈ R${zarValue}) · request ${request._id}`,
      data: { kind: 'withdrawal_request', requestId: String(request._id) },
    }, req.userId);
    createSnapNotification({
      recipientId: req.userId, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type: 'report_update',
      title: 'Withdrawal request received', body: `${coinsRequested} coins (≈ R${zarValue}) — we will update you when it is processed.`,
      data: { kind: 'withdrawal_received' },
    }).catch(() => {});
    res.json({ success: true, coinsRequested, zarValue, requestId: request._id });

  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[withdraw-request]', error);
    res.status(500).json({ error: error.message || 'Withdrawal request failed' });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/wallet/withdraw-requests', snapAuthRequired, async (req, res) => {
  try {
    const requests = await SnapsaWithdrawalRequest.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('coinsRequested zarValue status createdAt')
      .lean();
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Send coins directly to another user ─────────────────────────────────────────────
app.post('/snapsa/wallet/send-coins', snapAuth, async (req, res) => {
  let session = null;
  try {
    if (!req.userId) return res.status(401).json({ error: 'Sign in to send coins' });
    const toUserId = String(req.body?.toUserId || '');
    const amount = Math.floor(Number(req.body?.amount));
    if (!_oid(toUserId)) return res.status(400).json({ error: 'Choose who to send coins to' });
    if (!Number.isFinite(amount) || amount < 1) return res.status(400).json({ error: 'Enter at least 1 coin' });
    if (amount > 1_000_000_000) return res.status(400).json({ error: 'That amount is too large' });
    if (toUserId === String(req.userId)) return res.status(400).json({ error: "You can't send coins to yourself" });

    const recipient = await SnapsaProfile.findOne({ userId: toUserId }).select('username isBarred').lean();
    if (!recipient) return res.status(404).json({ error: 'That user was not found' });
    if (recipient.isBarred) return res.status(403).json({ error: "This account can't receive coins" });
    if (await hasBlockBetween(req.userId, toUserId)) return res.status(403).json({ error: "You can't send coins to this user" });

    if (!(await idemClaim(req, res, 'send-coins'))) return;

    session = await mongoose.startSession();
    session.startTransaction();
    const balance = await getSnapsaCoinBalance(req.userId, { session });
    if (balance < amount) {
      await session.abortTransaction();
      await idemRelease(req);
      return res.status(400).json({ error: `Not enough coins. You have ${balance}.` });
    }
    await awardCoins(req.userId, -amount, { session });
    await awardCoins(toUserId, amount, { session });
    const senderName = await snapActorName(req.userId);
    await logCoinTransaction({
      userId: req.userId, type: 'debit', amount: -amount,
      description: `Sent ${amount} coins to @${recipient.username || toUserId}`,
      metadata: { kind: 'coin_transfer_out', counterpartyId: toUserId },
    }, { session });
    await logCoinTransaction({
      userId: toUserId, type: 'credit', amount,
      description: `Received ${amount} coins from ${senderName}`,
      metadata: { kind: 'coin_transfer_in', counterpartyId: String(req.userId) },
    }, { session });
    await session.commitTransaction();

    const result = { success: true, amount, newBalance: balance - amount, to: recipient.username || '' };
    await idemDone(req, result);
    req.idemCommitted = true;

    createSnapNotification({
      recipientId: toUserId, senderId: req.userId, type: 'gift_received', priority: 'high',
      title: `${senderName} sent you ${amount.toLocaleString()} coins 🪙`, body: '',
      data: { kind: 'coins_received', amount },
    }).catch(() => {});
    if (amount >= 5000) {   // big transfers are flagged to the admins
      notifyAllAdmins({
        senderId: req.userId, type: 'report_update',
        title: '🪙 Large coin transfer',
        body: `${senderName} → @${recipient.username || toUserId}: ${amount.toLocaleString()} coins`,
        data: { kind: 'large_coin_transfer', from: String(req.userId), to: toUserId, amount },
      }, req.userId);
    }
    res.json(result);
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[send-coins]', error);
    await idemRelease(req);
    res.status(500).json({ error: error.message });
  } finally { session?.endSession?.(); }
});


app.post('/snapsa/store/purchase', snapAuthRequired, async (req, res) => {
  let session = null;
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Cart is empty' });     if (!(await idemClaim(req, res, 'store-purchase'))) return;
    
    let totalCoins = 0;
    const receipts = [];
    const profileInvInc = {};
    for (const it of items) {
      if (it.type === 'coins') continue; 
      const priceInfo = STORE_ITEM_PRICES[it.itemId];
      if (!priceInfo) return res.status(400).json({ error: `Unknown item: ${it.itemId}` });
      const qty = Math.max(1, parseInt(it.quantity) || 1);
      const bulk = qty >= 5 ? BULK5_DISCOUNT : 1;
      const lineCoins = Math.round(priceInfo.coins * qty * bulk);
      totalCoins += lineCoins;
      receipts.push({ itemId: it.itemId, qty, lineCoins }); 
      
      profileInvInc[`inventory.${it.itemId}`] = (profileInvInc[`inventory.${it.itemId}`] || 0) + qty;
    }
    if (totalCoins <= 0) return res.status(400).json({ error: 'Nothing to purchase' });

    session = await mongoose.startSession();
    session.startTransaction();

    const balance = await getSnapsaCoinBalance(req.userId, { session });
    
    if (balance < totalCoins) {
      throw new Error(`Insufficient coins. Balance: ${balance}, Cost: ${totalCoins}`);
    }

    await awardCoins(req.userId, -totalCoins, { session });
    await SnapsaProfile.findOneAndUpdate(
      { userId: req.userId },
      { $inc: profileInvInc },
      { session, upsert: true }
    );
    await logCoinTransaction({
      userId: req.userId, type: 'debit', amount: -totalCoins,
      description: `Store purchase: ${receipts.map(r => `${r.qty}x ${r.itemId}`).join(', ')}`,
      metadata: { receipts, kind: 'store_gift_purchase' },
    }, { session });

        await session.commitTransaction();
    treasuryMove(totalCoins, { kind: 'store_purchase', userId: req.userId, note: receipts.map(r => `${r.qty}x ${r.itemId}`).join(', ') });

    const purchaseResult = { success: true, totalCoins, receipts, newBalance: balance - totalCoins };     await idemDone(req, purchaseResult);     res.json(purchaseResult);
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    console.error('[store/purchase]', error);     await idemRelease(req);
    res.status(500).json({ error: error.message });
  } finally {
    if (session) await session.endSession();
  }
});

app.get('/snapsa/watch-progress', snapAuthRequired, async (req, res) => {
  try {
    const profile = await SnapsaProfile.findOne({ userId: req.userId }).lean();
    const today = todayStr();
    const watchedMs = (profile?.watchDay === today) ? (profile.watchMsToday || 0) : 0;
    res.json({
      watchedMs,
      thresholdMs: WATCH_REWARD_THRESHOLD_MS,
      claimedToday: profile?.watchClaimedDay === today,
      rewardAmount: WATCH_REWARD_AMOUNT,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/watch-progress', snapAuthRequired, async (req, res) => {
  try { 
    
    const deltaMs = Math.max(0, Math.min(45000, parseInt(req.body.deltaMs) || 0));
    const today = todayStr();
    let profile = await SnapsaProfile.findOne({ userId: req.userId });
    if (!profile) return res.json({ watchedMs: 0, thresholdMs: WATCH_REWARD_THRESHOLD_MS, claimedToday: false });

    if (profile.watchDay !== today) {
      profile.watchDay = today;
      profile.watchMsToday = 0;
    }
    profile.watchMsToday = Math.min(WATCH_REWARD_THRESHOLD_MS, profile.watchMsToday + deltaMs);

    let justClaimed = false;
    if (profile.watchMsToday >= WATCH_REWARD_THRESHOLD_MS && profile.watchClaimedDay !== today) {
      profile.watchClaimedDay = today;
      justClaimed = true;
    }
    await profile.save();

    if (justClaimed) {
      awardCoins(req.userId, WATCH_REWARD_AMOUNT).catch(() => {});   
      treasuryMove(-WATCH_REWARD_AMOUNT, { kind: 'watch_reward', userId: req.userId, note: 'Daily watch reward' });
      logCoinTransaction({
        userId: req.userId, type: 'credit', amount: WATCH_REWARD_AMOUNT,
        description: 'Daily watch-time reward (2 hours watched)',
        metadata: { unit: 'snapsa_coin', coinValueZar: SNAPSA_COIN_VALUE_ZAR, kind: 'watch_reward', day: today },
      });
      createSnapNotification({
        recipientId: req.userId, senderId: req.userId, type: 'watch_reward',
        title: `You earned today's watch reward`,
        body: `Thanks for watching — ${WATCH_REWARD_AMOUNT} Snapsa Coins added to your balance.`,
        data: {}, priority: 'low',
        expiresAt: new Date(Date.now() + 3 * 86400000),
      }).catch(() => {});
    }

    res.json({
      watchedMs: profile.watchMsToday,
      thresholdMs: WATCH_REWARD_THRESHOLD_MS,
      claimedToday: profile.watchClaimedDay === today,
      justClaimed,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/snapsa/store', snapAuthRequired, async (req, res) => {
  try {
    const { enabled, name, description, contact, location } = req.body;
    const update = {};
    if (enabled !== undefined) update['store.enabled'] = !!enabled;
    if (name !== undefined) update['store.name'] = String(name).slice(0, 60);
    if (description !== undefined) update['store.description'] = String(description).slice(0, 300);
    if (contact !== undefined) update['store.contact'] = String(contact).slice(0, 120);
    if (location !== undefined) update['store.location'] = String(location).slice(0, 120);

    if (req.body.bannerBase64) {
      const uploaded = await uploadBase64ToCloudinary(req.body.bannerBase64, { resourceType: 'image', folder: 'snapsa/store_banners' });
      update['store.bannerUrl'] = uploaded.secure_url;
      update['store.bannerPublicId'] = uploaded.public_id;
    }

    if (req.body.avatarBase64) {
      const uploadedAvatar = await uploadBase64ToCloudinary(req.body.avatarBase64, { resourceType: 'image', folder: 'snapsa/store_avatars' });
      update['store.avatarUrl'] = uploadedAvatar.secure_url;
      update['store.avatarPublicId'] = uploadedAvatar.public_id;
    }

    const profile = await SnapsaProfile.findOneAndUpdate(
      { userId: req.userId }, { $set: update }, { upsert: true, new: true }
    ).lean();
    res.json({ success: true, store: profile.store });
  } catch (error) {
    console.error('[store/patch]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/store/:userId', snapAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ error: 'Invalid store' });
    const [profile, seller, products] = await Promise.all([
      SnapsaProfile.findOne({ userId: req.params.userId }).select('store').lean(),
      User.findById(req.params.userId).select('username avatar tier snapsaTier').lean(),
      SnapsaProduct.find({ sellerId: req.params.userId, active: true }).sort({ createdAt: -1 }).lean(),
    ]);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    res.json({
      seller: { id: seller._id, username: seller.username, avatar: seller.avatar, tier: seller.tier, snapsaTier: seller.snapsaTier },
      store: profile?.store || { enabled: false, name: '', description: '', bannerUrl: null, avatarUrl: null },
      coinValueZar: SNAPSA_COIN_VALUE_ZAR,
      products,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- Products ----------------------------------------------------------------
app.get('/snapsa/store/mine/products', snapAuthRequired, async (req, res) => {
  try {
    const products = await SnapsaProduct.find({ sellerId: req.userId }).sort({ createdAt: -1 }).lean();
    res.json({ products, coinValueZar: SNAPSA_COIN_VALUE_ZAR });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/store/products', snapAuthRequired, async (req, res) => {
  try {
    const { title, description, price, location, category, images, affiliateCommissionPct } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Price (in Snapsa Coins) must be a positive number' });

    const uploadedImages = [];
    for (const img of (Array.isArray(images) ? images : []).slice(0, 6)) {
      if (typeof img !== 'string' || !img.startsWith('data:')) continue; 
      const uploaded = await uploadBase64ToCloudinary(img, { resourceType: 'image', folder: 'snapsa/products' });
      uploadedImages.push({ url: uploaded.secure_url, publicId: uploaded.public_id });
    }

    const product = await SnapsaProduct.create({
      sellerId: req.userId,
      title: String(title).trim().slice(0, 80),
      description: String(description || '').slice(0, 500),
      price: priceNum,
      images: uploadedImages,
      location: { text: String(location?.text || location || '').slice(0, 120), lat: location?.lat ?? null, lng: location?.lng ?? null },
      category: String(category || 'general').slice(0, 30),
      affiliateCommissionPct: Math.min(0.5, Math.max(0, Number(affiliateCommissionPct) || 0.10)),
    });
    
    
    await SnapsaProfile.findOneAndUpdate({ userId: req.userId }, { $set: { 'store.enabled': true } }, { upsert: true });

    res.json({ success: true, product });
  } catch (error) {
    console.error('[store/products/create]', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/snapsa/store/products/:productId', snapAuthRequired, async (req, res) => {
  try {
    const product = await SnapsaProduct.findById(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (String(product.sellerId) !== String(req.userId)) return res.status(403).json({ error: 'Not your product' });

    const { title, description, price, location, category, active, affiliateCommissionPct, newImages, removeImagePublicIds } = req.body;
    if (title !== undefined) product.title = String(title).trim().slice(0, 80);
    if (description !== undefined) product.description = String(description).slice(0, 500);
    if (price !== undefined) {
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Invalid price' });
      product.price = priceNum;
    }
    if (location !== undefined) product.location = { text: String(location?.text || location || '').slice(0, 120), lat: location?.lat ?? null, lng: location?.lng ?? null };
    if (category !== undefined) product.category = String(category).slice(0, 30);
    if (active !== undefined) product.active = !!active;
    if (affiliateCommissionPct !== undefined) product.affiliateCommissionPct = Math.min(0.5, Math.max(0, Number(affiliateCommissionPct) || 0));

    if (Array.isArray(removeImagePublicIds) && removeImagePublicIds.length) {
      product.images = product.images.filter(im => !removeImagePublicIds.includes(im.publicId));
    }
    for (const img of (Array.isArray(newImages) ? newImages : []).slice(0, 6 - product.images.length)) {
      if (typeof img !== 'string' || !img.startsWith('data:')) continue;
      const uploaded = await uploadBase64ToCloudinary(img, { resourceType: 'image', folder: 'snapsa/products' });
      product.images.push({ url: uploaded.secure_url, publicId: uploaded.public_id });
    }

    await product.save();
    res.json({ success: true, product });
  } catch (error) {
    console.error('[store/products/update]', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/snapsa/store/products/:productId', snapAuthRequired, async (req, res) => {
  try {
    const product = await SnapsaProduct.findById(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (String(product.sellerId) !== String(req.userId)) return res.status(403).json({ error: 'Not your product' });
    product.active = false;
    await product.save();
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/marketplace/products', snapAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const filter = { active: true, sellerId: { $nin: restrictedIds } };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.q) filter.$text = { $search: String(req.query.q).slice(0, 100) };

    const products = await SnapsaProduct.find(filter)
      .sort(req.query.q ? { score: { $meta: 'textScore' } } : { createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean();
    res.json({ products, page, coinValueZar: SNAPSA_COIN_VALUE_ZAR });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/snapsa/marketplace/stores', snapAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    const matchStage = { 'store.enabled': true };
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      matchStage.$or = [{ 'store.name': rx }];
    }

    const profiles = await SnapsaProfile.aggregate([
      { $match: matchStage },
      { $sort: { updatedAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $lookup: { from: 'snapsa_products', let: { sid: '$userId' }, pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$sellerId', '$$sid'] }, { $eq: ['$active', true] }] } } },
        { $count: 'count' },
      ], as: 'productCountAgg' } },
      { $project: {
        _id: 0,
        sellerId: '$userId',
        username: '$user.username',
        avatar: '$user.avatar',
        tier: '$user.tier',
        snapsaTier: '$user.snapsaTier',
        store: 1,
        productCount: { $ifNull: [{ $arrayElemAt: ['$productCountAgg.count', 0] }, 0] },
      } },
    ]); 
    
    res.json({ stores: profiles.filter(p => p.productCount > 0), page, coinValueZar: SNAPSA_COIN_VALUE_ZAR });
  } catch (error) {
    console.error('[marketplace/stores]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/videos/:videoId/featured-products', snapAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.videoId)) return res.status(400).json({ error: 'Invalid video' });
    
    
    
    let video = await SnapsaVideo.findById(req.params.videoId);
    if (!video) video = await SnapsaVideo.findOne({ postId: req.params.videoId });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (String(video.authorId) !== String(req.userId)) return res.status(403).json({ error: 'Not your video' });

    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 5) : []; 
    const featured = [];
    for (const it of items) {
      if (!mongoose.Types.ObjectId.isValid(it.productId)) continue;
      const product = await SnapsaProduct.findOne({ _id: it.productId, active: true }).lean();
      if (!product) continue; 
      featured.push({
        productId: product._id,
        sellerId: product.sellerId,
        title: product.title,
        price: product.price,
        imageUrl: product.images?.[0]?.url || '',
        appearAt: Math.max(0, Number(it.appearAt) || 3),
        commissionPct: product.affiliateCommissionPct,
      });
    }
    video.featuredProducts = featured;
    await video.save();
    res.json({ success: true, featuredProducts: featured });
  } catch (error) {
    console.error('[videos/featured-products]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/videos/:videoId/featured-products', snapAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.videoId)) return res.status(400).json({ error: 'Invalid video' });
    let video = await SnapsaVideo.findById(req.params.videoId).select('featuredProducts authorId').lean();
    if (!video) video = await SnapsaVideo.findOne({ postId: req.params.videoId }).select('featuredProducts authorId').lean();
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json({ featuredProducts: video.featuredProducts || [], coinValueZar: SNAPSA_COIN_VALUE_ZAR });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/store/products/:productId/tag', snapAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.productId)) return res.status(400).json({ error: 'Invalid product' });
    const product = await SnapsaProduct.findOne({ _id: req.params.productId, active: true }).lean();
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (String(product.sellerId) === String(req.userId)) return res.status(400).json({ error: "That's your own product" });

    const message = String(req.body.message || '').slice(0, 500);
    let featuringVideoId = null, featuringAuthorId = null, commissionPct = 0;
    if (req.body.videoId && mongoose.Types.ObjectId.isValid(req.body.videoId)) {
      let video = await SnapsaVideo.findById(req.body.videoId).select('featuredProducts authorId').lean();
      if (!video) video = await SnapsaVideo.findOne({ postId: req.body.videoId }).select('featuredProducts authorId').lean();
      const feature = video?.featuredProducts?.find(f => String(f.productId) === String(product._id));
      if (feature && String(video.authorId) !== String(req.userId)) { 
        featuringVideoId = video._id;
        featuringAuthorId = video.authorId;
        commissionPct = feature.commissionPct || product.affiliateCommissionPct;
      }
    }
    
    const chatId = buildSnapChatId(req.userId, product.sellerId);
    const msg = await SnapsaMessage.create({
      chatId, senderId: req.userId, receiverId: product.sellerId,
      type: 'text', text: message,
      replyContext: { kind: 'product_tag', productId: product._id },
      productSnapshot: { title: product.title, price: product.price, imageUrl: product.images?.[0]?.url || null },
    });

    const lead = await SnapsaProductLead.create({
      productId: product._id, sellerId: product.sellerId, buyerId: req.userId,
      message, messageId: msg._id,
      featuringVideoId, featuringAuthorId, commissionPct,
      priceAtTag: product.price,
    });

    await SnapsaProduct.findByIdAndUpdate(product._id, { $inc: { tagCount: 1 } });

    const out = { ...msg.toObject(), mediaUrl: mediaUrl(req, msg.mediaFile), status: snapMsgStatus(msg) };
    broadcastToUser(String(product.sellerId), { type: 'snapsa_dm', message: out });

    const buyerName = await snapActorName(req.userId);
    createSnapNotification({
      recipientId: product.sellerId, senderId: req.userId, type: 'product_tag',
      title: `@${buyerName} is interested in "${product.title}"`,
      body: message || 'Tap to view in your inbox',
      data: { productId: product._id, leadId: lead._id, thumbUrl: product.images?.[0]?.url || null }, priority: 'high',
      expiresAt: new Date(Date.now() + 14 * 86400000),
    }).catch(() => {});

    res.json({ success: true, lead, message: out });
  } catch (error) {
    console.error('[store/products/tag]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/snapsa/store/leads', snapAuthRequired, async (req, res) => {
  try {
    const filter = { sellerId: req.userId };
    if (req.query.status) filter.status = req.query.status;
    const leads = await SnapsaProductLead.find(filter).sort({ createdAt: -1 }).limit(200)
      .populate('productId', 'title price images')
      .populate('buyerId', 'username avatar')
      .lean();
    res.json({ leads });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/snapsa/store/leads/:leadId/mark-sold', snapAuthRequired, async (req, res) => {
  try {
    const lead = await SnapsaProductLead.findById(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (String(lead.sellerId) !== String(req.userId)) return res.status(403).json({ error: 'Not your lead' });
    if (lead.status !== 'new') return res.status(400).json({ error: `Lead already ${lead.status}` });

    lead.status = 'sold';
    lead.soldAt = new Date();

    if (lead.featuringAuthorId && lead.commissionPct > 0) {
      const commissionCoins = +(lead.priceAtTag * lead.commissionPct).toFixed(2);
      lead.coinsAwarded = commissionCoins;
      if (commissionCoins > 0) {
        await awardCoins(lead.featuringAuthorId, commissionCoins);
        await logCoinTransaction({
          userId: lead.featuringAuthorId, type: 'credit', amount: commissionCoins,
          description: `Marketplace commission: sale via your featured product`,
          reference: lead.productId, referenceModel: 'SnapsaProduct',
          metadata: { unit: 'snapsa_coin', coinValueZar: SNAPSA_COIN_VALUE_ZAR, leadId: lead._id, kind: 'marketplace_commission' },
        });
        const soldProduct = await SnapsaProduct.findById(lead.productId).select('images').lean();
        createSnapNotification({
          recipientId: lead.featuringAuthorId, senderId: req.userId, type: 'product_sold',
          title: `Your featured product sold!`,
          body: `+${commissionCoins} Snapsa Coins commission`,
          data: { leadId: lead._id, productId: lead.productId, thumbUrl: soldProduct?.images?.[0]?.url || null }, priority: 'high',
          expiresAt: new Date(Date.now() + 7 * 86400000),
        }).catch(() => {});
      }
    }
    await lead.save();
    await SnapsaProduct.findByIdAndUpdate(lead.productId, { $inc: { salesCount: 1 } });

    res.json({ success: true, lead });
  } catch (error) {
    console.error('[store/leads/mark-sold]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/snapsa/avatar', snapAuthRequired, async (req, res) => {
  try {
    const { avatar } = req.body;
    if (!avatar) {
      return res.status(400).json({ error: 'Avatar image is required' });
    }

    
    const profile = await SnapsaProfile.findOne({ userId: req.userId });
    if (!profile) {
      return res.status(400).json({
        error: 'Please create a Snapsa username first before setting a profile picture'
      });
    }

    
    let avatarUrl = null;
    let avatarPublicId = null;

    if (avatar.startsWith('data:image')) {
      const uploaded = await uploadBase64ToCloudinary(avatar, {
        resourceType: 'image',
        folder: 'snapsa/avatars',
      });
      avatarUrl = uploaded.secure_url;
      avatarPublicId = uploaded.public_id;
    } else {
      
      avatarUrl = avatar;
    }

    
    if (profile.avatarPublicId) {
      try {
        await cloudinary.uploader.destroy(profile.avatarPublicId);
      } catch (e) {
        console.warn('[avatar] Could not delete old avatar:', e.message);
      }
    }

    
    profile.avatarUrl = avatarUrl;
    profile.avatarPublicId = avatarPublicId;
    await profile.save();

    res.json({
      success: true,
      avatarUrl: avatarUrl,
      message: 'Profile picture saved successfully'
    });

  } catch (error) {
    console.error('[avatar] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save profile picture'
    });
  }
});

app.delete('/snapsa/avatar', snapAuthRequired, async (req, res) => {
  try {
    const profile = await SnapsaProfile.findOne({ userId: req.userId });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    if (profile.avatarPublicId) {
      try {
        await cloudinary.uploader.destroy(profile.avatarPublicId);
      } catch (e) {
        console.warn('[avatar-delete] Could not delete avatar:', e.message);
      }
    }

    profile.avatarUrl = null;
    profile.avatarPublicId = null;
    await profile.save();

    res.json({
      success: true,
      message: 'Profile picture removed successfully'
    });
  } catch (error) {
    console.error('[avatar-delete]', error);
    res.status(500).json({ error: error.message });
  }
});

wss.on('connection', async (ws, req) => {
  fw.wsOpened(req); ws.on('close', () => fw.wsClosed(req));
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const token = params.get('token');
  
  
  if (params.get('snapsa') === '1') {
    let userId;
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      userId = String(payload.userId || payload.id || payload.sub);
    } catch {
      ws.close(4001, 'Invalid authentication token');
      return;
    }
    // Suspended / barred accounts don't get a live connection either.
    if (await getAccountRestriction(userId)) { ws.close(4003, 'Account restricted'); return; }
    ws._snapUserId = userId;
    const wsId = uuidv4();
    if (!liveState.snapRealtime) liveState.snapRealtime = new Map(); 
    if (!liveState.snapRealtime.has(userId)) liveState.snapRealtime.set(userId, new Set());
    liveState.snapRealtime.get(userId).add(ws);
    markSnapUserOnline(userId, wsId);
    touchLastActive(userId);
    markDeliveredOnConnect(userId);

    ws.send(JSON.stringify({ type: 'connected', userId, serverTime: Date.now() }));
    try { replayPendingCall(userId, ws); } catch {}

    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      refreshSnapUserOnline(userId);
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      touchLastActive(userId);
      markSnapUserOffline(userId, wsId);
      liveState.snapRealtime.get(userId)?.delete(ws);
      if (liveState.snapRealtime.get(userId)?.size === 0) liveState.snapRealtime.delete(userId);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    return;
  }

  const channelArn = params.get('channelArn') || params.get('roomId') || params.get('channelName');

  let userId, username, capabilities = [];
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    userId = payload.userId || payload.id || payload.sub;
    username = payload.username || payload.name || userId.slice(-8);
    capabilities = payload.capabilities || ['SEND_MESSAGE'];
  } catch (err) {
    ws.close(4001, 'Invalid authentication token');
    return;
  }

  let channelData = liveState.channels.get(channelArn);
  if (!channelData) {
    for (const data of liveState.channels.values()) {
      if (data.channelName === channelArn || data.hostId === channelArn) {
        channelData = data;
        break;
      }
    }
  }

  if (!channelData) {
    ws.close(4004, 'Channel not found');
    return;
  }

  const liveRoom = await SnapsaLive.findOne({
    channelArn: channelData.channelArn,
    'blockedUsers.userId': userId
  });

  if (liveRoom) {
    ws.close(4008, 'You are blocked from this stream');
    return;
  }

  const wsId = `${userId}_${Date.now()}`;
  ws._userId = userId;
  ws._wsId = wsId;

  liveState.chatConnections.set(wsId, {
    ws,
    userId,
    username,
    channelArn: channelData.channelArn,
    capabilities,
    joinedAt: new Date()
  });

  if (!liveState.viewerCounts.has(channelData.channelArn)) {
    liveState.viewerCounts.set(channelData.channelArn, new Set());
  }
  liveState.viewerCounts.get(channelData.channelArn).add(userId);

  ws.send(JSON.stringify({
    type: 'connected',
    userId,
    username,
    channelArn: channelData.channelArn,
    channelName: channelData.channelName,
    hostId: channelData.hostId,
    viewerCount: liveState.viewerCounts.get(channelData.channelArn).size,
    serverTime: Date.now()
  }));

  broadcastToChannel(channelData.channelArn, {
    type: 'user_joined',
    userId,
    username,
    viewerCount: liveState.viewerCounts.get(channelData.channelArn).size
  }, userId);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const conn = liveState.chatConnections.get(wsId);
      if (!conn) return;

      switch (msg.type) {
        case 'chat':
          if (!capabilities.includes('SEND_MESSAGE')) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not authorized to chat' }));
            return;
          }

          const chatMsg = {
            type: 'chat',
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            sender: conn.username,
            senderId: userId,
            text: msg.text?.slice(0, 500),
            replyTo: msg.replyTo || null,
            taggedUser: msg.taggedUser || null,
            timestamp: Date.now(),
            badges: msg.badges || []
          };

          await mongoose.connection.collection('live_chat_messages').insertOne({
            ...chatMsg,
            channelArn: channelData.channelArn,
            roomId: channelData.chatRoomArn,
            createdAt: new Date()
          });

          broadcastToChannel(channelData.channelArn, chatMsg);
          break;

        case 'like':
          broadcastToChannel(channelData.channelArn, {
            type: 'like',
            userId,
            username: conn.username,
            count: Math.min(msg.count || 1, 100),
            timestamp: Date.now()
          });
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (err) {
      console.error('[chat message error]', err);
    }
  });

  ws.on('close', async () => {
    const conn = liveState.chatConnections.get(wsId);
    if (!conn) return;

    liveState.chatConnections.delete(wsId);

    if (conn.channelArn && liveState.viewerCounts.has(conn.channelArn)) {
      liveState.viewerCounts.get(conn.channelArn).delete(userId);
      const newCount = liveState.viewerCounts.get(conn.channelArn).size;

      await SnapsaLive.findOneAndUpdate(
        { channelArn: conn.channelArn },
        { viewers: newCount }
      );

      broadcastToChannel(conn.channelArn, {
        type: 'user_left',
        userId,
        username: conn.username,
        viewerCount: newCount
      });
    }
  });

  ws.on('error', (err) => {
    console.error('[WebSocket error]', err);
    liveState.chatConnections.delete(wsId);
  });
});

setInterval(async () => {
  try {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const [arn, data] of liveState.channels) {
      try {
        const sessionsCmd = new ListStreamSessionsCommand({ channelArn: arn, maxResults: 1 });
        const sessions = await ivsClient.send(sessionsCmd);
        const hasActiveStream = sessions.streamSessions?.some(s => !s.endTime);

        if (!hasActiveStream && (now - data.createdAt > staleThreshold)) {
          console.log(`[cleanup] Removing stale channel: ${arn}`);
          await cleanupChannel(arn);
          await SnapsaLive.findOneAndUpdate(
            { channelArn: arn },
            { isLive: false, endedAt: new Date() }
          );
        }
      } catch (error) {
        console.error(`[cleanup] Error checking ${arn}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[cleanup job]', error);
  }
}, 60 * 1000);

// Health / ping: tiny, generic answer (Render and uptime tools use it). The Firewall screen can switch it off.
app.get(['/', '/health', '/healthz', '/ping'], (req, res) => res.json({ ok: true }));

// Firewall control screen (admin only) + database storage for its settings and bans
const SnapsaFirewallState = mongoose.model('SnapsaFirewallState', new mongoose.Schema({ _id: String, cfg: mongoose.Schema.Types.Mixed, pending: mongoose.Schema.Types.Mixed }, { minimize: false }));
const SnapsaFirewallBan = mongoose.model('SnapsaFirewallBan', new mongoose.Schema({ ip: { type: String, unique: true }, until: Date, count: Number, reason: String }));
fw.registerAdmin(app, { snapAuth, requireSnapAdmin });
fw.buildRegistry(app);   // default deny: from now on only the routes registered above are let through
app.use(fw.errorHandler);   // last of all: never shows stack traces or internal messages
const fwStore = {
  loadConfig: async () => { const d = await SnapsaFirewallState.findById('main').lean(); return d ? { cfg: d.cfg, pending: d.pending } : null; },
  saveConfig: async ({ cfg, pending }) => { await SnapsaFirewallState.findByIdAndUpdate('main', { cfg, pending: pending || null }, { upsert: true }); },
  loadBans: async () => SnapsaFirewallBan.find({ until: { $gt: new Date() } }).lean(),
  saveBan: async (b) => { await SnapsaFirewallBan.findOneAndUpdate({ ip: b.ip }, b, { upsert: true }); },
  deleteBan: async (ip) => { await SnapsaFirewallBan.deleteOne({ ip }); },
};

async function start() {
  if (mongoose.connection.readyState < 1 && config.mongoUri) {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10
    });
        console.log('✅ MongoDB connected');
    fw.attachStore(fwStore).catch(() => {});   // load the saved firewall settings + bans
    await runCryptoSelfTest(); // switches encryption of new messages/stories/country on only if it proves itself  
    
    try {
      const backfilled = await SnapsaVideo.updateMany(
        { feedRandom: { $exists: false } },
        [{ $set: { feedRandom: { $rand: {} } } }]
      );
      if (backfilled.modifiedCount) {
        console.log(`[startup] Backfilled feedRandom on ${backfilled.modifiedCount} video(s)`);
      }
    } catch (e) {
      console.warn('[startup] feedRandom backfill skipped:', e.message);
    }
  }

  server.listen(config.port, () => {
    console.log(`\n🎬 SnapServer v4.0.0`);
    console.log(`   Port: ${config.port}`);
    console.log(`   MongoDB: ${config.mongoUri ? 'connected' : 'disabled'}`);
    console.log(`   FFmpeg: ${ffmpeg ? 'available' : 'unavailable'}`);
    console.log(`   AWS IVS: ${config.awsAccessKey ? 'configured' : 'disabled'}`);
    console.log(`   WebSocket: ws://localhost:${config.port}/snapsa/live/ws\n`);
  });
  setTimeout(autoBroadcastRelease, 5000);   setTimeout(reconcileFollowCounts, 8000);
  refreshRestrictedIds();
}

start().catch(console.error);

export default app;
