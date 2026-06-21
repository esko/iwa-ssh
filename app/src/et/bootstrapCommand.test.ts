import { describe, expect, it } from 'vitest';
import { buildEtBootstrapCommand } from './bootstrapCommand';

describe('ET SSH bootstrap command', () => {
  it('uses env plus sh so fish login shells accept Homebrew paths', () => {
    const command = buildEtBootstrapCommand('1234567890abcdef', '12345678901234567890123456789012');
    expect(command).toContain('env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin sh -c');
    expect(command).toContain('| exec etterminal');
    expect(command).not.toMatch(/^PATH=/);
  });

  it('rejects values that could alter the remote command', () => {
    expect(() => buildEtBootstrapCommand('bad;id', '12345678901234567890123456789012')).toThrow();
  });
});
