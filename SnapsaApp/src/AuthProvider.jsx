import React, {
  createContext, useContext, useState, useEffect,
  useCallback, useRef, useMemo
} from 'react';
import {
  initSQLite, getDB, queueSyncAction, getPendingActionsCount,
  clearSyncedData, upsertUser, getUser, cacheUserData,
  loadCachedUserData, saveAuthToken,
  getAuthToken as getSQLiteAuthToken,
  clearAuthToken as clearSQLiteAuthToken,
  saveUserId, getUserId as getSQLiteUserId,
  clearAuthData as clearSQLiteAuthData,
  getQueuedActions, deleteSyncedAction,
  secureStoreSeed, secureGetSeed, secureClearSeed, verifySeed, queueOfflineAction
} from './SQLite';

import init, {
  decrypt_user_identity,
  decrypt_display_blob,
  decrypt_display_fields
} from '../pkg/ironclad_security';
import {syncEngine} from './syncEngine';

const AuthContext = createContext(null);

/* ============================================================================
 * UTILITIES & HELPERS
 * ==========================================================================*/

/* -------------------------------------------
 * Network Status Manager
 * ----------------------------------------- */
class NetworkManager {
  constructor() {
    this.isOnline = navigator.onLine;
    this.listeners = new Set();
    this.setupListeners();
  }

  setupListeners() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.notifyListeners(true);
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.notifyListeners(false);
    });
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners(online) {
    this.listeners.forEach(cb => cb(online));
  }
}

const networkManager = new NetworkManager();

/* -------------------------------------------
 * Hex -> Uint8Array
 * ----------------------------------------- */
const hexToBytes = (hex) => {
  if (!hex) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
};

/* -------------------------------------------
 * WASM initialization — promise lock prevents double-init race
 * ----------------------------------------- */
let wasmInitialized = false;
let wasmInitPromise = null;
const initializeWasm = async () => {
  if (wasmInitialized) return;
  if (!wasmInitPromise) {
    wasmInitPromise = init().then(() => { wasmInitialized = true; });
  }
  await wasmInitPromise;
};

/* -------------------------------------------
 * Extract identity fields from user object
 * ----------------------------------------- */
const extractEncryptedIdentity = (user) => ({
  encryptedIdentity: user?.encryptedIdentity,
  identityIv: user?.identityIv,
  identitySalt: user?.identitySalt
});

/* -----------------------------------------------------------------
 * VALID ACTION TYPES — whitelist used by queueAction.
 * FIX 4/14: Any caller passing a typo (e.g. 'liek_post') now gets
 * an immediate throw instead of a silent queue that dead-letters
 * after 5 retries (150 s) while the optimistic UI state diverges.
 * ----------------------------------------------------------------- */
const VALID_ACTION_TYPES = new Set([
  'LIKE', 'LIKE_POST',
  'UNLIKE', 'UNLIKE_POST',
  'COMMENT', 'COMMENT_POST', 'NEW_COMMENT_QUEUED', 'QA_ANSWER',
  'FOLLOW', 'FOLLOW_USER',
  'UNFOLLOW', 'UNFOLLOW_USER',
  'MESSAGE', 'SEND_MESSAGE', 'MESSAGE_SEND', 'MESSAGE_EDIT',
  'BURN_MESSAGE', 'SET_BAR', 'MESSAGE_REACT',
  'POST_CREATE', 'CREATE_POST',
  'EDIT_POST', 'DELETE_POST', 'SHARE_POST', 'POLL_VOTE',
  'STATUS_POST', 'UPDATE_STATUS',
  'PIN_MESSAGE',
  'VIEW',
  'CALL_EVENT',
  'IDENTITY_UPDATE',
  // lowercase aliases kept for back-compat
  'like_post', 'unlike_post', 'comment_post', 'follow_user', 'unfollow_user',
  'send_message', 'create_post', 'update_status', 'wt:identityChanged',
]);

/* ----------------------------------------------------------------
 * CORE IDENTITY DECRYPTION
 * ----------------------------------------------------------------*/
const decryptIdentityImpl = async (encryptedData, seed) => {
  try {
    await initializeWasm();
    const storedSeed = seed || await secureGetSeed();
    if (!storedSeed) return null;
    if (!encryptedData?.encryptedIdentity || !encryptedData?.identityIv || !encryptedData?.identitySalt)
      throw new Error('Missing encryption data');

    const decrypted = decrypt_user_identity(
      storedSeed,
      hexToBytes(encryptedData.encryptedIdentity),
      hexToBytes(encryptedData.identityIv),
      hexToBytes(encryptedData.identitySalt)
    );
    try { return JSON.parse(decrypted); } catch { return null; }
  } catch { return null; }
};

/* ----------------------------------------------------------------
 * DISPLAY FIELD DECRYPTION
 * ----------------------------------------------------------------*/
export const decryptDisplayFields = async (userRecord) => {
  if (!userRecord) return { displayName: '', photo: null, coverPhoto: null };

  await initializeWasm();

  let displayName = '';
  let photo       = null;
  let coverPhoto  = null;

 if (userRecord?.displayNameEncrypted && userRecord?.displayNameIv) {
  try {
    const result = decrypt_display_fields(
      hexToBytes(userRecord.displayNameEncrypted),
      hexToBytes(userRecord.displayNameIv)
    );
    // WASM returns a plain string, not JSON
    if (typeof result === 'string') {
      displayName = result.trim();
    } else {
      // Handle if it ever returns an object
      const parsed = JSON.parse(result);
      displayName = parsed?.value || parsed?.displayName || String(parsed) || '';
    }
  } catch (e) {
    console.warn('[decryptDisplayFields] displayName failed:', e);
    displayName = userRecord.displayName || userRecord.name || '';
  }
} else {
    console.warn('[decryptDisplayFields] missing displayName fields on userRecord:', {
      hasEncrypted: !!userRecord?.displayNameEncrypted,
      hasIv:        !!userRecord?.displayNameIv,
    });
  }

  if (userRecord?.avatarEncrypted && userRecord?.avatarIv) {
    try {
      const bytes = decrypt_display_blob(
        hexToBytes(userRecord.avatarEncrypted),
        hexToBytes(userRecord.avatarIv)
      );
      const blob  = new Blob([bytes]);
      photo       = URL.createObjectURL(blob);
    } catch (e) {
      console.warn('[decryptDisplayFields] avatar failed:', e);
    }
  } else {
    console.warn('[decryptDisplayFields] missing avatar fields on userRecord:', {
      hasEncrypted: !!userRecord?.avatarEncrypted,
      hasIv:        !!userRecord?.avatarIv,
    });
  }

  if (userRecord?.coverEncrypted && userRecord?.coverIv) {
    try {
      const bytes = decrypt_display_blob(
        hexToBytes(userRecord.coverEncrypted),
        hexToBytes(userRecord.coverIv)
      );
      const blob  = new Blob([bytes]);
      coverPhoto  = URL.createObjectURL(blob);
    } catch (e) {
      console.warn('[decryptDisplayFields] cover failed:', e);
    }
  }

  return { displayName, photo, coverPhoto };
};

