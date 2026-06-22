import type { TerminalAppearance } from '../settings/types';

export type TerminalSubscription = {
  dispose(): void;
};

/** Transport-facing terminal I/O. Renderer behavior stays behind Restty. */
export interface TerminalSink {
  write(data: string | Uint8Array): void;
  onInput(cb: (data: string) => void): TerminalSubscription;
  onResize(cb: (cols: number, rows: number) => void): TerminalSubscription;
  focus(): void;
  getSize(): { cols: number; rows: number };
}

export interface TerminalAdapter extends TerminalSink {
  open(el: HTMLElement): void;
  dispose(): void;
  fit?(): void;
  updateAppearance?(appearance: TerminalAppearance): void;
}
