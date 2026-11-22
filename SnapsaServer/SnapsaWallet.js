// SnapsaWallet.js
// Snapsa Wallet. Stanbic Bank holds the money and issues account numbers.
// Snapsa issues the virtual and physical Visa cards and keeps the ledger.

import crypto from 'crypto';
import https from 'https';
import mongoose from 'mongoose';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';

const { ObjectId } = mongoose.Types;

const CURRENCY = (process.env.SNAPSA_WALLET_CURRENCY || 'BWP').toUpperCase();
const MIN_WITHDRAWAL_MINOR = 1000;
const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const PIN_RE = /^\d{4,6}$/;
const ACCOUNT_RE = /^[A-Za-z0-9]{6,30}$/;
const BANK_ACCOUNT_RE = /^\d{6,20}$/;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const KYC_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const NOTICE_MS = 30 * 86400000;

// ── Wallet display + card controls ─────────────────────────────────────────
const DISPLAY_CURRENCIES = ['ZAR', 'NAD', 'GBP', 'SC', 'BWP', 'USD'];
// Indicative rates: how much of each currency 1 BWP is worth. Display only,
// never used to move money. Override any of them with the SNAPSA_DISPLAY_RATES
// setting, for example: {"ZAR":1.3,"USD":0.072,"GBP":0.054}
const DEFAULT_RATES_PER_BWP = { BWP: 1, ZAR: 1.22, NAD: 1.22, GBP: 0.055, USD: 0.073 };
// Default and maximum daily limits, in minor units (cents)
const DEFAULT_LIMITS_MINOR = { purchase: 500000, atm: 200000, transfer: 1000000 };
const MAX_LIMITS_MINOR     = { purchase: 5000000, atm: 1000000, transfer: 5000000 };
const MAX_ART_BYTES = 6 * 1024 * 1024;

function displayRates(walletCurrency) {
  const table = { ...DEFAULT_RATES_PER_BWP };
  try {
    const extra = process.env.SNAPSA_DISPLAY_RATES ? JSON.parse(process.env.SNAPSA_DISPLAY_RATES) : {};
    for (const [k, v] of Object.entries(extra)) {
      const code = String(k).toUpperCase();
      if (code !== 'SC' && Number.isFinite(Number(v)) && Number(v) > 0) table[code] = Number(v);
    }
  } catch { /* bad JSON: keep the defaults */ }
  const coinZar = Number(process.env.SNAPSA_COIN_VALUE_ZAR) > 0 ? Number(process.env.SNAPSA_COIN_VALUE_ZAR) : 5;
  table.SC = table.ZAR / coinZar;                       // 1 Snapsa Coin = R5
  const base = table[walletCurrency] || 1;
  const out = {};
  for (const c of DISPLAY_CURRENCIES) if (table[c]) out[c] = +(table[c] / base).toFixed(6);
  out[walletCurrency] = 1;
  return out;
}

class WalletError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = (message, status = 400) => { throw new WalletError(message, status); };

// ─── Models ───────────────────────────────────────────────────────────────