/* ----------------------------------------------------------------
 * BLOB URL CLEANUP HELPER
 * ----------------------------------------------------------------*/
const revokeBlobUrls = (userObj) => {
  if (!userObj) return;
  if (userObj.photo?.startsWith('blob:'))      URL.revokeObjectURL(userObj.photo);
  if (userObj.coverPhoto?.startsWith('blob:')) URL.revokeObjectURL(userObj.coverPhoto);
};

/* ----------------------------------------------------------------
 * TOKEN MANAGEMENT
 * Tokens are stored in memory (_memToken) and SQLite only.
 * localStorage, sessionStorage, and client-written cookies are
 * XSS-readable and have been removed entirely.
 * DEPLOYMENT NOTE: The server MUST send:
 *   Set-Cookie: jwt=<token>; HttpOnly; Secure; SameSite=Strict
 * on every login response so the cookie persists across reloads.
 * Client JS cannot set HttpOnly — that is by design.
 * ----------------------------------------------------------------*/
let _memToken = null;

const setAuthTokenMem = async (token) => {
  if (!token) return;
  _memToken = token;
  await saveAuthToken(token);
};

// NOTE: getAuthToken hydrates _memToken from SQLite as a side-effect.
// Always call this (or ensure doInit has completed) before relying on
// getTokenSync — getTokenSync reads _memToken only and returns null if
// memory has not yet been hydrated (e.g. fresh tab before boot completes).
export const getAuthToken = async () => {
  if (_memToken) return _memToken;
  try {
    const token = await getSQLiteAuthToken();
    if (token) { _memToken = token; return token; }
    return null;
  } catch {
    return null;
  }
};

const clearAuthTokenMem = async () => {
  _memToken = null;
  await clearSQLiteAuthToken();
};

// onAuthSuccess — called by SignupFlow/SigninFlow after successful auth.
// directLogin handles token/userId/seed storage internally; this exists
// for flows that do not go through directLogin.
// TODO: reconcile with directLogin to eliminate duplication — whichever
// path gets updated, the other must stay in sync.
export const onAuthSuccess = async (userData, token, seed) => {
  if (token) await setAuthTokenMem(token);
  if (userData?._id) { localStorage.setItem('userId', userData._id); await saveUserId(userData._id); }
  if (seed) await secureStoreSeed(seed);
};

export { initializeWasm, decryptIdentityImpl as decryptIdentity };

/* ----------------------------------------------------------------
 * buildFullUser — pure function outside the component so it is
 * never re-created on render and carries no stale closure risk.
 * ----------------------------------------------------------------*/
const buildFullUser = (userRecord, relatedData = {}, extra = {}, displayData = {}) => ({
  _id:            userRecord._id,
  zkCommitment:   userRecord.zkCommitment,
  encryptedIdentity: userRecord.encryptedIdentity,
  identityIv:     userRecord.identityIv,
  identitySalt:   userRecord.identitySalt,
  avatarEncrypted:  userRecord.avatarEncrypted,
  avatarIv:  userRecord.avatarIv,
  coverEncrypted:  userRecord.coverEncrypted,
  coverIv:  userRecord.coverIv,
  setupProof:     userRecord.setupProof,
  circuitVersion: userRecord.circuitVersion || '1.0-ZT',
  createdAt:      userRecord.createdAt,
  updatedAt:      userRecord.updatedAt || new Date().toISOString(),
  lastSeen: userRecord.lastSeen
    ? (typeof userRecord.lastSeen === 'string'
        ? userRecord.lastSeen
        : new Date(userRecord.lastSeen).toISOString())
    : new Date().toISOString(),
  isOnline: extra.isOnline ?? (userRecord.isOnline ?? false),
  followers:      userRecord.followers || [],
  following:      userRecord.following || [],
  isAdmin:        userRecord.isAdmin || false,
  ghostMode:      userRecord.ghostMode ?? false,
  founder:        userRecord.founder || false,
  tier:           userRecord.tier || '',
  rank:           userRecord.rank || 'Private',
  clearanceLevel: userRecord.clearanceLevel || 1,
  unit:           userRecord.unit || '',
  coins:          userRecord.coins ?? 0,
  earnings:       userRecord.earnings ?? userRecord.coins ?? 0,
  name:        displayData.displayName || userRecord.name        || userRecord.displayName || '',
  displayName: displayData.displayName || userRecord.displayName || userRecord.name        || '',
  firstName:   displayData.displayName
    ? displayData.displayName.split(' ')[0]
    : userRecord.firstName || (userRecord.name || '').split(' ')[0] || '',
  lastName:    displayData.displayName
    ? displayData.displayName.split(' ').slice(1).join(' ')
    : userRecord.lastName || '',
  photo:      displayData.photo      || null,
  coverPhoto: displayData.coverPhoto || null,
  bio:                    userRecord.bio                || '',
  profession:             userRecord.profession         || '',
  workPlace:              userRecord.workPlace          || '',
  dob:                    userRecord.dob                || null,
  gender:                 userRecord.gender             || '',
  location:               userRecord.location           || userRecord.currentCity || '',
  hometown:               userRecord.hometown           || '',
  university:             userRecord.university         || '',
  universityYear:         userRecord.universityYear     || '',
  highSchool:             userRecord.highSchool         || '',
  highSchoolYear:         userRecord.highSchoolYear     || '',
  primarySchool:          userRecord.primarySchool      || '',
  education:              userRecord.education          || '',
  languages:              userRecord.languages          || [],
  interests:              userRecord.interests          || [],
  hobbies:                userRecord.hobbies            || [],
  work:                   userRecord.work               || [],
  relationshipStatus:     userRecord.relationshipStatus || '',
  customStatus:           userRecord.customStatus       || '',
  followApprovalRequired: userRecord.followApprovalRequired ?? false,
  connectionMode:         userRecord.connectionMode     || 'followers_only',
  identityVisibility:     userRecord.identityVisibility || userRecord.privacySettings?.identityVisibility || 'Everyone',
  lastSeenVisibility:     userRecord.lastSeenVisibility || userRecord.privacySettings?.lastSeenVisibility || 'Everyone',
  privacy:                userRecord.privacy            || userRecord.privacySettings || {},
  badges:                 userRecord.badges             || [],
  privacySettings:        userRecord.privacySettings    || {},
  tierExpiresAt:          userRecord.tierExpiresAt      || null,
  encryptionKeys:         userRecord.encryptionKeys     || { history: [] },
  defcon:                 userRecord.defcon             || { level: 4, appliedAt: new Date().toISOString(), lastAction: extra.lastAction || 'LOGIN' },
  giftInventory:          userRecord.giftInventory      || { crowns: 0, diamonds: 0, flowers: 0, rockets: 0 },
  notifications:          userRecord.notifications      || relatedData.notifications || { unreadCount: 0, recent: [], lastSync: new Date().toISOString() },
  chats:                  userRecord.chats              || { unreadCount: 0, recent: [], lastSync: new Date().toISOString() },
  groups:                 userRecord.groups             || [],
  feed:                   userRecord.feed               || { recent: relatedData.posts || [], lastSync: new Date().toISOString() },
  followRequests:         userRecord.followRequests     || { received: { count: 0, recent: [] }, sent: { count: 0, pendingIds: [] } },
  wallet:                 userRecord.wallet             || { recentTransactions: [], pendingGifts: { incoming: 0, outgoing: 0 } },
  statuses:               userRecord.statuses           || { active: [], viewedRecently: [] },
  security:               userRecord.security           || { activeSessions: [], anomalyScore: 0, lastSecurityCheck: new Date().toISOString(), trustedDevices: [] },
  syncStatus:             userRecord.syncStatus         || { lastFullSync: new Date().toISOString(), pendingActions: [], conflicts: [], lastConflictCheck: new Date().toISOString() },
  posts:                  relatedData.posts             || [],
  conversations:          relatedData.conversations     || [],
});

