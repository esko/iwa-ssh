import { Router } from '../app-shell/router';
import { listProfiles } from '../storage/indexedDb';
import { createTerminalHomeModel } from '../terminal-shell';
import { escapeHtml, shell } from './shared';

export async function renderHome(root: HTMLElement): Promise<void> {
  const profiles = await listProfiles();
  const model = createTerminalHomeModel(profiles, import.meta.env.DEV);

  const profileCards =
    model.recentProfiles.length === 0
      ? `<p class="muted">No profiles yet. Create one to start connecting.</p>`
      : `<ul class="profile-list">
          ${model.recentProfiles
            .map(
              (p) => `
            <li class="profile-card">
              <button type="button" data-profile-id="${p.id}" class="profile-card__button">
                <span class="profile-card__name">${escapeHtml(p.label)}</span>
                <span class="profile-card__host">${escapeHtml(p.description)}</span>
              </button>
            </li>`,
            )
            .join('')}
        </ul>`;

  root.innerHTML = shell(
    'Home',
    `
      <section class="panel">
        <h2>Recent profiles</h2>
        ${profileCards}
      </section>
      <section class="panel">
        <h2>Quick actions</h2>
        <div class="button-row">
          <button type="button" id="new-connection" class="btn primary">New connection</button>
          <button type="button" id="manage-profiles" class="btn">Manage profiles</button>
          <button type="button" id="open-settings" class="btn">Settings</button>
          ${model.actions.includes('debug') ? '<button type="button" id="open-dev" class="btn">Dev inspector</button>' : ''}
        </div>
      </section>
    `,
    `<button type="button" id="header-connect" class="btn primary">Connect</button>`,
  );

  root.querySelector('#new-connection')?.addEventListener('click', () => Router.openTab('/connect', 'Connect'));
  root.querySelector('#header-connect')?.addEventListener('click', () => Router.openTab('/connect', 'Connect'));
  root.querySelector('#manage-profiles')?.addEventListener('click', () => Router.go('/profiles'));
  root.querySelector('#open-settings')?.addEventListener('click', () => Router.go('/settings'));
  root.querySelector('#open-dev')?.addEventListener('click', () => Router.go('/debug'));

  root.querySelectorAll('[data-profile-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.profileId;
      if (id) Router.go(`/connect?profile=${encodeURIComponent(id)}`);
    });
  });
}
