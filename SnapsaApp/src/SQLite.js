// ─────────────────────────────────────────────────────────────────────────────
// WernTjat — SQLite Database Layer
// ─────────────────────────────────────────────────────────────────────────────

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';

// ─────────────────────────────────────────────────────────────────────────────
// STORE / TABLE NAMES
// ─────────────────────────────────────────────────────────────────────────────
export const AUTH_STORE            = 'auth';
export const IDENTITY_STORE        = 'identity';
export const IDENTITIES_STORE      = 'identities';
export const SYNC_QUEUE_STORE      = 'offlineVault';
export const DATA_CACHE_STORE      = 'dataCache';
export const POSTS_STORE           = 'WernPosts';
export const NOTIFICATIONS_STORE   = 'notifications';
export const KEYS_STORE            = 'keys';
export const PINS_STORE            = 'pins';
export const PENDING_UPLOADS_STORE = 'pendingUploads';
export const SALTS_STORE           = 'salts';
export const DEVICE_KEYS_STORE     = 'deviceKeys';
export const BIOMETRIC_KEYS_STORE  = 'biometricKeys';
export const USERS_STORE           = 'users';
export const FOLLOWERS_STORE       = 'followers';
export const FOLLOW_REQUESTS_STORE = 'followRequests';
export const MESSAGES_STORE        = 'messages';
export const USER_CHATS_STORE      = 'userChats';
export const GROUPS_STORE          = 'groups';
export const GROUP_MEMBERS_STORE   = 'groupMembers';
export const LIKES_STORE           = 'likes';
export const COMMENTS_STORE        = 'comments';
export const SHARES_STORE          = 'shares';
export const STATUSES_STORE        = 'statuses';
export const BALANCE_STORE         = 'balance';
export const SECURE_STORE          = 'securityVault';
export const LOCK_STORE            = 'securityLocks';
export const KEY_STORE             = 'masterKey'

// ─────────────────────────────────────────────────────────────────────────────
// ROW CAPS  
// ─────────────────────────────────────────────────────────────────────────────
const ROW_CAPS = {
    messages:       { max: 500, col: 'createdAt' },
    WernPosts:          { max: 200, col: 'createdAt' },
    notifications:  { max: 100, col: 'createdAt' },
    likes:          { max: 500, col: 'createdAt' },
    comments:       { max: 300, col: 'createdAt' },
    shares:         { max: 200, col: 'createdAt' },
    followers:      { max: 500, col: 'createdAt' },
    followRequests: { max: 200, col: 'createdAt' },
    statuses:       { max: 100, col: 'createdAt' },
    users:          { max: 200, col: 'updatedAt' },
    offlineVault:   { max: 300, col: 'timestamp' },
};

const SECURE_DB_NAME      = 'WernTjatDB';
const SECURE_DB_VERSION   = 5;
const DB_ENCRYPTED        = true;
let dbInitAttempts        = 0;
const MAX_DB_INIT_ATTEMPTS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION SINGLETON 
// ─────────────────────────────────────────────────────────────────────────────

let sqliteConnection = null;
let _db = null;
let _dbOpeningPromise = null;  // Prevent double-open
let initPromise = null;

// Initialize SQLite connection 
export async function initSQLite() {
    if (sqliteConnection) return sqliteConnection;
    if (initPromise) return initPromise;
    
    initPromise = (async () => {
        const platform = Capacitor.getPlatform();
        
        if (platform === 'web') {
            const { defineCustomElements } = await import('jeep-sqlite/loader');
            await defineCustomElements(window);
            
            let jeepEl = document.querySelector('jeep-sqlite');
            if (!jeepEl) {
                jeepEl = document.createElement('jeep-sqlite');
                jeepEl.setAttribute('wasmPath', '/assets');
                document.body.appendChild(jeepEl);
            }
            
            await customElements.whenDefined('jeep-sqlite');
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('jeep-sqlite init timeout after 10s'));
                }, 10000);
                
                const checkReady = () => {
                    if (jeepEl.isStoreOpen) {
                        clearTimeout(timeout);
                        resolve();
                    } else {
                        jeepEl.addEventListener('jeepSqliteStoreOpen', () => {
                            clearTimeout(timeout);
                            resolve();
                        }, { once: true });
                    }
                };
                
                checkReady();
            });
            
            sqliteConnection = new SQLiteConnection(CapacitorSQLite);
            await sqliteConnection.initWebStore();
            
        } else {
            sqliteConnection = new SQLiteConnection(CapacitorSQLite);
        }
        
        return sqliteConnection;
    })();
    
    return initPromise;
}

export async function getDB() {
    // Ensure initialized first
    await initSQLite();
    
    // Return existing connection if open
    if (_db) return _db;
    
    
    // Prevent double-open if already in progress
    if (_dbOpeningPromise) return _dbOpeningPromise;
    
    _dbOpeningPromise = _openDB().then(db => {
        _db = db;
        _dbOpeningPromise = null;
        return db;
    }).catch(err => {
        _dbOpeningPromise = null;
        throw err;
    });
    
    return _dbOpeningPromise;
}

async function _openDB() {
    // Check if already open and consistent
    const isConsistent = (await sqliteConnection.checkConnectionsConsistency()).result;
    const isOpen = (await sqliteConnection.isConnection(SECURE_DB_NAME, false)).result;

    let db;
    if (isConsistent && isOpen) {
        db = await sqliteConnection.retrieveConnection(SECURE_DB_NAME, false);
    } else {
        db = await sqliteConnection.createConnection(
            SECURE_DB_NAME, DB_ENCRYPTED, 'no-encryption', SECURE_DB_VERSION, false
        );
    }

    await db.open();
    await _applySchema(db);
    return db;
}

export async function repairMainDBIfBroken() {
}

async function _saveWebStore() {
    if (Capacitor.getPlatform() !== 'web') return;
    try {
        await sqliteConnection.saveToStore(SECURE_DB_NAME);
    } catch (e) {
        console.warn('[SQLite] saveToStore failed:', e);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// SEED ENCRYPTION  
// ─────────────────────────────────────────────────────────────────────────────

const SEED_KEY_NAME = 'wt_seed_master_key'; 

async function getSeedMasterKey() {
    const stored = localStorage.getItem(SEED_KEY_NAME);
    if (stored) {
        try {
            const raw = Uint8Array.from(JSON.parse(stored));
            return await crypto.subtle.importKey(
                'raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
            );
        } catch (e) {
            console.warn('[SEED KEY] Stored key corrupted — regenerating');
            localStorage.removeItem(SEED_KEY_NAME);
        }
    }
    // Generate and persist a new dedicated key
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    const exported = await crypto.subtle.exportKey('raw', key);
    localStorage.setItem(SEED_KEY_NAME, JSON.stringify(Array.from(new Uint8Array(exported))));
    return key;
}

export async function secureStoreSeed(seed) {
    if (!seed) return;
    try {
        const key = await getSeedMasterKey();
        const iv  = crypto.getRandomValues(new Uint8Array(12));
        const ct  = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            new TextEncoder().encode(seed)
        );
        const payload = {
            encryptedSeed: Array.from(new Uint8Array(ct)),
            iv:            Array.from(iv),
            storedAt:      Date.now(),
            version:       '2.0'
        };
        const db = await getDB();
        await db.run(
            
            `INSERT OR REPLACE INTO auth(id, data) VALUES(?, ?)`,
            ['secure_seed', JSON.stringify(payload)]
            
        );
        await _saveWebStore();
        // Fast-verify hash — stored separately so verifySeed never needs full decrypt
        const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
        localStorage.setItem('wt_seed_hash', JSON.stringify(Array.from(new Uint8Array(hashBuf))));
        console.log('[SEED] Stored successfully');
    } catch (err) {
        console.error('[SEED] Store failed:', err);
        throw err;
    }
}

export async function secureGetSeed() {
    try {
        const db  = await getDB();
        const row = await db.query(`SELECT data FROM auth WHERE id='secure_seed'`);
        if (!row.values?.length) return null;

        const payload = JSON.parse(row.values[0].data);
        const key     = await getSeedMasterKey();

        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
            key,
            new Uint8Array(payload.encryptedSeed)
        );
        return new TextDecoder().decode(plain);
    } catch (err) {
        // OperationError = key mismatch (e.g. after logout cleared localStorage key)
        // Silently return null — caller handles missing seed gracefully
        if (err.name !== 'OperationError') {
            console.warn('[SEED] Get failed:', err.name);
        }
        // Clear the stale encrypted blob so it doesn't keep failing
        try {
            const db = await getDB();
            await db.run(`DELETE FROM auth WHERE id='secure_seed'`);
            localStorage.removeItem('wt_seed_hash');
        } catch (_) {}
        return null;
    }
}

export async function secureClearSeed() {
    try {
        const db = await getDB();
        await db.run(`DELETE FROM auth WHERE id='secure_seed'`);
        localStorage.removeItem('wt_seed_hash');
        localStorage.removeItem(SEED_KEY_NAME);
        console.log('[SEED] Cleared');
    } catch (err) {
        console.error('[SEED] Clear failed:', err);
    }
}

export async function verifySeed(inputSeed) {
    // Fast path — compare hashes without touching SQLite
    const storedHash = localStorage.getItem('wt_seed_hash');
    if (storedHash) {
        try {
            const hashBuf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inputSeed));
            const hashArr  = Array.from(new Uint8Array(hashBuf));
            if (JSON.stringify(hashArr) === storedHash) return true;
        } catch (_) {}
    }
    // Slow path fallback — full decrypt comparison
    const stored = await secureGetSeed();
    return !!stored && inputSeed === stored;
}
// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA_SQL = `

-- ── Auth ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

