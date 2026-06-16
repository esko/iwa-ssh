import { Router } from '../app-shell/router';
import { shell } from './shared';

export function renderNotFound(root: HTMLElement): void {
  root.innerHTML = shell(
    'Not found',
    `
      <section class="panel">
        <p>The page you requested does not exist.</p>
        <div class="button-row">
          <button type="button" id="go-home" class="btn primary">Go home</button>
        </div>
      </section>
    `,
  );

  root.querySelector('#go-home')?.addEventListener('click', () => Router.go('/'));
}
