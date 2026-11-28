import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4040,
    host: true,
    allowedHosts: ['snapsa-ahdb.onrender.com'],
  }, 
  preview: {
  host: true,             // ← ADD THIS
  port: 4173,             // ← Good to be explicit
  allowedHosts: ['snapsa-ahdb.onrender.com'],
},
  build: {
    outDir: 'dist',
    sourcemap: false,   // maps are never used by the app, and they were being packed into the APK
    // WASM files need to be handled correctly
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'framer-motion'],
          icons: ['lucide-react'],
          i18n: ['i18next', 'react-i18next'],
        },
      },
    },
  },
  // Ensure WASM files are treated as assets
  assetsInclude: ['**/*.wasm'],
  // ❌ The manually hardcoded 'define' block has been removed 
});
