import { describe, expect, it, vi } from 'vitest';
import type { SessionStatusMeta } from '../settings/types';
import { composeSshArgstr, isLoginPasswordPrompt, NASSH_ENVIRONMENT, NasshCommandBridge } from './NasshCommandBridge';

describe('composeSshArgstr', () => {
  it('returns trimmed extra args when there is no remote command', () => {
    expect(composeSshArgstr(undefined, undefined)).toBe('');
    expect(composeSshArgstr('  -o Foo=bar ', '')).toBe('-o Foo=bar');
  });

  it('appends the remote command after a -- separator so ssh runs it', () => {
    expect(composeSshArgstr(undefined, 'etterminal')).toBe('-- etterminal');
    expect(composeSshArgstr('-o Foo=bar', "env PATH=/bin sh -c 'exec etterminal'")).toBe(
      "-o Foo=bar -- env PATH=/bin sh -c 'exec etterminal'",
    );
  });
});
describe('isLoginPasswordPrompt', () => {
  it('treats masked password prompts as the savable login password', () => {
    expect(isLoginPasswordPrompt("user@host's password: ", false)).toBe(true);
    expect(isLoginPasswordPrompt('Password:', false)).toBe(true);
  });

  it('never offers to save echoed responses', () => {
    expect(isLoginPasswordPrompt("user@host's password: ", true)).toBe(false);
  });

  it('excludes one-time / 2FA prompts that also mask input', () => {
    expect(isLoginPasswordPrompt('Verification code: ', false)).toBe(false);
    expect(isLoginPasswordPrompt('One-time password: ', false)).toBe(false);
    expect(isLoginPasswordPrompt('Enter your OTP: ', false)).toBe(false);
    expect(isLoginPasswordPrompt('Authenticator token: ', false)).toBe(false);
  });

  it('ignores non-password prompts', () => {
    expect(isLoginPasswordPrompt('Are you sure you want to continue connecting?', false)).toBe(false);
  });
});

type ExitHarness = {
  handleExit(code: number, source: 'nassh' | 'nassh-exit' | 'wassh'): void;
  ioShim: { dispose(): void } | null;
  resizeSubscription: { dispose(): void } | null;
  hostKeyGuard: { reset(): void } | null;
};

describe('NasshCommandBridge environment', () => {
  it('sends a UTF-8 locale for non-interactive Mosh bootstrap commands', () => {
    expect(NASSH_ENVIRONMENT).toMatchObject({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    });
  });
});

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
