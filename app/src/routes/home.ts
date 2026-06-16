import { Router } from '../app-shell/router';
import { listProfiles } from '../storage/indexedDb';
import { escapeHtml, shell } from './shared';

export async function renderHome(root: HTMLElement): Promise<void> {
  const profiles = await listProfiles();
  const recent = profiles.slice(0, 8);

  const profileCards =
    recent.length === 0
      ? `<p class="muted">No profiles yet. Create one to start connecting.</p>`
      : `<ul class="profile-list">
          ${recent
            .map(
              (p) => `
            <li class="profile-card">
              <button type="button" data-profile-id="${p.id}" class="profile-card__button">
                <span class="profile-card__name">${escapeHtml(p.name)}</span>
                <span class="profile-card__host">${escapeHtml(p.username)}@${escapeHtml(p.host)}:${p.port}</span>
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
        </div>
      </section>
    `,
    `<button type="button" id="header-connect" class="btn primary">Connect</button>`,
  );

  root.querySelector('#new-connection')?.addEventListener('click', () => Router.go('/connect'));
  root.querySelector('#header-connect')?.addEventListener('click', () => Router.go('/connect'));
  root.querySelector('#manage-profiles')?.addEventListener('click', () => Router.go('/profiles'));
  root.querySelector('#open-settings')?.addEventListener('click', () => Router.go('/settings'));

  root.querySelectorAll('[data-profile-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.profileId;
      if (id) Router.go(`/connect?profile=${encodeURIComponent(id)}`);
    });
  });
}