-- ── Offline sync queue ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offlineVault (
    _id          TEXT    PRIMARY KEY,
    type         TEXT    NOT NULL,
    payload      TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending', 'syncing', 'failed', 'confirmed')),
    timestamp    INTEGER NOT NULL,
    server_time  INTEGER,
    retries      INTEGER DEFAULT 0 CHECK(retries < 10),
    last_error   TEXT,
    checksum     TEXT,
    optimisticId TEXT,
    priority     TEXT    NOT NULL DEFAULT 'normal',
    lastAttempt  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oq_status_time ON offlineVault(status, timestamp);
CREATE INDEX IF NOT EXISTS idx_oq_optimistic  ON offlineVault(optimisticId);

-- ── Generic data cache ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dataCache (
    id        TEXT    PRIMARY KEY,
    userId    TEXT,
    data      TEXT,
    timestamp INTEGER NOT NULL,
    type      TEXT
);

-- ── Users ─────────────────────────────────────────────────────────────────────
-- Cap: 200. Full mirror of server User schema.
CREATE TABLE IF NOT EXISTS users (
    _id                    TEXT    PRIMARY KEY,
    zkCommitment           TEXT    UNIQUE NOT NULL,
    encryptedIdentity      TEXT,
    identityIv             TEXT,
    identitySalt           TEXT,
    setupProof             TEXT,
    circuitVersion         TEXT,
    displayNameEncrypted   TEXT,
    displayNameIv          TEXT,
    avatarEncrypted        TEXT,
    avatarIv               TEXT,
    coverEncrypted         TEXT,
    coverIv                TEXT,
    isOnline               INTEGER NOT NULL DEFAULT 0,
    lastSeen               INTEGER,
    customStatus           TEXT    DEFAULT '',
    ghostMode              INTEGER NOT NULL DEFAULT 0,
    isAdmin                INTEGER NOT NULL DEFAULT 0,
    founder                INTEGER NOT NULL DEFAULT 0,
    tier                   TEXT,
    tierExpiresAt          INTEGER,
    rank                   TEXT    NOT NULL DEFAULT 'private',
    clearanceLevel         INTEGER NOT NULL DEFAULT 1,
    unit                   TEXT    DEFAULT '',
    followerCount          INTEGER NOT NULL DEFAULT 0,
    followingCount         INTEGER NOT NULL DEFAULT 0,
    privacySettings        TEXT    NOT NULL DEFAULT '{}',
    defcon                 TEXT    NOT NULL DEFAULT '{"level":5}',
    encryptionKeys         TEXT    NOT NULL DEFAULT '{}',
    coins                  INTEGER NOT NULL DEFAULT 0,
    giftInventory          TEXT    NOT NULL DEFAULT '{}',
    anomalyScore           REAL    NOT NULL DEFAULT 0,
    lastSecurityCheck      INTEGER,
    trustedDevices         TEXT    NOT NULL DEFAULT '[]',
    lastFullSync           INTEGER,
    hasPendingActions      INTEGER NOT NULL DEFAULT 0,
    createdAt              INTEGER,
    updatedAt              INTEGER,
    lastSync               INTEGER,
    synced                 INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_online   ON users(isOnline, lastSeen);
CREATE INDEX IF NOT EXISTS idx_users_rank     ON users(rank, clearanceLevel);
CREATE INDEX IF NOT EXISTS idx_users_created  ON users(createdAt);
CREATE INDEX IF NOT EXISTS idx_users_lastsync ON users(lastSync);

-- ── Identity (current logged-in user profile) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS identity (
    userId    TEXT    PRIMARY KEY,
    data      TEXT,
    updatedAt INTEGER NOT NULL,
    synced    INTEGER NOT NULL DEFAULT 0
);

-- ── ZK Identities (known commitments) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS identities (
    zkCommitment TEXT    PRIMARY KEY,
    data         TEXT,
    lastLogin    INTEGER
);

-- ── Social: Follow Requests ───────────────────────────────────────────────────
-- Cap: 200.
CREATE TABLE IF NOT EXISTS followRequests (
    _id        TEXT    PRIMARY KEY,
    fromUserId TEXT    NOT NULL,
    toUserId   TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',
    createdAt  INTEGER,
    updatedAt  INTEGER,
    UNIQUE(fromUserId, toUserId)
);
CREATE INDEX IF NOT EXISTS idx_freq_from ON followRequests(fromUserId, status, createdAt);
CREATE INDEX IF NOT EXISTS idx_freq_to   ON followRequests(toUserId, status, createdAt);

-- ── Social: Followers ─────────────────────────────────────────────────────────
-- Cap: 500.
CREATE TABLE IF NOT EXISTS followers (
    _id         TEXT    PRIMARY KEY,
    followerId  TEXT    NOT NULL,
    followingId TEXT    NOT NULL,
    createdAt   INTEGER,
    UNIQUE(followerId, followingId)
);
CREATE INDEX IF NOT EXISTS idx_foll_follower  ON followers(followerId, createdAt);
CREATE INDEX IF NOT EXISTS idx_foll_following ON followers(followingId, createdAt);

-- ── Messaging: Messages ───────────────────────────────────────────────────────
-- Cap: 500 total rows. Oldest pruned first when cap hit.
CREATE TABLE IF NOT EXISTS messages (
    _id           TEXT    PRIMARY KEY,
    senderId      TEXT    NOT NULL,
    receiverId    TEXT,
    groupId       TEXT,
    chatId        TEXT    NOT NULL,
    text          TEXT,
    image         TEXT,
    imagePublicId TEXT,
    read          INTEGER NOT NULL DEFAULT 0,
    readAt        INTEGER,
    createdAt     INTEGER,
    updatedAt     INTEGER,
    pending       INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_chat     ON messages(chatId, createdAt);
CREATE INDEX IF NOT EXISTS idx_msg_sender   ON messages(senderId, createdAt);
CREATE INDEX IF NOT EXISTS idx_msg_receiver ON messages(receiverId, read, createdAt);
CREATE INDEX IF NOT EXISTS idx_msg_group    ON messages(groupId, createdAt);

-- ── Messaging: User Chat Metadata ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS userChats (
    _id           TEXT    PRIMARY KEY,
    userId        TEXT    NOT NULL,
    chatId        TEXT    NOT NULL,
    partnerId     TEXT,
    groupId       TEXT,
    partnerType   TEXT    NOT NULL DEFAULT 'user',
    unreadCount   INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    muted         INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    lastReadAt    INTEGER,
    lastMessage   TEXT,
    lastMessageAt INTEGER,
    createdAt     INTEGER,
    updatedAt     INTEGER,
    UNIQUE(userId, chatId)
);
CREATE INDEX IF NOT EXISTS idx_uc_user   ON userChats(userId, updatedAt);
CREATE INDEX IF NOT EXISTS idx_uc_pinned ON userChats(userId, pinned, updatedAt);
CREATE INDEX IF NOT EXISTS idx_uc_chatid ON userChats(chatId);

-- ── Groups ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
    _id          TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    description  TEXT,
    avatar       TEXT    DEFAULT '',
    adminId      TEXT    NOT NULL,
    isPrivate    INTEGER NOT NULL DEFAULT 0,
    allowInvites INTEGER NOT NULL DEFAULT 1,
    memberCount  INTEGER NOT NULL DEFAULT 1,
    createdAt    INTEGER,
    updatedAt    INTEGER,
    lastSync     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grp_admin   ON groups(adminId, createdAt);
CREATE INDEX IF NOT EXISTS idx_grp_private ON groups(isPrivate, createdAt);
CREATE INDEX IF NOT EXISTS idx_grp_members ON groups(memberCount);

-- ── Group Memberships ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groupMembers (
    _id      TEXT    PRIMARY KEY,
    groupId  TEXT    NOT NULL,
    userId   TEXT    NOT NULL,
    role     TEXT    NOT NULL DEFAULT 'member',
    joinedAt INTEGER,
    UNIQUE(groupId, userId)
);
CREATE INDEX IF NOT EXISTS idx_gm_group ON groupMembers(groupId, role);
CREATE INDEX IF NOT EXISTS idx_gm_user  ON groupMembers(userId, joinedAt);

-- ── Content: WernPosts ────────────────────────────────────────────────────────────
-- Cap: 200. Feed/trending window.
CREATE TABLE IF NOT EXISTS WernPosts (
    _id                     TEXT    PRIMARY KEY,
    authorId                TEXT    NOT NULL,
    authorSnapshot          TEXT    NOT NULL DEFAULT '{}',
    content                 TEXT,
    image                   TEXT,
    imagePublicId           TEXT,
    video                   TEXT,
    videoPublicId           TEXT,
    location                TEXT,
    feeling                 TEXT,
    mood                    TEXT,
    energy                  INTEGER,
    burnAt                  INTEGER,
    likeCount               INTEGER NOT NULL DEFAULT 0,
    commentCount            INTEGER NOT NULL DEFAULT 0,
    shareCount              INTEGER NOT NULL DEFAULT 0,
    viewCount               INTEGER NOT NULL DEFAULT 0,
    trendingScore           REAL    NOT NULL DEFAULT 0,
    recentEngagement        REAL    NOT NULL DEFAULT 0,
    lastTrendingCalculation INTEGER,
    contentHash             TEXT,
    zkVerified              INTEGER NOT NULL DEFAULT 0,
    isActive                INTEGER NOT NULL DEFAULT 1,
    deletedAt               INTEGER,
    createdAt               INTEGER,
    updatedAt               INTEGER,
    lastSync                INTEGER
);
CREATE INDEX IF NOT EXISTS idx_WernPosts_author   ON WernPosts(authorId, createdAt);
CREATE INDEX IF NOT EXISTS idx_WernPosts_trending ON WernPosts(trendingScore, createdAt);
CREATE INDEX IF NOT EXISTS idx_WernPosts_active   ON WernPosts(isActive, createdAt);
CREATE INDEX IF NOT EXISTS idx_WernPosts_burnAt   ON WernPosts(burnAt);
CREATE INDEX IF NOT EXISTS idx_WernPosts_lastsync ON WernPosts(lastSync);

-- ── Content: Likes ────────────────────────────────────────────────────────────
-- Cap: 500.
CREATE TABLE IF NOT EXISTS likes (
    _id       TEXT    PRIMARY KEY,
    PostId    TEXT    NOT NULL,
    userId    TEXT    NOT NULL,
    createdAt INTEGER,
    UNIQUE(PostId, userId)
);
CREATE INDEX IF NOT EXISTS idx_likes_WernPost ON likes(PostId, createdAt);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(userId, createdAt);

-- ── Content: Comments ─────────────────────────────────────────────────────────
-- Cap: 300.
CREATE TABLE IF NOT EXISTS comments (
    _id       TEXT    PRIMARY KEY,
    PostId    TEXT    NOT NULL,
    userId    TEXT    NOT NULL,
    content   TEXT    NOT NULL,
    parentId  TEXT,
    likeCount INTEGER NOT NULL DEFAULT 0,
    isActive  INTEGER NOT NULL DEFAULT 1,
    deletedAt INTEGER,
    createdAt INTEGER,
    updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comm_WernPost   ON comments(PostId, createdAt);
CREATE INDEX IF NOT EXISTS idx_comm_user   ON comments(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_comm_parent ON comments(PostId, parentId, createdAt);
CREATE INDEX IF NOT EXISTS idx_comm_active ON comments(isActive, createdAt);

-- ── Content: Shares ───────────────────────────────────────────────────────────
-- Cap: 200.
CREATE TABLE IF NOT EXISTS shares (
    _id       TEXT    PRIMARY KEY,
    PostId    TEXT    NOT NULL,
    userId    TEXT    NOT NULL,
    shareType TEXT    NOT NULL DEFAULT 'reWernPost',
    createdAt INTEGER,
    UNIQUE(PostId, userId)
);
CREATE INDEX IF NOT EXISTS idx_shares_WernPost ON shares(PostId);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(userId, createdAt);

-- ── Content: Statuses (Stories) ───────────────────────────────────────────────
-- Cap: 100. Short-lived — removed by clearOldCache() on expiry.
CREATE TABLE IF NOT EXISTS statuses (
    _id           TEXT    PRIMARY KEY,
    userId        TEXT    NOT NULL,
    text          TEXT,
    mediaUrl      TEXT,
    mediaPublicId TEXT,
    type          TEXT    NOT NULL DEFAULT 'text',
    visibility    TEXT    NOT NULL DEFAULT 'public',
    durationHours INTEGER NOT NULL DEFAULT 24,
    burnAfterView INTEGER NOT NULL DEFAULT 0,
    viewCount     INTEGER NOT NULL DEFAULT 0,
    expiresAt     INTEGER NOT NULL,
    createdAt     INTEGER,
    updatedAt     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stat_user ON statuses(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_stat_exp  ON statuses(expiresAt);
CREATE INDEX IF NOT EXISTS idx_stat_vis  ON statuses(visibility, createdAt);

-- ── Notifications ─────────────────────────────────────────────────────────────
-- Cap: 100. Server never stores these — push fires and forgets.
-- userDeleted: soft-hide flag. User can also hard-delete individually or wipe all.
CREATE TABLE IF NOT EXISTS notifications (
    _id         TEXT    PRIMARY KEY,
    recipientId TEXT    NOT NULL,
    senderId    TEXT,
    type        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    data        TEXT    NOT NULL DEFAULT '{}',
    isRead      INTEGER NOT NULL DEFAULT 0,
    readAt      INTEGER,
    priority    TEXT    NOT NULL DEFAULT 'medium',
    userDeleted INTEGER NOT NULL DEFAULT 0,
    expiresAt   INTEGER,
    createdAt   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notif_recip ON notifications(recipientId, isRead, userDeleted, createdAt);
CREATE INDEX IF NOT EXISTS idx_notif_type  ON notifications(type, createdAt);
CREATE INDEX IF NOT EXISTS idx_notif_exp   ON notifications(expiresAt);

-- ── Balance — CLIENT ONLY ─────────────────────────────────────────────────────
-- Single row per user. Encrypted — device extraction is useless without the key.
-- Sequence guards against replay attacks that would roll back the balance.
-- Server never stores a balance; it processes transactions and deletes them.
CREATE TABLE IF NOT EXISTS balance (
    userId           TEXT    PRIMARY KEY,
    encryptedBalance TEXT    NOT NULL,
    balanceIv        TEXT    NOT NULL,
    sequence         INTEGER NOT NULL DEFAULT 0,
    updatedAt        INTEGER NOT NULL
);

-- ── Key Management ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keys (
    chatId    TEXT    PRIMARY KEY,
    data      TEXT,
    timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS salts (
    id   TEXT PRIMARY KEY,
    data TEXT
);

CREATE TABLE IF NOT EXISTS deviceKeys (
    id   TEXT PRIMARY KEY,
    data TEXT
);

CREATE TABLE IF NOT EXISTS biometricKeys (
    zkCommitment TEXT PRIMARY KEY,
    data         TEXT
);

-- ── Pending Uploads ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pendingUploads (
    id        TEXT    PRIMARY KEY,
    type      TEXT,
    synced    INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT,
    data      TEXT
);

-- ── Pins ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pins (
    id   TEXT PRIMARY KEY,
    data TEXT
);

-- ── Pepper (device-local, generated on first install) ────────────────────────
CREATE TABLE IF NOT EXISTS pepper (
    _id       TEXT PRIMARY KEY,
    value     TEXT,
    createdAt TEXT
);
 
CREATE TABLE IF NOT EXISTS biometric_auth (
  userId TEXT PRIMARY KEY,
  method TEXT NOT NULL CHECK(method IN ('pin','password','pattern','fingerprint','faceid')),
  credentialHash TEXT NOT NULL,
  salt TEXT NOT NULL,
  webauthnCredentialId TEXT,
  webauthnPublicKey TEXT,
  challengeCounter INTEGER DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS biometric_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  action TEXT NOT NULL,
  method TEXT,
  ipAddress TEXT,
  userAgent TEXT,
  timestamp INTEGER NOT NULL
);
 
CREATE INDEX IF NOT EXISTS idx_biometric_auth_userId ON biometric_auth(userId);
CREATE INDEX IF NOT EXISTS idx_biometric_logs_userId ON biometric_logs(userId);
CREATE INDEX IF NOT EXISTS idx_biometric_logs_action ON biometric_logs(action);
`;

async function _applySchema(db) {
    if (db._schemaApplied) {
        return;
    }
    
    try {
        await db.execute(SCHEMA_SQL);
        db._schemaApplied = true;
    } catch (err) {
        console.error('Schema execute failed:', err);
        throw err;
    }

    // Seed pepper on first install only
    const pepperCheck = await db.query(`SELECT _id FROM pepper WHERE _id='main'`);
    if (!pepperCheck.values?.length) {
        const pepperBytes = Array.from(crypto.getRandomValues(new Uint8Array(32)));
        await db.run(
            `INSERT INTO pepper(_id, value, createdAt) VALUES(?,?,?)`,
            ['main', JSON.stringify(pepperBytes), new Date().toISOString()]
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENCRYPTION UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
const CRYPTO_KEY_STORE = 'wt_idb_key';

// PATCH 1 — getOrCreateCryptoKey()
// Use localStorage instead of sessionStorage so the AES key survives page reloads
async function getOrCreateCryptoKey() {
    // ✅ localStorage instead of sessionStorage — persists across reloads
    const stored = localStorage.getItem(CRYPTO_KEY_STORE);
    if (stored) {
        const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
        return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
    const key      = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', key);
    // ✅ localStorage instead of sessionStorage
    localStorage.setItem(CRYPTO_KEY_STORE, btoa(String.fromCharCode(...new Uint8Array(exported))));
    return key;
}

export async function encryptForIDB(data) {
    const key        = await getOrCreateCryptoKey();
    const iv         = crypto.getRandomValues(new Uint8Array(12));
    const encoded    = new TextEncoder().encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ciphertext)), encrypted: true };
}

export async function decryptFromIDB(stored) {
    if (!stored?.encrypted) return stored;
    const key   = await getOrCreateCryptoKey();
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(stored.iv) }, key, new Uint8Array(stored.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain));
}

// ─────────────────────────────────────────────────────────────────────────────
// LOW-LEVEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function j(v)  { return v === undefined ? null : JSON.stringify(v); }
function p(v)  { try { return v == null ? null : JSON.parse(v); } catch { return v; } }
function ts()  { return Date.now(); }

async function _selectOne(sql, values = []) {
    const db  = await getDB();
    const res = await db.query(sql, values);
    return res.values?.[0] ?? null;
}

async function _selectAll(sql, values = []) {
    const db  = await getDB();
    const res = await db.query(sql, values);
    return res.values ?? [];
}

async function _scalar(sql, values = []) {
    const row = await _selectOne(sql, values);
    return row ? Object.values(row)[0] : null;
}

async function _del(table, pkCol, pk) {
    const db = await getDB();
    await db.run(`DELETE FROM ${table} WHERE ${pkCol}=?`, [pk]);
}

async function _clearTable(table) {
    const db = await getDB();
    await db.run(`DELETE FROM ${table}`);
}

/**
 * Enforce row cap 
 */
async function _enforceRowCap(db, table) {
    const cap = ROW_CAPS[table];
    if (!cap) return;
    await db.run(`
        DELETE FROM ${table}
        WHERE rowid IN (
            SELECT rowid FROM ${table}
            ORDER BY ${cap.col} ASC
            LIMIT MAX(0, (SELECT COUNT(*) FROM ${table}) - ?)
        )
    `, [cap.max]);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
export async function saveAuthToken(token) {
    const db = await getDB();
    await db.run(`INSERT OR REPLACE INTO auth(id,data) VALUES(?,?)`,
        ['auth_token', j({ token, storedAt: ts() })]);
    await _saveWebStore();
}

export async function getAuthToken() {
    const row = await _selectOne(`SELECT data FROM auth WHERE id='auth_token'`);
    return row ? p(row.data)?.token : null;
}
export async function saveUserId(userId) {
    const db = await getDB();
    await db.run(`INSERT OR REPLACE INTO auth(id,data) VALUES(?,?)`,
        ['user_id', j({ value: userId, storedAt: ts() })]);
    await _saveWebStore();
}

export async function getUserId() {
    const row = await _selectOne(`SELECT data FROM auth WHERE id='user_id'`);
    return row ? p(row.data)?.value : null;
}

export async function clearAuthData() {
    const db = await getDB();
    await db.run(`DELETE FROM auth WHERE id IN ('auth_token', 'user_id', 'secure_seed')`);
    localStorage.removeItem('wt_seed_hash');
    localStorage.removeItem('wt_seed_master_key');
}

export async function clearAuthToken() {
    const db = await getDB();
    await db.run(`DELETE FROM auth WHERE id='auth_token'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertUser(user) {
    const db  = await getDB();
    const now = ts();

    // Sanitize: convert any object/array fields to null or JSON string
    // SQLite cannot bind objects — only TEXT, INTEGER, REAL, NULL
    const safeStr = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        // Object or array — shouldn't be in a scalar column, skip it
        return null;
    };

    await db.run(`
        INSERT INTO users (
            _id, zkCommitment, encryptedIdentity, identityIv, identitySalt,
            setupProof, circuitVersion,
            displayNameEncrypted, displayNameIv,
            avatarEncrypted, avatarIv, coverEncrypted, coverIv,
            isOnline, lastSeen, customStatus, ghostMode, isAdmin, founder,
            tier, tierExpiresAt, rank, clearanceLevel, unit,
            followerCount, followingCount, privacySettings, defcon,
            encryptionKeys, coins, giftInventory,
            anomalyScore, lastSecurityCheck, trustedDevices,
            lastFullSync, hasPendingActions, createdAt, updatedAt, lastSync, synced
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(_id) DO UPDATE SET
            zkCommitment=excluded.zkCommitment,
            encryptedIdentity=excluded.encryptedIdentity,
            identityIv=excluded.identityIv,
            identitySalt=excluded.identitySalt,
            displayNameEncrypted=excluded.displayNameEncrypted,
            displayNameIv=excluded.displayNameIv,
            avatarEncrypted=excluded.avatarEncrypted,
            avatarIv=excluded.avatarIv,
            coverEncrypted=excluded.coverEncrypted,
            coverIv=excluded.coverIv,
            isOnline=excluded.isOnline,
            lastSeen=excluded.lastSeen,
            customStatus=excluded.customStatus,
            ghostMode=excluded.ghostMode,
            tier=excluded.tier,
            tierExpiresAt=excluded.tierExpiresAt,
            rank=excluded.rank,
            clearanceLevel=excluded.clearanceLevel,
            unit=excluded.unit,
            followerCount=excluded.followerCount,
            followingCount=excluded.followingCount,
            privacySettings=excluded.privacySettings,
            defcon=excluded.defcon,
            encryptionKeys=excluded.encryptionKeys,
            coins=excluded.coins,
            giftInventory=excluded.giftInventory,
            anomalyScore=excluded.anomalyScore,
            lastSecurityCheck=excluded.lastSecurityCheck,
            trustedDevices=excluded.trustedDevices,
            lastFullSync=excluded.lastFullSync,
            hasPendingActions=excluded.hasPendingActions,
            updatedAt=excluded.updatedAt,
            lastSync=excluded.lastSync,
            synced=excluded.synced
    `, [
        safeStr(user._id),
        safeStr(user.zkCommitment),
        safeStr(user.encryptedIdentity),
        safeStr(user.identityIv),
        safeStr(user.identitySalt),
        safeStr(user.setupProof),
        safeStr(user.circuitVersion),
        safeStr(user.displayNameEncrypted),
        safeStr(user.displayNameIv),
        safeStr(user.avatarEncrypted),
        safeStr(user.avatarIv),
        safeStr(user.coverEncrypted),
        safeStr(user.coverIv),
        user.isOnline ? 1 : 0,
        // lastSeen might be a Date object or ISO string — coerce to number
        user.lastSeen
            ? (typeof user.lastSeen === 'number'
                ? user.lastSeen
                : new Date(user.lastSeen).getTime() || null)
            : null,
        user.customStatus ?? '',
        user.ghostMode ? 1 : 0,
        user.isAdmin ? 1 : 0,
        user.founder ? 1 : 0,
        safeStr(user.tier),
        // tierExpiresAt might be a Date object
        user.tierExpiresAt
            ? (typeof user.tierExpiresAt === 'number'
                ? user.tierExpiresAt
                : new Date(user.tierExpiresAt).getTime() || null)
            : null,
        user.rank ?? 'private',
        user.clearanceLevel ?? 1,
        user.unit ?? '',
        // followerCount/followingCount — server might send arrays, get length
        Array.isArray(user.followers)
            ? user.followers.length
            : (user.followerCount ?? 0),
        Array.isArray(user.following)
            ? user.following.length
            : (user.followingCount ?? 0),
        j(user.privacySettings ?? {}),
        j(user.defcon ?? { level: 5 }),
        j(user.encryptionKeys ?? {}),
        user.coins ?? 0,
        j(user.giftInventory ?? {}),
        user.anomalyScore ?? 0,
        user.lastSecurityCheck
            ? (typeof user.lastSecurityCheck === 'number'
                ? user.lastSecurityCheck
                : new Date(user.lastSecurityCheck).getTime() || null)
            : null,
        j(user.trustedDevices ?? []),
        user.lastFullSync ?? null,
        user.hasPendingActions ? 1 : 0,
        // createdAt/updatedAt — coerce ISO strings to timestamps
        user.createdAt
            ? (typeof user.createdAt === 'number'
                ? user.createdAt
                : new Date(user.createdAt).getTime() || now)
            : now,
        user.updatedAt
            ? (typeof user.updatedAt === 'number'
                ? user.updatedAt
                : new Date(user.updatedAt).getTime() || now)
            : now,
        now,
        0
    ]);
    await _enforceRowCap(db, 'users');
}

export async function getUser(userId) {
    return _hydrateUser(await _selectOne(`SELECT * FROM users WHERE _id=?`, [userId]));
}

export async function getUserByCommitment(zkCommitment) {
    return _hydrateUser(await _selectOne(`SELECT * FROM users WHERE zkCommitment=?`, [zkCommitment]));
}

export async function getOnlineUsers(limit = 50) {
    const rows = await _selectAll(
        `SELECT * FROM users WHERE isOnline=1 AND ghostMode=0 ORDER BY lastSeen DESC LIMIT ?`, [limit]
    );
    return rows.map(_hydrateUser);
}

export async function updateUserOnlineStatus(userId, isOnline) {
    const db = await getDB();
    await db.run(`UPDATE users SET isOnline=?, lastSeen=?, updatedAt=? WHERE _id=?`,
        [isOnline ? 1 : 0, ts(), ts(), userId]);
}

export async function incrementFollowerCount(userId, delta = 1) {
    const db = await getDB();
    await db.run(`UPDATE users SET followerCount=followerCount+?, updatedAt=? WHERE _id=?`,
        [delta, ts(), userId]);
}

export async function incrementFollowingCount(userId, delta = 1) {
    const db = await getDB();
    await db.run(`UPDATE users SET followingCount=followingCount+?, updatedAt=? WHERE _id=?`,
        [delta, ts(), userId]);
}

export async function updateUserCoins(userId, newBalance) {
    const db = await getDB();
    await db.run(`UPDATE users SET coins=?, updatedAt=? WHERE _id=?`, [newBalance, ts(), userId]);
}

export async function updateUserDefcon(userId, defcon) {
    const db = await getDB();
    await db.run(`UPDATE users SET defcon=?, updatedAt=? WHERE _id=?`, [j(defcon), ts(), userId]);
}

function _hydrateUser(row) {
    if (!row) return null;
    return {
        ...row,
        isOnline:          !!row.isOnline,
        ghostMode:         !!row.ghostMode,
        isAdmin:           !!row.isAdmin,
        founder:           !!row.founder,
        hasPendingActions: !!row.hasPendingActions,
        privacySettings:   p(row.privacySettings) ?? {},
        defcon:            p(row.defcon) ?? { level: 5 },
        encryptionKeys:    p(row.encryptionKeys) ?? {},
        giftInventory:     p(row.giftInventory) ?? {},
        trustedDevices:    p(row.trustedDevices) ?? []
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY
// ─────────────────────────────────────────────────────────────────────────────
export async function saveIdentityToIDB(userId, data) {
    const db = await getDB();
    await db.run(`INSERT OR REPLACE INTO identity(userId,data,updatedAt,synced) VALUES(?,?,?,0)`,
        [userId, j(data), ts()]);
}

export async function loadIdentityFromIDB(userId) {
    const row = await _selectOne(`SELECT data FROM identity WHERE userId=?`, [userId]);
    return row ? p(row.data) : null;
}

export async function getUnsyncedIdentities() {
    const rows = await _selectAll(`SELECT userId, data FROM identity WHERE synced=0`);
    return rows.map(r => ({ userId: r.userId, ...p(r.data) }));
}

export async function markIdentitySynced(userId) {
    const db = await getDB();
    await db.run(`UPDATE identity SET synced=1 WHERE userId=?`, [userId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL: FOLLOW REQUESTS
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertFollowRequest(req) {
    const db = await getDB();
    await db.run(`
        INSERT INTO followRequests(_id, fromUserId, toUserId, status, createdAt, updatedAt)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(fromUserId, toUserId) DO UPDATE SET
            status=excluded.status, updatedAt=excluded.updatedAt
    `, [req._id, req.fromUserId, req.toUserId, req.status ?? 'pending',
        req.createdAt ?? ts(), req.updatedAt ?? ts()]);
    await _enforceRowCap(db, 'followRequests');
}

export async function getOutgoingFollowRequests(fromUserId) {
    return _selectAll(
        `SELECT * FROM followRequests WHERE fromUserId=? ORDER BY createdAt DESC`, [fromUserId]);
}

export async function getIncomingFollowRequests(toUserId) {
    return _selectAll(
        `SELECT * FROM followRequests WHERE toUserId=? AND status='pending' ORDER BY createdAt DESC`,
        [toUserId]);
}

export async function updateFollowRequestStatus(fromUserId, toUserId, status) {
    const db = await getDB();
    await db.run(`UPDATE followRequests SET status=?, updatedAt=? WHERE fromUserId=? AND toUserId=?`,
        [status, ts(), fromUserId, toUserId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL: FOLLOWERS
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertFollower(follow) {
    const db = await getDB();
    await db.run(`INSERT OR IGNORE INTO followers(_id, followerId, followingId, createdAt) VALUES(?,?,?,?)`,
        [follow._id, follow.followerId, follow.followingId, follow.createdAt ?? ts()]);
    await _enforceRowCap(db, 'followers');
}

export async function removeFollower(followerId, followingId) {
    const db = await getDB();
    await db.run(`DELETE FROM followers WHERE followerId=? AND followingId=?`, [followerId, followingId]);
}

export async function getFollowers(userId, limit = 50) {
    return _selectAll(
        `SELECT * FROM followers WHERE followingId=? ORDER BY createdAt DESC LIMIT ?`, [userId, limit]);
}

export async function getFollowing(userId, limit = 50) {
    return _selectAll(
        `SELECT * FROM followers WHERE followerId=? ORDER BY createdAt DESC LIMIT ?`, [userId, limit]);
}

export async function isFollowing(followerId, followingId) {
    return !!(await _selectOne(
        `SELECT _id FROM followers WHERE followerId=? AND followingId=?`, [followerId, followingId]));
}

//____________________________________________________________________________________________
export async function upsertMessagesBatch(msgs) {
  if (!msgs || msgs.length === 0) return;

  const db = await getDB();
  const now = ts();

  // @capacitor-community/sqlite does NOT have db.transaction()
  // Use individual run() calls instead
  for (const msg of msgs) {
    await db.run(`
      INSERT INTO messages (
        _id, senderId, receiverId, groupId, chatId,
        text, image, imagePublicId, read, readAt,
        createdAt, updatedAt, pending, failed
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(_id) DO UPDATE SET
        text=excluded.text,
        read=excluded.read,
        readAt=excluded.readAt,
        updatedAt=excluded.updatedAt,
        pending=excluded.pending,
        failed=excluded.failed
    `, [
      msg._id,
      msg.senderId,
      msg.receiverId ?? null,
      msg.groupId ?? null,
      msg.chatId,
      msg.text ?? null,
      msg.image ?? null,
      msg.imagePublicId ?? null,
      msg.read ? 1 : 0,
      msg.readAt ?? null,
      msg.createdAt ?? now,
      msg.updatedAt ?? now,
      msg.pending ? 1 : 0,
      msg.failed ? 1 : 0
    ]);
  }
  
  await _enforceRowCap(db, 'messages');
}
// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING: MESSAGES
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertMessage(msg) {
    const db = await getDB();
    await db.run(`
        INSERT INTO messages (
            _id, senderId, receiverId, groupId, chatId,
            text, image, imagePublicId, read, readAt,
            createdAt, updatedAt, pending, failed
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(_id) DO UPDATE SET
            text=excluded.text, read=excluded.read, readAt=excluded.readAt,
            updatedAt=excluded.updatedAt, pending=excluded.pending, failed=excluded.failed
    `, [
        msg._id, msg.senderId, msg.receiverId ?? null, msg.groupId ?? null, msg.chatId,
        msg.text ?? null, msg.image ?? null, msg.imagePublicId ?? null,
        msg.read ? 1 : 0, msg.readAt ?? null,
        msg.createdAt ?? ts(), msg.updatedAt ?? ts(),
        msg.pending ? 1 : 0, msg.failed ? 1 : 0
    ]);
    await _enforceRowCap(db, 'messages');
}

export async function getMessages(chatId, limit = 50, beforeTimestamp = null) {
    let sql    = `SELECT * FROM messages WHERE chatId=?`;
    const bind = [chatId];
    if (beforeTimestamp) { sql += ` AND createdAt<?`; bind.push(beforeTimestamp); }
    sql += ` ORDER BY createdAt DESC LIMIT ?`;
    bind.push(limit);
    return (await _selectAll(sql, bind)).reverse().map(_hydrateMessage);
}

export async function markMessageRead(messageId, readAt) {
    const db = await getDB();
    await db.run(`UPDATE messages SET read=1, readAt=?, updatedAt=? WHERE _id=?`,
        [readAt ?? ts(), ts(), messageId]);
}

export async function markAllChatMessagesRead(chatId, userId) {
    const db = await getDB();
    await db.run(
        `UPDATE messages SET read=1, readAt=?, updatedAt=? WHERE chatId=? AND receiverId=? AND read=0`,
        [ts(), ts(), chatId, userId]);
}

export async function getPendingMessages() {
    return (await _selectAll(`SELECT * FROM messages WHERE pending=1`)).map(_hydrateMessage);
}

export async function deleteMessage(messageId) { await _del('messages', '_id', messageId); }

function _hydrateMessage(row) {
    if (!row) return null;
    return { ...row, read: !!row.read, pending: !!row.pending, failed: !!row.failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING: USER CHAT METADATA
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertUserChat(chat) {
     if (chat.lastMessage !== null && typeof chat.lastMessage !== 'string') {
        chat = { ...chat, lastMessage: String(chat.lastMessage) };
    }
    const db  = await getDB();
    const now = ts();
    await db.run(`
        INSERT INTO userChats (
            _id, userId, chatId, partnerId, groupId, partnerType,
            unreadCount, pinned, muted, archived, lastReadAt,
            lastMessage, lastMessageAt, createdAt, updatedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(userId, chatId) DO UPDATE SET
            unreadCount=excluded.unreadCount, pinned=excluded.pinned,
            muted=excluded.muted, archived=excluded.archived,
            lastReadAt=excluded.lastReadAt, lastMessage=excluded.lastMessage,
            lastMessageAt=excluded.lastMessageAt, updatedAt=excluded.updatedAt
    `, [
        chat._id ?? `${chat.userId}_${chat.chatId}`,
        chat.userId, chat.chatId,
        chat.partnerId ?? null, chat.groupId ?? null, chat.partnerType ?? 'user',
        chat.unreadCount ?? 0,
        chat.pinned ? 1 : 0, chat.muted ? 1 : 0, chat.archived ? 1 : 0,
        chat.lastReadAt ?? null, chat.lastMessage ?? null, chat.lastMessageAt ?? null,
        chat.createdAt ?? now, chat.updatedAt ?? now
    ]);
}

export async function getUserChats(userId, includeArchived = false) {
    let sql    = `SELECT * FROM userChats WHERE userId=?`;
    const bind = [userId];
    if (!includeArchived) { sql += ` AND archived=0`; }
    sql += ` ORDER BY pinned DESC, lastMessageAt DESC`;
    return (await _selectAll(sql, bind))
        .map(r => ({ ...r, pinned: !!r.pinned, muted: !!r.muted, archived: !!r.archived }));
}

export async function incrementChatUnread(userId, chatId) {
    const db = await getDB();
    await db.run(`UPDATE userChats SET unreadCount=unreadCount+1, updatedAt=? WHERE userId=? AND chatId=?`,
        [ts(), userId, chatId]);
}

export async function resetChatUnread(userId, chatId) {
    const db = await getDB();
    await db.run(`UPDATE userChats SET unreadCount=0, lastReadAt=?, updatedAt=? WHERE userId=? AND chatId=?`,
        [ts(), ts(), userId, chatId]);
}

export async function updateChatLastMessage(chatId, lastMessage, lastMessageAt) {
    const db = await getDB();
    await db.run(`UPDATE userChats SET lastMessage=?, lastMessageAt=?, updatedAt=? WHERE chatId=?`,
        [lastMessage, lastMessageAt, ts(), chatId]);
}

export async function pinChat(userId, chatId, pinned = true) {
    const db = await getDB();
    await db.run(`UPDATE userChats SET pinned=?, updatedAt=? WHERE userId=? AND chatId=?`,
        [pinned ? 1 : 0, ts(), userId, chatId]);
}

export async function archiveChat(userId, chatId, archived = true) {
    const db = await getDB();
    await db.run(`UPDATE userChats SET archived=?, updatedAt=? WHERE userId=? AND chatId=?`,
        [archived ? 1 : 0, ts(), userId, chatId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUPS
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertGroup(group) {
    const db  = await getDB();
    const now = ts();
    await db.run(`
        INSERT INTO groups (_id, name, description, avatar, adminId, isPrivate, allowInvites, memberCount, createdAt, updatedAt, lastSync)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(_id) DO UPDATE SET
            name=excluded.name, description=excluded.description,
            avatar=excluded.avatar, isPrivate=excluded.isPrivate,
            allowInvites=excluded.allowInvites, memberCount=excluded.memberCount,
            updatedAt=excluded.updatedAt, lastSync=excluded.lastSync
    `, [
        group._id, group.name, group.description ?? null, group.avatar ?? '',
        group.adminId ?? group.admin,
        (group.isPrivate ?? group.settings?.isPrivate) ? 1 : 0,
        (group.allowInvites ?? group.settings?.allowInvites ?? true) ? 1 : 0,
        group.memberCount ?? 1,
        group.createdAt ?? now, group.updatedAt ?? now, now
    ]);
}

export async function getGroup(groupId) {
    return _hydrateGroup(await _selectOne(`SELECT * FROM groups WHERE _id=?`, [groupId]));
}

export async function getUserGroups(userId) {
    const rows = await _selectAll(`
        SELECT g.* FROM groups g
        INNER JOIN groupMembers gm ON gm.groupId=g._id
        WHERE gm.userId=? ORDER BY g.updatedAt DESC
    `, [userId]);
    return rows.map(_hydrateGroup);
}

function _hydrateGroup(row) {
    if (!row) return null;
    return { ...row, isPrivate: !!row.isPrivate, allowInvites: !!row.allowInvites };
}

export async function upsertGroupMember(member) {
    const db = await getDB();
    await db.run(`
        INSERT INTO groupMembers(_id, groupId, userId, role, joinedAt)
        VALUES(?,?,?,?,?)
        ON CONFLICT(groupId, userId) DO UPDATE SET role=excluded.role
    `, [
        member._id ?? `${member.groupId}_${member.userId}`,
        member.groupId, member.userId, member.role ?? 'member', member.joinedAt ?? ts()
    ]);
}

export async function removeGroupMember(groupId, userId) {
    const db = await getDB();
    await db.run(`DELETE FROM groupMembers WHERE groupId=? AND userId=?`, [groupId, userId]);
}

export async function getGroupMembers(groupId) {
    return _selectAll(`SELECT * FROM groupMembers WHERE groupId=? ORDER BY joinedAt ASC`, [groupId]);
}

export async function isGroupMember(groupId, userId) {
    return !!(await _selectOne(
        `SELECT _id FROM groupMembers WHERE groupId=? AND userId=?`, [groupId, userId]));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT: POSTS
// ─────────────────────────────────────────────────────────────────────────────
export async function cachePosts(WernPosts) {
    const now = ts();
    for (const WernPost of WernPosts) await upsertPost(WernPost, now);
}

export async function upsertPost(WernPost, syncTime = null) {
    const db  = await getDB();
    const now = ts();
    await db.run(`
        INSERT INTO WernPosts (
            _id, authorId, authorSnapshot, content, image, imagePublicId,
            video, videoPublicId, location, feeling, mood, energy, burnAt,
            likeCount, commentCount, shareCount, viewCount,
            trendingScore, recentEngagement, lastTrendingCalculation,
            contentHash, zkVerified, isActive, deletedAt, createdAt, updatedAt, lastSync
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(_id) DO UPDATE SET
            authorSnapshot=excluded.authorSnapshot,
            content=excluded.content, image=excluded.image,
            likeCount=excluded.likeCount, commentCount=excluded.commentCount,
            shareCount=excluded.shareCount, viewCount=excluded.viewCount,
            trendingScore=excluded.trendingScore, recentEngagement=excluded.recentEngagement,
            lastTrendingCalculation=excluded.lastTrendingCalculation,
            isActive=excluded.isActive, deletedAt=excluded.deletedAt,
            updatedAt=excluded.updatedAt, lastSync=excluded.lastSync
    `, [
        WernPost._id, WernPost.authorId, j(WernPost.authorSnapshot ?? {}),
        WernPost.content ?? null, WernPost.image ?? null, WernPost.imagePublicId ?? null,
        WernPost.video ?? null, WernPost.videoPublicId ?? null,
        WernPost.location ?? null, WernPost.feeling ?? null, WernPost.mood ?? null, WernPost.energy ?? null,
        WernPost.burnAt ?? null,
        WernPost.likeCount ?? 0, WernPost.commentCount ?? 0, WernPost.shareCount ?? 0, WernPost.viewCount ?? 0,
        WernPost.trendingScore ?? 0, WernPost.recentEngagement ?? 0, WernPost.lastTrendingCalculation ?? now,
        WernPost.contentHash ?? null, WernPost.zkVerified ? 1 : 0, WernPost.isActive !== false ? 1 : 0,
        WernPost.deletedAt ?? null, WernPost.createdAt ?? now, WernPost.updatedAt ?? now, syncTime ?? now
    ]);
    await _enforceRowCap(db, 'WernPosts');
}

export async function getCachedPosts(limit = 50, offset = 0) {
    return (await _selectAll(
        `SELECT * FROM WernPosts WHERE isActive=1 ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [limit, offset]
    )).map(_hydratePost);
}

export async function getTrendingPosts(limit = 20) {
    return (await _selectAll(
        `SELECT * FROM WernPosts WHERE isActive=1 ORDER BY trendingScore DESC, createdAt DESC LIMIT ?`, [limit]
    )).map(_hydratePost);
}

export async function getCachedPost(PostId) {
    return _hydratePost(await _selectOne(`SELECT * FROM WernPosts WHERE _id=?`, [PostId]));
}

export async function getAuthorPosts(authorId, limit = 30) {
    return (await _selectAll(
        `SELECT * FROM WernPosts WHERE authorId=? AND isActive=1 ORDER BY createdAt DESC LIMIT ?`,
        [authorId, limit]
    )).map(_hydratePost);
}

export async function updatePostCounters(PostId, { likeCount, commentCount, shareCount, viewCount } = {}) {
    const db     = await getDB();
    const fields = [];
    const bind   = [];
    if (likeCount    !== undefined) { fields.push('likeCount=?');    bind.push(likeCount); }
    if (commentCount !== undefined) { fields.push('commentCount=?'); bind.push(commentCount); }
    if (shareCount   !== undefined) { fields.push('shareCount=?');   bind.push(shareCount); }
    if (viewCount    !== undefined) { fields.push('viewCount=?');    bind.push(viewCount); }
    if (!fields.length) return;
    fields.push('updatedAt=?');
    bind.push(ts(), PostId);
    await db.run(`UPDATE WernPosts SET ${fields.join(',')} WHERE _id=?`, bind);
}

export async function softDeletePost(PostId) {
    const db = await getDB();
    await db.run(`UPDATE WernPosts SET isActive=0, deletedAt=?, updatedAt=? WHERE _id=?`,
        [ts(), ts(), PostId]);
}

function _hydratePost(row) {
    if (!row) return null;
    return {
        ...row,
        authorSnapshot: p(row.authorSnapshot) ?? {},
        zkVerified:     !!row.zkVerified,
        isActive:       !!row.isActive
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT: LIKES
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertLike(like) {
    const db = await getDB();
    await db.run(`INSERT OR IGNORE INTO likes(_id, PostId, userId, createdAt) VALUES(?,?,?,?)`,
        [like._id ?? `${like.PostId}_${like.userId}`, like.PostId, like.userId, like.createdAt ?? ts()]);
    await _enforceRowCap(db, 'likes');
}

export async function removeLike(PostId, userId) {
    const db = await getDB();
    await db.run(`DELETE FROM likes WHERE PostId=? AND userId=?`, [PostId, userId]);
}

export async function hasLiked(PostId, userId) {
    return !!(await _selectOne(`SELECT _id FROM likes WHERE PostId=? AND userId=?`, [PostId, userId]));
}

export async function getLikeCount(PostId) {
    return (await _scalar(`SELECT COUNT(*) AS n FROM likes WHERE PostId=?`, [PostId])) ?? 0;
}

export async function getUserLikedPostIds(userId, limit = 200) {
    return (await _selectAll(
        `SELECT PostId FROM likes WHERE userId=? ORDER BY createdAt DESC LIMIT ?`, [userId, limit]
    )).map(r => r.PostId);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT: COMMENTS
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertComment(comment) {
    const db  = await getDB();
    const now = ts();
    await db.run(`
        INSERT INTO comments (_id, PostId, userId, content, parentId, likeCount, isActive, deletedAt, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(_id) DO UPDATE SET
            content=excluded.content, likeCount=excluded.likeCount,
            isActive=excluded.isActive, deletedAt=excluded.deletedAt,
            updatedAt=excluded.updatedAt
    `, [
        comment._id, comment.PostId, comment.userId, comment.content, comment.parentId ?? null,
        comment.likeCount ?? 0, comment.isActive !== false ? 1 : 0, comment.deletedAt ?? null,
        comment.createdAt ?? now, comment.updatedAt ?? now
    ]);
    await _enforceRowCap(db, 'comments');
}

export async function getComments(PostId, parentId = null, limit = 50) {
    return (await _selectAll(
        `SELECT * FROM comments WHERE PostId=? AND parentId IS ? AND isActive=1 ORDER BY createdAt ASC LIMIT ?`,
        [PostId, parentId, limit]
    )).map(r => ({ ...r, isActive: !!r.isActive }));
}

export async function deleteComment(commentId) {
    const db = await getDB();
    await db.run(`UPDATE comments SET isActive=0, deletedAt=?, updatedAt=? WHERE _id=?`,
        [ts(), ts(), commentId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT: SHARES
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertShare(share) {
    const db = await getDB();
    await db.run(`INSERT OR IGNORE INTO shares(_id, PostId, userId, shareType, createdAt) VALUES(?,?,?,?,?)`,
        [share._id ?? `${share.PostId}_${share.userId}`, share.PostId, share.userId,
         share.shareType ?? 'reWernPost', share.createdAt ?? ts()]);
    await _enforceRowCap(db, 'shares');
}

export async function removeShare(PostId, userId) {
    const db = await getDB();
    await db.run(`DELETE FROM shares WHERE PostId=? AND userId=?`, [PostId, userId]);
}

export async function hasShared(PostId, userId) {
    return !!(await _selectOne(`SELECT _id FROM shares WHERE PostId=? AND userId=?`, [PostId, userId]));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT: STATUSES (STORIES)
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertStatus(status) {
    const db  = await getDB();
    const now = ts();
    await db.run(`
        INSERT INTO statuses (_id, userId, text, mediaUrl, mediaPublicId, type, visibility,
            durationHours, burnAfterView, viewCount, expiresAt, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(_id) DO UPDATE SET viewCount=excluded.viewCount, updatedAt=excluded.updatedAt
    `, [
        status._id, status.userId, status.text ?? null, status.mediaUrl ?? null,
        status.mediaPublicId ?? null, status.type ?? 'text', status.visibility ?? 'public',
        status.durationHours ?? 24, status.burnAfterView ? 1 : 0, status.viewCount ?? 0,
        status.expiresAt ?? (now + 86400000), status.createdAt ?? now, status.updatedAt ?? now
    ]);
    await _enforceRowCap(db, 'statuses');
}

export async function getActiveStatuses(userId) {
    return _selectAll(
        `SELECT * FROM statuses WHERE userId=? AND expiresAt>? ORDER BY createdAt DESC`, [userId, ts()]);
}

export async function getAllActiveStatuses(limit = 100) {
    return _selectAll(
        `SELECT * FROM statuses WHERE expiresAt>? AND visibility!='private' ORDER BY createdAt DESC LIMIT ?`,
        [ts(), limit]);
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS 
// ─────────────────────────────────────────────────────────────────────────────
export async function cacheNotifications(notifications) {
    for (const n of notifications) await upsertNotification(n);
}

export async function upsertNotification(n) {
    const db = await getDB();
    await db.run(`
        INSERT INTO notifications (
            _id, recipientId, senderId, type, title, body, data,
            isRead, readAt, priority, userDeleted, expiresAt, createdAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)
        ON CONFLICT(_id) DO UPDATE SET isRead=excluded.isRead, readAt=excluded.readAt
    `, [
        n._id, n.recipientId, n.senderId ?? null, n.type, n.title ?? '', n.body ?? '',
        j(n.data ?? {}), n.isRead ? 1 : 0, n.readAt ?? null, n.priority ?? 'medium',
        n.expiresAt ?? null, n.createdAt ?? ts()
    ]);
    await _enforceRowCap(db, 'notifications');
}

export async function getNotifications(recipientId, limit = 50, unreadOnly = false) {
    let sql    = `SELECT * FROM notifications WHERE recipientId=? AND userDeleted=0`;
    const bind = [recipientId];
    if (unreadOnly) { sql += ` AND isRead=0`; }
    sql += ` ORDER BY createdAt DESC LIMIT ?`;
    bind.push(limit);
    return (await _selectAll(sql, bind)).map(r => ({ ...r, isRead: !!r.isRead, data: p(r.data) ?? {} }));
}

export async function getUnreadNotificationsCount(recipientId) {
    return (await _scalar(
        `SELECT COUNT(*) AS n FROM notifications WHERE recipientId=? AND isRead=0 AND userDeleted=0`,
        [recipientId])) ?? 0;
}

export async function markNotificationRead(notificationId) {
    const db = await getDB();
    await db.run(`UPDATE notifications SET isRead=1, readAt=? WHERE _id=?`, [ts(), notificationId]);
}

export async function markAllNotificationsRead(recipientId) {
    const db = await getDB();
    await db.run(`UPDATE notifications SET isRead=1, readAt=? WHERE recipientId=? AND isRead=0`,
        [ts(), recipientId]);
}

/** Hard-delete a single notification immediately. */
export async function deleteNotification(id) { await _del('notifications', '_id', id); }

/** User wipes all their notifications from this device. */
export async function deleteAllNotifications() { await _clearTable('notifications'); }

/** Soft-hide — vanishes from UI instantly, hard-deleted on next flush. */
export async function dismissNotification(id) {
    const db = await getDB();
    await db.run(`UPDATE notifications SET userDeleted=1 WHERE _id=?`, [id]);
}

/** Flush all soft-dismissed rows. Call on app resume or background task. */
export async function flushDismissedNotifications() {
    const db = await getDB();
    await db.run(`DELETE FROM notifications WHERE userDeleted=1`);
}

export async function deleteExpiredNotifications() {
    const db = await getDB();
    await db.run(`DELETE FROM notifications WHERE expiresAt IS NOT NULL AND expiresAt<?`, [ts()]);
}

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE
// ─────────────────────────────────────────────────────────────────────────────
export async function saveBalance(userId, encryptedBalance, balanceIv, sequence) {
    const db = await getDB();
    await db.run(`
        INSERT INTO balance(userId, encryptedBalance, balanceIv, sequence, updatedAt)
        VALUES(?,?,?,?,?)
        ON CONFLICT(userId) DO UPDATE SET
            encryptedBalance = CASE WHEN excluded.sequence > sequence THEN excluded.encryptedBalance ELSE encryptedBalance END,
            balanceIv        = CASE WHEN excluded.sequence > sequence THEN excluded.balanceIv        ELSE balanceIv        END,
            sequence         = MAX(sequence, excluded.sequence),
            updatedAt        = excluded.updatedAt
    `, [userId, encryptedBalance, balanceIv, sequence, ts()]);
}

export async function getBalance(userId) {
    // Returns { userId, encryptedBalance, balanceIv, sequence, updatedAt } — caller decrypts
    return _selectOne(`SELECT * FROM balance WHERE userId=?`, [userId]);
}

export async function deleteBalance(userId) { await _del('balance', 'userId', userId); }

// ─────────────────────────────────────────────────────────────────────────────
// SYNC QUEUE 
// ─────────────────────────────────────────────────────────────────────────────
export async function queueSyncAction(type, payload, options = {}) {
    const db  = await getDB();
    const _id = options.id || crypto.randomUUID();
    await db.run(`
        INSERT OR REPLACE INTO offlineVault
        (_id, type, payload, status, timestamp, retries, optimisticId, priority)
        VALUES(?,?,?,?,?,?,?,?)
    `, [_id, type.toUpperCase(), j(payload), 'pending', ts(), 0,
        options.optimisticId ?? null, options.priority ?? 'normal']);
    await _enforceRowCap(db, 'offlineVault');
    return _id;
}

export async function getPendingActions(limit = 50, priority = null) {
    let sql    = `SELECT * FROM offlineVault WHERE status='pending'`;
    const bind = [];
    if (priority) { sql += ` AND priority=?`; bind.push(priority); }
    sql += ` ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, timestamp ASC LIMIT ?`;
    bind.push(limit);
    return (await _selectAll(sql, bind)).map(r => ({ ...r, payload: p(r.payload) }));
}

export async function updateActionStatus(_id, status, error = null) {
    const db  = await getDB();
    const row = await _selectOne(`SELECT retries, lastAttempt FROM offlineVault WHERE _id=?`, [_id]);
    if (!row) return;
    await db.run(`UPDATE offlineVault SET status=?, lastError=?, retries=?, lastAttempt=? WHERE _id=?`, [
        status, error ?? null,
        status === 'failed' ? (row.retries || 0) + 1 : row.retries,
        status === 'failed' ? ts() : row.lastAttempt,
        _id
    ]);
}

export async function deleteSyncedAction(_id)  { await _del('offlineVault', '_id', _id); }
export const clearSyncedAction                 = deleteSyncedAction;
export const storeOfflineAction                = (type, data) => queueSyncAction(type, data);

export async function getPendingActionsCount() {
    return (await _scalar(`SELECT COUNT(*) AS n FROM offlineVault WHERE status='pending'`)) ?? 0;
}

export async function clearSyncedData() {
    const db = await getDB();
    await db.run(`DELETE FROM offlineVault WHERE status='completed'`);
}

export async function getQueuedActions() {
    return (await _selectAll(`SELECT * FROM offlineVault`)).map(r => ({ ...r, payload: p(r.payload) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE VAULT 
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queue an action for server sync.
 * NEVER writes to WernPosts / messages / likes tables directly.
 * UI must show "pending" indicator until server confirms.
 */
export async function queueOfflineAction(type, payload, options = {}) {
    const db       = await getDB();
    const _id      = options.id || crypto.randomUUID();
    const now      = Date.now();
    const checksum = await generateHMAC(payload);

    await db.run(`
        INSERT OR REPLACE INTO offlineVault
        (_id, type, payload, status, timestamp, checksum, optimisticId, retries, priority)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, 0, ?)
    `, [
        _id,
        type.toUpperCase(),
        JSON.stringify(payload),
        now,
        checksum,
        options.optimisticId || _id,
        options.priority || 'normal'
    ]);

    await _enforceRowCap(db, 'offlineVault');

    return {
        _id,
        optimisticId: options.optimisticId || _id,
        status: 'pending',
        queuedAt: now
    };
}

/**
 * Get next batch of pending actions ready to send.
 * High-priority items go first, then by oldest timestamp.
 */
export async function getPendingSyncBatch(limit = 5) {
    const rows = await _selectAll(`
        SELECT * FROM offlineVault
        WHERE status = 'pending' AND retries < 10
        ORDER BY
            CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
            timestamp ASC
        LIMIT ?
    `, [limit]);

    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

/**
 * Lock action as "syncing" so it isn't picked up again mid-flight.
 */
export async function markActionSyncing(_id) {
    const db = await getDB();
    await db.run(
        `UPDATE offlineVault SET status = 'syncing' WHERE _id = ?`,
        [_id]
    );
}

/**
 * Call ONLY after server returns 200 OK.
 * Promotes the action into the real local table, then deletes the queue entry.
 */
export async function confirmActionSynced(_id, serverId, serverTime) {
    const db = await getDB();

    await db.run(
        `UPDATE offlineVault SET status = 'confirmed', server_time = ? WHERE _id = ?`,
        [serverTime, _id]
    );

    await promoteToLocalTable(db, _id, serverId, serverTime);

    // Clean up immediately — confirmed items have no further use in queue
    await db.run(`DELETE FROM offlineVault WHERE _id = ?`, [_id]);
}

/**
 * Mark action as failed, increment retry counter.
 */
export async function markActionFailed(_id, error) {
    const db = await getDB();
    await db.run(`
        UPDATE offlineVault
        SET status      = 'failed',
            last_error  = ?,
            retries     = retries + 1,
            lastAttempt = ?
        WHERE _id = ?
    `, [String(error), Date.now(), _id]);
}

/**
 * Delete confirmed actions older than maxAgeHours. Run as a cleanup job.
 */
export async function clearConfirmedActions(maxAgeHours = 24) {
    const db     = await getDB();
    const cutoff = Date.now() - maxAgeHours * 3_600_000;
    await db.run(
        `DELETE FROM offlineVault WHERE status = 'confirmed' AND server_time < ?`,
        [cutoff]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMOTE
// ─────────────────────────────────────────────────────────────────────────────

async function promoteToLocalTable(db, localId, serverId, serverTime) {
    const row = await _selectOne(
        `SELECT * FROM offlineVault WHERE _id = ?`,
        [localId]
    );
    if (!row) return;

    const payload = JSON.parse(row.payload);
    const now     = serverTime || Date.now();

    switch (row.type) {

        case 'POST_CREATE': {
            await db.run(`
                INSERT OR IGNORE INTO WernPosts
                (_id, authorId, authorSnapshot, content, image, imagePublicId,
                 likeCount, commentCount, shareCount, viewCount,
                 trendingScore, zkVerified, isActive, createdAt, updatedAt, lastSync)
                VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 1, ?, ?, ?)
            `, [
                serverId,
                payload.authorId,
                JSON.stringify(payload.authorSnapshot || {}),
                payload.content,
                payload.image || null,
                payload.imagePublicId || null,
                payload.createdAt || now,
                now,
                now
            ]);
            break;
        }
        case 'MESSAGE_SEND': {
            await db.run(`
                INSERT OR IGNORE INTO messages
                (_id, senderId, receiverId, chatId, text, image,
                 read, pending, failed, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
            `, [
                serverId,
                payload.senderId,
                payload.receiverId || null,
                payload.chatId,
                payload.text || null,
                payload.image || null,
                now,
                now
            ]);
            break;
        }

        case 'LIKE': {
            await db.run(`
                INSERT OR IGNORE INTO likes (_id, PostId, userId, createdAt)
                VALUES (?, ?, ?, ?)
            `, [serverId, payload.PostId, payload.userId, now]);
            break;
        }

        case 'COMMENT': {
            await db.run(`
                INSERT OR IGNORE INTO comments
                (_id, PostId, userId, content, parentId,
                 likeCount, isActive, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
            `, [
                serverId,
                payload.PostId,
                payload.userId,
                payload.content,
                payload.parentId || null,
                now,
                now
            ]);
            break;
        }

        case 'FOLLOW_REQUEST': {
            await db.run(`
                INSERT OR IGNORE INTO followRequests
                (_id, fromUserId, toUserId, status, createdAt, updatedAt)
                VALUES (?, ?, ?, 'accepted', ?, ?)
            `, [serverId, payload.fromUserId, payload.toUserId, now, now]);
            break;
        }

        default:
            break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIMISTIC FEED 
// ─────────────────────────────────────────────────────────────────────────────

export async function getPendingPosts() {
    const rows = await _selectAll(`
        SELECT
            _id         AS optimisticId,
            type,
            payload,
            status,
            timestamp   AS createdAt,
            retries,
            last_error  AS lastError
        FROM offlineVault
        WHERE type   = 'POST_CREATE'
          AND status IN ('pending', 'syncing', 'failed')
        ORDER BY timestamp DESC
        LIMIT 10
    `);

    return rows.map(r => ({
        ...r,
        ...JSON.parse(r.payload),   
        _isPending: true
    }));
}
// ─────────────────────────────────────────────────────────────────────────────
// DATA CACHE 
// ─────────────────────────────────────────────────────────────────────────────
export async function cacheUserData(userId, data) {
    const db    = await getDB();
    const entry = {
        user: data.user, WernPosts: data.WernPosts || [], conversations: data.conversations || [],
        notifications: data.notifications || [], followers: data.followers || [],
        following: data.following || [], timestamp: ts(), type: 'full'
    };
    await db.run(`INSERT OR REPLACE INTO dataCache(id,userId,data,timestamp,type) VALUES(?,?,?,?,?)`,
        ['current', userId, j(entry), entry.timestamp, 'full']);
    await _saveWebStore(); 
}

export async function loadCachedUserData() {
    const row = await _selectOne(`SELECT data FROM dataCache WHERE id='current'`);
    return row ? p(row.data) : null;
}

export async function isCacheStale(maxAgeHours = 24) {
    const stamp = await _scalar(`SELECT timestamp FROM dataCache WHERE id='current'`);
    if (!stamp) return true;
    return (ts() - stamp) > maxAgeHours * 3_600_000;
}

export async function updateCachedUserData(updates) {
    const cached = await loadCachedUserData();
    if (!cached) return;
    const db      = await getDB();
    const updated = { ...cached, ...updates, timestamp: ts() };
    await db.run(`UPDATE dataCache SET data=?,timestamp=? WHERE id='current'`, [j(updated), updated.timestamp]);
}

export async function cacheIndividualUser(userId, userData) {
    const db = await getDB();
    await db.run(
        `INSERT OR REPLACE INTO dataCache(id, userId, data, timestamp, type) VALUES(?,?,?,?,?)`,
        [`user_${userId}`, userId, j(userData), ts(), 'user']
    );
}

export async function getCachedIndividualUser(userId) {
    const row = await _selectOne(
        `SELECT data FROM dataCache WHERE id=?`, [`user_${userId}`]
    );
    return row ? p(row.data) : null;
}
// ─────────────────────────────────────────────────────────────────────────────
// PENDING UPLOADS
// ─────────────────────────────────────────────────────────────────────────────
export async function savePendingUpload(uploadData) {
    const db  = await getDB();
    const rec = { ...uploadData, id: uploadData.id || crypto.randomUUID(), createdAt: new Date().toISOString(), synced: false };
    await db.run(`INSERT OR REPLACE INTO pendingUploads(id,type,synced,createdAt,data) VALUES(?,?,0,?,?)`,
        [rec.id, rec.type, rec.createdAt, j(rec)]);
    return rec;
}

export async function getPendingUploads() {
    return (await _selectAll(`SELECT data FROM pendingUploads WHERE synced=0`)).map(r => p(r.data));
}

export async function markUploadSynced(id) {
    const db = await getDB();
    await db.run(`UPDATE pendingUploads SET synced=1 WHERE id=?`, [id]);
}

export async function deletePendingUpload(id) { await _del('pendingUploads', 'id', id); }
export async function clearAllPendingUploads() { await _clearTable('pendingUploads'); }

// ─────────────────────────────────────────────────────────────────────────────
// KEY MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function saveChatKey(chatId, keyData) {
    const db = await getDB();
    await db.run(`INSERT OR REPLACE INTO keys(chatId,data,timestamp) VALUES(?,?,?)`,
        [chatId, j(keyData), ts()]);
}

export async function getChatKey(chatId) {
    const row = await _selectOne(`SELECT data FROM keys WHERE chatId=?`, [chatId]);
    return row ? p(row.data) : null;
}

export async function deleteChatKey(chatId) { await _del('keys', 'chatId', chatId); }


//______________________________________________________________________________
//______________________________________________________________________________
export async function nukeAllData() {
    try {
        const db = await getDB();
        // Get every table name
        const result = await db.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        );
        const tables = (result.values || []).map(r => r[0] || r.name).filter(Boolean);
        for (const table of tables) {
            try {
                await db.run(`DELETE FROM "${table}"`);
            } catch (_) {}
        }
        // Also nuke localStorage keys we know about
        const knownKeys = [
            'wt_seed_hash', 'token', 'userId', 'currentUser',
            'authToken', 'wt_auth_token'
        ];
        knownKeys.forEach(k => localStorage.removeItem(k));
        // Platform web: persist the empty state
        if (typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'web') {
            try {
                const { CapacitorSQLite } = await import('@capacitor-community/sqlite');
                await CapacitorSQLite.saveToStore({ database: SECURE_DB_NAME });
            } catch (_) {}
        }
        console.log('[SQLite] nukeAllData: all tables cleared');
    } catch (err) {
        console.warn('[SQLite] nukeAllData failed:', err.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────────────
export async function clearAllAuthData() {
    const db     = await getDB();
    const tables = [
        'dataCache', 'auth', 'offlineVault', 'messages', 'userChats',
        'WernPosts', 'notifications', 'pendingUploads', 'identity', 'identities',
        'users', 'followers', 'followRequests', 'likes', 'comments',
        'shares', 'statuses', 'balance'
    ];
    for (const t of tables) await db.run(`DELETE FROM ${t}`);
    await db.run(`VACUUM`);
}

export async function clearOldCache(maxAgeHours = 24) {
    const db     = await getDB();
    const cutoff = ts() - maxAgeHours * 3_600_000;
    await db.run(`DELETE FROM dataCache WHERE timestamp<? AND id!='current'`, [cutoff]);
    await db.run(`DELETE FROM WernPosts WHERE lastSync<? AND isActive=0`, [cutoff]);
    await db.run(`DELETE FROM statuses WHERE expiresAt<?`, [ts()]);
    await db.run(`DELETE FROM notifications WHERE expiresAt IS NOT NULL AND expiresAt<?`, [ts()]);
    await db.run(`DELETE FROM notifications WHERE userDeleted=1`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE STATUS
// ─────────────────────────────────────────────────────────────────────────────
export async function getDatabaseStats() {
    const capped = Object.keys(ROW_CAPS);
    const uncapped = ['groups', 'groupMembers', 'userChats', 'balance', 'pins', 'salts', 'deviceKeys', 'biometricKeys', 'identities'];
    const stats  = {};

    for (const t of capped) {
        const count = (await _scalar(`SELECT COUNT(*) AS n FROM ${t}`)) ?? 0;
        stats[t] = { count, cap: ROW_CAPS[t].max, pct: Math.round((count / ROW_CAPS[t].max) * 100) };
    }
    for (const t of uncapped) {
        stats[t] = { count: (await _scalar(`SELECT COUNT(*) AS n FROM ${t}`)) ?? 0, cap: null };
    }
    return stats;
}

export async function checkDatabaseHealth() {
    try {
        const stats = await getDatabaseStats();
        return { healthy: true, storeCount: Object.keys(stats).length, stats };
    } catch (error) {
        return { healthy: false, error: error.message };
    }
}

const _openMediaIDB = () => new Promise((resolve, reject) => {
    const req = window.indexedDB.open('wt_media_cache', 1);
    req.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains('offlineMedia')) {
            idb.createObjectStore('offlineMedia', { keyPath: 'id' });
        }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
});

export const saveMediaToIDB = async (mediaKey, dataUrl, mediaType) => {
    const idb = await _openMediaIDB();
    return new Promise((resolve, reject) => {
        const tx = idb.transaction('offlineMedia', 'readwrite');
        tx.objectStore('offlineMedia').put({ id: mediaKey, data: dataUrl, type: mediaType, createdAt: Date.now() });
        tx.oncomplete = () => { idb.close(); resolve(); };
        tx.onerror    = (e) => { idb.close(); reject(e.target.error); };
    });
};

export const getMediaFromIDB = async (mediaKey) => {
    const idb = await _openMediaIDB();
    return new Promise((resolve, reject) => {
        const tx  = idb.transaction('offlineMedia', 'readonly');
        const req = tx.objectStore('offlineMedia').get(mediaKey);
        req.onsuccess = () => { idb.close(); resolve(req.result); };
        req.onerror   = (e) => { idb.close(); reject(e.target.error); };
    });
};
// ─────────────────────────────────────────────────────────────────────────────
// HMAC 
// ─────────────────────────────────────────────────────────────────────────────

async function generateHMAC(payload) {
    try {
        const encoded  = new TextEncoder().encode(JSON.stringify(payload));
        const keyMat   = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode('wt-hmac-key-v1'),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', keyMat, encoded);
        return btoa(String.fromCharCode(...new Uint8Array(sig)));
    } catch (e) {
        console.warn('[HMAC] failed, using fallback checksum:', e);
        return btoa(JSON.stringify(payload)).slice(0, 32);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNC: MongoDB → SQLite  
// These are the only functions that should call the server for reads.
// Everything else reads from SQLite directly.
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_META_KEY = 'last_sync';

export async function getLastSyncTime() {
  const row = await _selectOne(`SELECT data FROM auth WHERE id=?`, [SYNC_META_KEY]);
  if (!row) return null;
  const parsed = p(row.data);
  return parsed?.timestamp ?? null;
}

export async function setLastSyncTime(timestamp = Date.now()) {
  const db = await getDB();
  await db.run(
    `INSERT OR REPLACE INTO auth(id, data) VALUES(?, ?)`,
    [SYNC_META_KEY, j({ timestamp, iso: new Date(timestamp).toISOString() })]
  );
  await _saveWebStore();
}

/**
 * Full sync: pulls everything from MongoDB via the server and writes to SQLite.
 * Call this on login and when user explicitly requests a sync.
 * 
 * @param {string} userId - the current user's _id
 * @param {object} apiInstance - the axios api instance (passed in to avoid circular import)
 * @returns {{ success: boolean, syncedAt: number, error?: string }}
 */
export async function syncFromServer(userId, apiInstance) {
  if (!userId || !apiInstance) {
    return { success: false, error: 'Missing userId or api instance' };
  }

  const syncStart = Date.now();

  try {
    // Pull everything in parallel
    const [
      userRes,
      postsRes,
      chatsRes,
      notifRes,
      followersRes,
      followingRes,
    ] = await Promise.allSettled([
      apiInstance.get(`/users/me`),
      apiInstance.get(`/WernPosts?limit=50`),
      apiInstance.get(`/messages/chats`),
      apiInstance.get(`/notifications?limit=100`),
      apiInstance.get(`/followers/${userId}`),
      apiInstance.get(`/following/${userId}`),
    ]);

    const db = await getDB();

    // ── USER ──────────────────────────────────────────────────────
if (userRes.status === 'fulfilled') {
  const user = userRes.value.data;
  if (user?._id) {
    await upsertUser(user);
    
    // FIX: Force JSON serialization instead of relying on j(user)
    const userStringData = typeof user === 'object' ? JSON.stringify(user) : user;

    await db.run(
      `INSERT OR REPLACE INTO identity(userId, data, updatedAt, synced) VALUES(?,?,?,1)`,
      [user._id, userStringData, Date.now()]
    );
  }
}
    // ── POSTS ─────────────────────────────────────────────────────
    if (postsRes.status === 'fulfilled') {
      const posts = postsRes.value.data?.WernPosts || postsRes.value.data || [];
      if (Array.isArray(posts)) {
        for (const post of posts) {
          await upsertPost(post, syncStart);
        }
      }
    }

    // ── CHATS (last message metadata only) ───────────────────────
    if (chatsRes.status === 'fulfilled') {
      const chats = chatsRes.value.data || [];
      if (Array.isArray(chats)) {
        for (const chat of chats) {
          await upsertUserChat({
            _id:           `${userId}_${chat.chatId}`,
            userId,
            chatId:        chat.chatId,
            partnerId:     chat.User?._id || null,
            partnerType:   chat.type === 'group' ? 'group' : 'user',
            unreadCount:   chat.unreadCount || 0,
            lastMessage:   chat.lastMessage?.text
                             ? String(chat.lastMessage.text)
                             : null,
            lastMessageAt: chat.lastMessage?.createdAt
                             ? new Date(chat.lastMessage.createdAt).getTime()
                             : null,
          });

          // Also cache the partner user
          if (chat.User?._id) {
            await upsertUser(chat.User);
          }
        }
      }
    }

    // ── NOTIFICATIONS ─────────────────────────────────────────────
    if (notifRes.status === 'fulfilled') {
      const notifs = notifRes.value.data?.notifications || notifRes.value.data || [];
      if (Array.isArray(notifs)) {
        for (const n of notifs) {
          await upsertNotification(n);
        }
      }
    }

    // ── FOLLOWERS ─────────────────────────────────────────────────
    if (followersRes.status === 'fulfilled') {
      const followers = followersRes.value.data?.users || [];
      for (const f of followers) {
        if (f._id) {
          await upsertUser(f);
          await upsertFollower({
            _id:        `${f._id}_${userId}`,
            followerId:  f._id,
            followingId: userId,
            createdAt:   Date.now(),
          });
        }
      }
    }

    // ── FOLLOWING ─────────────────────────────────────────────────
    if (followingRes.status === 'fulfilled') {
      const following = followingRes.value.data?.users || [];
      for (const f of following) {
        if (f._id) {
          await upsertUser(f);
          await upsertFollower({
            _id:        `${userId}_${f._id}`,
            followerId:  userId,
            followingId: f._id,
            createdAt:   Date.now(),
          });
        }
      }
    }

    // ── RECORD SYNC TIME ─────────────────────────────────────────
    await setLastSyncTime(syncStart);
    await _saveWebStore();

    return {
      success: true,
      syncedAt: syncStart,
      results: {
        user:      userRes.status,
        posts:     postsRes.status,
        chats:     chatsRes.status,
        notifs:    notifRes.status,
        followers: followersRes.status,
        following: followingRes.status,
      },
    };

  } catch (err) {
    console.error('[syncFromServer] Fatal error:', err);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE MEDIA (SQLite) 
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete offline media by its key from SQLite
 */
export async function deleteOfflineMedia(mediaKey) {
    if (!mediaKey) return;
    try {
        const db = await getDB();
        
        // Try both places where media might be stored
        await db.run(
            `DELETE FROM pendingUploads WHERE id = ? OR data LIKE ?`,
            [mediaKey, `%${mediaKey}%`]
        );
        
        // If you have a dedicated media table
        try {
            await db.run(
                `DELETE FROM offline_media WHERE media_key = ?`,
                [mediaKey]
            );
        } catch (_) {
            // Table might not exist, that's fine
        }
        
        console.log('[SQLite] Deleted offline media:', mediaKey);
    } catch (err) {
        console.warn('[SQLite] Delete offline media failed:', err);
    }
}