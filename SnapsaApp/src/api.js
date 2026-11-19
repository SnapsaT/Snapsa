import axios from 'axios';
import { getAuthToken } from './SQLite.js'; // from SQLite, not AuthProvider

const API_URL = (import.meta.env.VITE_API_URL || 'https://werntjat-server.onrender.com/api').trim();

const AUTH_WHITELIST = [
  '/auth/signup',
  '/auth/zksigninchallenge',
  '/auth/zksigninverify',
  '/health',
];

const isAuthEndpoint = (url = '') => {
  const clean = url.split('?')[0];
  return AUTH_WHITELIST.some(path => clean.endsWith(path) || clean.includes(path));
};

export const authEvents = {
  _listeners: {},
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => this.off(event, fn);
  },
  off(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(l => l !== fn);
  },
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => {
      try { fn(data); } catch (e) { console.error('authEvents error:', e); }
    });
  },
};

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// ── REQUEST: attach token from SQLite on every non-auth write ────
api.interceptors.request.use(
  async (config) => {
    if (isAuthEndpoint(config.url)) return config;

    try {
      const token = await getAuthToken(); // reads from SQLite auth table
      if (token) {
        config.headers = config.headers || {};
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (err) {
      console.warn('[api] Token read failed:', err.message);
    }

    return config;
  },
  (error) => Promise.reject(error)
);

// ── RESPONSE: handle 401 globally ───────────────────────────────
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);

    if (!error.response) {
      console.warn('[api] Network error:', error.message);
      return Promise.reject(error);
    }

    const { status } = error.response;
    const url = error.config?.url || '';

    if (status === 401) {
      console.warn('[api] 401 on:', url);
      authEvents.emit('auth:logout', { reason: 'unauthorized', url });
    }

    if (status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '30', 10);
      error.retryAfter = retryAfter;
    }

    return Promise.reject(error);
  }
);

export { api };
export default api;