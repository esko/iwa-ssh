import type { TerminalAppearance } from '../settings/types';

export type TerminalSubscription = {
  dispose(): void;
};

export type TerminalViewport = {
  cols: number;
  rows: number;
  widthPx: number;
  heightPx: number;
};

export const DEFAULT_TERMINAL_VIEWPORT: TerminalViewport = {
  cols: 80,
  rows: 24,
  widthPx: 0,
  heightPx: 0,
};

function validMetric(value: number | undefined, allowZero: boolean): value is number {
  return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && (allowZero ? value >= 0 : value > 0);
}

/** Merge renderer metrics while ignoring transient invalid/partial callbacks. */
export function mergeTerminalViewport(
  current: TerminalViewport,
  update: Partial<TerminalViewport>,
): TerminalViewport {
  const next = {
    cols: validMetric(update.cols, false) ? update.cols : current.cols,
    rows: validMetric(update.rows, false) ? update.rows : current.rows,
    widthPx: validMetric(update.widthPx, true) ? update.widthPx : current.widthPx,
    heightPx: validMetric(update.heightPx, true) ? update.heightPx : current.heightPx,
  };
  return next.cols === current.cols && next.rows === current.rows &&
    next.widthPx === current.widthPx && next.heightPx === current.heightPx
    ? current
    : next;
}

/** Transport-facing terminal I/O. Renderer behavior stays behind Restty. */
export interface TerminalSink {
  write(data: string | Uint8Array): void;
  onInput(cb: (data: string) => void): TerminalSubscription;
  onResize(cb: (viewport: TerminalViewport) => void): TerminalSubscription;
  focus(): void;
  getSize(): TerminalViewport;
}

export interface TerminalAdapter extends TerminalSink {
  open(el: HTMLElement): void;
  dispose(): void;
  fit?(): void;
  updateAppearance?(appearance: TerminalAppearance): void;
}
