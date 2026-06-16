import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// xterm 6 is pre-minified; re-minifying breaks the bundle (xtermjs/xterm.js#5800).
export default defineConfig({
  root: 'app',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'app/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@xterm/')) {
            return 'xterm';
          }
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-search', '@xterm/addon-clipboard'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
