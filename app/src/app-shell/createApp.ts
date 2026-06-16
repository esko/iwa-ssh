import { Router } from './router';
import { renderHome } from '../routes/home';
import { renderConnect } from '../routes/connect';
import { disposeActiveSession, renderSession } from '../routes/session';
import { renderSettings } from '../routes/settings';
import { renderProfiles } from '../routes/profiles';
import { renderNotFound } from '../routes/notFound';

export function createApp(root: HTMLElement): Router {
  const router = new Router();

  const leaveSession = async (render: () => void | Promise<void>) => {
    disposeActiveSession();
    root.classList.remove('popup-root');
    await render();
  };

  router
    .on('/', 'home', async () => {
      await leaveSession(() => renderHome(root));
    })
    .on('/connect', 'connect', async (match) => {
      await leaveSession(() => renderConnect(root, match.query));
    })
    .on('/session/:id', 'session', async (match) => {
      disposeActiveSession();
      root.classList.remove('popup-root');
      await renderSession(root, match.params.id);
    })
    .on('/settings', 'settings', async (match) => {
      await leaveSession(() => renderSettings(root, match.query));
    })
    .on('/profiles', 'profiles', async () => {
      await leaveSession(() => renderProfiles(root));
    })
    .onNotFound(async () => {
      await leaveSession(() => renderNotFound(root));
    });

  return router;
}
