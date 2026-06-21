/**
 * Custom window controls for the borderless (unframed) IWA window.
 *
 * With `display_override: ["borderless"]` the OS draws no title bar or caption
 * buttons — the whole window is web content — so the app must provide its own
 * draggable title bar and minimize / maximize-restore / close controls. These
 * are styled to match ChromeOS caption buttons (frameless glyphs with a gray
 * circular hover highlight).
 *
 * Window actions use the Additional Windowing Controls API
 * (`window.minimize/maximize/restore`, gated by the `window-management`
 * permission) with feature detection; `window.close()` always works for an app
 * window. In a plain browser tab the browser supplies its own frame, so the
 * custom title bar is not shown.
 */

type AcwWindow = Window & {
  minimize?: () => Promise<void> | void;
  maximize?: () => Promise<void> | void;
  restore?: () => Promise<void> | void;
  displayState?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
};

const TITLEBAR_ID = 'app-titlebar';
/** Slot in the caption (left of the window controls) the terminal tab strip
 *  moves into when the window is unframed. Empty on non-tabbed pages. */
export const CAPTION_TABS_SLOT_ID = 'app-titlebar-tabs';

// 16×16 glyphs, centered, using currentColor so they follow the theme.
const ICONS = {
  minimize: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  maximize: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.1" y="4.1" width="7.8" height="7.8" rx="1.2" stroke="currentColor" stroke-width="1.3"/></svg>',
  restore: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="6" width="6" height="6" rx="1.1" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 4.6h4.2c.66 0 1.2.54 1.2 1.2v4.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

/** True when the app owns the whole window (no OS-drawn title bar). */
function isAppWindow(): boolean {
  if (new URLSearchParams(location.search).get('chrome') === 'force') return true;
  // Only the frameless modes: the OS draws no title bar, so the app must draw
  // its own. In standalone/tabbed the OS still draws a caption, and adding ours
  // there stacks a second title bar under the native one (device-confirmed).
  return ['borderless', 'unframed'].some(
    (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
  );
}

function isMaximized(): boolean {
  // Additional Windowing Controls exposes window.displayState and a
  // (display-state: maximized) media feature; fall back to a size heuristic.
  const state = (window as AcwWindow).displayState;
  if (state) return state === 'maximized';
  if (window.matchMedia('(display-state: maximized)').matches) return true;
  return (
    Math.abs(window.outerWidth - screen.availWidth) <= 4 &&
    Math.abs(window.outerHeight - screen.availHeight) <= 4
  );
}

/** Request window-management up front so borderless + ACW are usable. */
async function ensureWindowManagement(): Promise<void> {
  try {
    const status = await navigator.permissions?.query({ name: 'window-management' as PermissionName });
    if (status && status.state === 'prompt' && 'getScreenDetails' in window) {
      // getScreenDetails triggers the permission prompt under a user gesture; if
      // called without one it simply rejects and we keep the default frame.
      await (window as unknown as { getScreenDetails: () => Promise<unknown> }).getScreenDetails().catch(() => undefined);
    }
  } catch {
    /* permission API unavailable — controls still render, actions feature-detect */
  }
}

export function installWindowControls(): void {
  // window-management is what unlocks unframed/borderless, and it may only be
  // granted a beat after load (flipping the window from standalone to unframed).
  // Mount immediately if already frameless, and re-check on display-mode changes
  // so the caption appears once the mode flips — without it the user is stuck
  // with the native standalone bar even after the grant.
  mountCaption();
  for (const mode of ['unframed', 'borderless']) {
    window.matchMedia(`(display-mode: ${mode})`).addEventListener?.('change', mountCaption);
  }
  void ensureWindowManagement();
}

function mountCaption(): void {
  if (!isAppWindow()) return;
  if (document.getElementById(TITLEBAR_ID)) return;
  document.documentElement.classList.add('app-chrome');

  const bar = document.createElement('div');
  bar.id = TITLEBAR_ID;
  bar.className = 'titlebar';
  bar.innerHTML = `
    <div class="titlebar-tabs" id="${CAPTION_TABS_SLOT_ID}"></div>
    <div class="titlebar-drag"><span class="titlebar-title"></span></div>
    <div class="win-controls">
      <button class="win-btn" type="button" data-act="minimize" aria-label="Minimize">${ICONS.minimize}</button>
      <button class="win-btn" type="button" data-act="maximize" aria-label="Maximize">${ICONS.maximize}</button>
      <button class="win-btn win-close" type="button" data-act="close" aria-label="Close">${ICONS.close}</button>
    </div>`;
  document.body.prepend(bar);
  // Let the terminal view relocate its tab strip into the caption slot now that
  // it exists (the caption can mount after the terminal renders).
  window.dispatchEvent(new CustomEvent('app-caption-mounted'));

  // Mirror the document title into the caption (ChromeOS shows the window title).
  const titleEl = bar.querySelector<HTMLElement>('.titlebar-title')!;
  const syncTitle = (): void => { titleEl.textContent = document.title; };
  syncTitle();
  const titleNode = document.querySelector('title');
  if (titleNode) new MutationObserver(syncTitle).observe(titleNode, { childList: true });

  const maxBtn = bar.querySelector<HTMLButtonElement>('[data-act="maximize"]')!;
  const syncMaxIcon = (): void => {
    const max = isMaximized();
    maxBtn.innerHTML = max ? ICONS.restore : ICONS.maximize;
    maxBtn.setAttribute('aria-label', max ? 'Restore' : 'Maximize');
  };
  syncMaxIcon();
  window.addEventListener('resize', syncMaxIcon);
  // Prefer the ACW state-change event; fall back to the media-feature change.
  window.addEventListener('displaystatechange', syncMaxIcon);
  window.matchMedia('(display-state: maximized)').addEventListener?.('change', syncMaxIcon);

  const w = window as AcwWindow;
  const toggleMaximize = async (): Promise<void> => {
    if (isMaximized()) await w.restore?.();
    else await w.maximize?.();
    syncMaxIcon();
  };
  bar.querySelector('[data-act="minimize"]')?.addEventListener('click', () => void w.minimize?.());
  maxBtn.addEventListener('click', () => void toggleMaximize());
  bar.querySelector('[data-act="close"]')?.addEventListener('click', () => window.close());
  // ChromeOS: double-clicking the caption (not a button) maximizes/restores.
  bar.addEventListener('dblclick', (event) => {
    if (!(event.target as Element)?.closest('.win-controls')) void toggleMaximize();
  });
}
