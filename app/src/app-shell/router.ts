import { getTabManager } from './TabManager';
import { showBootError } from '../security/bootError';

export type RouteMatch = {
  name: string;
  params: Record<string, string>;
  query: URLSearchParams;
};

export type RouteHandler = (match: RouteMatch) => void | Promise<void>;

type RouteDef = {
  name: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
};

function compilePath(pathPattern: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regex = pathPattern
    .replace(/\//g, '\\/')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });

  return {
    pattern: new RegExp(`^${regex}$`),
    paramNames,
  };
}

export class Router {
  private readonly routes: RouteDef[] = [];
  private notFoundHandler: RouteHandler = () => undefined;
  private static onNavigate: ((path: string) => void) | null = null;

  /** Called after each successful route render to sync simulated tab strip. */
  static setNavigateHook(hook: (path: string) => void): void {
    Router.onNavigate = hook;
  }

  on(pathPattern: string, name: string, handler: RouteHandler): this {
    const { pattern, paramNames } = compilePath(pathPattern);
    this.routes.push({ name, pattern, paramNames, handler });
    return this;
  }

  onNotFound(handler: RouteHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  async navigate(pathname: string, query = new URLSearchParams()): Promise<void> {
    const path = pathname.replace(/\/+$/, '') || '/';
    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
      });

      await route.handler({ name: route.name, params, query });
      Router.onNavigate?.(path + (query.toString() ? `?${query}` : ''));
      return;
    }

    await this.notFoundHandler({ name: 'not-found', params: {}, query });
  }

  start(): void {
    const run = async () => {
      try {
        await this.navigate(window.location.pathname, new URLSearchParams(window.location.search));
      } catch (error) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        showBootError(detail);
        console.error('Route navigation failed', error);
      }
    };
    window.addEventListener('popstate', () => {
      void run();
    });
    void run();
  }

  static go(path: string): void {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  /** Open a new app tab (simulated strip in dev, browser tab in native IWA). */
  static openTab(path: string, title?: string): void {
    const tabs = getTabManager();
    if (tabs) {
      tabs.openTab(path, title);
      return;
    }
    window.open(path, '_blank');
  }
}
