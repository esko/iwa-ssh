import { describe, expect, it, vi } from 'vitest';
import { HostKeyGuard } from './HostKeyGuard';

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
});
