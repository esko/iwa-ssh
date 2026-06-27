#!/usr/bin/env node
/**
 * Print Chrome CLI flags to install Gosh (or any URL) via Dev Mode Proxy.
 * Chrome must be fully quit before launching with these flags.
 *
 * Usage:
 *   node scripts/install-iwa-dev.mjs
 *   node scripts/install-iwa-dev.mjs http://127.0.0.1:8765/
 */

const url = process.argv[2] ?? `http://127.0.0.1:${process.env.GOSH_DEV_PORT || 5173}/`;

console.log(`Install URL: ${url}\n`);
console.log('1. Quit all Chrome windows');
console.log('2. Start your dev server (npm run dev)');
console.log('3. Run ONE of:\n');
console.log(`   google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \\
     --install-isolated-web-app-from-url=${url}\n`);
console.log('   — or —\n');
console.log('   chrome://web-app-internals → Install IWA with Dev Mode Proxy');
console.log(`   → paste ${url}\n`);
console.log('References:');
console.log('  Kitchen Sink  https://github.com/chromeos/iwa-sink');
console.log('  Telnet client https://github.com/GoogleChromeLabs/telnet-client');
console.log('  Direct Sockets https://developer.chrome.com/docs/iwa/direct-sockets');
console.log('');
console.log('Manifest: /.well-known/manifest.webmanifest');
console.log('permissions_policy: cross-origin-isolated, direct-sockets,');
console.log('  direct-sockets-private, local-network, loopback-network (all ["self"])');
console.log('See https://developer.chrome.com/docs/iwa/direct-sockets');
