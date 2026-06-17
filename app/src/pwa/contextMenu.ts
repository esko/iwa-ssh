export type ContextMenuItem =
  | { type: 'item'; label: string; key?: string; disabled?: boolean; onSelect: () => void }
  | { type: 'separator' };

let openMenu: HTMLElement | null = null;

export function closeContextMenu(): void {
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
        closeContextMenu();
        item.onSelect();
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
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 6)}px`;
  menu.style.visibility = 'visible';
  openMenu = menu;

  const dismiss = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
    if (event.type === 'pointerdown' && menu.contains(event.target as Node)) return;
    closeContextMenu();
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('keydown', dismiss, true);
    window.removeEventListener('blur', dismiss, true);
  };
  // Defer so the opening click doesn't immediately dismiss.
  setTimeout(() => {
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', dismiss, true);
    window.addEventListener('blur', dismiss, true);
  });
}
