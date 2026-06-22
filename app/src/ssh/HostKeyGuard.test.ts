import { describe, expect, it, vi } from 'vitest';
import { HostKeyGuard } from './HostKeyGuard';

const { ensureHostTrusted } = vi.hoisted(() => ({ ensureHostTrusted: vi.fn() }));
vi.mock('./KnownHostPrompt', () => ({ ensureHostTrusted }));

function prompt(host: string, fingerprint: string): string {
  return `The authenticity of host '${host}' can't be established.\nED25519 key fingerprint is ${fingerprint}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `;
}

describe('HostKeyGuard', () => {
  it('does not latch after auto-accepting a session-trusted host key', async () => {
    const sendResponse = vi.fn();
    const guard = new HostKeyGuard({
      host: 'target',
      port: 22,
      sendResponse,
      isSessionTrusted: () => true,
    });

    await Promise.all([
      guard.handleOutput(prompt('bastion', 'SHA256:first')),
      guard.handleOutput(prompt('target', 'SHA256:second')),
    ]);

    expect(sendResponse).toHaveBeenCalledTimes(2);
    expect(sendResponse).toHaveBeenNthCalledWith(1, 'yes\n');
    expect(sendResponse).toHaveBeenNthCalledWith(2, 'yes\n');
  });

  it('routes a host-key decision through secureInput without also injecting tty input', async () => {
    let decide!: (trusted: boolean) => void;
    ensureHostTrusted.mockReturnValueOnce(new Promise<boolean>((resolve) => { decide = resolve; }));
    const sendResponse = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse });

    const handling = guard.handleOutput(prompt('target', 'SHA256:remember-me'));
    const response = guard.consumePendingHostKeyResponse();
    decide(true);

    await expect(response).resolves.toBe('yes');
    await handling;
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('returns rejection from the button decision to secureInput', async () => {
    ensureHostTrusted.mockResolvedValueOnce(false);
    const onDenied = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn(), onDenied });

    const handling = guard.handleOutput(prompt('target', 'SHA256:rejected'));
    await expect(guard.consumePendingHostKeyResponse()).resolves.toBe('no');
    await handling;
    expect(onDenied).toHaveBeenCalledOnce();
  });

  it('detects a host-key prompt delivered directly through secureInput', async () => {
    ensureHostTrusted.mockResolvedValueOnce(true);
    const sendResponse = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse });

    await expect(
      guard.consumePendingHostKeyResponse(prompt('target', 'SHA256:secureInputOnly')),
    ).resolves.toBe('yes');

    expect(ensureHostTrusted).toHaveBeenCalledWith(
      'target',
      22,
      'SHA256:secureInputOnly',
      'ssh-ed25519',
      { useLiveVerification: true },
    );
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
