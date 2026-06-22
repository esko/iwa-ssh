#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchResttyRenderer } from './restty-renderer-patches.ts';

const root = new URL('..', import.meta.url).pathname;
const bundles = [
  'vendor/restty/dist/internal.esm.js',
  'vendor/restty/dist/restty-C1ZKXXYO.js',
  'vendor/restty/dist/restty.esm.js',
  'vendor/restty/dist/xterm.esm.js',
];

let failed = false;
for (const relative of bundles) {
  const source = readFileSync(join(root, relative), 'utf8');
  const patched = patchResttyRenderer(source, relative) ?? source;
  const hasCellBoundedSampling =
    /Math\.max\(1, Math\.round\(c\)\)/.test(patched) &&
    /\(r \+ \.5\) \/ l/.test(patched) &&
    /u = n \+ r/.test(patched);
  if (!hasCellBoundedSampling) {
    console.error(`FAIL ${relative}: Powerline rows are not sampled inside the cell`);
    failed = true;
  }

  const hasCellJoinedRoundCaps =
    /e === "round_right"/.test(patched) &&
    /e === "round_left"/.test(patched) &&
    /Math\.sqrt\(Math\.max\(0, 1 - Math\.pow\(i \* 2 - 1, 2\)\)\)/.test(patched) &&
    /case 57524: return u\("round_right"\), !0;/.test(patched) &&
    /case 57526: return u\("round_left"\), !0;/.test(patched);
  if (!hasCellJoinedRoundCaps) {
    console.error(`FAIL ${relative}: filled Powerline half circles do not join the cell edge`);
    failed = true;
  }
}

const adapter = readFileSync(join(root, 'app/src/pwa/resttyAdapter.ts'), 'utf8');
const iconScale = adapter.match(/nerdIconScale:\s*([0-9.]+)/)?.[1];
if (!iconScale || Number(iconScale) > 0.85) {
  console.error(`FAIL resttyAdapter.ts: Nerd icon scale must be explicit and <= 0.85 (found ${iconScale ?? 'none'})`);
  failed = true;
}

if (failed) process.exit(1);
console.log('PASS Restty Powerline shapes stay cell-bounded and joined; Nerd icons stay text-sized');
