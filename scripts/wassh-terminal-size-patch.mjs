const BEFORE = `      // TODO(vapier): Add info to hterm and return it here.  Needed for SIXEL,
      // but not much else atm.
      xpixel: 0,
      ypixel: 0,`;

const AFTER = `      xpixel: Number.isFinite(size.widthPx)
        ? Math.max(0, Math.min(0xffff, Math.trunc(size.widthPx)))
        : 0,
      ypixel: Number.isFinite(size.heightPx)
        ? Math.max(0, Math.min(0xffff, Math.trunc(size.heightPx)))
        : 0,`;

/** Patch TIOCGWINSZ to include hterm-shim backing-canvas dimensions. */
export function patchWasshTerminalPixelSize(source) {
  if (!source.includes(BEFORE)) {
    throw new Error('wassh/js/syscall_handler.js terminal pixel-size pattern not found');
  }
  return source.replace(BEFORE, AFTER);
}