const applicationSchema = new mongoose.Schema({
  userId:       { type: ObjectId, required: true, unique: true },
  status:       { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  fullName:     { type: String, required: true, maxlength: 80 },
  firstNames:   { type: String, default: '' },
  lastName:     { type: String, default: '' },
  country:      { type: String, required: true },
  phone:        { type: String, default: '', index: true },
  idDoc:        { publicId: String, resourceType: String, format: String, mime: String, bytes: Number },
  addressDoc:   { publicId: String, resourceType: String, format: String, mime: String, bytes: Number },
  appliedAt:    Date,
  reviewedAt:   Date,
  reviewedBy:   { type: ObjectId, default: null },
  rejectReason: { type: String, default: '' },
  approvedAt:   Date,
}, { timestamps: true, collection: 'snapsa_wallet_applications' });
export const SnapsaWalletApplication =
  mongoose.models.SnapsaWalletApplication || mongoose.model('SnapsaWalletApplication', applicationSchema);

const walletSchema = new mongoose.Schema({
  userId:            { type: ObjectId, required: true, unique: true },
  holderName:        { type: String, required: true },
  cardHolderName:    { type: String, required: true },          // "F.D. VAN DER WERNDTZ"
  cardPanEnc:        { type: String, required: true },          // AES-256-GCM
  cardPanHash:       { type: String, required: true, unique: true },
  cardLast4:         { type: String, required: true },
  cardExpiry:        { type: String, required: true },          // "MM/YY"
  cardType:          { type: String, enum: ['virtual', 'physical'], default: 'virtual' },
  cardStatus:        { type: String, enum: ['active', 'frozen', 'cancelled'], default: 'active' },
  cardIsTest:        { type: Boolean, default: false },
  accountNumber:     { type: String, default: undefined, unique: true, sparse: true },   // left missing (not null) until assigned, so sparse-unique lets many wallets wait
  phone:             { type: String, default: '', index: true },   // E.164, e.g. +26771234567
  accountStatus:     { type: String, enum: ['pending_partner', 'active'], default: 'pending_partner', index: true },
  accountAssignedAt: { type: Date, default: null },
  accountBatchId:    { type: String, default: null },
  currency:          { type: String, default: CURRENCY },
  pinHash:           { type: String, default: null },
  pinSalt:           { type: String, default: null },
  pinFailures:       { type: Number, default: 0 },
  pinLockedUntil:    { type: Date, default: null },
  ledgerVersion:     { type: Number, default: 0 },              // bumped inside every money transaction (row lock)
  displayCurrency:   { type: String, default: null },           // how the user likes to see their balance
  tapToPay:          { type: Boolean, default: true },
  onlinePayments:    { type: Boolean, default: true },
  atmEnabled:        { type: Boolean, default: true },
  dailyPurchaseLimitMinor: { type: Number, default: DEFAULT_LIMITS_MINOR.purchase },
  dailyAtmLimitMinor:      { type: Number, default: DEFAULT_LIMITS_MINOR.atm },
  dailyTransferLimitMinor: { type: Number, default: DEFAULT_LIMITS_MINOR.transfer },
  status:            { type: String, enum: ['active', 'suspended', 'closed'], default: 'active' },
}, { timestamps: true, collection: 'snapsa_wallets' });
export const SnapsaWallet = mongoose.models.SnapsaWallet || mongoose.model('SnapsaWallet', walletSchema);

// Append-only ledger in integer minor units. Balance is derived, never stored.
const entrySchema = new mongoose.Schema({
  txId:                 { type: String, required: true, index: true },
  walletId:             { type: ObjectId, required: true, index: true },
  amountMinor:          { type: Number, required: true },        // signed
  kind:                 { type: String, enum: ['deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'adjustment'], required: true },
  status:               { type: String, enum: ['posted', 'pending', 'void'], default: 'posted' },
  partnerRef:           { type: String, default: null },         // Stanbic idempotency key
  counterpartyWalletId: { type: ObjectId, default: null },
  description:          { type: String, default: '' },
}, { timestamps: true, collection: 'snapsa_wallet_ledger' });
entrySchema.index({ partnerRef: 1 }, { unique: true, sparse: true });
entrySchema.index({ walletId: 1, createdAt: -1 });
export const SnapsaWalletEntry = mongoose.models.SnapsaWalletEntry || mongoose.model('SnapsaWalletEntry', entrySchema);

const payoutSchema = new mongoose.Schema({
  walletId:      { type: ObjectId, required: true, index: true },
  userId:        { type: ObjectId, required: true },
  entryId:       { type: ObjectId, required: true },
  amountMinor:   { type: Number, required: true },
  bankName:      { type: String, required: true },
  accountHolder: { type: String, required: true },
  accountNumber: { type: String, required: true },
  branchCode:    { type: String, default: '' },
  status:        { type: String, enum: ['queued', 'paid', 'rejected'], default: 'queued', index: true },
  reference:     { type: String, default: '' },
  reason:        { type: String, default: '' },
  processedAt:   { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_wallet_payouts' });
export const SnapsaWalletPayout = mongoose.models.SnapsaWalletPayout || mongoose.model('SnapsaWalletPayout', payoutSchema);

// Stanbic credits for account numbers we don't recognise.
const suspenseSchema = new mongoose.Schema({
  partnerRef:    { type: String, unique: true, sparse: true },
  accountNumber: { type: String },
  amountMinor:   { type: Number },
  currency:      { type: String },
  raw:           { type: mongoose.Schema.Types.Mixed, default: {} },
  resolved:      { type: Boolean, default: false },
}, { timestamps: true, collection: 'snapsa_wallet_suspense' });
const SnapsaWalletSuspense = mongoose.models.SnapsaWalletSuspense || mongoose.model('SnapsaWalletSuspense', suspenseSchema);

const batchSchema = new mongoose.Schema({
  batchId:  { type: String, required: true, unique: true },
  source:   { type: String, default: 'stanbic' },
  received: { type: Number, default: 0 },
  assigned: { type: Number, default: 0 },
}, { timestamps: true, collection: 'snapsa_wallet_batches' });
const SnapsaWalletBatch = mongoose.models.SnapsaWalletBatch || mongoose.model('SnapsaWalletBatch', batchSchema);

// One document that holds wallet-wide settings, such as the card artwork.
const walletSettingsSchema = new mongoose.Schema({
  key:             { type: String, required: true, unique: true },
  cardArtUrl:      { type: String, default: null },
  cardArtPublicId: { type: String, default: null },
  cardArtUpdatedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_wallet_settings' });
const SnapsaWalletSettings = mongoose.models.SnapsaWalletSettings || mongoose.model('SnapsaWalletSettings', walletSettingsSchema);

// A request to change a wallet PIN. The new PIN is stored hashed and only replaces
// the old one when an admin approves it. One waiting request per wallet.
const pinChangeSchema = new mongoose.Schema({
  walletId:       { type: ObjectId, required: true },
  userId:         { type: ObjectId, required: true },
  holderName:     { type: String, default: '' },
  pinHash:        { type: String, required: true },
  pinSalt:        { type: String, required: true },
  knewCurrentPin: { type: Boolean, default: true },
  status:         { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reason:         { type: String, default: '' },
  reviewedBy:     { type: ObjectId, default: null },
  reviewedAt:     { type: Date, default: null },
}, { timestamps: true, collection: 'snapsa_wallet_pin_changes' });
pinChangeSchema.index({ walletId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
const SnapsaWalletPinChange = mongoose.models.SnapsaWalletPinChange || mongoose.model('SnapsaWalletPinChange', pinChangeSchema);

// ─── Crypto ───────────────────────────────────────────────────────────────

function cardKey() {
  const raw = process.env.SNAPSA_CARD_KEY;
  if (raw && /^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (process.env.NODE_ENV === 'production') throw new Error('SNAPSA_CARD_KEY (64 hex characters) must be set in production');
  return crypto.createHash('sha256').update(String(process.env.SNAP_JWT_SECRET || process.env.JWT_SECRET || 'dev')).digest();
}

function encryptPan(pan) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cardKey(), iv);
  const enc = Buffer.concat([cipher.update(pan, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

function decryptPan(stored) {
  const [ivHex, tagHex, dataHex] = String(stored).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cardKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

const panHash = (pan) => crypto.createHmac('sha256', cardKey()).update(pan).digest('hex');

function luhnDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

// SNAPSA_CARD_BIN is the BIN from your card processor. Without it, development
// cards use a test prefix and are flagged. Production refuses to issue test cards.
function generateCard() {
  const bin = process.env.SNAPSA_CARD_BIN || '';
  const isTest = !/^\d{6,8}$/.test(bin);
  if (isTest && process.env.NODE_ENV === 'production') throw new Error('SNAPSA_CARD_BIN must be set in production');
  const prefix = isTest ? '5412' : bin;
  const body = prefix + Array.from({ length: 15 - prefix.length }, () => crypto.randomInt(0, 10)).join('');
  return { pan: body + luhnDigit(body), isTest };
}

const groupPan = (pan) => pan.replace(/(\d{4})(?=\d)/g, '$1 ');

function cardExpiry() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear() + 3).slice(-2)}`;
}

const hashPin = (pin, salt) => crypto.scryptSync(String(pin), String(salt), 32).toString('hex');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ─── Names and money ──────────────────────────────────────────────────────

const cleanPhone = (s) => { const d = String(s || '').replace(/[^\d+]/g, ''); const p = d.startsWith('+') ? d : ''; return /^\+\d{8,15}$/.test(p) ? p : ''; };
const cleanName = (s) => String(s || '').replace(/[^\p{L}\s'-]/gu, '').replace(/\s+/g, ' ').trim();

function splitName(fullName, firstNames, lastName) {
  const holder = String(fullName || '').replace(/\s+/g, ' ').trim();
  const parts = holder.split(' ').filter(Boolean);
  const last = cleanName(lastName) || parts.slice(-1).join(' ');
  const first = cleanName(firstNames) || parts.slice(0, -1).join(' ') || last;
  return { holder, first, last };
}

function cardHolderName(first, last) {
  const initials = cleanName(first).split(' ').filter(Boolean).map(p => `${p[0].toUpperCase()}.`).join('');
  return `${initials} ${cleanName(last).toUpperCase()}`.trim();
}

// Accepts "12", "12.5", "12.50". Anything else is rejected.
function toMinor(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0;
  const minor = Math.round(Number(s) * 100);
  return minor > 0 ? minor : 0;
}
const toMajor = (m) => +(m / 100).toFixed(2);

async function balanceOf(walletId, session) {
  const agg = SnapsaWalletEntry.aggregate([
    { $match: { walletId: new ObjectId(String(walletId)), status: { $in: ['posted', 'pending'] } } },
    { $group: { _id: '$status', sum: { $sum: '$amountMinor' } } },
  ]);
  if (session) agg.session(session);
  const rows = await agg;
  const by = Object.fromEntries(rows.map(r => [r._id, r.sum]));
  const postedMinor = by.posted || 0;
  const pendingMinor = by.pending || 0;   // pending holds are withdrawals, stored negative
  return { postedMinor, pendingMinor, availableMinor: postedMinor + pendingMinor };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } finally {
    await session.endSession();
  }
}

// Bumps ledgerVersion on each wallet inside the transaction. This takes a row
// lock, so two concurrent withdrawals on the same wallet cannot both pass the
// balance check. Ids are sorted so two transfers in opposite directions can't deadlock.
async function lockWallets(session, ...walletIds) {
  const ids = [...new Set(walletIds.map(String))].sort();
  for (const id of ids) {
    await SnapsaWallet.updateOne({ _id: id }, { $inc: { ledgerVersion: 1 } }, { session });
  }
}

async function requireWallet(userId, mustBeActive = false) {
  if (!userId) bad('Sign in required', 401);
  const w = await SnapsaWallet.findOne({ userId });
  if (!w) bad('You do not have a wallet yet', 404);
  if (mustBeActive && w.status !== 'active') bad('Your wallet is not active', 403);
  return w;
}

// ─── Wallet issuance ──────────────────────────────────────────────────────

async function ensureWallet(appDoc) {
  const existing = await SnapsaWallet.findOne({ userId: appDoc.userId });
  if (existing) return existing;
  const { holder, first, last } = splitName(appDoc.fullName, appDoc.firstNames, appDoc.lastName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const card = generateCard();
    if (await SnapsaWallet.exists({ cardPanHash: panHash(card.pan) })) continue;   // never hand out a number that is already in use
    try {
      return await SnapsaWallet.create({
        userId: appDoc.userId,
        holderName: holder,
        cardHolderName: cardHolderName(first, last),
        cardPanEnc: encryptPan(card.pan),
        cardPanHash: panHash(card.pan),
        cardLast4: card.pan.slice(-4),
        cardExpiry: cardExpiry(),
        cardIsTest: card.isTest,
        currency: CURRENCY,
        phone: appDoc.phone || '',
        accountStatus: 'pending_partner',
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
      const again = await SnapsaWallet.findOne({ userId: appDoc.userId });
      if (again) return again;
    }
  }
  throw new Error('Could not issue a unique card number');
}

// ─── PIN ──────────────────────────────────────────────────────────────────

async function verifyPin(wallet, pin) {
  if (!wallet.pinHash) bad('Set your wallet PIN first', 409);
  if (wallet.pinLockedUntil && wallet.pinLockedUntil > new Date()) {
    bad('Too many wrong PINs. Try again in a few minutes.', 423);
  }
  const given = String(pin || '');
  const ok = PIN_RE.test(given) &&
    crypto.timingSafeEqual(Buffer.from(hashPin(given, wallet.pinSalt), 'hex'), Buffer.from(wallet.pinHash, 'hex'));
  if (ok) {
    if (wallet.pinFailures) await SnapsaWallet.updateOne({ _id: wallet._id }, { $set: { pinFailures: 0 } });
    return;
  }
  const after = await SnapsaWallet.findByIdAndUpdate(wallet._id, { $inc: { pinFailures: 1 } }, { new: true });
  if (after.pinFailures >= MAX_PIN_FAILURES) {
    await SnapsaWallet.updateOne({ _id: wallet._id }, {
      $set: { pinFailures: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) },
    });
    bad('Too many wrong PINs. Locked for 15 minutes.', 423);
  }
  bad('Wrong PIN', 401);
}

// ─── Private KYC documents ────────────────────────────────────────────────

function sniffDoc(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG') return 'png';
  if (b.slice(0, 4).toString() === '%PDF') return 'pdf';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

const uploadPrivate = (buffer, folder) => new Promise((resolve, reject) => {
  cloudinary.uploader.upload_stream(
    { type: 'authenticated', resource_type: 'auto', folder, overwrite: false },
    (err, r) => (err ? reject(err) : resolve(r))
  ).end(buffer);
});

function destroyPrivate(docs) {
  docs.filter(d => d?.publicId).forEach(d => {
    cloudinary.uploader.destroy(d.publicId, { resource_type: d.resourceType || 'image', type: 'authenticated' }).catch(() => {});
  });
}

const kycUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES, files: 2 },
  fileFilter(req, file, cb) {
    if (/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WebP or PDF files are accepted'));
  },
}).fields([{ name: 'idDocument', maxCount: 1 }, { name: 'proofOfAddress', maxCount: 1 }]);

const withKyc = (req, res, next) => kycUploader(req, res, (err) => (err
  ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 8 MB' : err.message })
  : next()));

// ─── Route registration ───────────────────────────────────────────────────

// ─── Daily limits, lookups and card artwork ───────────────────────────────

// Money that left the wallet in the last 24 hours (transfers and bank sends,
// including ones still waiting to be paid).
async function sentLast24hMinor(walletId, session) {
  const agg = SnapsaWalletEntry.aggregate([
    { $match: {
        walletId: new ObjectId(String(walletId)),
        kind: { $in: ['transfer_out', 'withdrawal'] },
        status: { $in: ['posted', 'pending'] },
        createdAt: { $gte: new Date(Date.now() - 86400000) },
    } },
    { $group: { _id: null, sum: { $sum: '$amountMinor' } } },
  ]);
  if (session) agg.session(session);
  const rows = await agg;
  return Math.abs(rows[0]?.sum || 0);
}

async function assertWithinDailyLimit(wallet, amountMinor, session) {
  const limit = wallet.dailyTransferLimitMinor ?? DEFAULT_LIMITS_MINOR.transfer;
  const used = await sentLast24hMinor(wallet._id, session);
  if (used + amountMinor > limit) {
    const left = Math.max(0, limit - used);
    bad(`This is over your daily send limit of ${wallet.currency} ${toMajor(limit).toFixed(2)}. You can still send ${wallet.currency} ${toMajor(left).toFixed(2)} today.`);
  }
}

// "5000", "5000.5" or "5000.50" in major units. Zero is allowed (it switches the limit off).
function parseLimitMinor(v, max, label) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) bad(`Enter a valid ${label} limit`);
  const minor = Math.round(Number(s) * 100);
  if (minor > max) bad(`The most you can set for the ${label} limit is ${toMajor(max).toFixed(2)}`);
  return minor;
}

// Stops people from scanning through account numbers.
const lookupHits = new Map();
function throttleLookup(userId) {
  const now = Date.now();
  const hits = (lookupHits.get(String(userId)) || []).filter(t => now - t < 60000);
  if (hits.length >= 15) bad('Too many lookups. Wait a minute and try again.', 429);
  hits.push(now);
  lookupHits.set(String(userId), hits);
  if (lookupHits.size > 5000) {
    for (const [k, v] of lookupHits) if (!v.some(t => now - t < 60000)) lookupHits.delete(k);
  }
}

const artUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ART_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (/^image\/(png|jpeg|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('The card image must be a PNG, JPG or WebP'));
  },
}).single('card');

const withArt = (req, res, next) => artUploader(req, res, (err) => (err
  ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The card image must be under 6 MB' : err.message })
  : next()));

export function registerSnapsaWallet(app, deps) {
  const {
    snapAuth, requireSnapAdmin, uploadLimiter, User,
    createSnapNotification, sendSnapsaSystemMessage, SNAPSA_SYSTEM_ACCOUNT_ID,
  } = deps;

  const notify = (userId, type, title, body, data = {}) =>
    createSnapNotification({
      recipientId: userId, senderId: SNAPSA_SYSTEM_ACCOUNT_ID, type, title, body, data,
      priority: 'high', expiresAt: new Date(Date.now() + NOTICE_MS),
    }).catch(() => {});

  // The unique indexes are what make two wallets with the same card number (or two
  // pending PIN requests for one wallet) impossible. Make sure they exist.
  // One-time repair: wallets saved with accountNumber:null collide on the unique index, which made every approval after the first fail.
  SnapsaWallet.updateMany({ accountNumber: null }, { $unset: { accountNumber: 1 } }).catch((e) => console.error('[wallet] null accountNumber repair failed:', e.message));
  Promise.all([SnapsaWallet.createIndexes(), SnapsaWalletEntry.createIndexes(), SnapsaWalletPinChange.createIndexes()])
    .catch((e) => console.error('[wallet] could not create indexes:', e.message));

  const route = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof WalletError) return res.status(e.status).json({ error: e.message });
      console.error('[wallet]', req.method, req.path, e);
      res.status(500).json({ error: 'Something went wrong — please try again' });
    }
  };

  async function walletView(userId) {
    const appDoc = await SnapsaWalletApplication.findOne({ userId }).select('status fullName appliedAt rejectReason').lean();
    const w = await SnapsaWallet.findOne({ userId }).lean();
    const application = appDoc
      ? { status: appDoc.status, fullName: appDoc.fullName, appliedAt: appDoc.appliedAt,
          rejectReason: appDoc.status === 'rejected' ? appDoc.rejectReason : '' }
      : { status: 'none' };
    if (!w) return { application, wallet: null };
    const bal = await balanceOf(w._id);
    const walletSettings = await SnapsaWalletSettings.findOne({ key: 'main' }).lean();
    const sentMinor = await sentLast24hMinor(w._id);
    const lastPinChange = await SnapsaWalletPinChange.findOne({ walletId: w._id }).sort({ createdAt: -1 }).lean();
    const pinChange = lastPinChange && (lastPinChange.status === 'pending' ||
      (lastPinChange.status === 'rejected' && Date.now() - new Date(lastPinChange.updatedAt).getTime() < 7 * 86400000))
      ? { status: lastPinChange.status, requestedAt: lastPinChange.createdAt, reason: lastPinChange.reason || '', forgot: !lastPinChange.knewCurrentPin }
      : null;
    return {
      application,
      wallet: {
        status: w.status,
        currency: w.currency,
        holderName: w.holderName,
        phone: w.phone || '',
        card: {
          type: w.cardType,
          status: w.cardStatus,
          holderName: w.cardHolderName,
          masked: '•••• •••• •••• ' + w.cardLast4,
          expiry: w.cardExpiry,
          isTest: w.cardIsTest,
        },
        account: {
          status: w.accountStatus,
          number: w.accountNumber || null,
          message: w.accountNumber ? null : 'Your account number is being prepared',
        },
        displayCurrency: DISPLAY_CURRENCIES.includes(w.displayCurrency) ? w.displayCurrency : w.currency,
        rates: displayRates(w.currency),
        cardArtUrl: walletSettings?.cardArtUrl || null,
        controls: {
          tapToPay: w.tapToPay !== false,
          online: w.onlinePayments !== false,
          atm: w.atmEnabled !== false,
        },
        limits: {
          purchase: toMajor(w.dailyPurchaseLimitMinor ?? DEFAULT_LIMITS_MINOR.purchase),
          atm: toMajor(w.dailyAtmLimitMinor ?? DEFAULT_LIMITS_MINOR.atm),
          transfer: toMajor(w.dailyTransferLimitMinor ?? DEFAULT_LIMITS_MINOR.transfer),
          sentToday: toMajor(sentMinor),
          max: {
            purchase: toMajor(MAX_LIMITS_MINOR.purchase),
            atm: toMajor(MAX_LIMITS_MINOR.atm),
            transfer: toMajor(MAX_LIMITS_MINOR.transfer),
          },
        },
        pinChange,
        pinSet: !!w.pinHash,
        balance: { available: toMajor(bal.availableMinor), pending: toMajor(bal.pendingMinor), currency: w.currency },
      },
    };
  }

  // ── Customer routes ────────────────────────────────────────────────────

  app.get('/snapsa/wallet/me', snapAuth, route(async (req, res) => {
    if (!req.userId) return res.json({ application: { status: 'none' }, wallet: null });
    res.json(await walletView(req.userId));
  }));

  app.post('/snapsa/wallet/apply', snapAuth, uploadLimiter, withKyc, route(async (req, res) => {
    if (!req.userId) bad('Sign in to apply', 401);
    const fullName = String(req.body.fullName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const firstNames = cleanName(req.body.firstNames).slice(0, 60);
    const lastName = cleanName(req.body.lastName).slice(0, 60);
    const country = String(req.body.country || '').toUpperCase();
    if (fullName.length < 5 || !fullName.includes(' ')) bad('Enter your full name exactly as it appears on your ID');
    if (!/^[A-Z]{2}$/.test(country)) bad('Choose your country');
    const phone = cleanPhone(req.body.phone);
    if (!phone) bad('Enter a valid mobile number');
    const phoneTaken = await Promise.all([
      SnapsaWallet.exists({ phone, userId: { $ne: req.userId } }),
      SnapsaWalletApplication.exists({ phone, userId: { $ne: req.userId }, status: { $in: ['pending', 'approved'] } }),
    ]);
    if (phoneTaken.some(Boolean)) bad('That mobile number is already linked to another Snapsa Wallet', 409);
    if (req.body.consent !== 'true') bad('Please tick the declaration');
    const idFile = req.files?.idDocument?.[0];
    const addrFile = req.files?.proofOfAddress?.[0];
    if (!idFile || !addrFile) bad('Attach both your ID and your proof of address');
    const idExt = sniffDoc(idFile.buffer), addrExt = sniffDoc(addrFile.buffer);
    if (!idExt || !addrExt) bad('Files must be a real JPG, PNG, WebP or PDF');

    const existing = await SnapsaWalletApplication.findOne({ userId: req.userId });
    if (existing?.status === 'approved') bad('You already have a Snapsa Wallet', 409);
    if (existing?.status === 'pending') bad('Your application is already being reviewed', 409);

    const folder = `snapsa/kyc/${req.userId}`;
    const [idUp, addrUp] = await Promise.all([uploadPrivate(idFile.buffer, folder), uploadPrivate(addrFile.buffer, folder)]);
    const toDoc = (up, file, ext) => ({
      publicId: up.public_id, resourceType: up.resource_type || 'image',
      format: up.format || ext, mime: KYC_MIME[ext], bytes: file.size,
    });

    const previousDocs = existing ? [existing.idDoc, existing.addressDoc] : [];
    await SnapsaWalletApplication.findOneAndUpdate(
      { userId: req.userId },
      { $set: {
          status: 'pending', fullName, firstNames, lastName, country, phone,
          idDoc: toDoc(idUp, idFile, idExt), addressDoc: toDoc(addrUp, addrFile, addrExt),
          appliedAt: new Date(), reviewedAt: null, reviewedBy: null, rejectReason: '',
      } },
      { upsert: true, new: true }
    );
    destroyPrivate(previousDocs);

    sendSnapsaSystemMessage(req.userId, 'We’ve received your Snapsa Wallet application and sent it to our team for review. We’ll message you here as soon as there’s a decision.');
    const admins = await User.find({ $or: [{ isAdmin: true }, { founder: true }] }).select('_id').lean();
    admins.forEach(a => createSnapNotification({
      recipientId: a._id, senderId: req.userId, type: 'wallet_application',
      title: 'New Snapsa Wallet application', body: 'Review it in Admin',
      data: { userId: String(req.userId) }, priority: 'medium', expiresAt: new Date(Date.now() + NOTICE_MS),
    }).catch(() => {}));

    res.json({ success: true, status: 'pending' });
  }));

  app.post('/snapsa/wallet/pin', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId);
    const pin = String(req.body.pin || '');
    if (!PIN_RE.test(pin)) bad('PIN must be 4 to 6 digits');
    if (wallet.pinHash) bad('To change your PIN, send a change request from Settings. Our team approves it first.', 403);
    const salt = crypto.randomBytes(16).toString('hex');
    await SnapsaWallet.updateOne({ _id: wallet._id }, {
      $set: { pinSalt: salt, pinHash: hashPin(pin, salt), pinFailures: 0, pinLockedUntil: null },
    });
    res.json({ success: true });
  }));

  app.post('/snapsa/wallet/card/reveal', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId);
    if (wallet.cardStatus === 'cancelled') bad('This card has been cancelled', 409);
    await verifyPin(wallet, req.body.pin);
    res.set('Cache-Control', 'no-store');
    res.json({ number: groupPan(decryptPan(wallet.cardPanEnc)), expiry: wallet.cardExpiry, holderName: wallet.cardHolderName });
  }));

  app.post('/snapsa/wallet/card/status', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId);
    if (wallet.cardStatus === 'cancelled') bad('This card has been cancelled', 409);
    const frozen = !!req.body.frozen;
    await SnapsaWallet.updateOne({ _id: wallet._id }, { $set: { cardStatus: frozen ? 'frozen' : 'active' } });
    res.json({ success: true, cardStatus: frozen ? 'frozen' : 'active' });
  }));

  app.get('/snapsa/wallet/transactions', snapAuth, route(async (req, res) => {
    if (!req.userId) return res.json({ transactions: [] });
    const w = await SnapsaWallet.findOne({ userId: req.userId }).select('_id currency').lean();
    if (!w) return res.json({ transactions: [] });
    const rows = await SnapsaWalletEntry.find({ walletId: w._id }).sort({ createdAt: -1 }).limit(60).lean();
    res.json({
      transactions: rows.map(r => ({
        id: r._id, kind: r.kind, amount: toMajor(r.amountMinor), currency: w.currency,
        status: r.status, description: r.description, createdAt: r.createdAt,
      })),
    });
  }));

  app.post('/snapsa/wallet/transfer', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId, true);
    await verifyPin(wallet, req.body.pin);
    const amount = toMinor(req.body.amount);
    if (!amount) bad('Enter a valid amount');
    const to = String(req.body.toAccountNumber || '').replace(/\s/g, '');
    const toPhone = cleanPhone(req.body.toPhone || (to.startsWith('+') ? to : ''));
    const dest = toPhone
      ? await SnapsaWallet.findOne({ phone: toPhone, accountStatus: 'active', status: 'active' }).lean()
      : (to ? await SnapsaWallet.findOne({ accountNumber: to, accountStatus: 'active', status: 'active' }).lean() : null);
    if (!dest) bad(toPhone ? 'No active Snapsa Wallet is linked to that mobile number' : 'No active Snapsa Wallet has that account number', 404);
    if (String(dest._id) === String(wallet._id)) bad("You can't send money to your own wallet");
    const note = String(req.body.note || '').slice(0, 120);

    await inTransaction(async (session) => {
      await lockWallets(session, wallet._id, dest._id);
      await assertWithinDailyLimit(wallet, amount, session);
      const { availableMinor } = await balanceOf(wallet._id, session);
      if (availableMinor < amount) bad(`Insufficient balance (${toMajor(availableMinor).toFixed(2)} ${wallet.currency} available)`);
      const txId = crypto.randomUUID();
      await SnapsaWalletEntry.create([
        { txId, walletId: wallet._id, amountMinor: -amount, kind: 'transfer_out', status: 'posted',
          counterpartyWalletId: dest._id, description: note || 'Transfer sent' },
        { txId, walletId: dest._id, amountMinor: amount, kind: 'transfer_in', status: 'posted',
          counterpartyWalletId: wallet._id, description: note || 'Transfer received' },
      ], { session });
    });

    const money = `${wallet.currency} ${toMajor(amount).toFixed(2)}`;
    notify(req.userId, 'wallet_alert', 'Money sent', `${money} sent from your Snapsa Wallet`, { kind: 'transfer_out' });
    notify(dest.userId, 'wallet_alert', 'Money received', `${money} received in your Snapsa Wallet`, { kind: 'transfer_in' });
    res.json({ success: true, amount: toMajor(amount), currency: wallet.currency });
  }));

  // Ask to change the PIN. It only takes effect once an admin approves it.
  // The user proves it is them with the current PIN, or says they forgot it
  // (the admin is told, and checks who it is before approving).
  app.post('/snapsa/wallet/pin/change-request', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId);
    if (!wallet.pinHash) bad('Set your wallet PIN first');
    const newPin = String(req.body.newPin || '');
    if (!PIN_RE.test(newPin)) bad('PIN must be 4 to 6 digits');
    const forgot = req.body.forgot === true;
    if (!forgot) {
      await verifyPin(wallet, req.body.currentPin);
      if (String(req.body.currentPin) === newPin) bad('Choose a PIN that is different from your current one');
    }
    const pinSalt = crypto.randomBytes(16).toString('hex');
    const pinHash = hashPin(newPin, pinSalt);

    const existing = await SnapsaWalletPinChange.findOne({ walletId: wallet._id, status: 'pending' });
    if (existing) {
      existing.pinHash = pinHash; existing.pinSalt = pinSalt; existing.knewCurrentPin = !forgot;
      await existing.save();
    } else {
      try {
        await SnapsaWalletPinChange.create({
          walletId: wallet._id, userId: req.userId, holderName: wallet.holderName,
          pinHash, pinSalt, knewCurrentPin: !forgot,
        });
        const admins = await User.find({ $or: [{ isAdmin: true }, { founder: true }] }).select('_id').lean();
        admins.forEach(a => createSnapNotification({
          recipientId: a._id, senderId: req.userId, type: 'wallet_application',
          title: 'Wallet PIN change request', body: 'Review it in Admin',
          data: { userId: String(req.userId) }, priority: 'medium', expiresAt: new Date(Date.now() + NOTICE_MS),
        }).catch(() => {}));
      } catch (e) {
        if (e.code !== 11000) throw e;   // a request for this wallet was just created: fine
      }
    }
    sendSnapsaSystemMessage(req.userId, 'We’ve received your request to change your Snapsa Wallet PIN. Our team will review it and message you here. Your current PIN keeps working until then.');
    res.json({ success: true, status: 'pending' });
  }));

  // Display currency, card controls and daily limits.
  // Changing a limit needs the wallet PIN. Switches and the display currency do not.
  app.post('/snapsa/wallet/settings', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId);
    const b = req.body || {};
    const set = {};

    if (b.displayCurrency !== undefined) {
      const c = String(b.displayCurrency).toUpperCase();
      if (!DISPLAY_CURRENCIES.includes(c)) bad('That currency is not supported');
      set.displayCurrency = c;
    }
    for (const [key, field] of [['tapToPay', 'tapToPay'], ['online', 'onlinePayments'], ['atm', 'atmEnabled']]) {
      if (b[key] !== undefined) set[field] = !!b[key];
    }

    const limitInputs = [
      ['purchaseLimit', 'dailyPurchaseLimitMinor', 'purchase'],
      ['atmLimit', 'dailyAtmLimitMinor', 'ATM'],
      ['transferLimit', 'dailyTransferLimitMinor', 'send'],
    ];
    if (limitInputs.some(([k]) => b[k] !== undefined)) {
      await verifyPin(wallet, b.pin);
      for (const [k, field, label] of limitInputs) {
        if (b[k] === undefined) continue;
        const maxKey = field === 'dailyPurchaseLimitMinor' ? 'purchase' : field === 'dailyAtmLimitMinor' ? 'atm' : 'transfer';
        set[field] = parseLimitMinor(b[k], MAX_LIMITS_MINOR[maxKey], label);
      }
    }

    if (!Object.keys(set).length) bad('Nothing to change');
    await SnapsaWallet.updateOne({ _id: wallet._id }, { $set: set });
    res.json({ success: true });
  }));

  // Shows who owns an account number before the user pays (confirmation of payee).
  app.get('/snapsa/wallet/lookup', snapAuth, route(async (req, res) => {
    if (!req.userId) bad('Sign in required', 401);
    throttleLookup(req.userId);
    const number = String(req.query.account || '').replace(/\s/g, '');
    const lookPhone = cleanPhone(req.query.phone || (number.startsWith('+') ? number : ''));
    if (!lookPhone && !ACCOUNT_RE.test(number)) return res.json({ found: false });
    const w = await SnapsaWallet.findOne(lookPhone ? { phone: lookPhone, accountStatus: 'active', status: 'active' } : { accountNumber: number, accountStatus: 'active', status: 'active' })
      .select('cardHolderName userId').lean();
    if (!w) return res.json({ found: false });
    res.json({ found: true, name: w.cardHolderName, self: String(w.userId) === String(req.userId) });
  }));

  // Send to a Stanbic Bank account. If the number belongs to a Snapsa Wallet the
  // money moves instantly inside Snapsa. Otherwise it is queued and an admin pays
  // it to Stanbic until the Stanbic payment connection is live.
  app.post('/snapsa/wallet/send-bank', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId, true);
    await verifyPin(wallet, req.body.pin);
    const amount = toMinor(req.body.amount);
    if (!amount) bad('Enter a valid amount');
    const accountNumber = String(req.body.accountNumber || '').replace(/\s/g, '');
    const accountHolder = cleanName(req.body.accountHolder).slice(0, 80);
    const note = String(req.body.note || '').slice(0, 120);
    if (!BANK_ACCOUNT_RE.test(accountNumber)) bad('Enter a valid Stanbic account number (digits only)');

    const dest = await SnapsaWallet.findOne({ accountNumber, accountStatus: 'active', status: 'active' }).lean();
    if (dest) {
      if (String(dest._id) === String(wallet._id)) bad("You can't send money to your own wallet");
      await inTransaction(async (session) => {
        await lockWallets(session, dest._id, wallet._id);
        await assertWithinDailyLimit(wallet, amount, session);
        const { availableMinor } = await balanceOf(wallet._id, session);
        if (availableMinor < amount) bad(`Insufficient balance (${toMajor(availableMinor).toFixed(2)} ${wallet.currency} available)`);
        const txId = crypto.randomUUID();
        await SnapsaWalletEntry.create([
          { txId, walletId: wallet._id, amountMinor: -amount, kind: 'transfer_out', status: 'posted',
            counterpartyWalletId: dest._id, description: note || 'Transfer sent' },
          { txId, walletId: dest._id, amountMinor: amount, kind: 'transfer_in', status: 'posted',
            counterpartyWalletId: wallet._id, description: note || 'Transfer received' },
        ], { session });
      });
      const money = `${wallet.currency} ${toMajor(amount).toFixed(2)}`;
      notify(req.userId, 'wallet_alert', 'Money sent', `${money} sent from your Snapsa Wallet`, { kind: 'transfer_out' });
      notify(dest.userId, 'wallet_alert', 'Money received', `${money} received in your Snapsa Wallet`, { kind: 'transfer_in' });
      return res.json({ success: true, instant: true, amount: toMajor(amount), currency: wallet.currency });
    }

    if (!accountHolder) bad("Enter the account holder's name");
    if (amount < MIN_WITHDRAWAL_MINOR) bad(`Minimum bank transfer is ${toMajor(MIN_WITHDRAWAL_MINOR).toFixed(2)} ${wallet.currency}`);
    await inTransaction(async (session) => {
      await lockWallets(session, ...[wallet._id]);
      await assertWithinDailyLimit(wallet, amount, session);
      const { availableMinor } = await balanceOf(wallet._id, session);
      if (availableMinor < amount) bad(`Insufficient balance (${toMajor(availableMinor).toFixed(2)} ${wallet.currency} available)`);
      const [entry] = await SnapsaWalletEntry.create([{
        txId: crypto.randomUUID(), walletId: wallet._id, amountMinor: -amount, kind: 'withdrawal',
        status: 'pending', description: note || `Bank transfer to ••${accountNumber.slice(-4)}`,
      }], { session });
      await SnapsaWalletPayout.create([{
        walletId: wallet._id, userId: req.userId, entryId: entry._id, amountMinor: amount,
        bankName: 'Stanbic Bank', accountHolder, accountNumber, branchCode: '',
      }], { session });
    });
    res.json({ success: true, instant: false, status: 'queued', amount: toMajor(amount), currency: wallet.currency });
  }));

  // Withdrawal: held as pending in the ledger, paid to the user's bank by an admin.
  app.post('/snapsa/wallet/withdraw', snapAuth, route(async (req, res) => {
    const wallet = await requireWallet(req.userId, true);
    await verifyPin(wallet, req.body.pin);
    const amount = toMinor(req.body.amount);
    if (!amount) bad('Enter a valid amount');
    if (amount < MIN_WITHDRAWAL_MINOR) bad(`Minimum withdrawal is ${toMajor(MIN_WITHDRAWAL_MINOR).toFixed(2)} ${wallet.currency}`);
    const bank = {
      bankName: cleanName(req.body.bankName).slice(0, 60),
      accountHolder: cleanName(req.body.accountHolder).slice(0, 80),
      accountNumber: String(req.body.accountNumber || '').replace(/\s/g, ''),
      branchCode: String(req.body.branchCode || '').replace(/\s/g, '').slice(0, 10),
    };
    if (!bank.bankName || !bank.accountHolder || !BANK_ACCOUNT_RE.test(bank.accountNumber)) {
      bad('Enter bank name, account holder and a valid account number');
    }

    await inTransaction(async (session) => {
      await lockWallets(session, wallet._id);
      await assertWithinDailyLimit(wallet, amount, session);
      const { availableMinor } = await balanceOf(wallet._id, session);
      if (availableMinor < amount) bad(`Insufficient balance (${toMajor(availableMinor).toFixed(2)} ${wallet.currency} available)`);
      const [entry] = await SnapsaWalletEntry.create([{
        txId: crypto.randomUUID(), walletId: wallet._id, amountMinor: -amount, kind: 'withdrawal',
        status: 'pending', description: `Withdrawal to ${bank.bankName}`,
      }], { session });
      await SnapsaWalletPayout.create([{
        walletId: wallet._id, userId: req.userId, entryId: entry._id, amountMinor: amount,
        bankName: bank.bankName, accountHolder: bank.accountHolder,
        accountNumber: bank.accountNumber, branchCode: bank.branchCode,
      }], { session });
    });

    res.json({ success: true, status: 'queued', amount: toMajor(amount), currency: wallet.currency });
  }));

  // ── Stanbic credit webhook ─────────────────────────────────────────────
  // Signature: HMAC-SHA256 of the raw request body, hex, in x-stanbic-signature.
  // partnerRef makes retries safe: a duplicate is acknowledged and not credited twice.
  app.post('/snapsa/webhooks/stanbic/credit', route(async (req, res) => {
    const secret = process.env.STANBIC_WEBHOOK_SECRET || '';
    if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEq(req.headers['x-stanbic-signature'] || '', expected)) return res.status(401).json({ error: 'Bad signature' });

    const { partnerRef, accountNumber, amount, currency } = req.body || {};
    if (!partnerRef || !accountNumber) return res.status(400).json({ error: 'partnerRef and accountNumber are required' });
    const amountMinor = toMinor(amount);
    if (!amountMinor) return res.status(400).json({ error: 'Invalid amount' });

    const wallet = await SnapsaWallet.findOne({ accountNumber: String(accountNumber), accountStatus: 'active' }).lean();
    if (!wallet || (currency && String(currency).toUpperCase() !== wallet.currency)) {
      await SnapsaWalletSuspense.updateOne(
        { partnerRef: String(partnerRef) },
        { $setOnInsert: { accountNumber: String(accountNumber), amountMinor, currency: String(currency || ''), raw: req.body, resolved: false } },
        { upsert: true }
      ).catch(() => {});
      return res.json({ ok: true, matched: false });
    }

    try {
      await SnapsaWalletEntry.create({
        txId: `stanbic:${partnerRef}`, walletId: wallet._id, amountMinor, kind: 'deposit',
        status: 'posted', partnerRef: String(partnerRef), description: 'Deposit from bank transfer',
      });
    } catch (e) {
      if (e.code === 11000) return res.json({ ok: true, duplicate: true });
      throw e;
    }
    notify(wallet.userId, 'wallet_alert', 'Money received', `${wallet.currency} ${toMajor(amountMinor).toFixed(2)} deposited to your account`, { kind: 'deposit' });
    res.json({ ok: true, matched: true });
  }));

  // ── Admin: applications ────────────────────────────────────────────────

  // ── Admin: card artwork ────────────────────────────────────────────────
  // The picture of the card. The app prints each user's card number, name and
  // valid-thru date on top of it, so upload the card WITHOUT those three details.
  // ── Admin: PIN change requests ─────────────────────────────────────────
  app.get('/snapsa/admin/wallet/pin-changes', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const rows = await SnapsaWalletPinChange.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).lean();
    res.json({
      requests: rows.map(r => ({
        id: r._id, userId: r.userId, holderName: r.holderName,
        knewCurrentPin: r.knewCurrentPin, createdAt: r.createdAt,
      })),
    });
  }));

  app.post('/snapsa/admin/wallet/pin-changes/:id/approve', snapAuth, requireSnapAdmin, route(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) bad('Invalid request');
    let userId;
    await inTransaction(async (session) => {
      const pc = await SnapsaWalletPinChange.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        { $set: { status: 'approved', reviewedBy: req.userId, reviewedAt: new Date() } },
        { session, new: true }
      );
      if (!pc) bad('This request is no longer waiting', 409);
      const r = await SnapsaWallet.updateOne(
        { _id: pc.walletId },
        { $set: { pinHash: pc.pinHash, pinSalt: pc.pinSalt, pinFailures: 0, pinLockedUntil: null } },
        { session }
      );
      if (!r.matchedCount) bad('That wallet no longer exists', 404);
      userId = pc.userId;
    });
    notify(userId, 'wallet_update', 'Wallet PIN changed', 'Your new Snapsa Wallet PIN is now active.', { status: 'pin_changed' });
    sendSnapsaSystemMessage(userId, 'Your Snapsa Wallet PIN change was approved. Your new PIN is active now.');
    res.json({ success: true });
  }));

  app.post('/snapsa/admin/wallet/pin-changes/:id/reject', snapAuth, requireSnapAdmin, route(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) bad('Invalid request');
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) bad('Give a reason: the user is told why');
    const pc = await SnapsaWalletPinChange.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'rejected', reason, reviewedBy: req.userId, reviewedAt: new Date() } },
      { new: true }
    );
    if (!pc) bad('This request is no longer waiting', 409);
    notify(pc.userId, 'wallet_update', 'Wallet PIN not changed', `Your PIN change was not approved: ${reason}`.slice(0, 300), { status: 'pin_rejected' });
    sendSnapsaSystemMessage(pc.userId, `Your Snapsa Wallet PIN change was not approved.\n\nReason: ${reason}\n\nYour current PIN still works.`);
    res.json({ success: true });
  }));

  app.get('/snapsa/admin/wallet/card-art', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const s = await SnapsaWalletSettings.findOne({ key: 'main' }).lean();
    res.json({ url: s?.cardArtUrl || null, updatedAt: s?.cardArtUpdatedAt || null });
  }));

  app.post('/snapsa/admin/wallet/card-art', snapAuth, requireSnapAdmin, uploadLimiter, withArt, route(async (req, res) => {
    const file = req.file;
    if (!file) bad('Choose the card image to upload');
    const ext = sniffDoc(file.buffer);
    if (!['png', 'jpg', 'webp'].includes(ext)) bad('The card image must be a real PNG, JPG or WebP');
    const up = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'snapsa/wallet', resource_type: 'image', overwrite: false },
        (err, r) => (err ? reject(err) : resolve(r))
      ).end(file.buffer);
    });
    const prev = await SnapsaWalletSettings.findOneAndUpdate(
      { key: 'main' },
      { $set: { cardArtUrl: up.secure_url, cardArtPublicId: up.public_id, cardArtUpdatedAt: new Date() } },
      { upsert: true, new: false }
    ).lean();
    if (prev?.cardArtPublicId) cloudinary.uploader.destroy(prev.cardArtPublicId, { resource_type: 'image' }).catch(() => {});
    res.json({ success: true, url: up.secure_url });
  }));

  app.post('/snapsa/admin/wallet/card-art/remove', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const prev = await SnapsaWalletSettings.findOneAndUpdate(
      { key: 'main' },
      { $set: { cardArtUrl: null, cardArtPublicId: null, cardArtUpdatedAt: new Date() } },
      { new: false }
    ).lean();
    if (prev?.cardArtPublicId) cloudinary.uploader.destroy(prev.cardArtPublicId, { resource_type: 'image' }).catch(() => {});
    res.json({ success: true });
  }));

  app.get('/snapsa/admin/wallet/applications', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [list, pending, approved, rejected] = await Promise.all([
      SnapsaWalletApplication.find({ status }).sort(status === 'pending' ? { appliedAt: 1 } : { updatedAt: -1 }).limit(100)
        .select('userId status fullName country appliedAt approvedAt reviewedAt rejectReason idDoc.mime idDoc.bytes addressDoc.mime addressDoc.bytes').lean(),
      SnapsaWalletApplication.countDocuments({ status: 'pending' }),
      SnapsaWalletApplication.countDocuments({ status: 'approved' }),
      SnapsaWalletApplication.countDocuments({ status: 'rejected' }),
    ]);
    res.json({
      applications: list.map(a => ({
        userId: a.userId, fullName: a.fullName, country: a.country, status: a.status,
        appliedAt: a.appliedAt, approvedAt: a.approvedAt, reviewedAt: a.reviewedAt, rejectReason: a.rejectReason,
        idDoc: { mime: a.idDoc?.mime, bytes: a.idDoc?.bytes },
        addressDoc: { mime: a.addressDoc?.mime, bytes: a.addressDoc?.bytes },
      })),
      counts: { pending, approved, rejected },
    });
  }));

  // Streams one KYC document to the admin. Never exposes a Cloudinary link.
  app.get('/snapsa/admin/wallet/applications/:userId/file/:which', snapAuth, requireSnapAdmin, route(async (req, res) => {
    if (!ObjectId.isValid(req.params.userId)) bad('Invalid user');
    const doc = await SnapsaWalletApplication.findOne({ userId: req.params.userId }).select('idDoc addressDoc').lean();
    const d = req.params.which === 'id' ? doc?.idDoc : req.params.which === 'address' ? doc?.addressDoc : null;
    if (!d?.publicId) bad('Document not found', 404);
    const url = cloudinary.url(d.publicId, {
      resource_type: d.resourceType || 'image', type: 'authenticated', sign_url: true, secure: true, format: d.format,
    });
    https.get(url, (up) => {
      if (up.statusCode !== 200) { up.resume(); return res.status(502).json({ error: 'Could not fetch the document' }); }
      res.set({
        'Content-Type': d.mime || up.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
      up.pipe(res);
    }).on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Could not fetch the document' }); });
  }));

  // Approve issues the card now. The Stanbic account number is added later.
  app.post('/snapsa/admin/wallet/applications/:userId/approve', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) bad('Invalid user');
    const appDoc = await SnapsaWalletApplication.findOne({ userId });
    if (!appDoc) bad('Application not found', 404);
    const wasApproved = appDoc.status === 'approved';
    if (!wasApproved) {
      appDoc.status = 'approved';
      appDoc.approvedAt = new Date();
      appDoc.reviewedAt = new Date();
      appDoc.reviewedBy = req.userId;
      appDoc.rejectReason = '';
      await appDoc.save();
    }
    const wallet = await ensureWallet(appDoc);
    if (!wasApproved) {
      notify(userId, 'wallet_update', 'Your Snapsa Wallet is approved',
        'Your card is ready. Your account number will appear here as soon as it is ready.', { status: 'approved' });
      sendSnapsaSystemMessage(userId, '🎉 Your Snapsa Wallet is approved. Your card is ready in your profile under Snapsa Wallet. Your account number will be sent to you as soon as it is ready.');
    }
    res.json({ success: true, accountNumber: wallet.accountNumber });
  }));

  app.post('/snapsa/admin/wallet/applications/:userId/reject', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) bad('Invalid user');
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) bad('Give a reason — the applicant is told why');
    const appDoc = await SnapsaWalletApplication.findOne({ userId });
    if (!appDoc) bad('Application not found', 404);
    if (appDoc.status === 'approved') bad('This wallet is already approved', 409);
    appDoc.status = 'rejected';
    appDoc.rejectReason = reason;
    appDoc.reviewedAt = new Date();
    appDoc.reviewedBy = req.userId;
    await appDoc.save();
    sendSnapsaSystemMessage(userId, `We couldn’t approve your Snapsa Wallet application.\n\nReason: ${reason}\n\nYou can fix this and apply again from your profile under Snapsa Wallet.`);
    notify(userId, 'wallet_update', 'Snapsa Wallet application update', `Not approved: ${reason}`.slice(0, 300), { status: 'rejected' });
    res.json({ success: true });
  }));

  // ── Admin: Stanbic account numbers ─────────────────────────────────────
  // Body: { batchId, accountNumbers: [...] } in the order Stanbic supplied them.
  // Wallets are filled oldest first. A batch id can only be applied once.
  app.post('/snapsa/admin/wallet/assign-accounts', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const batchId = String(req.body.batchId || '').trim();
    const pool = Array.isArray(req.body.accountNumbers)
      ? req.body.accountNumbers.map(n => String(n).replace(/\s/g, '')).filter(Boolean) : [];
    if (!batchId) bad('batchId is required');
    if (!pool.length) bad('accountNumbers is required');
    if (pool.some(n => !ACCOUNT_RE.test(n))) bad('One or more account numbers look invalid');
    if (new Set(pool).size !== pool.length) bad('Duplicate account numbers in this batch');

    try { await SnapsaWalletBatch.create({ batchId, received: pool.length }); }
    catch (e) { if (e.code === 11000) bad('This batch was already applied', 409); throw e; }

    const waiting = await SnapsaWallet.find({ accountNumber: null, accountStatus: 'pending_partner' })
      .sort({ createdAt: 1 }).select('_id userId').lean();

    let assigned = 0;
    let cursor = 0;
    for (const w of waiting) {
      if (cursor >= pool.length) break;
      const number = pool[cursor];
      try {
        const r = await SnapsaWallet.updateOne(
          { _id: w._id, accountNumber: null },
          { $set: { accountNumber: number, accountStatus: 'active', accountAssignedAt: new Date(), accountBatchId: batchId } }
        );
        cursor++;
        if (r.modifiedCount === 1) {
          assigned++;
          notify(w.userId, 'wallet_update', 'Your Snapsa Wallet account is ready',
            `Your Snapsa Wallet account number is ${number}`, { status: 'account_ready' });
        }
      } catch (e) {
        if (e.code !== 11000) throw e;   // number already on another wallet: skip it
        cursor++;
      }
    }
    await SnapsaWalletBatch.updateOne({ batchId }, { $set: { assigned } });
    res.json({ success: true, assigned, unused: pool.length - cursor, stillWaiting: waiting.length - assigned });
  }));

  // ── Admin: payouts and unmatched credits ───────────────────────────────

  app.get('/snapsa/admin/wallet/payouts', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const status = ['queued', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'queued';
    const rows = await SnapsaWalletPayout.find({ status }).sort({ createdAt: 1 }).limit(200).lean();
    res.json({
      payouts: rows.map(p => ({
        id: p._id, userId: p.userId, amount: toMajor(p.amountMinor), bankName: p.bankName,
        accountHolder: p.accountHolder, accountNumber: p.accountNumber, branchCode: p.branchCode,
        status: p.status, reference: p.reference, reason: p.reason, createdAt: p.createdAt,
      })),
    });
  }));

  app.post('/snapsa/admin/wallet/payouts/:id/paid', snapAuth, requireSnapAdmin, route(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) bad('Invalid payout');
    const reference = String(req.body.reference || '').trim().slice(0, 80);
    if (!reference) bad('Enter the bank reference for this payment');
    let userId;
    await inTransaction(async (session) => {
      const p = await SnapsaWalletPayout.findById(req.params.id).session(session);
      if (!p || p.status !== 'queued') bad('This payout is not waiting to be paid', 409);
      p.status = 'paid'; p.reference = reference; p.processedAt = new Date();
      await p.save({ session });
      await SnapsaWalletEntry.updateOne({ _id: p.entryId }, { $set: { status: 'posted' } }, { session });
      userId = p.userId;
    });
    notify(userId, 'wallet_alert', 'Withdrawal paid', 'Your withdrawal has been sent to your bank account', { kind: 'withdrawal_paid' });
    res.json({ success: true });
  }));

  app.post('/snapsa/admin/wallet/payouts/:id/reject', snapAuth, requireSnapAdmin, route(async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) bad('Invalid payout');
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) bad('Give a reason — the user is told why');
    let userId;
    await inTransaction(async (session) => {
      const p = await SnapsaWalletPayout.findById(req.params.id).session(session);
      if (!p || p.status !== 'queued') bad('This payout is not waiting to be paid', 409);
      p.status = 'rejected'; p.reason = reason; p.processedAt = new Date();
      await p.save({ session });
      await SnapsaWalletEntry.updateOne({ _id: p.entryId }, { $set: { status: 'void' } }, { session });
      userId = p.userId;
    });
    notify(userId, 'wallet_alert', 'Withdrawal not completed', `Reason: ${reason}. The amount is back in your balance.`, { kind: 'withdrawal_rejected' });
    res.json({ success: true });
  }));

  app.get('/snapsa/admin/wallet/suspense', snapAuth, requireSnapAdmin, route(async (req, res) => {
    const rows = await SnapsaWalletSuspense.find({ resolved: false }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({
      items: rows.map(r => ({
        id: r._id, partnerRef: r.partnerRef, accountNumber: r.accountNumber,
        amount: toMajor(r.amountMinor), currency: r.currency, createdAt: r.createdAt,
      })),
    });
  }));

  // ── Account erasure guard ──────────────────────────────────────────────
  // Runs before the erase route in SnapServer.js. Blocks erasure while the
  // wallet holds money or has a payout waiting. Otherwise passes through.
  app.post('/snapsa/admin/users/:userId/erase', snapAuth, requireSnapAdmin, async (req, res, next) => {
    try {
      const w = ObjectId.isValid(req.params.userId)
        ? await SnapsaWallet.findOne({ userId: req.params.userId }).select('_id').lean() : null;
      if (w) {
        const { availableMinor } = await balanceOf(w._id);
        if (availableMinor > 0) {
          return res.status(409).json({ error: 'This user still has money in their Snapsa Wallet. It must be paid out or returned first.' });
        }
        if (await SnapsaWalletPayout.exists({ walletId: w._id, status: 'queued' })) {
          return res.status(409).json({ error: 'This user has a withdrawal waiting to be paid. Pay or reject it first.' });
        }
      }
      next();
    } catch (e) {
      console.error('[wallet erase guard]', e.message);
      res.status(500).json({ error: 'Could not check the wallet before erasing' });
    }
  });

  // Wallets for applicants approved before this module existed.
  setTimeout(async () => {
    try {
      const approved = await SnapsaWalletApplication.find({ status: 'approved' }).lean();
      for (const a of approved) await ensureWallet(a).catch(e => console.error('[wallet backfill]', a.userId, e.message));
    } catch (e) { console.error('[wallet backfill]', e.message); }
  }, 10000);
}