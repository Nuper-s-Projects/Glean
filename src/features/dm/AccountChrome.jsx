import { useCallback, useEffect, useRef, useState } from 'react';
import { disableDesktopPush, enableDesktopPush, notificationPermission } from '../../app/desktopPush';
import { promptInstall, subscribePwa } from '../../app/pwa';
import { signOut } from '../../app/storage';
import { changePassword, deleteAccount, getAccountSessions, getBlockedUsers, resetUserPassword, revokeAccountSession, revokeOtherSessions, sendPushAnnouncement, sendTestPush, setKeepInformationSecret, setPresenceHidden, setPresenceStatus, setPrivateNotesEnabled, setShowInspectServers, subscribeToDmEvents, unblockUser, updateAccountAccessibility, updateAccountAvatar, updateAccountBio, updateAccountCustomBadges, updateAccountDiscord, updateAccountGrade, updateAccountProgram, updateAccountProfileBackground, updateAccountSchool, updateAccountSocialLinks, updateAccountUsername } from '../../app/dmApi';
import { applyAccessibilitySettings, DEFAULT_ACCESSIBILITY, normalizeAccessibility } from '../../app/accessibility';
import GleanButton from './GleanButton';
import { schoolFitsGrade } from '../../app/laredoSchools';
import { programDraftFromAccount } from '../../app/programs';
import { normalizeDiscordUsername } from '../../app/discordUsername';
import { normalizeSocialUrl, normalizeSocialUsername } from '../../app/socialLinks';
import { normalizeUsername, USERNAME_RULES_MESSAGE } from '../../app/username';
import { presenceLabel, usePresence, usePresenceHidden } from '../../app/presence';
import AvatarCropEditor from './AvatarCropEditor';
import BannerEditor from './BannerEditor';
import NameStyleEditor from './NameStyleEditor';
import DisplayName from './DisplayName';
import { profileThemeStyle, useContactBannerStyle } from './banner';
import { Avatar } from './DmPrimitives';
import { SettingsIcon } from './icons';
import { useUserPopout } from './userPopout';
import { CURRENT_RELEASE } from '../../app/releaseNotes';
import { formatJoinedDate, formatReleaseDate } from './formatters';
import { MAX_CUSTOM_BADGES, MAX_CUSTOM_BADGE_LABEL, normalizeCustomBadges } from '../../app/customBadges';
import { isDeveloperModeEnabled, setDeveloperModeEnabled, subscribeDeveloperMode } from '../../app/developerMode';
import { ProfileSettings, PrivacySettings, SecuritySettings, NotificationSettings, AccessibilitySettings } from './AccountSettingsPanels';
import { SettingIcon, SettingsNotice } from './AccountSettingsPrimitives';
import './AccountSettings.css';
import { deleteE2EEIdentity, ensureE2EEIdentity, prepareProfileKeyBackupForPasswordChange, resetE2EEIdentity } from '../../app/e2ee';

const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const AVATAR_MAX_BYTES = 200 * 1024 * 1024;
const RELEASE_DISMISSED_KEY = 'glean.dismissed-release-version';
const SETTINGS_SECTIONS = [
  { id: 'profile', title: 'Profile', description: 'Your identity, appearance, and school.' },
  { id: 'privacy', title: 'Privacy', description: 'Control your visibility and who can reach you.' },
  { id: 'security', title: 'Security', description: 'Protect your account and manage signed-in devices.' },
  { id: 'notifications', title: 'Notifications', description: 'Choose how Glean gets your attention.' },
  { id: 'accessibility', title: 'Accessibility', description: 'Make Glean comfortable for you.' },
  { id: 'info', title: 'Info', description: 'About Glean and developer tools.' },
];

function releaseWasDismissed() {
  try { return window.localStorage.getItem(RELEASE_DISMISSED_KEY) === CURRENT_RELEASE.version; } catch { return false; }
}

function dismissRelease() {
  try { window.localStorage.setItem(RELEASE_DISMISSED_KEY, CURRENT_RELEASE.version); } catch { /* storage can be unavailable */ }
}

