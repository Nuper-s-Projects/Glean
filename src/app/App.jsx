import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentAccount, peekCachedAccount, rememberAccount, clearClientCaches, signOut as signOutAccount } from './storage';
import { stashInviteFromLocation } from './invite';
import { LOOP_ROUTES_ENABLED, pathForRoute, resolveRoute, routeFromLocation, ROUTES } from './routes';
import SignInScreen from '../screens/SignInScreen';
import SignUpScreen from '../screens/SignUpScreen';
import UsernameScreen from '../screens/UsernameScreen';
import GradePromptModal from '../components/GradePromptModal';
import ProgramPromptModal from '../components/ProgramPromptModal';
import SocialLinksPromptModal from '../components/SocialLinksPromptModal';
import { UserPopoutProvider } from '../features/dm/userPopout';
import { ImagePreviewProvider } from '../features/dm/ImagePreview';
import { DmCallProvider } from '../features/dm/DmCall';
import { disableDesktopPush, enableDesktopPush, notificationPermission, startDesktopPush } from './desktopPush';
import { applyUpdate, dismissInstallHint, promptInstall, subscribePwa } from './pwa';
import { invalidateServersCache } from './dmApi';
import { applyAccessibilitySettings } from './accessibility';
import GleanErrorState from '../components/GleanErrorState';
import AgreementPromptModal from '../components/AgreementPromptModal';
import PlatformAnnouncement from '../components/PlatformAnnouncement';
import { CONDUCT_VERSION, TERMS_VERSION } from './agreements';
import { isDeveloperModeEnabled, subscribeDeveloperMode } from './developerMode';
import DeveloperModeWindow from '../features/dm/DeveloperModeWindow';
import BackupLinksModal from '../components/BackupLinksModal';
import { loopReturnPath, loopSignInPath } from './loopEntry';
import MainThemeBackdrop from './MainThemeBackdrop';

const BACKUP_LINKS_DISMISSED_KEY = 'glean-backup-links-dismissed-v1';

function hasDismissedBackupLinks(accountId) {
  const key = `${BACKUP_LINKS_DISMISSED_KEY}:${accountId}`;
  try { return window.localStorage.getItem(key) === '1'; } catch {
    try { return window.sessionStorage.getItem(key) === '1'; } catch { return false; }
  }
}

const TRANSITION_MS = 180;
const AccountScreen = lazy(() => import('../screens/AccountScreen'));
const DirectMessagesScreen = lazy(() => import('../screens/DirectMessagesScreen'));
const CommunityScreen = lazy(() => import('../screens/CommunityScreen'));
const LoopScreen = LOOP_ROUTES_ENABLED ? lazy(() => import('../screens/LoopScreen')) : null;

function hasAcceptedCurrentAgreements(account) {
  return account?.agreementsAccepted === true && account.termsVersion === TERMS_VERSION && account.conductVersion === CONDUCT_VERSION;
}

function unknownRoutePath() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/' || ['/signin', '/signup', '/account', '/dms', '/servers', '/setup/username'].includes(pathname)) return null;
  if (LOOP_ROUTES_ENABLED && pathname === '/loop') return null;
  if (/^\/invite\/[A-Za-z0-9_-]{6,32}$/i.test(pathname)) return null;
  return pathname;
}

function screenForRoute(route, props) {
  if (route === ROUTES.SIGN_UP) return <SignUpScreen {...props} />;
  if (route === ROUTES.USERNAME) return <UsernameScreen {...props} />;
  if (route === ROUTES.ACCOUNT) return <AccountScreen {...props} />;
  if (route === ROUTES.APP) return <DirectMessagesScreen {...props} />;
  if (route === ROUTES.SERVERS) return <CommunityScreen {...props} />;
  if (route === ROUTES.LOOP && LOOP_ROUTES_ENABLED && LoopScreen) return <LoopScreen {...props} />;
  return <SignInScreen {...props} />;
}

