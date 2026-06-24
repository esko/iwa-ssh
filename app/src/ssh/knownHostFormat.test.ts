import { describe, expect, it } from 'vitest';
import { knownHostLinesForSync, knownHostLinesForTarget } from './knownHostFormat';

describe('knownHostLinesForSync', () => {
  const ipLine =
    '192.168.1.60 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTestPurposesOnly1234567890';

  it('matches an exact hostname marker', () => {
    const file = `mini.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTestPurposesOnly1234567890`;
    expect(knownHostLinesForTarget(file, 'mini.local', 22)).toHaveLength(1);
    expect(knownHostLinesForSync(file, 'mini.local', 22)).toHaveLength(1);
  });

  it('falls back to a single line when the profile hostname differs from the stored IP', () => {
    expect(knownHostLinesForTarget(ipLine, 'mini.local', 22)).toHaveLength(0);
    expect(knownHostLinesForSync(ipLine, 'mini.local', 22)).toHaveLength(1);
  });

  it('does not guess when multiple unrelated lines exist', () => {
    const file = `${ipLine}\nother.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyMaterialForTestPurposesOnly123456789012`;
    expect(knownHostLinesForSync(file, 'mini.local', 22)).toHaveLength(0);
  });
});
