/**
 * Signed Web Bundle configuration for IWA packaging.
 * Used by iwa/build-bundle.mjs (via dynamic import).
 */

export type BundleHeaderOverride = {
  'cross-origin-embedder-policy'?: string;
  'cross-origin-opener-policy'?: string;
  'cross-origin-resource-policy'?: string;
  'content-security-policy'?: string;
};

export type WebBundleConfig = {
  /** Human-readable app name (informational). */
  appName: string;
  /**
   * Web Bundle ID (base32). Derived from signing public key.
   * Run: npm run iwa:update-id
   * Placeholder until first key is generated.
   */
  webBundleId: string;
  /** Matches package.json / manifest version. */
  version: string;
  /** Vite build output directory. */
  distDir: string;
  /** Unsigned bundle output (relative to repo root). */
  unsignedBundle: string;
  /** Signed bundle output (relative to repo root). */
  signedBundle: string;
  /** Encrypted Ed25519 or ECDSA P-256 PEM (gitignored). */
  signingKeyPath: string;
  /** IWA-required response headers embedded in the bundle. */
  headerOverride: BundleHeaderOverride;
};

/**
 * Standard IWA CSP — keep in sync with docs/SECURITY.md.
 *
 * Mirrors Chrome's required IWA baseline. Trusted Types must be turned on with
 * `require-trusted-types-for 'script'` (the directive Chrome enforces on IWAs);
 * `trusted-types default` only allowlists policy names and does NOT enable
 * enforcement on its own. The app registers the `default` policy in
 * app/src/security/trustedTypes.ts.
 */
export const IWA_CSP =
  "base-uri 'none'; default-src 'self'; object-src 'none'; " +
  "frame-src 'self' https: blob: data:; connect-src 'self' https: wss: blob: data:; " +
  "script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https: blob: data:; " +
  "media-src 'self' https: blob: data:; font-src 'self' blob: data:; " +
  "style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types default;";

export const bundleConfig: WebBundleConfig = {
  appName: 'iwa-ssh',
  webBundleId: 'PLACEHOLDER_RUN_wbn-dump-id_AFTER_GENERATING_KEY',
  version: '0.1.1',
  distDir: 'dist',
  unsignedBundle: 'dist/iwa-ssh.unsigned.wbn',
  signedBundle: 'dist/iwa-ssh.swbn',
  signingKeyPath: 'iwa/keys/encrypted_key.pem',
  headerOverride: {
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': IWA_CSP,
  },
};

/**
 * IWA base URL for wbn --baseURL.
 * Replace webBundleId after generating signing keys.
 */
export function isolatedAppOrigin(webBundleId: string): string {
  return `isolated-app://${webBundleId}/`;
}
