import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalAdapter } from '../terminal/TerminalAdapter';

const mocks = vi.hoisted(() => ({
  bridgeOptions: null as null | { onStatus?: (...args: unknown[]) => void },
  et: {
    connectResolve: null as (() => void) | null,
    connectReject: null as ((error: Error) => void) | null,
    onInputCalls: 0,
    inputDispose: vi.fn(),
    resizeDispose: vi.fn(),
    controller: {
      connect: vi.fn(() => new Promise<void>((resolve, reject) => {
        mocks.et.connectResolve = resolve;
        mocks.et.connectReject = reject;
      })),
      sendInput: vi.fn(),
      resize: vi.fn(),
      disconnect: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
  },
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
vi.mock('../et/bootstrap', () => ({
  createEtSession: vi.fn(async () => 'session-id'),
}));
vi.mock('../et/EtWorkerController', () => ({
  createEtWorkerController: vi.fn(() => mocks.et.controller),
}));

import { EtDirectSocketsTransport, SshDirectSocketsTransport } from './transport';

const adapter = {
  open: () => {},
  write: () => {},
  onInput: vi.fn(() => {
    mocks.et.onInputCalls += 1;
    return { dispose: mocks.et.inputDispose };
  }),
  onResize: vi.fn(() => ({ dispose: mocks.et.resizeDispose })),
  focus: () => {},
  dispose: () => {},
  getSize: () => ({ cols: 80, rows: 24, widthPx: 960, heightPx: 576 }),
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

describe('EtDirectSocketsTransport', () => {
  beforeEach(() => {
    mocks.et.onInputCalls = 0;
    mocks.et.inputDispose.mockReset();
    mocks.et.resizeDispose.mockReset();
    mocks.et.controller.connect.mockClear();
    mocks.et.controller.sendInput.mockClear();
    mocks.et.controller.resize.mockClear();
    mocks.et.connectResolve = null;
    mocks.et.connectReject = null;
    vi.mocked(adapter.onInput).mockClear();
    vi.mocked(adapter.onResize).mockClear();
  });

  it('registers terminal input before ET connect resolves', async () => {
    const onStatus = vi.fn();
    const transport = new EtDirectSocketsTransport(
      { protocol: 'et', hostname: 'host', username: 'user', args: [], etSessionId: 'existing-session' },
      onStatus,
    );
    const connecting = transport.connect(adapter);

    expect(mocks.et.onInputCalls).toBe(1);
    expect(adapter.onResize).toHaveBeenCalledOnce();
    expect(mocks.et.controller.connect).toHaveBeenCalledOnce();

    mocks.et.connectResolve?.();
    await connecting;
    expect(mocks.et.controller.resize).toHaveBeenCalledWith(adapter.getSize());
  });

  it('disposes input subscriptions when connect fails', async () => {
    const onStatus = vi.fn();
    const transport = new EtDirectSocketsTransport(
      { protocol: 'et', hostname: 'host', username: 'user', args: [], etSessionId: 'existing-session' },
      onStatus,
    );
    const connecting = transport.connect(adapter);
    mocks.et.connectReject?.(new Error('ET connect failed'));

    await expect(connecting).rejects.toThrow('ET connect failed');
    expect(mocks.et.inputDispose).toHaveBeenCalledOnce();
    expect(mocks.et.resizeDispose).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith('error', 'ET connect failed');
  });

  it('drops duplicate Restty auto-replies while forwarding keyboard input', async () => {
    const onStatus = vi.fn();
    const transport = new EtDirectSocketsTransport(
      { protocol: 'et', hostname: 'host', username: 'user', args: [], etSessionId: 'existing-session' },
      onStatus,
    );
    const connecting = transport.connect(adapter);
    mocks.et.connectResolve?.();
    await connecting;

    const handler = vi.mocked(adapter.onInput).mock.calls.at(-1)?.[0] as (data: string) => void;
    handler('\x1b_Gi=1;OK\x1b\\');
    handler('echo hi\r');
    expect(mocks.et.controller.sendInput).toHaveBeenCalledTimes(1);
    expect(mocks.et.controller.sendInput).toHaveBeenCalledWith('echo hi\r');
  });
});
