// src/main-snapsa.jsx
// ─── Standalone Snapsa entry point ───────────────────────────────────
// Used when VITE_SNAPSA_ONLY=true (separate Render service).
// Renders ONLY SnapsaStandalone — no WernTjat router, no AuthProvider,
// no BiometricGateway.  Auth is handled entirely inside SnapsaStandalone.

import React from 'react';
import ReactDOM from 'react-dom/client';
import SnapsaStandalone from './SnapsaStandalone';

// Import shared global styles (Tailwind base, fonts, etc.)
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SnapsaStandalone />
  </React.StrictMode>
);
