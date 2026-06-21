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
});
