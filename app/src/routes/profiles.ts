import { Router } from '../app-shell/router';
import { identitySelectMarkup, wireIdentityImportButton } from '../ssh/KeyImport';
import { deleteProfile, listIdentities, listProfiles, saveProfile } from '../storage/indexedDb';
import type { Profile } from '../settings/types';
import { escapeHtml, shell } from './shared';

function profileRow(profile: Profile): string {
  const protocol = profile.protocol ?? 'ssh';
  return `
    <li class="profile-manage-row" data-profile-id="${escapeHtml(profile.id)}">
      <div class="profile-manage-row__info">
        <strong>${escapeHtml(profile.name)}</strong>
        <span class="muted">${escapeHtml(protocol)} ${escapeHtml(profile.username)}@${escapeHtml(profile.host)}:${profile.port}</span>
      </div>
      <div class="profile-manage-row__actions">
        <button type="button" class="btn" data-action="connect">Connect</button>
        <button type="button" class="btn" data-action="edit">Edit</button>
        <button type="button" class="btn danger" data-action="delete">Delete</button>
      </div>
    </li>
  `;
}

function renderEditor(profile: Profile | undefined, identityOptions: string): string {
  const isEdit = Boolean(profile);
  return `
    <form id="profile-editor" class="form panel">
      <h2>${isEdit ? 'Edit profile' : 'New profile'}</h2>
      <input type="hidden" id="profile-id" value="${escapeHtml(profile?.id ?? '')}" />
      <div class="form-row">
        <label for="profile-name">Name</label>
        <input id="profile-name" name="name" type="text" required value="${escapeHtml(profile?.name ?? '')}" />
      </div>
      <div class="form-row">
        <label for="profile-protocol">Protocol</label>
        <select id="profile-protocol" name="protocol">
          <option value="ssh"${(profile?.protocol ?? 'ssh') === 'ssh' ? ' selected' : ''}>SSH</option>
          <option value="mosh"${profile?.protocol === 'mosh' ? ' selected' : ''}>Mosh</option>
        </select>
      </div>
      <div class="form-row">
        <label for="profile-host">Host</label>
        <input id="profile-host" name="host" type="text" required value="${escapeHtml(profile?.host ?? '')}" />
      </div>
      <div class="form-row">
        <label for="profile-port">Port</label>
        <input id="profile-port" name="port" type="number" required min="1" max="65535"
          value="${profile?.port ?? 22}" />
      </div>
      <div class="form-row">
        <label for="profile-username">Username</label>
        <input id="profile-username" name="username" type="text" required
          value="${escapeHtml(profile?.username ?? '')}" />
      </div>
      <div class="form-row">
        <label for="profile-identity">Identity</label>
        <div class="identity-row">
          <select id="profile-identity" name="identity">${identityOptions}</select>
          <button type="button" id="profile-import-identity" class="btn">Import key</button>
        </div>
      </div>
      <div class="form-row">
        <label for="profile-connection-args">SSH arguments</label>
        <input id="profile-connection-args" name="connectionArgs" type="text"
          value="${escapeHtml(profile?.connectionArgs ?? '')}" placeholder="-o ServerAliveInterval=30" />
      </div>
      <div class="form-row">
        <label for="profile-startup">Startup command</label>
        <input id="profile-startup" name="startupCommand" type="text"
          value="${escapeHtml(profile?.startupCommand ?? '')}" />
      </div>
      <div class="button-row">
        <button type="submit" class="btn primary">${isEdit ? 'Save' : 'Create'}</button>
        <button type="button" id="profile-editor-cancel" class="btn">Cancel</button>
      </div>
    </form>
  `;
}

export async function renderProfiles(root: HTMLElement): Promise<void> {
  const [profiles, identities] = await Promise.all([listProfiles(), listIdentities()]);
  const editingId = new URLSearchParams(window.location.search).get('edit') ?? undefined;
  const editing = editingId ? profiles.find((p) => p.id === editingId) : undefined;
  const showEditor = window.location.search.includes('new') || Boolean(editing);
  const identityOptions = identitySelectMarkup(identities, editing?.identityId);

  const listMarkup =
    profiles.length === 0
      ? `<p class="muted">No profiles yet.</p>`
      : `<ul class="profile-manage-list">${profiles.map(profileRow).join('')}</ul>`;

  root.innerHTML = shell(
    'Profiles',
    `
      ${showEditor ? renderEditor(editing, identityOptions) : ''}
      <section class="panel">
        <div class="panel__header-row">
          <h2>Saved profiles</h2>
          ${showEditor ? '' : '<button type="button" id="new-profile" class="btn primary">New profile</button>'}
        </div>
        ${listMarkup}
      </section>
    `,
    `<button type="button" id="header-connect" class="btn primary">Connect</button>`,
  );

  root.querySelector('#header-connect')?.addEventListener('click', () => Router.go('/connect'));
  root.querySelector('#new-profile')?.addEventListener('click', () => Router.go('/profiles?new'));
  root.querySelector('#profile-editor-cancel')?.addEventListener('click', () => Router.go('/profiles'));
  await wireIdentityImportButton(root, '#profile-identity', 'profile-import-identity');

  root.querySelector('#profile-editor')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const existingId = (root.querySelector<HTMLInputElement>('#profile-id')?.value || '').trim();

    const identityId = String(data.get('identity') ?? '') || undefined;

    const profile: Profile = {
      id: existingId || crypto.randomUUID(),
      name: String(data.get('name') ?? '').trim(),
      protocol: String(data.get('protocol') ?? 'ssh') === 'mosh' ? 'mosh' : 'ssh',
      host: String(data.get('host') ?? '').trim(),
      port: Number(data.get('port') ?? 22),
      username: String(data.get('username') ?? '').trim(),
      identityId,
      connectionArgs: String(data.get('connectionArgs') ?? '').trim() || undefined,
      startupCommand: String(data.get('startupCommand') ?? '').trim() || undefined,
      lastConnectedAt: editing?.lastConnectedAt,
    };

    if (!profile.name || !profile.host || !profile.username) return;
    await saveProfile(profile);
    Router.go('/profiles');
  });

  root.querySelectorAll('.profile-manage-row').forEach((row) => {
    const id = (row as HTMLElement).dataset.profileId;
    if (!id) return;

    row.querySelector('[data-action="connect"]')?.addEventListener('click', () => {
      Router.go(`/connect?profile=${encodeURIComponent(id)}`);
    });
    row.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
      Router.go(`/profiles?edit=${encodeURIComponent(id)}`);
    });
    row.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      if (!window.confirm('Delete this profile?')) return;
      await deleteProfile(id);
      await renderProfiles(root);
    });
  });
}
