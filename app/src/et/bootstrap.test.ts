import { describe, expect, it } from 'vitest';
import { isEtBootstrapFailure } from './bootstrap';

describe('isEtBootstrapFailure', () => {
  it('ignores benign OpenSSH known_hosts maintenance warnings', () => {
    // Real output from a first connection to a host with no prior known_hosts
    // file: the "No such file" here is ssh housekeeping, not an etterminal error.
    const output = [
      "Warning: Permanently added 'mini.local' (ED25519) to the list of known hosts.",
      '(esko@mini.local) Password:',
      'hostfile_replace_entries: hostkeys_foreach: No such file or directory',
    ].join('\n');
    expect(isEtBootstrapFailure(output)).toBe(false);
  });

  it('still flags a missing etterminal binary', () => {
    expect(isEtBootstrapFailure('sh: 1: etterminal: not found\nsh: command not found')).toBe(true);
    expect(isEtBootstrapFailure('env: etterminal: No such file or directory')).toBe(true);
  });

  it('flags etterminal router/FATAL failures', () => {
    expect(isEtBootstrapFailure('Error connecting to router')).toBe(true);
    expect(isEtBootstrapFailure('FATAL: could not start session')).toBe(true);
  });

  it('does not flag clean bootstrap output', () => {
    expect(isEtBootstrapFailure('IDPASSKEY:abc/def\n')).toBe(false);
  });

  it('flags a real failure even alongside benign ssh noise', () => {
    const output = [
      'hostfile_replace_entries: hostkeys_foreach: No such file or directory',
      'sh: etterminal: command not found',
    ].join('\n');
    expect(isEtBootstrapFailure(output)).toBe(true);
  });

  it('flags et daemon connection errors but not bare OpenSSH housekeeping', () => {
    const output = [
      'yes',
      "Warning: Permanently added '192.168.1.60' (ED25519) to the list of known hosts.",
      '(esko@192.168.1.60) Password:',
      'hostfile_replace_entries: hostkeys_foreach: No such file or directory',
      'update_known_hosts: hostfile_replace_entries failed for /.ssh/known_hosts2: No such file or directory',
      'Error:  Connection error communicating with et daemon: No such file or directory.',
    ].join('\n');
    expect(isEtBootstrapFailure(output)).toBe(true);
  });

  it('does not treat auth-phase output alone as failure', () => {
    const output = [
      'yes',
      "Warning: Permanently added '192.168.1.60' (ED25519) to the list of known hosts.",
      '(esko@192.168.1.60) Password:',
      'hostfile_replace_entries: hostkeys_foreach: No such file or directory',
      'update_known_hosts: hostfile_replace_entries failed for /.ssh/known_hosts2: No such file or directory',
    ].join('\n');
    expect(isEtBootstrapFailure(output)).toBe(false);
  });
});
