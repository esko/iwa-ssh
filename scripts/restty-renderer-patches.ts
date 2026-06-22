/**
 * Local renderer correctness patches for the pinned Restty build.
 *
 * Keep these transforms narrow and fail on upstream drift. Remove a transform
 * as soon as the pinned Restty release contains the corresponding fix.
 */

const POWERLINE_MARKER = '#region src/renderer/shapes/powerline.ts';
const POWERLINE_ROW_SAMPLING = /let s = r, c = i, l = Math\.max\(2, Math\.round\(Math\.max\(s, c\)\)\), u = \(e\) => \{\n\t\tfor \(let r = 0; r < l; r \+= 1\) \{\n\t\t\tlet i = l === 1 \? 0 : r \/ \(l - 1\), u = n \+ i \* c,/;

const CELL_BOUNDED_POWERLINE_ROWS =
  'let s = r, c = i, l = Math.max(1, Math.round(c)), u = (e) => {\n' +
  '\t\tfor (let r = 0; r < l; r += 1) {\n' +
  '\t\t\tlet i = (r + .5) / l, u = n + r,';

export function patchResttyRenderer(source: string, id: string): string | null {
  if (!source.includes(POWERLINE_MARKER)) return null;

  const matches = source.match(POWERLINE_ROW_SAMPLING);
  if (!matches) {
    throw new Error(`Restty Powerline patch drifted for ${id}`);
  }

  return source.replace(POWERLINE_ROW_SAMPLING, CELL_BOUNDED_POWERLINE_ROWS);
}