export default function App() {
  const pendingLoop = useRef(LOOP_ROUTES_ENABLED ? loopReturnPath(window.location) : null);
  const [displayedRoute, setDisplayedRoute] = useState(() => {
    const cached = peekCachedAccount();
    return resolveRoute(routeFromLocation() || (cached ? ROUTES.APP : ROUTES.SIGN_IN), cached);
  });
  const [account, setAccount] = useState(() => peekCachedAccount());
  const [authReady, setAuthReady] = useState(() => Boolean(peekCachedAccount()));
  const [isLeaving, setIsLeaving] = useState(false);
  const transitionTimeout = useRef(null);
  const targetRoute = useRef(displayedRoute);
  const accountRef = useRef(account);
  const [runtimeError, setRuntimeError] = useState(null);
  const [developerMode, setDeveloperMode] = useState(() => isDeveloperModeEnabled());
  const [routeMotion, setRouteMotion] = useState('');
  const [routeError, setRouteError] = useState(() => unknownRoutePath());
  const [pushHint, setPushHint] = useState(false);
  const [pwa, setPwa] = useState(() => ({ standalone: false, canInstall: false, updateReady: false, offline: false, showInstallHint: false }));
  const [showBackupLinks, setShowBackupLinks] = useState(false);

  useEffect(() => {
    setShowBackupLinks(hasAcceptedCurrentAgreements(account) && !hasDismissedBackupLinks(account.id));
  }, [account?.id, account?.agreementsAccepted, account?.termsVersion, account?.conductVersion]);

  const dismissBackupLinks = useCallback(() => {
    const key = `${BACKUP_LINKS_DISMISSED_KEY}:${account?.id}`;
    try { window.localStorage.setItem(key, '1'); } catch {
      try { window.sessionStorage.setItem(key, '1'); } catch { /* Keep this dismissal for the current app session. */ }
    }
    setShowBackupLinks(false);
  }, [account?.id]);

  useEffect(() => {
    const onError = (event) => setRuntimeError(import.meta.env.DEV ? (event.error?.stack || event.message || 'Unknown application error') : 'Glean hit an unexpected error. Please retry.');
    const onRejection = (event) => setRuntimeError(import.meta.env.DEV ? (event.reason?.stack || event.reason?.message || String(event.reason || 'Unhandled promise rejection')) : 'Glean hit an unexpected error. Please retry.');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);

  useEffect(() => subscribePwa(setPwa), []);
  useEffect(() => subscribeDeveloperMode(setDeveloperMode), []);

  useEffect(() => {
    const apply = () => applyAccessibilitySettings(account?.accessibility);
    apply();
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    motionPreference.addEventListener('change', apply);
    return () => motionPreference.removeEventListener('change', apply);
  }, [account?.id, account?.accessibility?.theme, account?.accessibility?.contrast, account?.accessibility?.saturation, account?.accessibility?.glassFrost, account?.accessibility?.glassDepth, account?.accessibility?.glassRefraction, displayedRoute]);

  const transitionTo = useCallback((nextRoute) => {
    if (nextRoute === targetRoute.current && !transitionTimeout.current) return;

    const currentRoute = targetRoute.current;
    const isDmServerTransition = (currentRoute === ROUTES.APP && nextRoute === ROUTES.SERVERS)
      || (currentRoute === ROUTES.SERVERS && nextRoute === ROUTES.APP);
    setRouteMotion(isDmServerTransition ? (currentRoute === ROUTES.APP ? 'forward' : 'backward') : '');
    targetRoute.current = nextRoute;
    if (transitionTimeout.current) window.clearTimeout(transitionTimeout.current);
    setIsLeaving(true);

    transitionTimeout.current = window.setTimeout(() => {
      setDisplayedRoute(nextRoute);
      setIsLeaving(false);
      transitionTimeout.current = null;
    }, TRANSITION_MS);
  }, []);

  const navigate = useCallback((nextRoute) => {
    if (nextRoute === ROUTES.LOOP && !accountRef.current) pendingLoop.current = '/loop';
    const target = resolveRoute(nextRoute, accountRef.current);
    const path = pendingLoop.current && [ROUTES.SIGN_IN,ROUTES.SIGN_UP,ROUTES.USERNAME].includes(target)
      ? `${pathForRoute(target)}?${new URLSearchParams({next:pendingLoop.current})}` : pathForRoute(target);
    if (![ROUTES.SIGN_IN,ROUTES.SIGN_UP,ROUTES.USERNAME,ROUTES.LOOP].includes(target)) pendingLoop.current = null;
    if (target === targetRoute.current) return;
    window.history.pushState({}, '', path);
    transitionTo(target);
  }, [transitionTo]);

  const completeAuthentication = useCallback((nextAccount) => {
    rememberAccount(nextAccount);
    accountRef.current = nextAccount;
    setAccount(nextAccount);
    const target = resolveRoute(pendingLoop.current ? ROUTES.LOOP : ROUTES.APP, nextAccount);
    const path = target === ROUTES.LOOP ? pendingLoop.current || '/loop'
      : pendingLoop.current && target === ROUTES.USERNAME ? `${pathForRoute(target)}?${new URLSearchParams({next:pendingLoop.current})}` : pathForRoute(target);
    if (target !== ROUTES.USERNAME) pendingLoop.current = null;
    window.history.pushState({}, '', path);
    transitionTo(target);
  }, [transitionTo]);

  const completeSignOut = useCallback(() => {
    pendingLoop.current = null;
    disableDesktopPush();
    invalidateServersCache();
    clearClientCaches();
    accountRef.current = null;
    setAccount(null);
    setPushHint(false);
    window.history.replaceState({}, '', pathForRoute(ROUTES.SIGN_IN));
    transitionTo(ROUTES.SIGN_IN);
  }, [transitionTo]);

  const updateAccount = useCallback((nextAccount) => {
    rememberAccount(nextAccount);
    accountRef.current = nextAccount;
    setAccount(nextAccount);
  }, []);

  const signOutFromAgreement = useCallback(async () => {
    try { await signOutAccount(); } catch { /* Clear local state even if the server is unreachable. */ }
    completeSignOut();
  }, [completeSignOut]);

  useEffect(() => {
    let cancelled = false;
    getCurrentAccount().then((currentAccount) => {
      if (cancelled) return;
      stashInviteFromLocation();
      rememberAccount(currentAccount);
      accountRef.current = currentAccount;
      setAccount(currentAccount);
      const requestedRoute = routeFromLocation();
      setRouteError(unknownRoutePath());
      const initialRoute = pendingLoop.current && currentAccount && [ROUTES.SIGN_IN,ROUTES.SIGN_UP,ROUTES.USERNAME].includes(requestedRoute) ? ROUTES.LOOP : requestedRoute || (currentAccount ? ROUTES.APP : ROUTES.SIGN_IN);
      const target = resolveRoute(initialRoute, currentAccount);
      const path = pendingLoop.current && [ROUTES.SIGN_IN,ROUTES.SIGN_UP,ROUTES.USERNAME].includes(target) ? `${pathForRoute(target)}?${new URLSearchParams({next:pendingLoop.current})}`
        : target === ROUTES.LOOP && pendingLoop.current ? pendingLoop.current : pathForRoute(target);
      if (target !== requestedRoute || window.location.pathname !== pathForRoute(target)) window.history.replaceState({}, '', path);
      targetRoute.current = target;
      setDisplayedRoute(target);
      setAuthReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onRouteChange = () => {
      stashInviteFromLocation();
      const nextRouteError = unknownRoutePath();
      setRouteError(nextRouteError);
      if (nextRouteError) return;
      const requestedRoute = routeFromLocation() || (accountRef.current ? ROUTES.APP : ROUTES.SIGN_IN);
      pendingLoop.current = LOOP_ROUTES_ENABLED ? loopReturnPath(window.location) : null;
      const target = resolveRoute(pendingLoop.current && accountRef.current && [ROUTES.SIGN_IN,ROUTES.SIGN_UP,ROUTES.USERNAME].includes(requestedRoute) ? ROUTES.LOOP : requestedRoute, accountRef.current);
      const path = target === ROUTES.SIGN_IN && pendingLoop.current ? loopSignInPath(pendingLoop.current) : pathForRoute(target);
      if (target !== requestedRoute || window.location.pathname !== pathForRoute(target)) window.history.replaceState({}, '', path);
      transitionTo(target);
    };
    window.addEventListener('popstate', onRouteChange);
    return () => {
      window.removeEventListener('popstate', onRouteChange);
      if (transitionTimeout.current) window.clearTimeout(transitionTimeout.current);
    };
  }, [transitionTo]);

  useEffect(() => {
    const onOpenDm = (event) => {
      const username = String(event.detail?.username || '').trim();
      const conversationId = Number(event.detail?.conversationId);
      if (!username && !(Number.isInteger(conversationId) && conversationId > 0)) return;
      if (targetRoute.current === ROUTES.APP) return;
      if (username) {
        try { sessionStorage.setItem('glean.openUsername', username); } catch { /* ignore */ }
      }
      if (Number.isInteger(conversationId) && conversationId > 0) {
        try { sessionStorage.setItem('glean.openConversationId', String(conversationId)); } catch { /* ignore */ }
      }
      navigate(ROUTES.APP);
    };
    window.addEventListener('glean-open-dm', onOpenDm);
    return () => window.removeEventListener('glean-open-dm', onOpenDm);
  }, [navigate]);

  useEffect(() => {
    const onOpenFriendRequest = (event) => {
      const username = String(event.detail?.username || '').trim();
      if (!username) return;
      if (targetRoute.current !== ROUTES.APP) {
        try { sessionStorage.setItem('glean.friendRequestUsername', username); } catch { /* ignore */ }
        navigate(ROUTES.APP);
      }
    };
    window.addEventListener('glean-open-friend-request', onOpenFriendRequest);
    return () => window.removeEventListener('glean-open-friend-request', onOpenFriendRequest);
  }, [navigate]);

  useEffect(() => {
    const onOpenServer = (event) => {
      const serverId = Number(event.detail?.serverId || event.detail?.server?.id);
      if (!(Number.isInteger(serverId) && serverId > 0)) return;
      try { sessionStorage.setItem('glean.activeServerId', String(serverId)); } catch { /* ignore */ }
      navigate(ROUTES.SERVERS);
    };
    window.addEventListener('glean-open-server', onOpenServer);
    return () => window.removeEventListener('glean-open-server', onOpenServer);
  }, [navigate]);

  useEffect(() => {
    if (!hasAcceptedCurrentAgreements(account) || !account?.username) return undefined;
    let idleId = 0;
    const start = () => {
      startDesktopPush().then(() => {
        setPushHint(notificationPermission() === 'default');
      }).catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') idleId = window.requestIdleCallback(start, { timeout: 2500 });
    else idleId = window.setTimeout(start, 600);
    return () => {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
    };
  }, [account?.id, account?.username, account?.agreementsAccepted, account?.termsVersion, account?.conductVersion]);

  if (!authReady) {
    return <div className="app-loading" aria-label="Loading Glean" />;
  }

  return (
    <UserPopoutProvider account={hasAcceptedCurrentAgreements(account) ? account : null} onAccountUpdated={updateAccount}>
      <MainThemeBackdrop preferences={account?.mainThemes} enabled={Boolean(account) && displayedRoute !== ROUTES.LOOP} />
      <ImagePreviewProvider>
      <DmCallProvider account={hasAcceptedCurrentAgreements(account) ? account : null}>
      {hasAcceptedCurrentAgreements(account) ? <PlatformAnnouncement account={account} /> : null}
      {hasAcceptedCurrentAgreements(account) && pwa.offline ? <div className="glean-offline-bar" role="status">You're offline. Cached Glean still opens; new messages wait until you're back.</div> : null}
      {account && !hasAcceptedCurrentAgreements(account) ? <div className="agreement-app-blocked" aria-hidden="true" /> : (
        <div className={`screen-transition ${displayedRoute === ROUTES.LOOP ? 'is-loop-screen' : ''} ${routeMotion ? `is-dms-server-route is-route-${routeMotion}` : ''} ${isLeaving ? 'is-leaving' : 'is-entering'}`} style={displayedRoute === ROUTES.LOOP ? { position: 'fixed', inset: 0, width: '100vw', height: '100dvh', minHeight: '100dvh', maxWidth: 'none', margin: 0, padding: 0, overflow: 'hidden' } : undefined} key={displayedRoute}>
          <Suspense fallback={<div className="app-loading" aria-label="Loading Glean" />}>
            {routeError ? <GleanErrorState fullPage title="Page not found" description={`Glean could not find ${routeError}.`} /> : screenForRoute(displayedRoute, {
              goTo: navigate,
              account,
              authReady,
              onAuthenticated: completeAuthentication,
              onSignedOut: completeSignOut,
              onAccountUpdated: updateAccount,
            })}
          </Suspense>
        </div>
      )}
      {hasAcceptedCurrentAgreements(account) && developerMode ? <DeveloperModeWindow /> : null}
      {hasAcceptedCurrentAgreements(account) && pwa.updateReady ? (
        <div className="glean-push-hint">
          <span>A new Glean version is ready.</span>
          <button type="button" onClick={applyUpdate}>Reload</button>
        </div>
      ) : hasAcceptedCurrentAgreements(account) && pwa.showInstallHint ? (
        <div className="glean-push-hint">
          <span>Install Glean for a full-screen app, Home Screen icon, and better notifications.</span>
          <button type="button" onClick={() => promptInstall().catch(() => {})}>Install</button>
          <button type="button" onClick={dismissInstallHint} aria-label="Dismiss">×</button>
        </div>
      ) : hasAcceptedCurrentAgreements(account) && pushHint ? (
        <div className="glean-push-hint">
          <span>Turn on notifications so you still get DMs and server pings when Glean is closed.</span>
          <button type="button" onClick={() => enableDesktopPush().then(() => setPushHint(false)).catch(() => setPushHint(false))}>Enable</button>
          <button type="button" onClick={() => setPushHint(false)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {account && !hasAcceptedCurrentAgreements(account) ? <AgreementPromptModal account={account} onAccepted={updateAccount} onSignOut={signOutFromAgreement} /> : null}
      {hasAcceptedCurrentAgreements(account) && (account.grade == null || account.school == null) ? <GradePromptModal account={account} onSaved={updateAccount} /> : null}
      {hasAcceptedCurrentAgreements(account) && account.grade != null && account.school != null && account.programAnswered !== true ? <ProgramPromptModal account={account} onSaved={updateAccount} /> : null}
      {hasAcceptedCurrentAgreements(account) && account.grade != null && account.school != null && account.programAnswered === true && !account.socialPromptSeen ? <SocialLinksPromptModal account={account} onSaved={updateAccount} /> : null}
      {showBackupLinks && hasAcceptedCurrentAgreements(account) ? <BackupLinksModal onDismiss={dismissBackupLinks} /> : null}
      {hasAcceptedCurrentAgreements(account) && runtimeError ? <GleanErrorState title="Glean ran into a problem" description="Something did not load correctly. You can report it so it can be fixed." error={runtimeError} onDismiss={() => setRuntimeError(null)} /> : null}
      </DmCallProvider>
      </ImagePreviewProvider>
    </UserPopoutProvider>
  );
}
