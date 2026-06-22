import { describe, expect, it, vi } from 'vitest';
import { layoutSpecKey, profileToSpec, recordConnection, specToQuery, specFromQuery, specTitle } from './profileModel';
import type { Profile } from '../settings/types';

describe('profile to terminal query mapping', () => {
  it('round-trips a fully-populated SSH profile through profileToSpec -> specToQuery -> specFromQuery', () => {
    const profile: Profile = {
      id: 'test-profile-id',
      name: 'My SSH Host',
      protocol: 'ssh',
      host: 'example.com',
      port: 2222,
      username: 'alice',
      identityId: 'test-identity-id',
      connectionArgs: '-o ServerAliveInterval=30',
      startupCommand: 'cd /home/alice',
    };

    // profileToSpec converts Profile to the canonical ConnectionIntent.
    const spec = profileToSpec(profile);
    expect(spec.protocol).toBe('ssh');
    expect(spec.username).toBe('alice');
    expect(spec.hostname).toBe('example.com');
    expect(spec.port).toBe(2222);
    expect(spec.argstr).toBe('-o ServerAliveInterval=30');
    expect(spec.profileId).toBe('test-profile-id');
    expect(spec.identityId).toBe('test-identity-id');
    expect(spec.startupCommand).toBe('cd /home/alice');

    // specToQuery serializes to URL query string
    const queryString = specToQuery(spec);
    const searchParams = new URLSearchParams(queryString);

    // specFromQuery parses back to spec
    const parsedSpec = specFromQuery(searchParams);
    expect(parsedSpec).not.toBeNull();
    expect(parsedSpec!.protocol).toBe('ssh');
    expect(parsedSpec!.username).toBe('alice');
    expect(parsedSpec!.hostname).toBe('example.com');
    expect(parsedSpec!.port).toBe(2222);
    expect(parsedSpec!.argstr).toBe('-o ServerAliveInterval=30');
    expect(parsedSpec!.profileId).toBe('test-profile-id');
    expect(parsedSpec!.identityId).toBe('test-identity-id');
    expect(parsedSpec!.startupCommand).toBe('cd /home/alice');
  });

  it('specFromQuery with no port defaults to 22 and specTitle formats correctly', () => {
    const query = new URLSearchParams('protocol=ssh&host=h&username=u');
    const spec = specFromQuery(query);

    expect(spec).not.toBeNull();
    expect(spec!.protocol).toBe('ssh');
    expect(spec!.hostname).toBe('h');
    expect(spec!.username).toBe('u');
    expect(spec!.port).toBe(22);

    const title = specTitle(spec!);
    expect(title).toBe('ssh u@h');
  });

  it('specFromQuery with only protocol=ssh (no host) returns null', () => {
    const query = new URLSearchParams('protocol=ssh');
    const spec = specFromQuery(query);

    expect(spec).toBeNull();
  });

  it('round-trips Eternal Terminal bootstrap and daemon ports without credentials', () => {
    const profile: Profile = {
      id: 'et-profile',
      name: 'Durable shell',
      protocol: 'et',
      host: 'example.com',
      port: 2222,
      etPort: 2023,
      username: 'alice',
    };
    const query = specToQuery(profileToSpec(profile));
    expect(query).not.toContain('passkey');
    expect(specFromQuery(new URLSearchParams(query))).toMatchObject({
      protocol: 'et',
      port: 2222,
      etPort: 2023,
    });
  });

  it('defaults Eternal Terminal to SSH 22 and ET 2022', () => {
    expect(specFromQuery(new URLSearchParams('protocol=et&host=h'))).toMatchObject({
      protocol: 'et',
      port: 22,
      etPort: 2022,
    });
  });
});

describe('layoutSpecKey', () => {
  it('distinguishes session-affecting connection intent', () => {
    const base = { protocol: 'et' as const, hostname: 'host', username: 'user', args: [] as string[] };
    expect(layoutSpecKey({ ...base, etPort: 2022 })).not.toBe(layoutSpecKey({ ...base, etPort: 2023 }));
    expect(layoutSpecKey({ ...base, identityId: 'a' })).not.toBe(layoutSpecKey({ ...base, identityId: 'b' }));
    expect(layoutSpecKey({ ...base, startupCommand: 'one' })).not.toBe(layoutSpecKey({ ...base, startupCommand: 'two' }));
  });
});

describe('recents', () => {
  it('never stores development echo intents', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem });
    await recordConnection({ protocol: 'echo', testOnly: true, hostname: 'local', args: [] });
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
