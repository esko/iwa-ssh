import { describe, expect, it, vi } from 'vitest';
import type { SessionStatusMeta } from '../settings/types';
import { NasshCommandBridge } from './NasshCommandBridge';

type ExitHarness = {
  handleExit(code: number, source: 'nassh' | 'nassh-exit' | 'wassh'): void;
  ioShim: { dispose(): void } | null;
  resizeSubscription: { dispose(): void } | null;
  hostKeyGuard: { reset(): void } | null;
};

describe('NasshCommandBridge exit lifecycle', () => {
  it('reports a transport exit once and releases terminal subscriptions', () => {
    const statuses: Array<{ status: string; error?: string; meta?: SessionStatusMeta }> = [];
    const bridge = new NasshCommandBridge({
      host: 'host',
      port: 22,
      username: 'user',
      onStatus: (status, error, meta) => statuses.push({ status, error, meta }),
    });
    const harness = bridge as unknown as ExitHarness;
    const disposeIo = vi.fn();
    const disposeResize = vi.fn();
    const resetGuard = vi.fn();
    harness.ioShim = { dispose: disposeIo };
    harness.resizeSubscription = { dispose: disposeResize };
    harness.hostKeyGuard = { reset: resetGuard };

    harness.handleExit(255, 'nassh-exit');
    harness.handleExit(255, 'wassh');

    expect(statuses).toEqual([
      { status: 'disconnected', error: 'SSH exited with status 255', meta: { disconnectReason: 'transport' } },
    ]);
    expect(disposeIo).toHaveBeenCalledOnce();
    expect(disposeResize).toHaveBeenCalledOnce();
    expect(resetGuard).toHaveBeenCalledOnce();
  });

  it('marks a zero exit as a clean normal exit', () => {
    const onStatus = vi.fn();
    const bridge = new NasshCommandBridge({ host: 'host', port: 22, username: 'user', onStatus });
    (bridge as unknown as ExitHarness).handleExit(0, 'wassh');
    expect(onStatus).toHaveBeenCalledWith('disconnected', undefined, { disconnectReason: 'normal-exit' });
  });
});
