import type { Terminal } from '@xterm/xterm';
import type { KeyboardSettings } from '../settings/types';

export type KeyboardBindingsHandle = {
  dispose(): void;
};

async function copySelection(terminal: Terminal): Promise<boolean> {
  const text = terminal.getSelection();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function pasteFromClipboard(terminal: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) terminal.paste(text);
  } catch {
    // Clipboard access may be denied.
  }
}

function isCopyShortcut(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'c';
}

function isPasteShortcut(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'v';
}

export function applyKeyboardBindings(
  terminal: Terminal,
  container: HTMLElement,
  keyboard: KeyboardSettings,
): KeyboardBindingsHandle {
  const disposables: Array<() => void> = [];

  const target = terminal.element ?? container;

  terminal.options.scrollOnUserInput = keyboard.scrollToBottomOnKeypress;
  terminal.options.macOptionIsMeta = keyboard.altSendsEscape;

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown') return true;

    if (!keyboard.altSendsEscape && e.altKey && !e.metaKey && !/Mac/.test(navigator.platform)) {
      return false;
    }

    if (isCopyShortcut(e)) {
      const wantsShift = keyboard.ctrlShiftCopyPaste;
      const wantsPlain = keyboard.ctrlCopyPaste;
      const shift = e.shiftKey;

      if ((wantsShift && shift) || (wantsPlain && !shift)) {
        if (terminal.hasSelection()) {
          e.preventDefault();
          void copySelection(terminal);
          return false;
        }
        if (wantsPlain && !shift) {
          e.preventDefault();
          terminal.input('\x03');
          return false;
        }
      }
    }

    if (isPasteShortcut(e)) {
      const wantsShift = keyboard.ctrlShiftCopyPaste;
      const wantsPlain = keyboard.ctrlCopyPaste;
      const shift = e.shiftKey;

      if ((wantsShift && shift) || (wantsPlain && !shift)) {
        e.preventDefault();
        void pasteFromClipboard(terminal);
        return false;
      }
    }

    if (e.key === 'Backspace' && !keyboard.backspaceSendsDelete && !e.ctrlKey) {
      e.preventDefault();
      terminal.input(e.altKey ? '\x1b\b' : '\b');
      return false;
    }

    if (e.key === 'Delete' && !keyboard.deleteSendsEscapeSequence) {
      e.preventDefault();
      terminal.input('\x7f');
      return false;
    }

    return true;
  };

  terminal.attachCustomKeyEventHandler(onKeyDown);

  if (keyboard.copyOnSelect) {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || !terminal.hasSelection()) return;
      void copySelection(terminal);
    };
    target.addEventListener('mouseup', onMouseUp);
    disposables.push(() => target.removeEventListener('mouseup', onMouseUp));
  }

  if (keyboard.rightClickPaste) {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      void pasteFromClipboard(terminal);
    };
    target.addEventListener('contextmenu', onContextMenu, true);
    disposables.push(() => target.removeEventListener('contextmenu', onContextMenu, true));
  }

  if (keyboard.middleClickPaste) {
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      void pasteFromClipboard(terminal);
    };
    target.addEventListener('auxclick', onAuxClick, true);
    disposables.push(() => target.removeEventListener('auxclick', onAuxClick, true));
  }

  return {
    dispose() {
      terminal.attachCustomKeyEventHandler(() => true);
      for (const dispose of disposables) dispose();
    },
  };
}
