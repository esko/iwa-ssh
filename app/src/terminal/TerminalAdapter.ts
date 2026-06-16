export interface TerminalAdapter {
  open(el: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onInput(cb: (data: string) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  focus(): void;
  dispose(): void;
  fit?(): void;
  getSize(): { cols: number; rows: number };
}
