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
    allowedHosts: ['snapsa.onrender.com'],
  },
  preview: {
    allowedHosts: ['snapsa.onrender.com'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // WASM files need to be handled correctly
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'framer-motion'],
          icons: ['lucide-react'],
        },
      },
    },
  },
  // Ensure WASM files are treated as assets
  assetsInclude: ['**/*.wasm'],
  // ❌ The manually hardcoded 'define' block has been removed 
});