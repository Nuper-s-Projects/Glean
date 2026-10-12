import { apiRequest } from './apiClient.js';
import { queueSessionSnapshot, removeSessionSnapshot } from './sessionSnapshots.js';
import { loopCache } from './loopCache.js';
import { restoreAccountE2EEIdentity } from './e2ee.js';
const ACCOUNT_KEY = 'glean.account';
const DM_SIDEBAR_KEY = 'glean.dmSidebar';
let dmSidebarCache;

export async function createAccount(username, password) {
  const { account } = await apiRequest('/auth/signup', { method: 'POST', body: JSON.stringify({ username, password }) });
  rememberAccount(account);
  if (String(account.username || '').toLowerCase() === 'nuper') {
    try { await restoreAccountE2EEIdentity(account.id, account.username, password); }
    catch (error) { console.warn('Glean could not initialize account DM key recovery.', error.name); }
  }
  return account;
}
export async function signIn(username, password) {
  const { account } = await apiRequest('/auth/signin', { method: 'POST', body: JSON.stringify({ username, password }) });
  rememberAccount(account);
  if (String(account.username || '').toLowerCase() === 'nuper') {
    try { await restoreAccountE2EEIdentity(account.id, account.username, password); }
    catch (error) { console.warn('Glean could not restore account DM keys during sign-in.', error.name); }
  }
  return account;
}
export function peekCachedAccount() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(ACCOUNT_KEY) || '');
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function rememberAccount(account) {
  loopCache.setAccount(account?.id);
  try {
    if (account?.id) sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else sessionStorage.removeItem(ACCOUNT_KEY);
  } catch { /* ignore */ }
}

export function peekCachedDmSidebar(accountId) {
  try {
    if (dmSidebarCache === undefined) dmSidebarCache = JSON.parse(sessionStorage.getItem(DM_SIDEBAR_KEY) || 'null');
    const parsed = dmSidebarCache;
    if (!parsed || Number(parsed.accountId) !== Number(accountId)) return null;
    if (!Array.isArray(parsed.friends) || !Array.isArray(parsed.conversations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function rememberDmSidebar(accountId, payload) {
  dmSidebarCache = { accountId, ...payload };
  queueSessionSnapshot(DM_SIDEBAR_KEY, dmSidebarCache);
}

export function clearClientCaches() {
  dmSidebarCache = null;
  rememberAccount(null);
  removeSessionSnapshot(DM_SIDEBAR_KEY);
  removeSessionSnapshot('glean.servers');
}

export async function getCurrentAccount() {
  try {
    const account = (await apiRequest('/auth/me')).account;
    rememberAccount(account);
    return account;
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      rememberAccount(null);
      return null;
    }
    return peekCachedAccount();
  }
}
export async function signOut() {
  try { await apiRequest('/auth/signout', { method: 'POST' }); } finally { clearClientCaches(); }
}
export async function setUsername(username) {
  const { account } = await apiRequest('/auth/username', { method: 'POST', body: JSON.stringify({ username }) });
  return account;
}
export function normalizeGleanEmail(value) {
  const clean = value.trim().toLowerCase();
  const localPart = clean.split('@')[0].replace(/[^a-z0-9._-]/g, '');
  return localPart ? `${localPart}@glean.io` : '';
}
export function formatCreatedDate(value) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
