import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const tempDir = await mkdtemp(path.join(tmpdir(), 'iwa-ssh-reset-tests-'));

async function assertFileExists(relativePath) {
  const info = await stat(path.join(root, relativePath));
  assert.equal(info.isFile(), true, `${relativePath} should be a file`);
  assert.ok(info.size > 0, `${relativePath} should not be empty`);
}

async function transpile(sourcePath, destName) {
  const source = await readFile(path.join(root, sourcePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      verbatimModuleSyntax: true,
    },
  }).outputText
    .replaceAll('./ConnectionIntent', './ConnectionIntent.mjs')
    .replaceAll('./xtermOptions', './xtermOptions.mjs')
    .replaceAll('./themes', './themes.mjs')
    .replaceAll('./upstreamAssets', './upstreamAssets.mjs');
  await writeFile(path.join(tempDir, destName), output);
}

try {
  await transpile('app/src/connections/ConnectionIntent.ts', 'ConnectionIntent.mjs');
  await transpile('app/src/connections/sshCommandParser.ts', 'sshCommandParser.mjs');
  await transpile('app/src/settings/themes.ts', 'themes.mjs');
  await transpile('app/src/settings/defaults.ts', 'defaults.mjs');
  await transpile('app/src/ssh/upstreamAssets.ts', 'upstreamAssets.mjs');
  await transpile('app/src/ssh/moshGate.ts', 'moshGate.mjs');

  const {
    parseCommand,
    parseSSHDestination,
    parseTerminalConnectionCommand,
  } = await import(path.join(tempDir, 'sshCommandParser.mjs'));
  const {
    connectionIntentFromProfile,
    normalizeConnectionIntent,
    connectionIntentTitle,
  } = await import(path.join(tempDir, 'ConnectionIntent.mjs'));
  const {
    clampScrollback,
    SCROLLBACK_MIN,
    SCROLLBACK_MAX,
    SCROLLBACK_DEFAULT,
  } = await import(path.join(tempDir, 'defaults.mjs'));
  const {
    themeToJson,
    validateThemeJson,
  } = await import(path.join(tempDir, 'themes.mjs'));
  const {
    areMoshAssetsReady,
    checkMoshAssets,
    checkUpstreamAssets,
  } = await import(path.join(tempDir, 'upstreamAssets.mjs'));
  const {
    checkMoshPrerequisites,
  } = await import(path.join(tempDir, 'moshGate.mjs'));

  const stableIntent = (intent) => Object.fromEntries(
    Object.entries(intent).filter(([key, value]) => value !== undefined || !['etPort', 'etSessionId', 'settingsProfileId', 'rawCommand'].includes(key)),
  );

  assert.deepEqual(parseCommand('abc@localhost'), {
    destination: 'abc@localhost',
    argstr: '',
  });
  assert.deepEqual(parseCommand('-4Ao xxx=yyy "abc@a b c@localhost" -o zzz=yyy'), {
    destination: 'abc@a b c@localhost',
    argstr: '-4Ao xxx=yyy  -o zzz=yyy',
  });
  assert.deepEqual(parseCommand('-o abc@localhost'), {
    destination: null,
    argstr: '-o abc@localhost',
  });

  assert.deepEqual(parseSSHDestination('abc@def'), {
    username: 'abc',
    hostname: 'def',
    port: null,
  });
  assert.deepEqual(parseSSHDestination('ssh://abc@def:100'), {
    username: 'abc',
    hostname: 'def',
    port: 100,
  });
  assert.deepEqual(parseSSHDestination('abc@a b c@def'), {
    username: 'abc@a b c',
    hostname: 'def',
    port: null,
  });

  assert.deepEqual(stableIntent(parseTerminalConnectionCommand('ssh user@example.com')), {
    protocol: 'ssh',
    username: 'user',
    hostname: 'example.com',
    port: 22,
    args: [],
    argstr: undefined,
    profileId: undefined,
    identityId: undefined,
    startupCommand: undefined,
    rawCommand: 'ssh user@example.com',
  });
  assert.deepEqual(stableIntent(parseTerminalConnectionCommand('ssh -p 2222 user@example.com')), {
    protocol: 'ssh',
    username: 'user',
    hostname: 'example.com',
    port: 2222,
    args: ['-p', '2222'],
    argstr: '-p 2222',
    profileId: undefined,
    identityId: undefined,
    startupCommand: undefined,
    rawCommand: 'ssh -p 2222 user@example.com',
  });
  assert.deepEqual(stableIntent(parseTerminalConnectionCommand('mosh "abc@a b c@example.com"')), {
    protocol: 'mosh',
    username: 'abc@a b c',
    hostname: 'example.com',
    port: undefined,
    args: [],
    argstr: undefined,
    profileId: undefined,
    identityId: undefined,
    startupCommand: undefined,
    rawCommand: 'mosh "abc@a b c@example.com"',
  });
  assert.deepEqual(stableIntent(parseTerminalConnectionCommand('et user@example.com')), {
    protocol: 'et',
    username: 'user',
    hostname: 'example.com',
    port: 22,
    etPort: 2022,
    args: [],
    argstr: undefined,
    profileId: undefined,
    identityId: undefined,
    startupCommand: undefined,
    rawCommand: 'et user@example.com',
  });

  // Profile -> connection spec round trip preserves connection intent.
  const profile = {
    id: 'p1',
    name: 'box',
    protocol: 'mosh',
    host: 'example.com',
    port: 2222,
    username: 'user',
    identityId: 'id-7',
    connectionArgs: '-o StrictHostKeyChecking=yes',
    startupCommand: 'tmux attach',
  };
  const spec = connectionIntentFromProfile(profile);
  assert.deepEqual(stableIntent(spec), {
    protocol: 'mosh',
    username: 'user',
    hostname: 'example.com',
    port: 2222,
    args: [],
    argstr: '-o StrictHostKeyChecking=yes',
    profileId: 'p1',
    identityId: 'id-7',
    startupCommand: 'tmux attach',
  });
  assert.equal(connectionIntentTitle(spec), 'mosh user@example.com:2222');

  // Profiles without a protocol default to ssh, and port 22 is omitted from the title.
  const sshSpec = connectionIntentFromProfile({
    id: 'p2',
    name: 'plain',
    host: 'host',
    port: 22,
    username: 'me',
  });
  assert.equal(sshSpec.protocol, 'ssh');
  assert.equal(connectionIntentTitle(sshSpec), 'ssh me@host');

  // normalizeConnectionIntent trims, drops empties, and supplies the SSH default port.
  assert.deepEqual(
    stableIntent(normalizeConnectionIntent({
      protocol: 'ssh',
      username: '  me  ',
      hostname: ' host ',
      port: undefined,
      args: ['-A'],
      argstr: '   ',
      profileId: '',
      identityId: undefined,
      startupCommand: '  ls  ',
    })),
    {
      protocol: 'ssh',
      username: 'me',
      hostname: 'host',
      port: 22,
      args: ['-A'],
      argstr: undefined,
      profileId: undefined,
      identityId: undefined,
      startupCommand: 'ls',
    },
  );

  // Scrollback bounds/defaults.
  assert.equal(clampScrollback(SCROLLBACK_MIN - 1), SCROLLBACK_MIN);
  assert.equal(clampScrollback(SCROLLBACK_MAX + 1), SCROLLBACK_MAX);
  assert.equal(clampScrollback(0), SCROLLBACK_MIN);
  assert.equal(clampScrollback(25000), 25000);
  assert.equal(clampScrollback(1234.6), 1235);
  // Empty form fields coerce through Number('') === 0 -> clamped to the floor, not collapsed to 0.
  assert.equal(clampScrollback(Number('')), SCROLLBACK_MIN);
  // Non-finite input (NaN/Infinity) falls back to the default.
  assert.equal(clampScrollback(NaN), SCROLLBACK_DEFAULT);
  assert.equal(clampScrollback(Infinity), SCROLLBACK_DEFAULT);

  const themeJson = themeToJson({
    background: '#000000',
    foreground: '#ffffff',
    brightBlue: 'rgb(1, 2, 3)',
  });
  assert.deepEqual(validateThemeJson(themeJson), {
    background: '#000000',
    foreground: '#ffffff',
    brightBlue: 'rgb(1, 2, 3)',
  });
  assert.throws(
    () => validateThemeJson('{"background": 12}'),
    /Theme key background must be a CSS color string/,
  );
  assert.throws(
    () => validateThemeJson('{"unsupported": "#fff"}'),
    /Unsupported theme key/,
  );

  await assertFileExists('app/upstream/plugin/wasm/ssh.wasm');
  await assertFileExists('app/upstream/plugin/wasm/mosh-client.wasm');
  await assertFileExists('app/upstream/wassh/js/sockets.js');
  const upstreamManifest = JSON.parse(
    await readFile(path.join(root, 'app/upstream/manifest.json'), 'utf8'),
  );
  assert.equal(upstreamManifest.defaultSshWasm, '/upstream/plugin/wasm/ssh.wasm');
  assert.equal(
    upstreamManifest.defaultMoshWasm ?? '/upstream/plugin/wasm/mosh-client.wasm',
    '/upstream/plugin/wasm/mosh-client.wasm',
  );

  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  try {
    const missingMosh = new Set(['/upstream/plugin/wasm/mosh-client.wasm']);
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method, 'HEAD');
      return { ok: !missingMosh.has(String(url)) };
    };
    const upstreamChecks = await checkUpstreamAssets();
    assert.ok(upstreamChecks.length >= 6);
    assert.equal(upstreamChecks.every((entry) => entry.ok), true);
    assert.deepEqual(await checkMoshAssets(), [
      { path: '/upstream/plugin/wasm/mosh-client.wasm', ok: false },
    ]);
    assert.equal(await areMoshAssetsReady(), false);

    globalThis.window = {};
    assert.deepEqual(await checkMoshPrerequisites(), {
      ok: false,
      reason: 'missing-udp',
      message: 'Mosh requires UDPSocket. Install as an IWA with Direct Sockets UDP support.',
    });

    globalThis.window = { UDPSocket: function UDPSocket() {} };
    assert.deepEqual(await checkMoshPrerequisites(), {
      ok: false,
      reason: 'missing-mosh-wasm',
      message: 'Mosh requires /upstream/plugin/wasm/mosh-client.wasm. Run npm run fetch-assets.',
    });

    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method, 'HEAD');
      assert.equal(String(url), '/upstream/plugin/wasm/mosh-client.wasm');
      return { ok: true };
    };
    assert.deepEqual(await checkMoshPrerequisites(), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
} finally {
  await rm(tempDir, { force: true, recursive: true });
}
