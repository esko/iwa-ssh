/**
 * Restty's core limit is bytes, while the product setting is rendered lines.
 * A populated terminal row costs substantially more than its UTF-8 payload:
 * cells retain styles, graphemes, links, and row metadata. Four KiB per line
 * is conservative for normal terminal widths without preallocating the limit.
 */
const BYTES_PER_SCROLLBACK_LINE = 4_096;
const RESTTY_MAX_SCROLLBACK_BYTES = 256_000_000;

export function scrollbackBytesForLines(lines: number): number {
  const requestedLines = Number.isFinite(lines) ? Math.max(0, Math.round(lines)) : 0;
  return Math.min(RESTTY_MAX_SCROLLBACK_BYTES, requestedLines * BYTES_PER_SCROLLBACK_LINE);
}
