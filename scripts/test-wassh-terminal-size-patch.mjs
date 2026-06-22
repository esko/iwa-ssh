import assert from 'node:assert/strict';
import { patchWasshTerminalPixelSize } from './wassh-terminal-size-patch.mjs';

const upstream = `      // TODO(vapier): Add info to hterm and return it here.  Needed for SIXEL,
      // but not much else atm.
      xpixel: 0,
      ypixel: 0,`;
const patched = patchWasshTerminalPixelSize(upstream);
const size = { widthPx: 1200.8, heightPx: 99999 };
const evaluate = Function('size', `return ({${patched}});`);
const values = evaluate(size);
assert.deepEqual(values, { xpixel: 1200, ypixel: 65535 });
assert.deepEqual(
  evaluate({ widthPx: -4, heightPx: Number.NaN }),
  { xpixel: 0, ypixel: 0 },
);
assert.throws(() => patchWasshTerminalPixelSize('upstream drift'), /pattern not found/);
console.log('PASS wassh TIOCGWINSZ pixel dimensions are propagated and clamped');
