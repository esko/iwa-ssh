/// <reference types="vite/client" />

/** Injected by vite.config.ts — paths into app/upstream/ after fetch-assets. */
declare const __IWA_UPSTREAM_BASE__: string;
declare const __IWA_WASSH_WORKER_URL__: string;
declare const __IWA_PLUGIN_BASE__: string;
declare const __IWA_DEFAULT_SSH_WASM__: string;

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '@xterm/xterm/css/xterm.css';

/** Runtime ES modules under app/public/upstream/ (loaded via @vite-ignore, not bundled). */
declare module '/upstream/*';