export default function AccountChrome({ account, onAccountUpdated, onSignedOut }) {
  const accountRef = useRef(account);
  accountRef.current = account;
  const username = account?.username || 'you';
  const { open: openProfile, close: closeProfile } = useUserPopout();
  const bannerPreview = useContactBannerStyle(account);
  const profileBackgroundPreview = profileThemeStyle(account?.profileBackground);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showReleaseNotes, setShowReleaseNotes] = useState(() => !releaseWasDismissed());
  const [bioDraft, setBioDraft] = useState(account?.bio || '');
  const [usernameDraft, setUsernameDraft] = useState(account?.username || '');
  const [gradeDraft, setGradeDraft] = useState(account?.grade || '');
  const [schoolDraft, setSchoolDraft] = useState(account?.school || '');
  const [programDraft, setProgramDraft] = useState(() => programDraftFromAccount(account));
  const [discordDraft, setDiscordDraft] = useState(account?.discordUsername || '');
  const [instagramDraft, setInstagramDraft] = useState(account?.socialLinks?.instagram || '');
  const [instagramUsernameDraft, setInstagramUsernameDraft] = useState(account?.socialLinks?.instagramUsername || '');
  const [tiktokDraft, setTiktokDraft] = useState(account?.socialLinks?.tiktok || '');
  const [tiktokUsernameDraft, setTiktokUsernameDraft] = useState(account?.socialLinks?.tiktokUsername || '');
  const [customBadgeDraft, setCustomBadgeDraft] = useState(() => account?.customBadges || []);
  const [customBadgeNote, setCustomBadgeNote] = useState('');
  const [isSavingCustomBadges, setIsSavingCustomBadges] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [isSavingBio, setIsSavingBio] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [notifyState, setNotifyState] = useState(() => notificationPermission());
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [testPushBusy, setTestPushBusy] = useState(false);
  const [testPushNote, setTestPushNote] = useState('');
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [announcementBusy, setAnnouncementBusy] = useState(false);
  const [announcementNote, setAnnouncementNote] = useState('');
  const [pwa, setPwa] = useState(() => ({ standalone: false, canInstall: false }));
  const [cropSource, setCropSource] = useState(null);
  const [cropError, setCropError] = useState('');
  const [bannerOpen, setBannerOpen] = useState(false);
  const [profileBackgroundOpen, setProfileBackgroundOpen] = useState(false);
  const [nameStyleOpen, setNameStyleOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('profile');
  const settingsDialogRef = useRef(null);
  const settingsScrollRef = useRef(null);
  const activeSettings = SETTINGS_SECTIONS.find((section) => section.id === settingsTab);
  const selectSettings = (tab) => {
    setSettingsTab(tab);
    setSettingsError('');
    setAccessibilitySaved(false);
    settingsScrollRef.current?.scrollTo({ top: 0 });
  };
  const [developerMode, setDeveloperMode] = useState(() => isDeveloperModeEnabled());
  const [accessibility, setAccessibility] = useState(() => normalizeAccessibility(account?.accessibility));
  const [isSavingAccessibility, setIsSavingAccessibility] = useState(false);
  const [accessibilitySaved, setAccessibilitySaved] = useState(false);
  const accessibilitySaveTimer = useRef(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordNote, setPasswordNote] = useState('');
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [dmKeyStatus, setDmKeyStatus] = useState('checking');
  const [dmKeyPassword, setDmKeyPassword] = useState('');
  const [dmKeyAcknowledged, setDmKeyAcknowledged] = useState(false);
  const [dmKeyBusy, setDmKeyBusy] = useState(false);
  const [dmKeyError, setDmKeyError] = useState('');
  const [dmKeyNote, setDmKeyNote] = useState('');
  const [resetUsername, setResetUsername] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetNote, setResetNote] = useState('');
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsBusy, setSessionsBusy] = useState('');
  const [deleteStage, setDeleteStage] = useState(0);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [hidingPresence, setHidingPresence] = useState(false);
  const [secretModeBusy, setSecretModeBusy] = useState(false);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [privateNotesBusy, setPrivateNotesBusy] = useState(false);
  const [presenceStatusBusy, setPresenceStatusBusy] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [blockedLoading, setBlockedLoading] = useState(false);
  const [blockedBusy, setBlockedBusy] = useState('');
  const cropSourceRef = useRef(null);
  cropSourceRef.current = cropSource;
  const livePresence = usePresence(account?.id, account?.presence || 'offline');
  const selfHidden = usePresenceHidden(account?.id, Boolean(account?.presenceHidden));
  const selfLabel = presenceLabel(livePresence, selfHidden);

  const loadSessions = useCallback(async () => {
    const payload = await getAccountSessions();
    setSessions(payload.sessions || []);
  }, []);

  const loadBlocked = useCallback(async () => {
    const payload = await getBlockedUsers();
    setBlockedUsers(payload.blocked || []);
  }, []);

  const closeCrop = useCallback(() => {
    const current = cropSourceRef.current;
    if (current?.url) URL.revokeObjectURL(current.url);
    setCropSource(null);
    setCropError('');
  }, []);

  const closeSettings = useCallback(() => {
    closeCrop();
    setBannerOpen(false);
    setProfileBackgroundOpen(false);
    setNameStyleOpen(false);
    setDeleteStage(0);
    setDeletePassword('');
    setDeleteError('');
    setDmKeyPassword('');
    setDmKeyAcknowledged(false);
    setDmKeyError('');
    setDmKeyNote('');
    setIsSettingsOpen(false);
  }, [closeCrop]);

  useEffect(() => subscribePwa(setPwa), []);
  useEffect(() => subscribeDeveloperMode(setDeveloperMode), []);

  useEffect(() => {
    if (!isSettingsOpen) return undefined;
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => settingsDialogRef.current?.querySelector('.dm-settings-close')?.focus());
    return () => { cancelAnimationFrame(frame); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isSettingsOpen) return undefined;
    const trapFocus = (event) => {
      if (event.key !== 'Tab' || cropSourceRef.current || bannerOpen || profileBackgroundOpen || nameStyleOpen || deleteStage) return;
      const elements = [...(settingsDialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || [])].filter((element) => element.getClientRects().length);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || !settingsDialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !settingsDialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isSettingsOpen, bannerOpen, profileBackgroundOpen, nameStyleOpen, deleteStage]);

  useEffect(() => {
    setShowReleaseNotes(!releaseWasDismissed());
  }, [account?.id]);

  useEffect(() => {
    if (!isSettingsOpen) return undefined;
    const onKey = (event) => {
      if (deleteStage && event.key === 'Tab') {
        const dialog = document.querySelector('.dm-delete-account-modal');
        const focusable = dialog ? [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')] : [];
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) {
          event.preventDefault();
          focusable.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
          event.preventDefault();
          focusable[0].focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (deleteStage) {
        event.preventDefault();
        setDeleteStage(0);
        setDeletePassword('');
        setDeleteError('');
        return;
      }
      if (cropSourceRef.current) {
        event.preventDefault();
        closeCrop();
        return;
      }
      if (bannerOpen || profileBackgroundOpen || nameStyleOpen) return;
      setIsSettingsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isSettingsOpen, closeCrop, bannerOpen, profileBackgroundOpen, nameStyleOpen, deleteStage]);

  useEffect(() => () => {
    if (cropSourceRef.current?.url) URL.revokeObjectURL(cropSourceRef.current.url);
  }, []);

  const openSettings = () => {
    closeProfile();
    setBioDraft(account?.bio || '');
    setUsernameDraft(account?.username || '');
    setGradeDraft(account?.grade || '');
    setSchoolDraft(account?.school || '');
    setProgramDraft(programDraftFromAccount(account));
    setDiscordDraft(account?.discordUsername || '');
    setInstagramDraft(account?.socialLinks?.instagram || '');
    setInstagramUsernameDraft(account?.socialLinks?.instagramUsername || '');
    setTiktokDraft(account?.socialLinks?.tiktok || '');
    setTiktokUsernameDraft(account?.socialLinks?.tiktokUsername || '');
    setCustomBadgeDraft(account?.customBadges || []);
    setCustomBadgeNote('');
    setAccessibility(normalizeAccessibility(account?.accessibility));
    applyAccessibilitySettings(account?.accessibility);
    setSettingsError('');
    setPasswordNote('');
    setNotifyState(notificationPermission());
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setResetUsername('');
    setResetPassword('');
    setResetNote('');
    setDmKeyPassword('');
    setDmKeyAcknowledged(false);
    setDmKeyStatus('checking');
    setDmKeyError('');
    setDmKeyNote('');
    setDeleteStage(0);
    setDeletePassword('');
    setDeleteError('');
    setSettingsTab('profile');
    setIsSettingsOpen(true);
  };

  useEffect(() => {
    if (!isSettingsOpen || settingsTab !== 'security') return undefined;
    let cancelled = false;
    setSessionsLoading(true);
    loadSessions().catch((error) => { if (!cancelled) setSettingsError(error.message); }).finally(() => { if (!cancelled) setSessionsLoading(false); });
    if (account?.id) {
      ensureE2EEIdentity(account.id, account.username)
        .then((identity) => { if (!cancelled) setDmKeyStatus(identity.serverKeyMismatch ? 'mismatch' : 'ready'); })
        .catch((error) => { if (!cancelled) { setDmKeyStatus('error'); setDmKeyError(error.message || 'Could not check this browser’s DM key.'); } });
    }
    return () => { cancelled = true; };
  }, [isSettingsOpen, settingsTab, account?.id, account?.username, loadSessions]);

  useEffect(() => {
    if (!isSettingsOpen || settingsTab !== 'privacy') return undefined;
    let cancelled = false;
    setBlockedLoading(true);
    loadBlocked().catch((error) => { if (!cancelled) setSettingsError(error.message); }).finally(() => { if (!cancelled) setBlockedLoading(false); });
    return () => { cancelled = true; };
  }, [isSettingsOpen, settingsTab, loadBlocked]);

  useEffect(() => {
    if (!account?.id) return undefined;
    const subscription = subscribeToDmEvents((eventName, payload) => {
      if (eventName === 'account-privacy-settings' && Number(payload?.userId) === Number(accountRef.current?.id)) {
        onAccountUpdated({ ...accountRef.current, keepInformationSecret: Boolean(payload.keepInformationSecret) });
      }
    }, () => {}, account.id);
    return () => subscription.close();
  }, [account?.id, onAccountUpdated]);

  const saveAccessibilityPreferences = (next) => {
    setAccessibility(next);
    setAccessibilitySaved(false);
    applyAccessibilitySettings(next);
    window.clearTimeout(accessibilitySaveTimer.current);
    accessibilitySaveTimer.current = window.setTimeout(() => {
      setIsSavingAccessibility(true);
      setSettingsError('');
      updateAccountAccessibility(next.contrast, next.saturation, next.reduceMotion, next.glassFrost, next.glassDepth, next.glassRefraction, next.theme)
        .then((nextAccount) => {
          onAccountUpdated({ ...accountRef.current, accessibility: nextAccount.accessibility });
          setAccessibilitySaved(true);
        })
        .catch((error) => setSettingsError(error.message || 'Could not save accessibility settings.'))
        .finally(() => setIsSavingAccessibility(false));
    }, 300);
  };

  const changeAccessibility = (key, value) => {
    saveAccessibilityPreferences(normalizeAccessibility({ ...accessibility, [key]: key === 'theme' ? value : Number(value) }));
  };

  const resetGlassOptics = () => {
    saveAccessibilityPreferences(normalizeAccessibility({ ...accessibility, glassDepth: DEFAULT_ACCESSIBILITY.glassDepth, glassRefraction: DEFAULT_ACCESSIBILITY.glassRefraction }));
  };

  const savePassword = async (event) => {
    event.preventDefault();
    if (isSavingPassword) return;
    if (newPassword.length < 10) {
      setSettingsError('Use a password between 10 and 256 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setSettingsError('New passwords do not match.');
      return;
    }
    setIsSavingPassword(true);
    setSettingsError('');
    setPasswordNote('');
    try {
      const keyBackup = String(account.username || '').toLowerCase() === 'nuper'
        ? await prepareProfileKeyBackupForPasswordChange(account.id, account.username, currentPassword, newPassword)
        : null;
      const result = await changePassword(currentPassword, newPassword, keyBackup);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordNote(result.revoked ? `Password updated. Signed out ${result.revoked} other ${result.revoked === 1 ? 'device' : 'devices'}.` : 'Password updated.');
      await loadSessions();
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setIsSavingPassword(false);
    }
  };

  const resetDmEncryption = async (event) => {
    event.preventDefault();
    if (dmKeyBusy) return;
    if (!dmKeyAcknowledged) {
      setDmKeyError('Confirm that you understand the old-message limitation before resetting.');
      return;
    }
    setDmKeyBusy(true);
    setDmKeyError('');
    setDmKeyNote('');
    try {
      await resetE2EEIdentity(account.id, account.username, dmKeyPassword);
      setDmKeyStatus('ready');
      setDmKeyPassword('');
      setDmKeyAcknowledged(false);
      setDmKeyNote('Your new key is active. You can send DMs again.');
    } catch (error) {
      setDmKeyError(error.message || 'Could not reset DM encryption.');
    } finally {
      setDmKeyBusy(false);
    }
  };

  const resetUserPasswordForAdmin = async (event) => {
    event.preventDefault();
    if (isResettingPassword) return;
    setIsResettingPassword(true);
    setResetNote('');
    setSettingsError('');
    try {
      const result = await resetUserPassword(resetUsername, resetPassword);
      setResetPassword('');
      setResetNote(`Password reset for @${result.username}. Their active sessions were signed out.`);
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setIsResettingPassword(false);
    }
  };

  const revokeSession = async (session) => {
    if (sessionsBusy) return;
    setSessionsBusy(session.id);
    setSettingsError('');
    try {
      const result = await revokeAccountSession(session.id);
      if (result.signedOut) {
        await disableDesktopPush();
        await signOut();
        onSignedOut();
        return;
      }
      await loadSessions();
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setSessionsBusy('');
    }
  };

  const revokeOthers = async () => {
    if (sessionsBusy) return;
    setSessionsBusy('others');
    setSettingsError('');
    try {
      await revokeOtherSessions();
      await loadSessions();
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setSessionsBusy('');
    }
  };

  const toggleHidden = async () => {
    if (hidingPresence) return;
    setHidingPresence(true);
    setSettingsError('');
    try {
      onAccountUpdated(await setPresenceHidden(!selfHidden));
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setHidingPresence(false);
    }
  };

  const toggleSecretMode = async (enabled) => {
    if (secretModeBusy || Boolean(account?.keepInformationSecret) === enabled) return;
    setSecretModeBusy(true);
    setSettingsError('');
    try {
      onAccountUpdated(await setKeepInformationSecret(enabled));
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setSecretModeBusy(false);
    }
  };

  const toggleInspectServers = async (show) => {
    if (inspectBusy || Boolean(account?.showInspectServers) === show) return;
    setInspectBusy(true);
    setSettingsError('');
    try {
      onAccountUpdated(await setShowInspectServers(show));
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setInspectBusy(false);
    }
  };

  const togglePrivateNotes = async (enabled) => {
    if (privateNotesBusy || Boolean(account?.privateNotesEnabled) === enabled) return;
    setPrivateNotesBusy(true);
    setSettingsError('');
    try {
      onAccountUpdated(await setPrivateNotesEnabled(enabled));
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setPrivateNotesBusy(false);
    }
  };

  const changePresenceStatus = async (status) => {
    if (presenceStatusBusy || account?.presenceStatus === status) return;
    setPresenceStatusBusy(true);
    setSettingsError('');
    try {
      onAccountUpdated(await setPresenceStatus(status));
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setPresenceStatusBusy(false);
    }
  };


  const saveAccountInfo = async (event) => {
    event.preventDefault();
    if (isSavingBio) return;
    const nextUsername = normalizeUsername(usernameDraft);
    if (!nextUsername) {
      setSettingsError(USERNAME_RULES_MESSAGE);
      return;
    }
    if (!gradeDraft) {
      setSettingsError('Choose a grade option to continue.');
      return;
    }
    if (!schoolDraft) {
      setSettingsError('Choose a school option to continue.');
      return;
    }
    if (!programDraft.length) {
      setSettingsError('Pick a program, or choose “Neither in these programs”.');
      return;
    }
    if (discordDraft.trim() && normalizeDiscordUsername(discordDraft) == null) {
      setSettingsError('Use a Discord username like name or name#0000.');
      return;
    }
    const instagram = normalizeSocialUrl(instagramDraft, 'instagram');
    const instagramUsername = normalizeSocialUsername(instagramUsernameDraft, 'instagram');
    const tiktok = normalizeSocialUrl(tiktokDraft, 'tiktok');
    const tiktokUsername = normalizeSocialUsername(tiktokUsernameDraft, 'tiktok');
    if (instagram == null || instagramUsername == null || tiktok == null || tiktokUsername == null) {
      setSettingsError('Use valid Instagram and TikTok links.');
      return;
    }
    setIsSavingBio(true);
    setSettingsError('');
    try {
      let nextAccount = account;
      if (nextUsername !== (account?.username || '')) {
        nextAccount = await updateAccountUsername(nextUsername);
      }
      nextAccount = await updateAccountBio(bioDraft);
      nextAccount = await updateAccountGrade(gradeDraft);
      nextAccount = await updateAccountSchool(schoolDraft);
      nextAccount = await updateAccountProgram(programDraft);
      nextAccount = await updateAccountDiscord(discordDraft.trim());
      nextAccount = await updateAccountSocialLinks({ instagram, instagramUsername, tiktok, tiktokUsername });
      onAccountUpdated(nextAccount);
      closeSettings();
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setIsSavingBio(false);
    }
  };

  const editCustomBadge = (index, patch) => setCustomBadgeDraft((current) => current.map((badge, badgeIndex) => badgeIndex === index ? { ...badge, ...patch } : badge));
  const changeProfileDraft = (field, value) => {
    const setters = { username: setUsernameDraft, bio: setBioDraft, school: setSchoolDraft, programs: setProgramDraft, discord: setDiscordDraft, instagram: setInstagramDraft, instagramUsername: setInstagramUsernameDraft, tiktok: setTiktokDraft, tiktokUsername: setTiktokUsernameDraft };
    if (field === 'grade') {
      setGradeDraft(value);
      setSchoolDraft(current => schoolFitsGrade(current, value) ? current : '');
    } else setters[field]?.(value);
    setSettingsError('');
  };
  const addCustomBadge = () => {
    if (customBadgeDraft.length >= MAX_CUSTOM_BADGES) return;
    setCustomBadgeDraft((current) => [...current, { label: '', color: '#5865F2' }]);
    setCustomBadgeNote('');
  };
  const removeCustomBadge = (index) => {
    setCustomBadgeDraft((current) => current.filter((_, badgeIndex) => badgeIndex !== index));
    setCustomBadgeNote('');
  };
  const saveCustomBadges = async () => {
    const clean = normalizeCustomBadges(customBadgeDraft);
    if (!clean) {
      setCustomBadgeNote(`Use unique badge text up to ${MAX_CUSTOM_BADGE_LABEL} characters and valid colors.`);
      return;
    }
    setIsSavingCustomBadges(true);
    setCustomBadgeNote('');
    try {
      const nextAccount = await updateAccountCustomBadges(clean);
      onAccountUpdated(nextAccount);
      setCustomBadgeDraft(nextAccount.customBadges || []);
      setCustomBadgeNote('Badges saved.');
    } catch (error) {
      setCustomBadgeNote(error.message || 'Could not save badges.');
    } finally {
      setIsSavingCustomBadges(false);
    }
  };

  const pickAvatar = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > AVATAR_MAX_BYTES || (file.type && !AVATAR_TYPES.has(file.type))) {
      setCropError('Choose a JPG, PNG, WebP, or GIF up to 200 MB.');
      return;
    }
    closeCrop();
    setCropError('');
    setCropSource({ url: URL.createObjectURL(file), name: file.name, file });
  };

  const handleSignOut = async () => {
    if (isSigningOut || !onSignedOut) return;
    setIsSigningOut(true);
    setSettingsError('');
    try {
      await disableDesktopPush();
      await signOut();
      onSignedOut();
    } catch (error) {
      setSettingsError(error.message);
      setIsSigningOut(false);
    }
  };

  const openDeleteWarning = () => {
    setDeletePassword('');
    setDeleteError('');
    setDeleteStage(1);
  };

  const submitDeleteAccount = async (event) => {
    event.preventDefault();
    if (isDeletingAccount) return;
    setIsDeletingAccount(true);
    setDeleteError('');
    try {
      await deleteAccount(deletePassword);
      await disableDesktopPush();
      await deleteE2EEIdentity(account?.id).catch(() => {});
      await signOut().catch(() => {});
      setDeleteStage(0);
      setDeletePassword('');
      closeSettings();
      onSignedOut?.();
    } catch (error) {
      setDeleteError(error.message || 'Your account could not be deleted. Try again.');
      setIsDeletingAccount(false);
    }
  };

  const toggleNotifications = async () => {
    if (notifyBusy) return;
    setNotifyBusy(true);
    setSettingsError('');
    try {
      await enableDesktopPush();
      setNotifyState(notificationPermission());
    } catch (error) {
      setNotifyState(notificationPermission());
      setSettingsError(error.message);
    } finally {
      setNotifyBusy(false);
    }
  };

  const unblockPerson = async (username) => {
    if (blockedBusy) return;
    setBlockedBusy(username);
    setSettingsError('');
    try {
      await unblockUser(username);
      await loadBlocked();
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setBlockedBusy('');
    }
  };

  const sendTestNotification = async () => {
    if (testPushBusy) return;
    setTestPushBusy(true);
    setTestPushNote('');
    setSettingsError('');
    try {
      const result = await sendTestPush();
      setTestPushNote(result.sent ? `Sent to ${result.sent} ${result.sent === 1 ? 'person' : 'people'}.` : 'Sent. Nobody has notifications on yet.');
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setTestPushBusy(false);
    }
  };

  const sendAnnouncement = async () => {
    if (announcementBusy || !announcementDraft.trim()) return;
    setAnnouncementBusy(true);
    setAnnouncementNote('');
    setSettingsError('');
    try {
      const result = await sendPushAnnouncement(announcementDraft);
      setAnnouncementDraft('');
      setAnnouncementNote(result.sent ? `Queued for ${result.sent} user${result.sent === 1 ? '' : 's'} with notifications enabled.` : 'No users have enabled desktop notifications yet.');
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setAnnouncementBusy(false);
    }
  };

  const saveCroppedAvatar = async (file, crop = null) => {
    setIsUploadingAvatar(true);
    setCropError('');
    try {
      onAccountUpdated(await updateAccountAvatar(file, crop));
      closeCrop();
    } catch (error) {
      setCropError(error.message);
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  return (
    <>
      {showReleaseNotes ? (
        <div className="dm-release-backdrop">
          <section className="dm-release-modal" role="dialog" aria-modal="true" aria-labelledby="release-title">
            <p className="dm-release-kicker">GLEAN UPDATE</p>
            <div className="dm-release-heading">
              <div>
                <h2 id="release-title"><strong>{CURRENT_RELEASE.title}</strong></h2>
                <p>Version {CURRENT_RELEASE.version}</p>
              </div>
              <img src="/glean-mark.svg" alt="Glean logo" />
            </div>
            <p className="dm-release-summary">{CURRENT_RELEASE.summary}</p>
            <div className="dm-release-changes" aria-label="Release updates">
              {CURRENT_RELEASE.sections.map((section) => (
                <section className="dm-release-section" key={section.title}>
                  <h3>{section.title}</h3>
                  <div className="dm-release-change-grid">
                    {section.changes.map((change) => (
                      <article className="dm-release-change" key={change}><span>{change}</span></article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <GleanButton type="button" onClick={() => { dismissRelease(); setShowReleaseNotes(false); }}>Got it</GleanButton>
          </section>
        </div>
      ) : null}
      <div className="dm-profile-bar">
        <button className="dm-profile-summary" type="button" onClick={(event) => openProfile(account, event.currentTarget)} aria-label="Open your profile">
          <Avatar user={account} username={username} avatarUrl={account?.avatarUrl} interactive={false} presence />
          <span><strong><DisplayName user={account} /></strong><small>{account?.platformAdmin ? `Platform · ${selfLabel}` : selfLabel}</small></span>
        </button>
        <button type="button" onClick={openSettings} title="Account settings" aria-label="Account settings"><SettingsIcon /></button>
      </div>
      {isSettingsOpen ? (
        <div className="dm-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !cropSource && !bannerOpen && !profileBackgroundOpen && !nameStyleOpen && !deleteStage) closeSettings(); }}>
          <section className="dm-settings-modal dm-settings-organized dm-settings-redesigned" ref={settingsDialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description">
            <aside className="dm-settings-sidebar">
              <div className="dm-settings-category"><img src="/glean-mark.svg" alt="" /><span>Glean<small>Settings</small></span></div>
              <div className="dm-settings-subnav" role="navigation" aria-label="Settings sections">
                {SETTINGS_SECTIONS.filter((section) => section.id !== 'info').map((section) => <button key={section.id} type="button" aria-current={settingsTab === section.id ? 'page' : undefined} className={settingsTab === section.id ? 'is-active' : ''} onClick={() => selectSettings(section.id)}><SettingIcon name={section.id} /><span>{section.title}</span></button>)}
              </div>
              <button type="button" aria-current={settingsTab === 'info' ? 'page' : undefined} className={`dm-settings-info${settingsTab === 'info' ? ' is-active' : ''}`} onClick={() => selectSettings('info')}>Info <small>Glean {CURRENT_RELEASE.version}</small></button>
              <button className="dm-settings-signout" type="button" onClick={handleSignOut} disabled={isSigningOut}>{isSigningOut ? 'Signing out…' : 'Sign out'}</button>
            </aside>
            <div className="dm-settings-content">
              <header className="dm-settings-header">
                <div><h1 id="settings-title">{activeSettings.title}</h1><p id="settings-description" className="dm-settings-lead">{activeSettings.description}</p></div>
                {settingsTab === 'profile' ? <GleanButton className="settings-profile-save" form="account-profile-form" type="submit" disabled={isSavingBio}>{isSavingBio ? 'Saving…' : 'Save profile'}</GleanButton> : null}
                {settingsTab === 'accessibility' ? <p className="settings-autosave" role="status">{isSavingAccessibility ? 'Saving…' : accessibilitySaved ? 'Saved to your profile' : 'Changes save automatically'}</p> : null}
                <button type="button" className="dm-settings-close" onClick={closeSettings} aria-label="Close settings"><SettingIcon name="close" /></button>
                <label className="dm-settings-mobile-picker"><span>Section</span><select value={settingsTab} onChange={(event) => selectSettings(event.target.value)}>{SETTINGS_SECTIONS.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>
              </header>
              <div className="dm-settings-scroll" ref={settingsScrollRef}>
              <div className="settings-page-body">
                <SettingsNotice error>{settingsError}</SettingsNotice>
                {settingsTab === 'profile' ? <ProfileSettings
                  account={account}
                  draft={{ username: usernameDraft, bio: bioDraft, grade: gradeDraft, school: schoolDraft, programs: programDraft, discord: discordDraft, instagram: instagramDraft, instagramUsername: instagramUsernameDraft, tiktok: tiktokDraft, tiktokUsername: tiktokUsernameDraft, badges: customBadgeDraft }}
                  onChange={changeProfileDraft} banner={bannerPreview} background={profileBackgroundPreview}
                  onSubmit={saveAccountInfo} onChooseAvatar={pickAvatar} avatarBusy={isUploadingAvatar} avatarDisabled={isUploadingAvatar || Boolean(cropSource)}
                  onBanner={() => setBannerOpen(true)} onBackground={() => setProfileBackgroundOpen(true)} onNameStyle={() => setNameStyleOpen(true)}
                  badges={{ add: addCustomBadge, edit: (index, patch) => { editCustomBadge(index, patch); setCustomBadgeNote(''); }, remove: removeCustomBadge, save: saveCustomBadges, busy: isSavingCustomBadges, note: customBadgeNote }}
                /> : settingsTab === 'privacy' ? <PrivacySettings
                  account={account} hidden={selfHidden} presence={selfLabel} blockedUsers={blockedUsers} loading={blockedLoading}
                  busy={{ secret: secretModeBusy, presence: presenceStatusBusy, hidden: hidingPresence, notes: privateNotesBusy, blocked: blockedBusy, inspect: inspectBusy }}
                  actions={{ secret: toggleSecretMode, presence: changePresenceStatus, hidden: toggleHidden, notes: togglePrivateNotes, unblock: unblockPerson, inspect: toggleInspectServers }}
                /> : settingsTab === 'security' ? <SecuritySettings
                  account={account} passwords={{ current: currentPassword, next: newPassword, confirm: confirmPassword }}
                  onPasswordChange={(field, value) => ({ current: setCurrentPassword, next: setNewPassword, confirm: setConfirmPassword })[field](value)}
                  passwordBusy={isSavingPassword} passwordNote={passwordNote} onSavePassword={savePassword}
                  sessions={sessions} sessionsLoading={sessionsLoading} sessionsBusy={sessionsBusy} onRevoke={revokeSession} onRevokeOthers={revokeOthers}
                  encryption={{ status: dmKeyStatus, password: dmKeyPassword, setPassword: setDmKeyPassword, acknowledged: dmKeyAcknowledged, setAcknowledged: setDmKeyAcknowledged, busy: dmKeyBusy, reset: resetDmEncryption, note: dmKeyNote, error: dmKeyError }}
                  admin={{ username: resetUsername, setUsername: setResetUsername, password: resetPassword, setPassword: setResetPassword, busy: isResettingPassword, submit: resetUserPasswordForAdmin, note: resetNote }}
                  onDelete={openDeleteWarning}
                /> : settingsTab === 'notifications' ? <NotificationSettings
                  account={account} permission={notifyState} busy={notifyBusy} onEnable={toggleNotifications}
                  test={{ send: sendTestNotification, busy: testPushBusy, note: testPushNote }}
                  announcement={{ draft: announcementDraft, setDraft: setAnnouncementDraft, send: sendAnnouncement, busy: announcementBusy, note: announcementNote }}
                  pwa={pwa} onInstall={() => promptInstall().catch(error => setSettingsError(error.message || 'Could not install Glean.'))}
                /> : settingsTab === 'accessibility' ? <AccessibilitySettings value={accessibility} onChange={changeAccessibility} onReset={resetGlassOptics} mainThemes={account.mainThemes} onThemeSaved={mainThemes => onAccountUpdated({ ...accountRef.current, mainThemes })} /> : (
                  <section className="dm-info-screen" aria-labelledby="glean-info-name">
                    <img src="/glean-mark.svg" alt="Glean logo" />
                    <div className="dm-info-brandline"><h2 id="glean-info-name">Glean</h2><span>Beta</span></div>
                    <p>Version <strong>{CURRENT_RELEASE.version}</strong></p>
                    <dl className="dm-info-details">
                      <div><dt>Release date</dt><dd><time dateTime={CURRENT_RELEASE.releasedAt}>{formatReleaseDate(CURRENT_RELEASE.releasedAt)}</time></dd></div>
                      <div><dt>You joined</dt><dd>{formatJoinedDate(account?.createdAt) || 'Date unavailable'}</dd></div>
                    </dl>
                    <GleanButton type="button" onClick={() => setShowReleaseNotes(true)}>View update log</GleanButton>
                    <div className="dm-developer-mode-setting"><span><strong>Developer Mode</strong><small>Show local performance and network diagnostics.</small></span><button className="dm-accessibility-switch" type="button" role="switch" aria-checked={developerMode} onClick={() => setDeveloperModeEnabled(!developerMode)}>{developerMode ? 'On' : 'Off'}</button></div>
                  </section>
                )}
              </div>
              <div className="dm-settings-signout-block">
                <button type="button" className="dm-settings-info-mobile" onClick={() => { setSettingsTab('info'); setSettingsError(''); }}>Info</button>
                <GleanButton className="dm-settings-signout" variant="danger" type="button" onClick={handleSignOut} disabled={isSigningOut}>{isSigningOut ? 'Signing out…' : 'Sign out'}</GleanButton>
              </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {deleteStage > 0 ? (
        <div className="dm-delete-account-backdrop" onMouseDown={(event) => {
          if (event.target !== event.currentTarget || isDeletingAccount) return;
          setDeleteStage(0);
          setDeletePassword('');
          setDeleteError('');
        }}>
          {deleteStage === 1 ? (
            <section className="dm-delete-account-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-warning-title" aria-describedby="delete-account-warning-copy">
              <p className="dm-delete-account-kicker">Permanent account deletion</p>
              <h2 id="delete-account-warning-title">Are you sure?</h2>
              <p id="delete-account-warning-copy">Are you sure you want to delete your account on Glean? You cannot get your information back when you delete your account.</p>
              <p className="dm-delete-account-impact">This removes your messages, direct-message history, and servers you created.</p>
              <div className="dm-delete-account-actions">
                <GleanButton type="button" variant="quiet" onClick={() => setDeleteStage(0)} autoFocus>Cancel</GleanButton>
                <GleanButton type="button" variant="danger" onClick={() => { setDeleteError(''); setDeleteStage(2); }}>Proceed</GleanButton>
              </div>
            </section>
          ) : (
            <form className="dm-delete-account-modal" onSubmit={submitDeleteAccount} role="alertdialog" aria-modal="true" aria-labelledby="delete-account-confirm-title" aria-describedby="delete-account-irreversible-note">
              <p className="dm-delete-account-kicker">Final confirmation</p>
              <h2 id="delete-account-confirm-title">Confirm it’s you</h2>
              <label className="dm-bio-label" htmlFor="delete-account-password">Enter your password</label>
              <input id="delete-account-password" className="dm-username-input" type="password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} autoComplete="current-password" required maxLength={256} autoFocus />
              <p id="delete-account-irreversible-note" className="dm-delete-account-irreversible">This action is not reversible!</p>
              <GleanButton className="dm-delete-account-confirm" type="submit" variant="danger" disabled={isDeletingAccount || !deletePassword}>
                {isDeletingAccount ? 'Deleting account…' : 'I understand, let me delete my account now.'}
              </GleanButton>
              {deleteError ? <p className="dm-settings-error" role="alert">{deleteError}</p> : null}
              <GleanButton className="dm-delete-account-cancel" type="button" variant="quiet" onClick={() => { setDeleteStage(0); setDeletePassword(''); setDeleteError(''); }} disabled={isDeletingAccount}>Cancel</GleanButton>
            </form>
          )}
        </div>
      ) : null}
      {cropSource ? <AvatarCropEditor imageUrl={cropSource.url} sourceFile={cropSource.file} saving={isUploadingAvatar} error={cropError} onCancel={closeCrop} onSave={saveCroppedAvatar} onError={setCropError} /> : null}
      {bannerOpen ? (
        <BannerEditor
          banner={account?.banner}
          previewAccount={account}
          previewTarget="banner"
          title="Profile banner"
          lead="Choose the strip at the top of your profile card. Use a solid color, gradient, or image."
          preserveAnimatedGif
          onClose={() => setBannerOpen(false)}
          onSaved={(next) => onAccountUpdated(next)}
        />
      ) : null}
      {profileBackgroundOpen ? (
        <BannerEditor
          banner={account?.profileBackground}
          previewAccount={account}
          previewTarget="profileBackground"
          saveBanner={updateAccountProfileBackground}
          title="Profile background"
          lead="Choose a color, gradient, or image behind your profile. Adjust image contrast, saturation, and blur without changing your banner."
          saveLabel="Save background"
          onClose={() => setProfileBackgroundOpen(false)}
          onSaved={(next) => onAccountUpdated(next)}
        />
      ) : null}
      {nameStyleOpen ? (
        <NameStyleEditor
          account={account}
          onClose={() => setNameStyleOpen(false)}
          onSaved={(next) => onAccountUpdated(next)}
        />
      ) : null}
    </>
  );
}
