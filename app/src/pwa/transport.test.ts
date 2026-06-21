import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalAdapter } from '../terminal/TerminalAdapter';

const mocks = vi.hoisted(() => ({
  bridgeOptions: null as null | { onStatus?: (...args: unknown[]) => void },
}));

vi.mock('../ssh/upstreamAssets', () => ({
  areUpstreamAssetsReady: vi.fn(async () => true),
}));
vi.mock('../ssh/moshGate', () => ({
  checkMoshPrerequisites: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../ssh/NasshCommandBridge', () => ({
  NasshCommandBridge: class {
    constructor(options: { onStatus?: (...args: unknown[]) => void }) {
      mocks.bridgeOptions = options;
    }
    attachTerminal(): void {}
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    dispose(): void {}
  },
}));

import { SshDirectSocketsTransport } from './transport';

const adapter = {
  open: () => {},
  write: () => {},
  onInput: () => ({ dispose: () => {} }),
  onResize: () => ({ dispose: () => {} }),
  focus: () => {},
  dispose: () => {},
  getSize: () => ({ cols: 80, rows: 24 }),
} satisfies TerminalAdapter;

describe('SshDirectSocketsTransport', () => {
  beforeEach(() => {
    mocks.bridgeOptions = null;
  });

  it('preserves disconnect metadata from the nassh bridge', async () => {
    const onStatus = vi.fn();
    const transport = new SshDirectSocketsTransport(
      { protocol: 'ssh', hostname: 'host', username: 'user', args: [] },
      onStatus,
    );
    await transport.connect(adapter);

    mocks.bridgeOptions?.onStatus?.(
      'disconnected',
      'SSH exited with status 255',
      { disconnectReason: 'transport' },
    );

    expect(onStatus).toHaveBeenCalledWith(
      'disconnected',
      'SSH exited with status 255',
      { disconnectReason: 'transport' },
    );
  });
});
