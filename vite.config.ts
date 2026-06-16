import { defineConfig, type Plugin } from 'vite';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';

/** Public URL base for copied upstream libapps assets (see scripts/fetch-upstream-assets.mjs). */
const UPSTREAM_BASE = '/upstream';
const WASSH_WORKER_URL = `${UPSTREAM_BASE}/wassh/js/worker.js`;
const UPSTREAM_PLUGIN_BASE = `${UPSTREAM_BASE}/plugin`;

const DEV_HOST = process.env.IWA_SSH_DEV_HOST ?? '127.0.0.1';
const DEV_PORT = Number(process.env.IWA_SSH_DEV_PORT ?? 5173);

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** Load Trusted Types default policy before Vite client / app code (IWA requirement). */
function iwaTrustedTypesFirst(): Plugin {
  const tag = '<script type="module" src="/src/security/trustedTypes.ts"></script>';
  return {
    name: 'iwa-trusted-types-first',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (html.includes('/src/security/trustedTypes.ts')) return html;
        return html.replace('<head>', `<head>\n    ${tag}`);
      },
    },
  };
}

const UPSTREAM_ROOT = resolve(__dirname, 'app/upstream');

const upstreamMimeTypes: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
  '.map': 'application/json',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Serve /upstream/* from app/upstream/ in dev/preview (outside public/ so Vite allows runtime import).
 */
function upstreamStaticDev(): Plugin {
  const serveUpstream: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const pathname = req.url?.split('?')[0] ?? '';
    if (!pathname.startsWith(UPSTREAM_BASE)) return next();

    const rel = pathname.slice(UPSTREAM_BASE.length).replace(/^\/+/, '');
    if (!rel) return next();

    const filePath = path.resolve(UPSTREAM_ROOT, rel);
    if (filePath !== UPSTREAM_ROOT && !filePath.startsWith(`${UPSTREAM_ROOT}${path.sep}`)) {
      return next();
    }
    if (!existsSync(filePath)) return next();

    const stat = statSync(filePath);
    if (!stat.isFile()) return next();

    const ext = path.extname(filePath).toLowerCase();
    for (const [name, value] of Object.entries(crossOriginIsolationHeaders)) {
      res.setHeader(name, value);
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Type', upstreamMimeTypes[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.end();
      return;
    }

    createReadStream(filePath)
      .on('error', () => next())
      .pipe(res);
  };

  return {
    name: 'iwa-upstream-static-dev',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(serveUpstream);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveUpstream);
    },
  };
}

/** Copy libapps runtime tree into dist/ for production IWA and preview. */
function copyUpstreamDist(): Plugin {
  return {
    name: 'iwa-copy-upstream-dist',
    closeBundle() {
      if (!existsSync(UPSTREAM_ROOT)) return;
      cpSync(UPSTREAM_ROOT, resolve(__dirname, 'dist/upstream'), { recursive: true });
    },
  };
}

// xterm 6 is pre-minified; re-minifying breaks the bundle (xtermjs/xterm.js#5800).
export default defineConfig({
  root: 'app',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'app/src'),
    },
  },
  define: {
    __IWA_UPSTREAM_BASE__: JSON.stringify(UPSTREAM_BASE),
    __IWA_WASSH_WORKER_URL__: JSON.stringify(WASSH_WORKER_URL),
    __IWA_PLUGIN_BASE__: JSON.stringify(UPSTREAM_PLUGIN_BASE),
    __IWA_DEFAULT_SSH_WASM__: JSON.stringify(`${UPSTREAM_PLUGIN_BASE}/wasm/ssh.wasm`),
  },
  assetsInclude: ['**/*.wasm'],
  plugins: [upstreamStaticDev(), copyUpstreamDist(), iwaTrustedTypesFirst()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: (id) => id.startsWith('/upstream/'),
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
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    headers: crossOriginIsolationHeaders,
    // Vite overlay/HMR use innerHTML; disable overlay in IWA. Point HMR at 127.0.0.1 for Dev Mode Proxy.
    hmr: {
      host: DEV_HOST,
      port: DEV_PORT,
      clientPort: DEV_PORT,
      protocol: 'ws',
      overlay: false,
    },
  },
  preview: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    headers: crossOriginIsolationHeaders,
  },
});
