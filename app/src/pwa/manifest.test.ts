import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('IWA native tab manifest', () => {
  it('uses / as home tab and /terminal as native new-tab target', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app/public/.well-known/manifest.webmanifest'), 'utf8'),
    ) as { tab_strip?: { home_tab?: unknown; new_tab_button?: { url?: string } } };

    expect(manifest.tab_strip?.home_tab).toBeDefined();
    expect(manifest.tab_strip?.new_tab_button?.url).toBe('/terminal.html');
  });
});
