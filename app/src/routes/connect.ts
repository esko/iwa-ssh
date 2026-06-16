import { Router } from '../app-shell/router';
import { getProfile, listIdentities, saveProfile } from '../storage/indexedDb';
import type { Profile } from '../settings/types';
import { escapeHtml, shell } from './shared';

export type StoredSessionParams = {
  id: string;
  profileId?: string;
  host: string;
  port: number;
  username: string;
  identityId?: string;
  startupCommand?: string;
};

function sessionStorageKey(id: string): string {
  return `session:${id}`;
}

export function storeSessionParams(params: StoredSessionParams): void {
  sessionStorage.setItem(sessionStorageKey(params.id), JSON.stringify(params));
}

export function loadSessionParams(id: string): StoredSessionParams | null {
  const raw = sessionStorage.getItem(sessionStorageKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSessionParams;
  } catch {
    return null;
  }
}

export async function renderConnect(root: HTMLElement, query: URLSearchParams): Promise<void> {
  const profileId = query.get('profile') ?? undefined;
  const profile = profileId ? await getProfile(profileId) : undefined;
  const identities = await listIdentities();

  const identityOptions = [
    '<option value="">Default (no key)</option>',
    ...identities.map(
      (id) =>
        `<option value="${escapeHtml(id.id)}"${profile?.identityId === id.id ? ' selected' : ''}>${escapeHtml(id.label)}</option>`,
    ),
  ].join('');

  root.innerHTML = shell(
    'Connect',
    `
      <form id="connect-form" class="form panel">
        <div class="form-row">
          <label for="host">Host</label>
          <input id="host" name="host" type="text" required autocomplete="off" spellcheck="false"
            value="${escapeHtml(profile?.host ?? '')}" placeholder="example.com" />
        </div>
        <div class="form-row">
          <label for="port">Port</label>
          <input id="port" name="port" type="number" required min="1" max="65535"
            value="${profile?.port ?? 22}" />
        </div>
        <div class="form-row">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" required autocomplete="username" spellcheck="false"
            value="${escapeHtml(profile?.username ?? '')}" placeholder="user" />
        </div>
        <div class="form-row">
          <label for="identity">Identity</label>
          <select id="identity" name="identity">${identityOptions}</select>
        </div>
        <div class="form-row">
          <label for="startup-command">Startup command</label>
          <input id="startup-command" name="startupCommand" type="text" autocomplete="off" spellcheck="false"
            value="${escapeHtml(profile?.startupCommand ?? '')}" placeholder="Optional command to run after login" />
        </div>
        <fieldset class="form-fieldset">
          <legend>Save profile</legend>
          <label class="checkbox-row">
            <input id="save-profile" name="saveProfile" type="checkbox" ${profile ? 'checked' : ''} />
            <span>Save connection as profile</span>
          </label>
          <div class="form-row" id="profile-name-row">
            <label for="profile-name">Profile name</label>
            <input id="profile-name" name="profileName" type="text" spellcheck="false"
              value="${escapeHtml(profile?.name ?? '')}" placeholder="My server" />
          </div>
        </fieldset>
        <div class="button-row">
          <button type="submit" class="btn primary">Connect</button>
          <button type="button" id="cancel-connect" class="btn">Cancel</button>
        </div>
      </form>
    `,
    `<button type="button" id="header-profiles" class="btn">Profiles</button>`,
  );

  const saveProfileCheckbox = root.querySelector<HTMLInputElement>('#save-profile');
  const profileNameRow = root.querySelector<HTMLElement>('#profile-name-row');

  const syncProfileNameVisibility = () => {
    if (!profileNameRow || !saveProfileCheckbox) return;
    profileNameRow.hidden = !saveProfileCheckbox.checked;
  };
  saveProfileCheckbox?.addEventListener('change', syncProfileNameVisibility);
  syncProfileNameVisibility();

  root.querySelector('#cancel-connect')?.addEventListener('click', () => Router.go('/'));
  root.querySelector('#header-profiles')?.addEventListener('click', () => Router.go('/profiles'));

  root.querySelector('#connect-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);

    const host = String(data.get('host') ?? '').trim();
    const port = Number(data.get('port') ?? 22);
    const username = String(data.get('username') ?? '').trim();
    const identityId = String(data.get('identity') ?? '') || undefined;
    const startupCommand = String(data.get('startupCommand') ?? '').trim() || undefined;
    const shouldSave = data.get('saveProfile') === 'on';
    const profileName = String(data.get('profileName') ?? '').trim();

    if (!host || !username || !Number.isFinite(port)) return;

    let savedProfileId = profile?.id;

    if (shouldSave) {
      const name = profileName || `${username}@${host}`;
      const nextProfile: Profile = {
        id: profile?.id ?? crypto.randomUUID(),
        name,
        host,
        port,
        username,
        identityId,
        startupCommand,
        lastConnectedAt: Date.now(),
      };
      await saveProfile(nextProfile);
      savedProfileId = nextProfile.id;
    } else if (profile) {
      await saveProfile({ ...profile, lastConnectedAt: Date.now() });
    }

    const sessionId = crypto.randomUUID();
    storeSessionParams({
      id: sessionId,
      profileId: savedProfileId,
      host,
      port,
      username,
      identityId,
      startupCommand,
    });

    Router.go(`/session/${encodeURIComponent(sessionId)}`);
  });
}