/* ----------------------------------------------------------------
 * AUTH PROVIDER
 * ----------------------------------------------------------------*/
export const AuthProvider = ({ children }) => {
  const [user,                setUser]                = useState(null);
  const [identity,            setIdentity]            = useState(null);
  const [isAuthenticated,     setIsAuthenticated]     = useState(false);
  const [isOfflineMode,       setIsOfflineMode]       = useState(false);
  const [loading,             setLoading]             = useState(true);
  const [authError,           setAuthError]           = useState(null);
  const [syncStatus,          setSyncStatus]          = useState('idle');
  const [pendingActionsCount, setPendingActionsCount] = useState(0);
  const [lastAuthCheck,       setLastAuthCheck]       = useState(null);
  const [identityDecrypted,   setIdentityDecrypted]   = useState(false);

  const syncIntervalRef        = useRef(null);
  const isSyncingRef           = useRef(false);
  const isBackgroundSyncingRef = useRef(false);
  const isLoggingInRef         = useRef(false);
  const isInitializingRef      = useRef(false);
  const retryTimeoutRef        = useRef(null);

  // FIX 3/14: useRef mirror of isAuthenticated so the processSyncQueue
  // interval callback always reads the current value instead of the
  // stale closure value captured at the time the interval was created.
  const isAuthenticatedRef = useRef(false);
  useEffect(() => { isAuthenticatedRef.current = isAuthenticated; }, [isAuthenticated]);

  const decryptIdentity = useCallback(
    (encryptedData, externalSeed = null) => decryptIdentityImpl(encryptedData, externalSeed),
    []
  );

  const decryptUserDisplayFields = useCallback(
    (userRecord) => decryptDisplayFields(userRecord),
    []
  );

  const decryptUserData = useCallback(async (userRecord, externalSeed = null) => {
    const [identityResult, displayResult] = await Promise.all([
      decryptIdentityImpl(extractEncryptedIdentity(userRecord), externalSeed),
      decryptDisplayFields(userRecord),
    ]);
    return { identity: identityResult, display: displayResult };
  }, []);

  // FIX 1/14: clearAuthData accepts a reason param so voluntary sign-out
  // never shows a misleading "session expired" error.
  const clearAuthData = useCallback(async (reason = 'session_expired') => {
    await clearAuthTokenMem();
    localStorage.removeItem('userId');
    setUser(prev => { revokeBlobUrls(prev); return null; });
    setIdentity(null);
    setIsAuthenticated(false);
    setIsOfflineMode(false);
    setIdentityDecrypted(false);
    setPendingActionsCount(0);
    setLastAuthCheck(null);

    if (reason !== 'voluntary') {
      setAuthError('Session expired. Please log in again.');
    } else {
      setAuthError(null);
    }

    try { await clearSQLiteAuthData(); await secureClearSeed(); }
    catch (err) { console.error('Error clearing auth data:', err); }
  }, []);

  // FIX 4/14: queueAction validates actionType against the whitelist before
  // queuing. An unknown type throws immediately so the caller's optimistic
  // UI update never fires and state stays consistent.
  const queueAction = useCallback(async (actionType, payload, options = {}) => {
    if (!VALID_ACTION_TYPES.has(actionType)) {
      const msg = `[queueAction] Unknown action type: "${actionType}". Add it to VALID_ACTION_TYPES if intentional.`;
      console.error(msg);
      throw new Error(msg);
    }
    const id = await queueSyncAction(actionType, payload, {
      priority: options.priority || 'normal',
      optimisticId: options.optimisticId,
    });
    const count = await getPendingActionsCount();
    setPendingActionsCount(count);
    return id;
  }, []);

  const SYNC_MAX_RETRIES = 5;

  const processSyncQueue = useCallback(async () => {
    // FIX 3/14: read isAuthenticated from ref so interval callbacks always
    // see the current value, not the stale closure from mount time.
    if (!identityDecrypted || isSyncingRef.current || !navigator.onLine || !isAuthenticatedRef.current) return;
    if (retryTimeoutRef.current) { clearTimeout(retryTimeoutRef.current); retryTimeoutRef.current = null; }
    isSyncingRef.current = true;
    setSyncStatus('syncing');
    try {
      const actions = await getQueuedActions();
      if (actions.length === 0) { setSyncStatus('idle'); return; }
      for (const action of actions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
        if ((action.retryCount || 0) >= SYNC_MAX_RETRIES) {
          console.error('[SyncQueue] Dead-lettering action after max retries:', action.type, action._id);
          await deleteSyncedAction(action._id);
          continue;
        }
        try {
          let endpoint, method, body;
          switch ((action.type || '').toUpperCase()) {
            case 'LIKE':
            case 'LIKE_POST':
              endpoint = `/posts/${action.payload.postId || action.payload.WernPostId}/like`;
              method   = 'POST';
              break;
            case 'UNLIKE':
            case 'UNLIKE_POST':
              endpoint = `/posts/${action.payload.postId || action.payload.WernPostId}/unlike`;
              method   = 'DELETE';
              break;
            case 'COMMENT':
            case 'COMMENT_POST':
            case 'NEW_COMMENT_QUEUED':
            case 'QA_ANSWER':
              endpoint = `/posts/${action.payload.postId || action.payload.WernPostId}/comments`;
              method   = 'POST';
              body     = {
                content:     action.payload.content || action.payload.text || action.payload.answer,
                isAnonymous: action.payload.isAnonymous || false,
                isDirect:    action.payload.isDirect    || false,
                parentId:    action.payload.parentId    || null,
              };
              break;
            case 'FOLLOW':
            case 'FOLLOW_USER':
              endpoint = `/users/${action.payload.userId}/follow`;
              method   = 'POST';
              break;
            case 'UNFOLLOW':
            case 'UNFOLLOW_USER':
              endpoint = `/users/${action.payload.userId}/follow`;
              method   = 'DELETE';
              break;
            case 'MESSAGE':
            case 'SEND_MESSAGE':
            case 'MESSAGE_SEND':
              endpoint = `/messages/send/${action.payload.receiverId || action.payload.recipientId}`;
              method   = 'POST';
              body     = action.payload;
              break;
            case 'MESSAGE_EDIT':
              endpoint = `/messages/${action.payload.messageId}`;
              method   = 'PUT';
              body     = { content: action.payload.newContent, edited: action.payload.edited ?? true };
              break;
            case 'BURN_MESSAGE':
              endpoint = `/messages/${action.payload.messageId}`;
              method   = 'DELETE';
              body     = { burnedBy: action.payload.burnedBy };
              break;
            case 'SET_BAR':
              endpoint = `/messages/${action.payload.messageId}`;
              method   = 'PUT';
              body     = { burnAfterRead: true };
              break;
            case 'MESSAGE_REACT':
              endpoint = `/messages/${action.payload.messageId}/react`;
              method   = 'POST';
              body     = { emoji: action.payload.emoji, userId: action.payload.userId };
              break;
            case 'POST_CREATE':
            case 'CREATE_POST':
              endpoint = `/posts`;
              method   = 'POST';
              body     = action.payload.data || action.payload;
              break;
            case 'EDIT_POST':
              endpoint = `/posts/${action.payload.postId}`;
              method   = 'PUT';
              body     = action.payload;
              break;
            case 'DELETE_POST':
              endpoint = `/posts/${action.payload.postId}`;
              method   = 'DELETE';
              break;
            case 'SHARE_POST':
              endpoint = `/posts/share`;
              method   = 'POST';
              body     = { originalPostId: action.payload.postId, shareType: action.payload.shareType };
              break;
            case 'POLL_VOTE':
              endpoint = `/posts/${action.payload.WernPostId}/poll`;
              method   = 'POST';
              body     = { option: action.payload.option, userId: action.payload.userId };
              break;
            case 'STATUS_POST':
            case 'UPDATE_STATUS':
              endpoint = `/statuses`;
              method   = 'POST';
              body     = action.payload;
              break;
            case 'PIN_MESSAGE':
              endpoint = `/chats/${action.payload.chatId}/pin`;
              method   = 'PUT';
              body     = { messageId: action.payload.messageId, action: action.payload.action };
              break;
            case 'VIEW':
              try {
                await fetch(`${import.meta.env.VITE_API_URL}/api/WernPosts/${action.payload.WernPostId}/view`, {
                  method: 'POST', credentials: 'include',
                });
                await deleteSyncedAction(action._id);
              } catch { /* non-critical */ }
              continue;
            case 'CALL_EVENT':
              endpoint = `/calls/log`;
              method   = 'POST';
              body     = action.payload;
              break;
            case 'IDENTITY_UPDATE':
            case 'WT:IDENTITYCHANGED':
              endpoint = `/users/me`;
              method   = 'PUT';
              body     = action.payload;
              break;
            default:
              console.warn('[SyncQueue] Unhandled action type, skipping:', action.type);
              await deleteSyncedAction(action._id);
              continue;
          }
          const res = await fetch(`${import.meta.env.VITE_API_URL}${endpoint}`, {
            method, headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: body ? JSON.stringify(body) : undefined,
          });
          if (res.ok || res.status === 409) await deleteSyncedAction(action._id);
          else if (res.status === 401) throw new Error('Unauthorized');
          else if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
            setSyncStatus('rate-limited');
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            // FIX 13/14: store timeout ref so next processSyncQueue call cancels
            // it — prevents stacked timers building into a request storm.
            // NOTE: this still captures the processSyncQueue closure reference.
            // The proper long-term fix is moving all retry orchestration into
            // syncEngine, which owns its own stable references.
            retryTimeoutRef.current = setTimeout(() => {
              retryTimeoutRef.current = null;
              processSyncQueue();
            }, retryAfter * 1000);
            return;
          } else throw new Error(`HTTP ${res.status}`);
        } catch (err) { console.error('Sync action failed:', err); }
      }
      const remaining = await getPendingActionsCount();
      setPendingActionsCount(remaining);
      setSyncStatus(remaining > 0 ? 'error' : 'idle');
    } catch (err) {
      setSyncStatus('error');
      if (err.message === 'Unauthorized') clearAuthData();
    } finally { isSyncingRef.current = false; }
  }, [clearAuthData, identityDecrypted]);
  // NOTE: isAuthenticated intentionally removed from deps — read via
  // isAuthenticatedRef.current instead to avoid stale closure on interval.

  const fetchComprehensiveUserData = useCallback(async (userId = 'me', bypassIdentityCheck = false) => {
    if (!identityDecrypted && !bypassIdentityCheck) return null;
    if (!navigator.onLine) return null;
    const baseUrl = import.meta.env.VITE_API_URL;
    const endpoints = {
      user:          `/users/${userId}`,
      posts:         `/WernPosts${userId === 'me' ? '' : `?authorId=${userId}`}`,
      messages:      `/messages/chats${userId === 'me' ? '' : `?userId=${userId}`}`,
      notifications: `/notifications${userId === 'me' ? '' : `?userId=${userId}`}`,
    };
    const responses = await Promise.allSettled(
      Object.entries(endpoints).map(([_, url]) =>
        fetch(`${baseUrl}${url}`, { credentials: 'include' })
      )
    );
    const results = {};
    await Promise.all(Object.keys(endpoints).map(async (key, i) => {
      const res = responses[i];
      if (res.status === 'fulfilled' && res.value.ok) {
        try {
          results[key] = await res.value.json();
        } catch (e) {
          console.warn(`[fetchComprehensiveUserData] ${key} JSON parse failed:`, e);
          results[key] = null;
        }
      } else {
        if (res.status === 'fulfilled') {
          console.warn(`[fetchComprehensiveUserData] ${key} returned HTTP ${res.value.status}`);
        }
        results[key] = null;
      }
    }));
    return results;
  }, [identityDecrypted]);

  const cacheUserDataLocal = useCallback(async (data) => {
    try {
      const seed = await secureGetSeed();
      await cacheUserData(data.user._id, {
        user: data.user,
        seedHint: seed ? 'seed_in_secure_storage' : 'no_seed',
        posts: data.posts || [],
        conversations: data.conversations || [],
        notifications: data.notifications || [],
        followers: data.user?.followers || [],
        following: data.user?.following || [],
        timestamp: new Date().toISOString(),
        version: 2,
      });
    } catch (err) { console.error('Failed to cache user data:', err); }
  }, []);

  const loadCachedData = useCallback(async () => {
    try {
      const cached = await loadCachedUserData();
      console.log('[loadCachedData] result:', cached ? `found user ${cached.user?._id}` : 'EMPTY — nothing cached');
      if (!cached) return null;
      const age = Date.now() - new Date(cached.timestamp).getTime();
      if (age > 7 * 24 * 60 * 60 * 1000) console.warn('Cache is older than 7 days');
      return cached;
    } catch { return null; }
  }, []);

  const restoreSessionFromSQLite = useCallback(async () => {
    try {
      const cached = await loadCachedData();
      if (!cached?.user) return false;

      const seed = await secureGetSeed();
      let decryptedIdentity = null;
      let displayData = {};

      if (seed) {
        try {
          const dec = await decryptUserData(cached.user, seed);
          decryptedIdentity = dec.identity;
          displayData = dec.display;
        } catch (e) {
          console.warn('[restoreSessionFromSQLite] decryption failed — using raw cache', e);
        }
      }

      const full = buildFullUser(
        cached.user,
        {
          posts:         cached.posts         || [],
          conversations: cached.conversations || [],
          notifications: cached.notifications || [],
        },
        { isOnline: false, lastAction: 'SQLITE_RESTORE' },
        displayData
      );

      setUser(prev => { revokeBlobUrls(prev); return full; });
      setIdentity(decryptedIdentity);
      setIdentityDecrypted(!!decryptedIdentity);
      setIsAuthenticated(true);
      setIsOfflineMode(!navigator.onLine);
      setLastAuthCheck(Date.now());

      return true;
    } catch (err) {
      console.error('[restoreSessionFromSQLite] failed:', err);
      return false;
    }
  }, [loadCachedData, decryptUserData]);

  const restoreSessionFromCache = useCallback(async () => {
    return restoreSessionFromSQLite();
  }, [restoreSessionFromSQLite]);

  // FIX 6/14: _backgroundSync errors are no longer swallowed — the catch
  // block logs them. The call in doInit adds .catch() for the same reason.
  // FIX 5/14: guarded with isBackgroundSyncingRef to prevent concurrent runs.
  const _backgroundSync = useCallback(async () => {
    if (isBackgroundSyncingRef.current) return;
    isBackgroundSyncingRef.current = true;
    try {
      const data = await fetchComprehensiveUserData('me', true);
      if (!data?.user) return;

      const seed = await secureGetSeed();
      let decryptedIdentity = null;
      let displayData = {};

      if (seed) {
        const dec = await decryptUserData(data.user, seed);
        decryptedIdentity = dec.identity;
        displayData = dec.display;
      }

      const full = buildFullUser(
        data.user,
        {
          posts:         data.posts         || [],
          conversations: data.messages      || [],
          notifications: data.notifications || [],
        },
        { isOnline: !data.user.ghostMode, lastAction: 'BACKGROUND_SYNC' },
        displayData
      );

      setUser(prev => { revokeBlobUrls(prev); return full; });
      if (decryptedIdentity) {
        setIdentity(decryptedIdentity);
        setIdentityDecrypted(true);
      }
      setIsOfflineMode(false);
      setLastAuthCheck(Date.now());

      await cacheUserDataLocal({ ...data, user: full });
      processSyncQueue();

    } catch (err) {
      // FIX 6/14: was silently swallowed — now logged so failures are visible
      console.warn('[_backgroundSync] server unavailable, staying on cached data:', err.message);
    } finally {
      isBackgroundSyncingRef.current = false;
    }
  }, [fetchComprehensiveUserData, decryptUserData, cacheUserDataLocal, processSyncQueue]);

  /* ----------------------------------------------------------------
   * refreshAuthState
   * ----------------------------------------------------------------*/
  const refreshAuthState = useCallback(async (onProgress) => {
    if (isLoggingInRef.current) return;
    onProgress?.(0);
    setLoading(true);
    setAuthError(null);

    const token = await getAuthToken();
    if (!token) {
      const restored = await restoreSessionFromSQLite();
      if (!restored) {
        setIsAuthenticated(false);
        setIdentityDecrypted(false);
      }
      setLoading(false);
      return;
    }

    try {
      onProgress?.(10);
      if (!navigator.onLine) {
        const cached = await loadCachedData();
        if (cached?.user) {
          const seed = await secureGetSeed();
          if (!seed) { await restoreSessionFromCache(); setLoading(false); return; }
          const { identity: dec, display } = await decryptUserData(cached.user, seed);
          if (dec) {
            const full = buildFullUser(
              cached.user,
              { posts: cached.posts, conversations: cached.conversations, notifications: cached.notifications },
              { isOnline: false, lastAction: 'OFFLINE_LOGIN' },
              display
            );
            setUser(prev => { revokeBlobUrls(prev); return full; });
            setIdentity(dec);
            setIdentityDecrypted(true);
            setIsAuthenticated(true);
            setIsOfflineMode(true);
          } else {
            setIsAuthenticated(true); setIdentityDecrypted(false);
            setAuthError('Failed to decrypt identity offline');
          }
        } else {
          setIsAuthenticated(true); setIsOfflineMode(true); setIdentityDecrypted(false);
          setAuthError('Offline mode - limited functionality');
        }
        setLoading(false);
        return;
      }

      onProgress?.(20);
      const cached = await loadCachedData();
      let decryptedIdentity = null;
      let displayData = {};
      const seed = await secureGetSeed();
      let localIdentityDecrypted = false;

      if (cached?.user && seed) {
        const dec = await decryptUserData(cached.user, seed);
        decryptedIdentity = dec.identity;
        displayData = dec.display;
        if (decryptedIdentity) { localIdentityDecrypted = true; setIdentityDecrypted(true); }
      }

      let data;
      try {
        data = await fetchComprehensiveUserData('me', true);
        if (data === null) { setLoading(false); return; }
      } catch {
        const restored = await restoreSessionFromCache();
        setIsOfflineMode(true); setIsAuthenticated(true);
        if (restored) { setIdentityDecrypted(true); setAuthError('Network error - using cached data'); }
        else { setIdentityDecrypted(false); setAuthError('Cannot connect to server'); }
        setLoading(false);
        return;
      }

      if (!data.user) {
        const restored = await restoreSessionFromCache();
        setIsAuthenticated(true); setIsOfflineMode(true);
        if (restored) { setIdentityDecrypted(true); setAuthError('Session expired on server - using cached data.'); }
        else { setIdentityDecrypted(false); setAuthError('Account data unavailable - using offline mode'); }
        setLoading(false);
        return;
      }

      onProgress?.(50);

      if (!decryptedIdentity) {
        if (!seed) {
          setIsAuthenticated(true); setIdentityDecrypted(false);
          setAuthError('Your session key is missing. Please enter your seed to continue.');
          setLoading(false);
          return;
        }
        const dec = await decryptUserData(data.user, seed);
        decryptedIdentity = dec.identity;
        displayData = dec.display;
      } else {
        const freshDisplay = await decryptDisplayFields(data.user);
        displayData = {
          displayName: freshDisplay.displayName || displayData.displayName,
          photo:       freshDisplay.photo       || displayData.photo       || null,
          coverPhoto:  freshDisplay.coverPhoto  || displayData.coverPhoto  || null,
        };
      }

      const fullUser = buildFullUser(
        data.user,
        { posts: data.posts, conversations: data.messages, notifications: data.notifications },
        { isOnline: !data.user.ghostMode, lastAction: 'ONLINE_LOGIN' },
        displayData
      );

      setUser(prev => { revokeBlobUrls(prev); return fullUser; });
      setIdentity(decryptedIdentity);
      setIdentityDecrypted(true); setIsAuthenticated(true);
      setIsOfflineMode(false); setLastAuthCheck(Date.now());

      onProgress?.(80);
      await cacheUserDataLocal({ ...data, user: fullUser });
      if (localIdentityDecrypted || decryptedIdentity) processSyncQueue();
      onProgress?.(100);

    } catch (err) {
      const restored = await restoreSessionFromCache();
      if (restored) {
        setIsOfflineMode(true); setIsAuthenticated(true); setIdentityDecrypted(true);
        setAuthError('Error loading data - using cached version');
      } else {
        setIsAuthenticated(true); setIsOfflineMode(true); setIdentityDecrypted(false);
        setAuthError('Unable to load your data - please try again later');
      }
    } finally {
      setLoading(false);
    }
  }, [
    fetchComprehensiveUserData, loadCachedData, cacheUserDataLocal,
    processSyncQueue, clearAuthData, decryptUserData,
    restoreSessionFromCache, restoreSessionFromSQLite,
  ]);

  /* ----------------------------------------------------------------
   * directLogin
   * Seed MUST come from user input (signup/signin form), never from
   * a server response. Pass it via identityData.seed.
   * ----------------------------------------------------------------*/
 const directLogin = useCallback(async (token, userData, identityData) => {
    if (isLoggingInRef.current) return false;
    isLoggingInRef.current = true;

    try {
        await setAuthTokenMem(token);
        _memToken = token;

        const fullUser = userData.user || userData;
        const userProvidedSeed = identityData?.seed || null;
        let finalIdentity = identityData && !identityData.seed ? identityData : null;
        let displayData = { displayName: '', photo: null, coverPhoto: null };

        await initializeWasm();

        // ── Try provided seed first ──────────────────────────────────────────
        const seedToTry = userProvidedSeed || (await secureGetSeed());

        if (seedToTry) {
            try {
                const dec = await decryptUserData(fullUser, seedToTry);

                if (dec.display?.displayName) displayData.displayName = dec.display.displayName;
                // FIX: Only accept blob URLs from decryption (valid image URLs)
                if (dec.display?.photo && dec.display.photo.startsWith('blob:')) {
                    displayData.photo = dec.display.photo;
                }
                if (dec.display?.coverPhoto && dec.display.coverPhoto.startsWith('blob:')) {
                    displayData.coverPhoto = dec.display.coverPhoto;
                }

                if (!finalIdentity && dec.identity) finalIdentity = dec.identity;

            } catch (e) {
                console.warn('[directLogin] decryption failed:', e);
            }
        }

        // ── Fallback: use plain fields if encrypted ones didn't decrypt ──────
        if (!displayData.displayName) {
            displayData.displayName =
                fullUser.displayName ||
                fullUser.name ||
                fullUser.firstName ||
                'Anonymous';
        }

        // FIX: Guard against encrypted hex strings leaking into photo/coverPhoto
        const isValidImageUrl = (url) => {
            if (!url || typeof url !== 'string') return false;
            return url.startsWith('http') || url.startsWith('blob:') || url.startsWith('/') || url.startsWith('data:image');
        };

        if (!displayData.photo) {
            displayData.photo = isValidImageUrl(fullUser.photoUrl) ? fullUser.photoUrl :
                                isValidImageUrl(fullUser.avatarUrl) ? fullUser.avatarUrl :
                                isValidImageUrl(fullUser.photo) ? fullUser.photo : null;
        }
        if (!displayData.coverPhoto) {
            displayData.coverPhoto = isValidImageUrl(fullUser.coverUrl) ? fullUser.coverUrl :
                                     isValidImageUrl(fullUser.coverPhoto) ? fullUser.coverPhoto : null;
        }

        const uid = userData._id || fullUser._id;
        if (uid) {
            localStorage.setItem('userId', uid);
            await saveUserId(uid);
        }

        if (userProvidedSeed) {
            await secureStoreSeed(userProvidedSeed);
            const seedIsValid = await verifySeed(userProvidedSeed);
            if (!seedIsValid) {
                console.warn('[directLogin] seed hash mismatch — first-login expected, continuing');
            }
        }

        const completeUser = buildFullUser(
            fullUser,
            {},
            { isOnline: !fullUser.ghostMode, lastAction: 'DIRECT_LOGIN' },
            displayData
        );

        await cacheUserData(completeUser._id, {
            user: completeUser,
            seedHint: userProvidedSeed ? 'seed_in_secure_storage' : 'no_seed',
            posts: [],
            conversations: [],
            notifications: [],
            followers: completeUser.followers || [],
            following: completeUser.following || [],
            timestamp: new Date().toISOString(),
            version: 2,
        });

        setUser(prev => { revokeBlobUrls(prev); return completeUser; });
        setIdentity(finalIdentity);
        setIdentityDecrypted(!!finalIdentity);
        setIsAuthenticated(true);
        setIsOfflineMode(false);
        setLoading(false);
        setAuthError(null);
        setLastAuthCheck(Date.now());

        return true;
    } catch (err) {
        setAuthError(err.message);
        return false;
    } finally {
        isLoggingInRef.current = false;
    }
}, [decryptUserData]);

  const loginWithSeed = useCallback(async (inputSeed) => {
    if (isLoggingInRef.current) throw new Error('Login already in progress');
    isLoggingInRef.current = true;
    try {
      const cached = await loadCachedData();
      if (!cached?.user) throw new Error('No cached identity found');
      const isValid = await verifySeed(inputSeed);
      if (!isValid) throw new Error('Invalid seed - does not match stored hash');
      await secureStoreSeed(inputSeed);
      const { identity: dec, display } = await decryptUserData(cached.user, inputSeed);
      if (!dec) throw new Error('Invalid seed - decryption failed');
      if (!cached.user.zkCommitment) throw new Error('No ZK commitment found in cached user');
      const full = buildFullUser(
        cached.user,
        { posts: cached.posts, conversations: cached.conversations, notifications: cached.notifications },
        { isOnline: false, lastAction: 'OFFLINE_LOGIN' },
        display
      );
      setUser(prev => { revokeBlobUrls(prev); return full; });
      setIdentity(dec);
      setIdentityDecrypted(true); setIsAuthenticated(true);
      setIsOfflineMode(true); setLoading(false);
      return full;
    } finally {
      isLoggingInRef.current = false;
    }
  }, [decryptUserData, loadCachedData]);

  const likePost = useCallback(async (postId) => {
    if (!user?._id) return;
    setUser(prev => ({
      ...prev,
      posts: prev.posts?.map(p =>
        p._id === postId ? { ...p, likes: [...(p.likes || []), prev._id], likeCount: (p.likeCount || 0) + 1 } : p
      ),
    }));
    if (!navigator.onLine) { await queueAction('LIKE_POST', { postId }); return; }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/posts/${postId}/like`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to like');
    } catch { await queueAction('LIKE_POST', { postId }); }
  }, [user?._id, queueAction]);

  const createPost = useCallback(async (content, image = null) => {
    if (!user?._id) return;
    const tempId = crypto.randomUUID();
    const optimistic = { _id: tempId, content, image, authorId: user._id, createdAt: new Date().toISOString(), likes: [], likeCount: 0, comments: [], commentCount: 0, pending: true };
    setUser(prev => ({ ...prev, posts: [optimistic, ...(prev.posts || [])] }));
    if (!navigator.onLine) { await queueAction('CREATE_POST', { content, image, tempId }, { optimisticId: tempId }); return; }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ content, image }) });
      if (res.ok) { const p = await res.json(); setUser(prev => ({ ...prev, posts: prev.posts.map(x => x._id === tempId ? { ...p, pending: false } : x) })); }
      else throw new Error('Failed to create post');
    } catch { await queueAction('CREATE_POST', { content, image, tempId }, { optimisticId: tempId }); }
  }, [user?._id, queueAction]);

  const sendMessage = useCallback(async (chatId, text, receiverId) => {
    if (!user?._id) return;
    const tempId = crypto.randomUUID();
    if (!navigator.onLine) {
      await queueAction('SEND_MESSAGE', { chatId, text, receiverId, tempId });
      setUser(prev => {
        const convs = prev.conversations || [];
        const idx = convs.findIndex(c => c.chatId === chatId);
        if (idx < 0) return prev;
        const updated = [...convs];
        updated[idx].messages = [...(updated[idx].messages || []), { _id: tempId, text, senderId: user._id, pending: true, createdAt: new Date().toISOString() }];
        return { ...prev, conversations: updated };
      });
    } else {
      try {
        await fetch(`${import.meta.env.VITE_API_URL}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ chatId, text, receiverId }) });
      } catch { await queueAction('SEND_MESSAGE', { chatId, text, receiverId, tempId }); }
    }
  }, [user?._id, queueAction]);

  // FIX 1/14: pass 'voluntary' so clearAuthData does not set "session expired"
  const signOut = useCallback(async () => {
    try { await fetch(`${import.meta.env.VITE_API_URL}/auth/signout`, { method: 'POST', credentials: 'include' }); }
    catch (err) { console.error('Sign out error:', err); }
    await secureClearSeed();
    await clearAuthData('voluntary');
    setIdentityDecrypted(false);
    window.dispatchEvent(new CustomEvent('auth-logout'));
  }, [clearAuthData]);

  /* ----------------------------------------------------------------
   * Effects
   * ----------------------------------------------------------------*/

 useEffect(() => {
    const doInit = async () => {
        if (isInitializingRef.current) return;
        isInitializingRef.current = true;
        console.log('[doInit] starting...');

        try {
            console.log('[doInit] step 1: init SQLite');
            await initSQLite();
            console.log('[doInit] SQLite ready');

            // Step 2: Load token from SQLite into memory
            const token = await getAuthToken();
            if (token) {
                _memToken = token;
                console.log('[doInit] Token hydrated from SQLite');
            }

            // Step 3: Restore cached user data (for instant UI)
            console.log('[doInit] step 3: restoring from SQLite...');
            const restoredOffline = await restoreSessionFromSQLite();
            console.log('[doInit] restoreSessionFromSQLite result:', restoredOffline);

            if (restoredOffline) {
                  setLoading(false);

                  if (navigator.onLine && token) {
                      // Skip verify — just sync fresh data in background
                      // Auth is ONLY cleared by explicit signOut()
                      setIsAuthenticated(true);
                      setIsOfflineMode(false);
                      setLastAuthCheck(Date.now());
                      _backgroundSync().catch(err =>
                          console.warn('[doInit] background sync failed:', err.message)
                      );
                  } else if (!navigator.onLine) {
                      setIsOfflineMode(true);
                      setIsAuthenticated(true);
                  } else {
                      // Has cache but no token — keep session alive from cache
                      setIsAuthenticated(true);
                      setIsOfflineMode(true);
                  }
                  return;
              }

            // No cached data — not logged in
            console.log('[doInit] No cached session found');
            setIsAuthenticated(false);
            setLoading(false);

        } catch (err) {
            console.error('[doInit] failed:', err);
            setLoading(false);
        } finally {
            isInitializingRef.current = false;
        }
    };

    doInit();
}, []);

  useEffect(() => {
    if (isAuthenticated && !isOfflineMode) {
      syncEngine.start();
      syncIntervalRef.current = setInterval(() => {
        processSyncQueue();
      }, 30000);
      processSyncQueue();
    }
    return () => {
      syncEngine.stop();
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [isAuthenticated, isOfflineMode, processSyncQueue]);

  // FIX 7/14: debounce raised from 10 s to 30 s to prevent rapid
  // online/offline cycling from hammering the server on flaky networks.
  useEffect(() => {
    const unsubscribe = networkManager.subscribe(async (online) => {
      if (online) {
        const timeSinceLastCheck = Date.now() - (lastAuthCheck || 0);
        if (timeSinceLastCheck > 30000) {
          setIsOfflineMode(false);
          await refreshAuthState();
        }
      } else {
        setIsOfflineMode(true);
        const cached = await loadCachedData();
        if (cached && user) {
          setUser(prev => ({ ...prev, ...cached.user, posts: cached.posts }));
        }
      }
    });
    return unsubscribe;
  }, [refreshAuthState, loadCachedData, user, lastAuthCheck]);

  /* ----------------------------------------------------------------
   * Context value
   * FIX 2/14: debugInfo.storageCheck updated to reflect the new
   * storage model — localStorage/sessionStorage/cookie are no longer
   * written and will always show false; replaced with SQLite indicator.
   * ----------------------------------------------------------------*/
  const value = useMemo(() => ({
    user, identity, isAuthenticated, isOfflineMode, loading, authError,
    syncStatus, pendingActionsCount, lastAuthCheck, identityDecrypted,
    refreshAuthState, directLogin, loginWithSeed, signOut,
    queueAction, processSyncQueue,
    likePost, createPost, sendMessage,
    getCachedData: loadCachedData,
    isOnline: () => navigator.onLine,
    getAuthToken, setAuthToken: setAuthTokenMem, clearAuthToken: clearAuthTokenMem,
    decryptDisplayFields,
    debugInfo: {
      hasIdentity: !!identity,
      identityKeys: identity ? Object.keys(identity) : [],
      identityDecrypted,
      cacheStatus: syncStatus,
      lastCheck: lastAuthCheck,
      // FIX 2/14: reflect actual storage model — token is memory + SQLite only.
      // localStorage/sessionStorage/cookie entries are never written by this
      // client; those checks have been removed to avoid misleading false values.
      storageCheck: {
        memToken:  !!_memToken,
        // SQLite token presence is async — this flag is a best-effort snapshot
        // based on whether _memToken was hydrated (which only happens after
        // getAuthToken() resolves, i.e. after doInit completes).
        sqliteHydrated: !!_memToken,
      },
    },
  }), [
    user, identity, isAuthenticated, isOfflineMode, loading, authError,
    syncStatus, pendingActionsCount, lastAuthCheck, identityDecrypted,
    refreshAuthState, directLogin, loginWithSeed, signOut,
    queueAction, processSyncQueue, likePost, createPost, sendMessage, loadCachedData,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/* ----------------------------------------------------------------
 * HOOKS
 * ----------------------------------------------------------------*/
export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

// FIX 9/14: useUser documents the merge behaviour explicitly.
// identity keys silently win over user keys on overlap (e.g. _id, name).
// Callers needing both without override risk should destructure
// { user, identity } from useAuth() directly.
export const useUser     = () => { const { user, identity } = useAuth(); return { ...user, ...identity }; };
export const useIdentity = () => useAuth().identity;
export const useOffline  = () => {
  const { isOfflineMode, syncStatus, pendingActionsCount, queueAction } = useAuth();
  return { isOfflineMode, syncStatus, pendingActionsCount, queueAction };
};

// FIX 11/14: getTokenSync reads _memToken only. It returns null if called
// before doInit has completed (e.g. a fresh tab where getAuthToken() has
// not yet hydrated memory from SQLite). All interceptors and request
// handlers must ensure doInit has resolved before using this function.
// For async contexts, prefer getAuthToken() which also checks SQLite.
// FIX 8/14: cross-tab staleness is a known limitation — _memToken is
// module-level and does not sync across tabs. Each tab hydrates its own
// copy from SQLite on boot via getAuthToken(). There is no fix for this
// within AuthContext; a BroadcastChannel or shared worker would be needed.
export const getTokenSync = () => {
  if (!_memToken) {
    console.warn(
      '[getTokenSync] called before memory was hydrated. ' +
      'Ensure doInit (and getAuthToken) has completed before using sync token access.'
    );
  }
  return _memToken || null;
};