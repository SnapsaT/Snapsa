// src/safeError.js — what people are allowed to read when something goes wrong.
// A technical network message (server address, DNS, "failed to fetch" …) is NEVER shown: it becomes "You have lost connection."
// Any other message that still contains a web address becomes a plain "Something went wrong."
export const LOST_CONNECTION = 'You have lost connection.';
const NET = /onrender\.com|resolve host|No address associated|ENOTFOUND|ECONN|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Failed to fetch|NetworkError|Network request failed|network error|Load failed|timed out|timeout|socket|SSL|certificate|offline|internet|unreachable|connection (was )?(lost|reset|refused|closed|aborted)|software caused|UnknownHost|UnresolvedAddress/i;
export const friendlyError = (m) => {
  if (typeof m !== 'string') return m;
  if (NET.test(m)) return LOST_CONNECTION;
  if (/https?:\/\/|\b[a-z0-9-]+\.(com|io|net|org|app|dev|co\.za)\b/i.test(m)) return 'Something went wrong. Please try again.';
  return m;
};
