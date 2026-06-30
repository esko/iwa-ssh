/** Scrollback bounds. Large values stay usable; zero/NaN would break the buffer. */
export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 200000;
export const SCROLLBACK_DEFAULT = 10000;

/**
 * Clamp a user-entered scrollback value into the supported range. Non-finite
 * input (e.g. an empty form field coerced through `Number('')`) falls back to
 * the default rather than collapsing the buffer to zero.
 */
export function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return SCROLLBACK_DEFAULT;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(value)));
}
