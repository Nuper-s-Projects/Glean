import { peekPendingInvite } from './invite';

export const LOOP_ROUTES_ENABLED = import.meta.env.VITE_ENABLE_LOOP_ROUTES !== 'false';

export const ROUTES = Object.freeze({
  SIGN_IN: 'signin',
  SIGN_UP: 'signup',
  USERNAME: 'username',
  ACCOUNT: 'account',
  APP: 'app',
  SERVERS: 'servers',
  LOOP: 'loop',
});

const paths = Object.freeze({
  [ROUTES.SIGN_IN]: '/signin',
  [ROUTES.SIGN_UP]: '/signup',
  [ROUTES.USERNAME]: '/setup/username',
  [ROUTES.ACCOUNT]: '/account',
  [ROUTES.APP]: '/dms',
  [ROUTES.SERVERS]: '/servers',
  ...(LOOP_ROUTES_ENABLED ? { [ROUTES.LOOP]: '/loop' } : {}),
});
const routeByPath = new Map(Object.entries(paths).map(([route, path]) => [path, route]));
const validRoutes = new Set(Object.keys(paths));

export function pathForRoute(route) {
  return paths[route] || paths[ROUTES.SIGN_IN];
}

export function routeFromLocation() {
  const legacy = window.location.hash.slice(1);
  if (validRoutes.has(legacy)) {
    const path = pathForRoute(legacy);
    window.history.replaceState({}, '', path);
    return legacy;
  }
  const cleanPath = window.location.pathname.replace(/\/+$/, '') || '/';
  return routeByPath.get(cleanPath) || null;
}

export const routeFromHash = routeFromLocation;

export function resolveRoute(route, account) {
  if (!account) return route === ROUTES.SIGN_UP ? ROUTES.SIGN_UP : ROUTES.SIGN_IN;
  if (!account.username) return ROUTES.USERNAME;
  if (peekPendingInvite()) return ROUTES.SERVERS;
  if ([ROUTES.APP, ROUTES.SERVERS, ROUTES.ACCOUNT, ...(LOOP_ROUTES_ENABLED ? [ROUTES.LOOP] : [])].includes(route)) return route;
  return ROUTES.APP;
}
