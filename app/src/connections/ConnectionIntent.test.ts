import { describe, expect, it } from 'vitest';
import {
  connectionIntentFromProfile,
  connectionIntentFromQuery,
  connectionIntentToQuery,
  connectionLayoutKey,
  normalizeConnectionIntent,
  resolveConnectionIntent,
} from './ConnectionIntent';

describe('ConnectionIntent', () => {
  it('normalizes and round-trips a production intent', () => {
    const intent = normalizeConnectionIntent({
      protocol: 'et', username: ' user ', hostname: ' host ', port: 22,
      etPort: 2022, args: [], argstr: '  -v  ', profileId: ' p ',
      identityId: ' i ', settingsProfileId: ' s ', startupCommand: ' tmux ',
    });
    expect(connectionIntentFromQuery(new URLSearchParams(connectionIntentToQuery(intent)))).toEqual(intent);
  });

  it('rejects malformed hosts, ports, and production echo', () => {
    expect(connectionIntentFromQuery(new URLSearchParams('protocol=ssh&host=%20'))).toBeNull();
    expect(connectionIntentFromQuery(new URLSearchParams('protocol=ssh&host=bad%20host'))).toBeNull();
    expect(connectionIntentFromQuery(new URLSearchParams('protocol=ssh&host=h&port=70000'))).toBeNull();
    expect(connectionIntentFromQuery(new URLSearchParams('protocol=echo&host=local'), { allowTestIntent: false })).toBeNull();
  });

  it('allows echo only as an explicitly marked development test intent', () => {
    expect(connectionIntentFromQuery(new URLSearchParams('protocol=echo&host=local'), { allowTestIntent: true })).toMatchObject({
      protocol: 'echo', hostname: 'local', testOnly: true,
    });
  });

  it('uses resume, then profile, then direct query precedence', async () => {
    const query = new URLSearchParams('resume=r&profile=p&protocol=ssh&host=direct');
    const resolved = await resolveConnectionIntent(query, {
      getEtSession: async () => ({ id: 'r', phase: 'detached', username: 'u', host: 'resumed', sshPort: 22, etPort: 2022, connectionArgs: '' }),
      getProfile: async () => ({ id: 'p', name: 'P', host: 'profile', port: 22, username: 'u' }),
    });
    expect(resolved).toMatchObject({ protocol: 'et', hostname: 'resumed', etSessionId: 'r' });
  });

  it('falls through to profile and direct query when higher-priority sources are absent', async () => {
    const profile = { id: 'p', name: 'P', host: 'profile', port: 2222, username: 'u' };
    expect(await resolveConnectionIntent(new URLSearchParams('profile=p&host=direct'), {
      getEtSession: async () => undefined, getProfile: async () => profile,
    })).toEqual(connectionIntentFromProfile(profile));
    expect(await resolveConnectionIntent(new URLSearchParams('protocol=mosh&host=direct'), {
      getEtSession: async () => undefined, getProfile: async () => undefined,
    })).toMatchObject({ protocol: 'mosh', hostname: 'direct' });
  });

  it('uses normalized identity for tab-layout matching', () => {
    const a = normalizeConnectionIntent({ protocol: 'ssh', hostname: ' h ', args: [] });
    const b = normalizeConnectionIntent({ protocol: 'ssh', hostname: 'h', port: 22, args: [] });
    expect(connectionLayoutKey(a)).toBe(connectionLayoutKey(b));
  });
});
