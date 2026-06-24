import { describe, expect, it } from 'vitest';
import { HostKeyParser } from './HostKeyParser';

function prompt(host: string, keyType: string, fingerprint: string): string {
  return `The authenticity of host '${host}' can't be established.\r\n${keyType} key fingerprint is ${fingerprint}.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `;
}

describe('HostKeyParser', () => {
  it('emits each sequential ProxyJump host-key prompt exactly once', () => {
    const parser = new HostKeyParser();
    expect(parser.parse(prompt('bastion', 'ED25519', 'SHA256:abc+/='))).toEqual([
      { type: 'HostKeyPromptDetected', fingerprint: 'SHA256:abc+/=', keyType: 'ssh-ed25519' },
    ]);
    expect(parser.parse('')).toEqual([]);
    expect(parser.parse(prompt('target', 'RSA', 'SHA256:def+/='))).toEqual([
      { type: 'HostKeyPromptDetected', fingerprint: 'SHA256:def+/=', keyType: 'ssh-rsa' },
    ]);
    expect(parser.parse('')).toEqual([]);
  });

  it('recognizes a prompt split across chunks', () => {
    const parser = new HostKeyParser();
    const text = prompt('target', 'ECDSA', 'SHA256:xyz123');
    const midpoint = Math.floor(text.length / 2);
    expect(parser.parse(text.slice(0, midpoint))).toEqual([]);
    expect(parser.parse(text.slice(midpoint))).toEqual([
      { type: 'HostKeyPromptDetected', fingerprint: 'SHA256:xyz123', keyType: 'ssh-ecdsa' },
    ]);
  });

  it.each([
    ['ssh-ed25519', 'ssh-ed25519'],
    ['rsa-sha2-512', 'rsa-sha2-512'],
    ['ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp384'],
    ['sk-ssh-ed25519@openssh.com', 'sk-ssh-ed25519@openssh.com'],
    ['sk-ecdsa-sha2-nistp256@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'],
    ['SK-ED25519', 'sk-ssh-ed25519@openssh.com'],
    ['ECDSA-SK', 'sk-ecdsa-sha2-nistp256@openssh.com'],
  ])('recognizes %s host-key prompts', (rawKeyType, normalized) => {
    const parser = new HostKeyParser();

    expect(parser.parse(prompt('target', rawKeyType, 'SHA256:abc_DEF-123'))).toEqual([
      { type: 'HostKeyPromptDetected', fingerprint: 'SHA256:abc_DEF-123', keyType: normalized },
    ]);
  });

  it('recognizes OpenSSH prompts with a colon after "fingerprint is" and extra lines', () => {
    const parser = new HostKeyParser();
    const text =
      "The authenticity of host 'mini.local (::)' can't be established.\r\n" +
      'ED25519 key fingerprint is: SHA256:CF9+YLsBfp9Gyr9iwb9kmqvyovEyoRFwWMqccm176wU\r\n' +
      'This key is not known by any other names.\r\n' +
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? ';

    expect(parser.parse(text)).toEqual([
      {
        type: 'HostKeyPromptDetected',
        fingerprint: 'SHA256:CF9+YLsBfp9Gyr9iwb9kmqvyovEyoRFwWMqccm176wU',
        keyType: 'ssh-ed25519',
      },
    ]);
  });
});
