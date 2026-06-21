/**
 * Primary Device Attributes (DA1) auto-reply.
 *
 * ghostty-vt recognises the DA1 query (`CSI c` / `CSI 0 c`) but, as embedded
 * here, does not emit the response back through the per-pane PtyTransport. Apps
 * that gate feature detection on the reply — notably fish — then stall for ~10s
 * waiting for it and disable optional features (cursor-shape changes, reflow
 * detection) for the rest of the session.
 *
 * We answer at the adapter boundary with the standard VT220 + ANSI-colour
 * identity (`CSI ? 62 ; 22 c`, what ghostty itself reports) and route it back
 * through the pane's input path. Secondary/tertiary DA (`CSI > c` / `CSI = c`)
 * are deliberately not matched — fish only blocks on the primary query.
 */
export const DA1_REPLY = '\x1b[?62;22c';

// CSI c or CSI 0 c, not preceded by a private/intermediate marker (`>`, `=`,
// `?`), so DA2/DA3 queries and DA replies (`CSI ? … c`) are left untouched.
const DA1_QUERY = /\x1b\[0?c/;

/** The DA1 reply if `chunk` contains a Primary DA query, otherwise `null`. */
export function deviceAttributeReply(chunk: string): string | null {
  return DA1_QUERY.test(chunk) ? DA1_REPLY : null;
}
