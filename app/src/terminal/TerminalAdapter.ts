export type TerminalSubscription = {
  dispose(): void;
};

export interface TerminalAdapter {
  open(el: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onInput(cb: (data: string) => void): TerminalSubscription;
  onResize(cb: (cols: number, rows: number) => void): TerminalSubscription;
  focus(): void;
  dispose(): void;
  fit?(): void;
  getSize(): { cols: number; rows: number };
}
