import { apiRequest } from './apiClient';
const ACCOUNT_KEY = 'glean.account';
const DM_SIDEBAR_KEY = 'glean.dmSidebar';

export async function createAccount(username, password) {
  const { account } = await apiRequest('/auth/signup', { method: 'POST', body: JSON.stringify({ username, password }) });
  rememberAccount(account);
  return account;
}
export async function signIn(username, password) {
  const { account } = await apiRequest('/auth/signin', { method: 'POST', body: JSON.stringify({ username, password }) });
  rememberAccount(account);
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
  try {
    if (account?.id) sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else sessionStorage.removeItem(ACCOUNT_KEY);
  } catch { /* ignore */ }
}

export function peekCachedDmSidebar(accountId) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DM_SIDEBAR_KEY) || '');
    if (Number(parsed?.accountId) !== Number(accountId)) return null;
    if (!Array.isArray(parsed.friends) || !Array.isArray(parsed.conversations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function rememberDmSidebar(accountId, payload) {
  try {
    sessionStorage.setItem(DM_SIDEBAR_KEY, JSON.stringify({ accountId, ...payload }));
  } catch { /* ignore */ }
}

export function clearClientCaches() {
  rememberAccount(null);
  try {
    sessionStorage.removeItem(DM_SIDEBAR_KEY);
    sessionStorage.removeItem('glean.servers');
  } catch { /* ignore */ }
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
