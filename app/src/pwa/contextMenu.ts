export type ContextMenuItem =
  | { type: 'item'; label: string; key?: string; disabled?: boolean; onSelect: () => void }
  | { type: 'separator' };

let openMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  cleanup?.();
  cleanup = null;
  openMenu?.remove();
  openMenu = null;
}

/** Render a minimal black/white context menu at the pointer location. */
export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.append(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ctx-item';
    button.disabled = Boolean(item.disabled);
    button.setAttribute('role', 'menuitem');

    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);
    if (item.key) {
      const key = document.createElement('span');
      key.className = 'ctx-key';
      key.textContent = item.key;
      button.append(key);
    }
    if (!item.disabled) {
      button.addEventListener('click', () => {
        const run = item.onSelect;
        closeContextMenu();
        run();
      });
    }
    menu.append(button);
  }

  // Offscreen-measure, then clamp within the viewport.
  menu.style.left = '0';
  menu.style.top = '0';
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;
  menu.style.visibility = 'visible';
  openMenu = menu;

  // Dismiss on an outside press / Escape / blur. Capture-phase mousedown with a
  // contains() guard keeps the menu alive long enough for an item's own click
  // (mousedown inside → kept; mouseup → click → onSelect) while still closing
  // when the press lands elsewhere.
  const onMouseDown = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node)) closeContextMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeContextMenu();
  };
  cleanup = () => {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', closeContextMenu);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', closeContextMenu);
  });
}
