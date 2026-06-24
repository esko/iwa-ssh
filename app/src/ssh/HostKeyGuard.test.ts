import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostKeyGuard } from './HostKeyGuard';

const { ensureHostTrusted } = vi.hoisted(() => ({ ensureHostTrusted: vi.fn() }));
vi.mock('./KnownHostPrompt', () => ({ ensureHostTrusted }));

function prompt(host: string, fingerprint: string): string {
  return `The authenticity of host '${host}' can't be established.\nED25519 key fingerprint is ${fingerprint}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `;
}

describe('HostKeyGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    let decide!: (choice: 'once' | 'always' | 'trusted') => void;
    ensureHostTrusted.mockReturnValueOnce(new Promise<'once' | 'always' | 'trusted'>((resolve) => { decide = resolve; }));
    const sendResponse = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse });

    const handling = guard.handleOutput(prompt('target', 'SHA256:remember-me'));
    const response = guard.consumePendingHostKeyResponse();
    decide('once');

    await expect(response).resolves.toBe('yes');
    await handling;
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('returns rejection from the button decision to secureInput', async () => {
    ensureHostTrusted.mockResolvedValueOnce('cancel');
    const onDenied = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn(), onDenied });

    const handling = guard.handleOutput(prompt('target', 'SHA256:rejected'));
    await expect(guard.consumePendingHostKeyResponse()).resolves.toBe('no');
    await handling;
    expect(onDenied).toHaveBeenCalledOnce();
  });

  it('detects a host-key prompt delivered directly through secureInput', async () => {
    ensureHostTrusted.mockResolvedValueOnce('once');
    const sendResponse = vi.fn();
    const onSessionTrust = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse, onSessionTrust });

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
    expect(onSessionTrust).toHaveBeenCalledWith('SHA256:secureInputOnly');
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('returns null for non-host-key secureInput prompts', async () => {
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn() });

    await expect(guard.consumePendingHostKeyResponse("user@target's password: ")).resolves.toBeNull();

    expect(ensureHostTrusted).not.toHaveBeenCalled();
  });

  it('waits for queued terminal output before classifying secureInput host keys', async () => {
    ensureHostTrusted.mockResolvedValueOnce('once');
    const sendResponse = vi.fn();
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse });

    const slowPrior = guard.handleOutput('banner text without host key prompt\n');
    await expect(
      guard.consumePendingHostKeyResponse(prompt('target', 'SHA256:queued')),
    ).resolves.toBe('yes');
    await slowPrior;
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('combines terminal fingerprint output with a secureInput yes/no question', async () => {
    ensureHostTrusted.mockResolvedValueOnce('once');
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn() });

    void guard.handleOutput(
      "The authenticity of host 'target' can't be established.\nED25519 key fingerprint is SHA256:splitPrompt.\n",
    );

    await expect(
      guard.consumePendingHostKeyResponse('Are you sure you want to continue connecting (yes/no/[fingerprint])? '),
    ).resolves.toBe('yes');

    expect(ensureHostTrusted).toHaveBeenCalledWith(
      'target',
      22,
      'SHA256:splitPrompt',
      'ssh-ed25519',
      { useLiveVerification: true },
    );
  });

  it('uses the last terminal fingerprint when secureInput only asks for yes/no', async () => {
    ensureHostTrusted.mockResolvedValueOnce('once');
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn() });

    await guard.handleOutput("ED25519 key fingerprint is SHA256:questionOnly.\n");

    await expect(
      guard.consumePendingHostKeyResponse('(yes/no/[fingerprint])? '),
    ).resolves.toBe('yes');

    expect(ensureHostTrusted).toHaveBeenCalledWith(
      'target',
      22,
      'SHA256:questionOnly',
      'ssh-ed25519',
      { useLiveVerification: true },
    );
  });

  it('recognizes host-key prompts with URL-safe SHA256 fingerprints', async () => {
    ensureHostTrusted.mockResolvedValueOnce('once');
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn() });

    await expect(
      guard.consumePendingHostKeyResponse(
        "The authenticity of host 'target' can't be established.\nED25519 host key fingerprint is SHA256:abc_DEF-123.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
      ),
    ).resolves.toBe('yes');

    expect(ensureHostTrusted).toHaveBeenCalledWith(
      'target',
      22,
      'SHA256:abc_DEF-123',
      'ssh-ed25519',
      { useLiveVerification: true },
    );
  });

  it('keeps host-key-looking prompts out of the generic secure input modal even without a parsed fingerprint', async () => {
    ensureHostTrusted.mockResolvedValueOnce('once');
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn() });

    await expect(
      guard.consumePendingHostKeyResponse('Are you sure you want to continue connecting (yes/no/[fingerprint])? '),
    ).resolves.toBe('yes');

    expect(ensureHostTrusted).toHaveBeenCalledWith(
      'target',
      22,
      'unknown',
      'unknown',
      { useLiveVerification: true },
    );
  });

  it('filters inline host-key prompts from terminal output while preserving surrounding output', () => {
    const guard = new HostKeyGuard({ host: 'target', port: 22, sendResponse: vi.fn() });

    const first = guard.filterTerminalOutput('banner\nThe authenticity of host ');
    const second = guard.filterTerminalOutput(
      "'target' can't be established.\nED25519 key fingerprint is SHA256:inline.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? tail",
    );

    expect(first).toBe('banner\n');
    expect(second).toBe('tail');
  });
});
