/**
 * Local renderer correctness patches for the pinned Restty build.
 *
 * Keep these transforms narrow and fail on upstream drift. Remove a transform
 * as soon as the pinned Restty release contains the corresponding fix.
 */

const POWERLINE_MARKER = '#region src/renderer/shapes/powerline.ts';
const POWERLINE_ROW_SAMPLING = /let s = r, c = i, l = Math\.max\(2, Math\.round\(Math\.max\(s, c\)\)\), u = \(e\) => \{\n\t\tfor \(let r = 0; r < l; r \+= 1\) \{\n\t\t\tlet i = l === 1 \? 0 : r \/ \(l - 1\), u = n \+ i \* c,/;
const POWERLINE_SHAPE_GEOMETRY = /e === "right" \? f = t \+ s \* \(1 - Math\.abs\(i - \.5\) \* 2\) : e === "left" \? d = t \+ \(s - s \* \(1 - Math\.abs\(i - \.5\) \* 2\)\) : e === "diag_ul_lr" \?/;
const POWERLINE_SWITCH_START = /\t\tcase 57520: return u\("right"\), !0;/;

const CELL_BOUNDED_POWERLINE_ROWS =
  'let s = r, c = i, l = Math.max(1, Math.round(c)), u = (e) => {\n' +
  '\t\tfor (let r = 0; r < l; r += 1) {\n' +
  '\t\t\tlet i = (r + .5) / l, u = n + r,';

const CELL_JOINED_POWERLINE_GEOMETRY =
  'e === "right" ? f = t + s * (1 - Math.abs(i - .5) * 2) : ' +
  'e === "left" ? d = t + (s - s * (1 - Math.abs(i - .5) * 2)) : ' +
  'e === "round_right" ? f = t + s * Math.sqrt(Math.max(0, 1 - Math.pow(i * 2 - 1, 2))) : ' +
  'e === "round_left" ? d = t + (s - s * Math.sqrt(Math.max(0, 1 - Math.pow(i * 2 - 1, 2)))) : ' +
  'e === "diag_ul_lr" ?';

const FILLED_ROUND_POWERLINE_CASES =
  '\t\tcase 57524: return u("round_right"), !0;\n' +
  '\t\tcase 57526: return u("round_left"), !0;\n' +
  '\t\tcase 57520: return u("right"), !0;';

export function patchResttyRenderer(source: string, id: string): string | null {
  if (!source.includes(POWERLINE_MARKER)) return null;

  const matches = source.match(POWERLINE_ROW_SAMPLING);
  if (!matches) {
    throw new Error(`Restty Powerline patch drifted for ${id}`);
  }

  const sampled = source.replace(POWERLINE_ROW_SAMPLING, CELL_BOUNDED_POWERLINE_ROWS);
  if (!POWERLINE_SHAPE_GEOMETRY.test(sampled) || !POWERLINE_SWITCH_START.test(sampled)) {
    throw new Error(`Restty rounded Powerline patch drifted for ${id}`);
  }

  return sampled
    .replace(POWERLINE_SHAPE_GEOMETRY, CELL_JOINED_POWERLINE_GEOMETRY)
    .replace(POWERLINE_SWITCH_START, FILLED_ROUND_POWERLINE_CASES);
}
