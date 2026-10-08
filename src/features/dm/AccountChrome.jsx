import { useCallback, useEffect, useRef, useState } from 'react';
import { disableDesktopPush, enableDesktopPush, notificationPermission } from '../../app/desktopPush';
import { promptInstall, subscribePwa } from '../../app/pwa';
import { signOut } from '../../app/storage';
import { changePassword, deleteAccount, getAccountSessions, getBlockedUsers, resetUserPassword, revokeAccountSession, revokeOtherSessions, sendPushAnnouncement, sendTestPush, setKeepInformationSecret, setPresenceHidden, setPresenceStatus, setPrivateNotesEnabled, setShowInspectServers, subscribeToDmEvents, unblockUser, updateAccountAccessibility, updateAccountAvatar, updateAccountBio, updateAccountCustomBadges, updateAccountDiscord, updateAccountGrade, updateAccountProgram, updateAccountProfileBackground, updateAccountSchool, updateAccountSocialLinks, updateAccountUsername } from '../../app/dmApi';
import { applyAccessibilitySettings, DEFAULT_ACCESSIBILITY, normalizeAccessibility } from '../../app/accessibility';
import GleanButton from './GleanButton';
import GradeQuestion from '../../components/GradeQuestion';
import SchoolQuestion from '../../components/SchoolQuestion';
import ProgramQuestion from '../../components/ProgramQuestion';
import { schoolFitsGrade } from '../../app/laredoSchools';
import { programDraftFromAccount } from '../../app/programs';
import { normalizeDiscordUsername } from '../../app/discordUsername';
import { normalizeSocialUrl, normalizeSocialUsername } from '../../app/socialLinks';
import { normalizeUsername, USERNAME_INPUT_MAX_LENGTH, USERNAME_RULES_MESSAGE } from '../../app/username';
import { presenceLabel, usePresence, usePresenceHidden } from '../../app/presence';
import AvatarCropEditor from './AvatarCropEditor';
import BannerEditor from './BannerEditor';
import NameStyleEditor from './NameStyleEditor';
import DisplayName from './DisplayName';
import { profileThemeStyle, useContactBannerStyle } from './banner';
import { Avatar } from './DmPrimitives';
import { AccountIcon, SettingsIcon } from './icons';
import { useUserPopout } from './userPopout';
import { CURRENT_RELEASE } from '../../app/releaseNotes';
import { customBadgeTextColor, MAX_CUSTOM_BADGES, MAX_CUSTOM_BADGE_LABEL, normalizeCustomBadges } from '../../app/customBadges';
import { isDeveloperModeEnabled, setDeveloperModeEnabled, subscribeDeveloperMode } from '../../app/developerMode';
import { Glass } from '@samasante/liquid-glass';
import { glassOptics } from './MessageComposer';
import { deleteE2EEIdentity, ensureE2EEIdentity, resetE2EEIdentity } from '../../app/e2ee';

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
    loadSessions().catch((error) => { if (!cancelled) setSettingsError(error.message); });
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
    loadBlocked().catch((error) => { if (!cancelled) setSettingsError(error.message); });
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
          onAccountUpdated(nextAccount);
          setAccessibilitySaved(true);
        })
        .catch((error) => setSettingsError(error.message || 'Could not save accessibility settings.'))
        .finally(() => setIsSavingAccessibility(false));
    }, 300);
  };

  const changeAccessibility = (key, value) => {
    saveAccessibilityPreferences(normalizeAccessibility({ ...accessibility, [key]: key === 'reduceMotion' || key === 'theme' ? value : Number(value) }));
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
      const result = await changePassword(currentPassword, newPassword);
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
                <h2 id="release-title">{CURRENT_RELEASE.title}</h2>
                <p>Version {CURRENT_RELEASE.version}</p>
              </div>
              <img src="/glean-mark.svg" alt="Glean logo" />
            </div>
            <p className="dm-release-summary">{CURRENT_RELEASE.summary}</p>
            <div className="dm-release-changes">
              {CURRENT_RELEASE.changes.map((change) => (
                <div className="dm-release-change" key={`${change.label}-${change.text}`}>
                  <strong>{change.label}</strong>
                  <span>{change.text}</span>
                </div>
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
          <section className="dm-settings-modal dm-settings-organized" ref={settingsDialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description">
            <aside className="dm-settings-sidebar">
              <div className="dm-settings-category"><AccountIcon /><span>Settings</span></div>
              <div className="dm-settings-subnav" role="navigation" aria-label="Settings sections">
                <small className="dm-settings-nav-label">YOUR ACCOUNT</small>
                {SETTINGS_SECTIONS.filter((section) => section.id !== 'info').map((section) => <button key={section.id} type="button" aria-current={settingsTab === section.id ? 'page' : undefined} className={settingsTab === section.id ? 'is-active' : ''} onClick={() => selectSettings(section.id)}><span>{section.title}</span><small>{section.description}</small></button>)}
              </div>
              <button type="button" aria-current={settingsTab === 'info' ? 'page' : undefined} className={`dm-settings-info${settingsTab === 'info' ? ' is-active' : ''}`} onClick={() => selectSettings('info')}>Info <small>Glean {CURRENT_RELEASE.version}</small></button>
              <button className="dm-settings-signout" type="button" onClick={handleSignOut} disabled={isSigningOut}>{isSigningOut ? 'Signing out…' : 'Sign out'}</button>
            </aside>
            <div className="dm-settings-content">
              <header className="dm-settings-header">
                <div><span className="dm-settings-eyebrow">ACCOUNT SETTINGS</span><h1 id="settings-title">{activeSettings.title}</h1><p id="settings-description" className="dm-settings-lead">{activeSettings.description}</p></div>
                <button type="button" className="dm-settings-close" onClick={closeSettings} aria-label="Close settings">×</button>
                <label className="dm-settings-mobile-picker"><span>Section</span><select value={settingsTab} onChange={(event) => selectSettings(event.target.value)}>{SETTINGS_SECTIONS.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>
              </header>
              <div className="dm-settings-scroll" ref={settingsScrollRef}>
              {settingsTab === 'profile' ? (
                <>
              <form className="dm-profile-settings-form" onSubmit={saveAccountInfo}>
                <section className="dm-settings-card" aria-labelledby="settings-appearance-title">
                <h2 id="settings-appearance-title">Appearance</h2><p className="dm-settings-card-description">Personalize how your profile looks.</p>
                <div className="dm-avatar-upload">
                  <span>Profile picture</span>
                  <div className="dm-avatar-picker">
                    <Avatar username={username} avatarUrl={account?.avatarUrl} interactive={false} />
                    <div>
                      <label className="glean-btn is-quiet">
                        <span className="glean-btn-glare" aria-hidden="true" />
                        <span className="glean-btn-label">Choose photo</span>
                        <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={pickAvatar} disabled={isUploadingAvatar || Boolean(cropSource)} />
                      </label>
                      <small>{isUploadingAvatar ? 'Uploading…' : 'Choose an image or animated GIF up to 200 MB. GIFs open in the preview modal and stay animated.'}</small>
                    </div>
                  </div>
                </div>
                <div className="dm-account-banner-row">
                  <span>Profile banner</span>
                  <div className="dm-account-banner-preview" style={bannerPreview} />
                  <GleanButton variant="quiet" type="button" onClick={() => setBannerOpen(true)}>Customize</GleanButton>
                </div>
                <div className="dm-account-banner-row">
                  <span>Profile background</span>
                  <div className="dm-account-banner-preview" style={profileBackgroundPreview} />
                  <GleanButton variant="quiet" type="button" onClick={() => setProfileBackgroundOpen(true)}>Customize</GleanButton>
                  <small>Solid color or two-color gradient behind the full profile card.</small>
                </div>
                </section>
                <section className="dm-settings-card" aria-labelledby="settings-identity-title"><h2 id="settings-identity-title">Username</h2><p className="dm-settings-card-description">How people find and recognize you.</p>
                <div className="dm-username-field">
                  <label className="dm-bio-label" htmlFor="account-username">Username</label>
                  <input id="account-username" className="dm-username-input" value={usernameDraft} onChange={(event) => { setUsernameDraft(event.target.value); setSettingsError(''); }} maxLength={USERNAME_INPUT_MAX_LENGTH} autoComplete="username" spellCheck="false" />
                  <small>{USERNAME_RULES_MESSAGE} Can’t use a name that’s already taken.</small>
                </div>
                </section>
                <section className="dm-settings-card" aria-labelledby="settings-socials-title"><h2 id="settings-socials-title">Social accounts</h2><p className="dm-settings-card-description">Optional links to help friends find you elsewhere.</p>
                <div className="dm-username-field">
                  <label className="dm-bio-label" htmlFor="account-discord">Discord</label>
                  <input id="account-discord" className="dm-username-input" value={discordDraft} onChange={(event) => { setDiscordDraft(event.target.value); setSettingsError(''); }} maxLength="37" autoComplete="off" spellCheck="false" placeholder="username" />
                  <small>Optional. New Discord usernames or name#0000. Leave blank to hide it.</small>
                </div>
                <div className="dm-username-field">
                  <label className="dm-bio-label" htmlFor="account-instagram">Instagram</label>
                  <input id="account-instagram-username" aria-label="Instagram username" className="dm-username-input" value={instagramUsernameDraft} onChange={(event) => { setInstagramUsernameDraft(event.target.value); setSettingsError(''); }} placeholder="Username (optional)" autoComplete="username" />
                  <input id="account-instagram" className="dm-username-input" value={instagramDraft} onChange={(event) => { setInstagramDraft(event.target.value); setSettingsError(''); }} placeholder="Instagram link (optional)" autoComplete="url" />
                </div>
                <div className="dm-username-field">
                  <label className="dm-bio-label" htmlFor="account-tiktok">TikTok</label>
                  <input id="account-tiktok-username" aria-label="TikTok username" className="dm-username-input" value={tiktokUsernameDraft} onChange={(event) => { setTiktokUsernameDraft(event.target.value); setSettingsError(''); }} placeholder="Username (optional)" autoComplete="username" />
                  <input id="account-tiktok" className="dm-username-input" value={tiktokDraft} onChange={(event) => { setTiktokDraft(event.target.value); setSettingsError(''); }} placeholder="https://tiktok.com/@username" autoComplete="url" />
                </div>
                </section>
                <section className="dm-settings-card" aria-labelledby="settings-about-title"><h2 id="settings-about-title">About you</h2><p className="dm-settings-card-description">Your bio and how your name appears.</p>
                <div className="dm-account-name-row">
                  <span>Name style</span>
                  <div className="dm-account-name-preview"><DisplayName user={{ username: usernameDraft || username, nameStyle: account?.nameStyle }} /></div>
                  <GleanButton variant="quiet" type="button" onClick={() => setNameStyleOpen(true)}>Customize</GleanButton>
                </div>
                <label className="dm-bio-label" htmlFor="account-bio">Bio</label>
                <textarea id="account-bio" value={bioDraft} onChange={(event) => setBioDraft(event.target.value)} maxLength="500" placeholder="Tell people a little about yourself." rows="5" />
                </section>
                <section className="dm-settings-card" aria-labelledby="settings-school-title"><h2 id="settings-school-title">School & programs</h2><p className="dm-settings-card-description">Choose the badges shown on your profile.</p>
                <GradeQuestion
                  value={gradeDraft}
                  onChange={(next) => {
                    setGradeDraft(next);
                    setSchoolDraft((current) => (schoolFitsGrade(current, next) ? current : ''));
                    setSettingsError('');
                  }}
                  name="settings-grade"
                />
                <SchoolQuestion
                  value={schoolDraft}
                  grade={gradeDraft}
                  onChange={(next) => { setSchoolDraft(next); setSettingsError(''); }}
                  name="settings-school"
                />
                <ProgramQuestion
                  value={programDraft}
                  onChange={(next) => { setProgramDraft(next); setSettingsError(''); }}
                  name="settings-program"
                />
                </section>
                <section className="dm-custom-badge-settings dm-settings-card" aria-labelledby="custom-badges-title">
                  <div className="dm-custom-badge-heading">
                    <div><h2 id="custom-badges-title">Custom badges</h2><p>Add short text badges to your profile and beside your name. Choose a color. Icons aren’t used.</p></div>
                    <GleanButton variant="quiet" type="button" onClick={addCustomBadge} disabled={customBadgeDraft.length >= MAX_CUSTOM_BADGES}>Add badge</GleanButton>
                  </div>
                  {customBadgeDraft.length ? <div className="dm-custom-badge-list">
                    {customBadgeDraft.map((badge, index) => (
                      <div className="dm-custom-badge-row" key={`custom-badge-${index}`}>
                        <label><span>Badge text</span><input className="dm-username-input" value={badge.label} maxLength={MAX_CUSTOM_BADGE_LABEL} onChange={(event) => { editCustomBadge(index, { label: event.target.value }); setCustomBadgeNote(''); }} placeholder="e.g. OM" /></label>
                        <label><span>Color</span><input className="dm-custom-badge-color" type="color" value={badge.color} onChange={(event) => { editCustomBadge(index, { color: event.target.value.toUpperCase() }); setCustomBadgeNote(''); }} aria-label={`Badge ${index + 1} color`} /></label>
                        <span className="dm-profile-badge is-custom" style={{ '--custom-badge-background': badge.color, '--custom-badge-foreground': customBadgeTextColor(badge.color) }}>{badge.label.trim() || 'Preview'}</span>
                        <GleanButton variant="quiet" type="button" onClick={() => removeCustomBadge(index)} aria-label={`Remove badge ${index + 1}`}>Remove</GleanButton>
                      </div>
                    ))}
                  </div> : <p className="dm-custom-badge-empty">No custom badges yet.</p>}
                  <div className="dm-settings-actions">
                    <GleanButton type="button" onClick={saveCustomBadges} disabled={isSavingCustomBadges}>{isSavingCustomBadges ? 'Saving…' : 'Save badges'}</GleanButton>
                    <small>{customBadgeDraft.length}/{MAX_CUSTOM_BADGES}</small>
                  </div>
                  {customBadgeNote ? <p className="dm-settings-note" role="status">{customBadgeNote}</p> : null}
                </section>
                {settingsError ? <p className="dm-settings-error" role="alert">{settingsError}</p> : null}
                <div className="dm-bio-actions">
                  <GleanButton type="submit" disabled={isSavingBio}>{isSavingBio ? 'Saving…' : 'Save profile'}</GleanButton>
                </div>
              </form>
                </>
              ) : settingsTab === 'privacy' ? (
                <>
                  <section className="dm-notify-settings dm-privacy-secret">
                    <h2>Keep My Information Secret</h2>
                    <p>Reduces the activity Glean shares about you. It hides your online presence, stops typing indicators, and makes push alerts generic.</p>
                    <label className="dm-privacy-toggle">
                      <span><strong>Keep my information secret</strong><small>Applies to your account on all signed-in devices.</small></span>
                      <input type="checkbox" role="switch" checked={Boolean(account?.keepInformationSecret)} onChange={(event) => toggleSecretMode(event.target.checked)} disabled={secretModeBusy} aria-label="Keep My Information Secret" />
                    </label>
                    <small className="dm-privacy-limits">DMs are end-to-end encrypted. Calls use encrypted WebRTC media. Server messages and call signaling still pass through Glean, and people in a server can see what you post and when you join a call. This setting does not make you anonymous.</small>
                  </section>
                  <section className="dm-notify-settings">
                    <h2>Blocked users</h2>
                    <p>People you block can’t contact you through Glean.</p>
                    {settingsError ? <p className="dm-settings-error" role="alert">{settingsError}</p> : null}
                    {blockedUsers.length ? <div className="dm-blocked-list">{blockedUsers.map((person) => (
                      <div className="dm-session-row" key={person.id}><span><strong>{person.username}</strong></span>
                        <GleanButton className="is-compact" variant="quiet" type="button" onClick={() => unblockPerson(person.username)} disabled={Boolean(blockedBusy)}>{blockedBusy === person.username ? 'Unblocking…' : 'Unblock'}</GleanButton>
                      </div>
                    ))}</div> : !settingsError ? <p>Nobody is blocked.</p> : null}
                  </section>
                  <section className="dm-notify-settings">
                    <h2>Presence</h2>
                    <p>Choose whether other people can see when you’re online.</p>
                    <label className="dm-settings-field"><span>Status</span><select value={account?.presenceStatus || 'auto'} onChange={(event) => changePresenceStatus(event.target.value)} disabled={presenceStatusBusy} aria-label="Online status">
                      <option value="auto">Automatic</option>
                      <option value="online">Online</option>
                      <option value="idle">Idle</option>
                      <option value="dnd">Do Not Disturb</option>
                      <option value="offline">Offline</option>
                    </select></label>
                    {account?.keepInformationSecret ? <small>Keep My Information Secret is keeping your presence hidden.</small> : <GleanButton type="button" onClick={toggleHidden} disabled={hidingPresence}>{hidingPresence ? 'Saving…' : selfHidden ? 'Stop appearing offline' : 'Appear offline'}</GleanButton>}
                    <small> Right now: {selfLabel}</small>
                  </section>
                  <section className="dm-notify-settings">
                    <h2>Private notes</h2>
                    <p>Show or hide the private note area in user profiles. Existing notes are kept.</p>
                    <div className="dm-settings-actions" role="group" aria-label="Private notes">
                      <GleanButton type="button" pressed={account?.privateNotesEnabled !== false} onClick={() => togglePrivateNotes(true)} disabled={privateNotesBusy}>On</GleanButton>
                      <GleanButton variant="quiet" type="button" pressed={account?.privateNotesEnabled === false} onClick={() => togglePrivateNotes(false)} disabled={privateNotesBusy}>Off</GleanButton>
                    </div>
                  </section>
                  {account?.platformAdmin ? <section className="dm-notify-settings">
                    <h2>Hidden servers</h2><p>Servers you can inspect but not join. Turn this off to hide them from your rail.</p>
                    <div className="dm-settings-actions" role="group" aria-label="Hidden servers">
                      <GleanButton type="button" pressed={account?.showInspectServers !== false} onClick={() => toggleInspectServers(true)} disabled={inspectBusy}>On</GleanButton>
                      <GleanButton variant="quiet" type="button" pressed={account?.showInspectServers === false} onClick={() => toggleInspectServers(false)} disabled={inspectBusy}>Off</GleanButton>
                    </div>
                  </section> : null}
                </>
              ) : settingsTab === 'notifications' ? (
                <>
                  <section className="dm-notify-settings">
                    <h2>Desktop notifications</h2>
                    <p>Alerts for DMs, servers, and friend requests, even when Glean is in the background.</p>
                    <div className="dm-settings-actions">
                      <GleanButton type="button" pressed={notifyState === 'granted'} onClick={toggleNotifications} disabled={notifyBusy || notifyState === 'unsupported'}>{notifyBusy ? 'Enabling…' : notifyState === 'granted' ? 'Notifications on' : notifyState === 'denied' ? 'Blocked in browser' : 'Enable notifications'}</GleanButton>
                      {account?.platformAdmin ? <GleanButton variant="quiet" type="button" onClick={sendTestNotification} disabled={testPushBusy}>{testPushBusy ? 'Sending…' : 'Send test'}</GleanButton> : null}
                    </div>
                    {testPushNote ? <small>{testPushNote}</small> : null}
                  </section>
                  {account?.platformAdmin && String(account?.username || '').trim().toLowerCase() === 'nuper' ? <section className="dm-notify-settings">
                    <h2>Send an announcement</h2>
                    <p>Send a custom notification to users who have enabled desktop notifications.</p>
                    <label className="dm-announcement-label" htmlFor="dm-announcement-message">Message</label>
                    <textarea id="dm-announcement-message" className="dm-announcement-message" value={announcementDraft} maxLength={240} rows={3} placeholder="Write a notification…" onChange={(event) => setAnnouncementDraft(event.target.value)} />
                    <div className="dm-settings-actions"><GleanButton type="button" onClick={sendAnnouncement} disabled={announcementBusy || !announcementDraft.trim()}>{announcementBusy ? 'Sending…' : 'Send to everyone'}</GleanButton><small>{announcementDraft.length}/240</small></div>
                    {announcementNote ? <small role="status">{announcementNote}</small> : null}
                    {settingsError ? <p className="dm-settings-error" role="alert">{settingsError}</p> : null}
                  </section> : null}
                  <section className="dm-notify-settings">
                    <h2>Daily greetings</h2>
                    <p>Weekdays at 8:15 AM and 4:00 PM Central time. Friday afternoon has a weekend message. No scheduled greetings on Saturday or Sunday. Users need desktop notifications enabled.</p>
                  </section>
                  <section className="dm-notify-settings">
                    <h2>Install Glean</h2>
                    {pwa.standalone ? <p>Glean is installed on this device.</p> : pwa.canInstall ? <><p>Install Glean for a dedicated app window and easier access.</p><GleanButton type="button" onClick={() => promptInstall().catch(() => {})}>Install Glean</GleanButton></> : <p>Use your browser’s install or Add to Home Screen option to pin Glean as an app.</p>}
                  </section>
                </>
              ) : settingsTab === 'accessibility' ? (
                <section className="dm-accessibility-settings" aria-labelledby="accessibility-heading">
                  <h2 id="accessibility-heading">Display adjustments</h2>
                  <p className="dm-accessibility-description">Fine-tune Glean’s colors for your comfort. These preferences are saved to your profile and follow you to other devices.</p>
                  <div className="dm-accessibility-control">
                    <div className="dm-accessibility-label"><span>Theme</span><output>{accessibility.theme === 'system' ? 'System' : accessibility.theme === 'light' ? 'Light' : 'Dark'}</output></div>
                    <div className="dm-glass-presets" role="radiogroup" aria-label="Color theme">
                      {[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }].map((option) => (
                        <button key={option.value} type="button" role="radio" aria-checked={accessibility.theme === option.value} onClick={() => changeAccessibility('theme', option.value)}>{option.label}</button>
                      ))}
                    </div>
                    <p className="dm-accessibility-description">System follows your device appearance. Light and Dark set Glean’s appearance directly.</p>
                  </div>
                  <div className="dm-accessibility-control dm-accessibility-control-glass">
                    <>
                        <div className="dm-accessibility-label"><label htmlFor="accessibility-glass">Liquid Glass</label><output htmlFor="accessibility-glass">{accessibility.glassFrost < 20 ? 'Clear' : accessibility.glassFrost > 80 ? 'Frosted' : `${accessibility.glassFrost}% frosted`}</output></div>
                        <p className="dm-accessibility-description">Tune the glass finish, lens depth, and refraction. These controls update the live preview and the message composer.</p>
                        <div className="dm-glass-presets" role="group" aria-label="Liquid Glass presets">
                          {[{ value: 0, label: 'Clear' }, { value: 50, label: 'Balanced' }, { value: 100, label: 'Frosted' }].map((preset) => (
                            <button key={preset.value} type="button" aria-pressed={accessibility.glassFrost === preset.value} onClick={() => changeAccessibility('glassFrost', preset.value)}>{preset.label}</button>
                          ))}
                        </div>
                        <input id="accessibility-glass" type="range" min="0" max="100" step="1" value={accessibility.glassFrost} aria-valuetext={`${accessibility.glassFrost} percent frosted`} style={{ '--glass-frost-position': `${accessibility.glassFrost}%` }} onChange={(event) => changeAccessibility('glassFrost', event.target.value)} />
                        <div className="dm-accessibility-scale"><span>Clear, strong refraction</span><span>Soft, frosted blur</span></div>
                        <div className="dm-glass-optics-grid">
                          <div className="dm-glass-optics-control">
                            <div className="dm-accessibility-label"><label htmlFor="accessibility-glass-depth">Depth</label><output htmlFor="accessibility-glass-depth">{accessibility.glassDepth}%</output></div>
                            <p>Adjusts the lens bulge, from flat to more dimensional.</p>
                            <input id="accessibility-glass-depth" type="range" min="0" max="100" step="1" value={accessibility.glassDepth} aria-valuetext={`${accessibility.glassDepth} percent depth`} style={{ '--glass-frost-position': `${accessibility.glassDepth}%` }} onChange={(event) => changeAccessibility('glassDepth', event.target.value)} />
                          </div>
                          <div className="dm-glass-optics-control">
                            <div className="dm-accessibility-label"><label htmlFor="accessibility-glass-refraction">Refraction</label><output htmlFor="accessibility-glass-refraction">{accessibility.glassRefraction}%</output></div>
                            <p>Sets how strongly the background bends through the glass.</p>
                            <input id="accessibility-glass-refraction" type="range" min="0" max="100" step="1" value={accessibility.glassRefraction} aria-valuetext={`${accessibility.glassRefraction} percent refraction`} style={{ '--glass-frost-position': `${accessibility.glassRefraction}%` }} onChange={(event) => changeAccessibility('glassRefraction', event.target.value)} />
                          </div>
                        </div>
                        <button className="dm-glass-reset" type="button" onClick={resetGlassOptics}>Reset depth and refraction</button>
                        <div className="dm-glass-preview-wrap" role="group" aria-label="Live Liquid Glass preview">
                          <img className="dm-glass-preview-image" src="/liquid-glass-preview.jpg" alt="" />
                          <Glass className="dm-glass-live-preview" radius={18} optics={glassOptics(accessibility.glassFrost, accessibility.glassDepth, accessibility.glassRefraction)}>
                            <span className="dm-glass-preview-mark" aria-hidden="true">G</span>
                            <span>Live preview <small>{accessibility.glassFrost}% frost · {accessibility.glassDepth}% depth · {accessibility.glassRefraction}% refraction</small></span>
                          </Glass>
                        </div>
                        <p className="dm-glass-preview-hint">Preview updates as you move the slider. Your choice saves automatically.</p>
                    </>
                  </div>
                  <div className="dm-accessibility-control">
                    <div className="dm-accessibility-label"><label htmlFor="accessibility-contrast">Contrast</label><output htmlFor="accessibility-contrast">{accessibility.contrast}%</output></div>
                    <input id="accessibility-contrast" type="range" min="50" max="150" step="1" value={accessibility.contrast} aria-valuetext={`${accessibility.contrast} percent contrast`} onChange={(event) => changeAccessibility('contrast', event.target.value)} />
                    <div className="dm-accessibility-scale"><span>Lower</span><span>Higher</span></div>
                  </div>
                  <div className="dm-accessibility-control">
                    <div className="dm-accessibility-label"><label htmlFor="accessibility-saturation">Saturation</label><output htmlFor="accessibility-saturation">{accessibility.saturation}%</output></div>
                    <input id="accessibility-saturation" type="range" min="0" max="200" step="1" value={accessibility.saturation} aria-valuetext={`${accessibility.saturation} percent saturation`} onChange={(event) => changeAccessibility('saturation', event.target.value)} />
                    <div className="dm-accessibility-scale"><span>Grayscale</span><span>Vivid</span></div>
                  </div>
                  <div className="dm-accessibility-motion">
                    <span><strong>Reduce motion</strong><small>Turn off animations and smooth scrolling in Glean.</small></span>
                    <button className="dm-accessibility-switch" type="button" role="switch" aria-checked={accessibility.reduceMotion} onClick={() => changeAccessibility('reduceMotion', !accessibility.reduceMotion)}>{accessibility.reduceMotion ? 'On' : 'Off'}</button>
                  </div>
                  <p className="dm-accessibility-save" role="status">{isSavingAccessibility ? 'Saving to your profile…' : accessibilitySaved ? 'Saved to your profile.' : 'Changes save automatically.'}</p>
                  {settingsError ? <p className="dm-settings-error" role="alert">{settingsError}</p> : null}
                </section>
              ) : settingsTab === 'info' ? (
                <section className="dm-info-screen" aria-labelledby="glean-info-name">
                  <img src="/glean-mark.svg" alt="Glean logo" />
                  <div className="dm-info-brandline">
                    <h2 id="glean-info-name">Glean</h2>
                    <span>Beta</span>
                  </div>
                  <p>Version <strong>{CURRENT_RELEASE.version}</strong></p>
                  <div className="dm-developer-mode-setting">
                    <span><strong>Developer Mode</strong><small>Show local performance and network diagnostics.</small></span>
                    <button className="dm-accessibility-switch" type="button" role="switch" aria-checked={developerMode} onClick={() => setDeveloperModeEnabled(!developerMode)}>{developerMode ? 'On' : 'Off'}</button>
                  </div>
                </section>
              ) : (
                <>
                  <section className="dm-security-form dm-e2ee-recovery" aria-labelledby="dm-encryption-title">
                    <h2 id="dm-encryption-title">DM encryption</h2>
                    <p className="dm-e2ee-description">{dmKeyStatus === 'checking'
                      ? 'Checking this browser’s encryption key…'
                      : dmKeyStatus === 'mismatch'
                        ? 'This browser’s saved key does not match Glean’s active key, so it cannot send DMs yet.'
                        : dmKeyStatus === 'ready'
                          ? 'This browser has the active key for sending encrypted DMs.'
                          : 'The browser could not verify its DM key. You can start a fresh key.'}</p>
                    <p className="dm-e2ee-warning">Resetting creates a key for future messages. Old encrypted messages stay on Glean, but this browser can only read them if it still has their original key. The reset does not delete message history.</p>
                    <form onSubmit={resetDmEncryption}>
                      <label className="dm-bio-label" htmlFor="dm-key-reset-password">Current password</label>
                      <input id="dm-key-reset-password" className="dm-username-input" type="password" value={dmKeyPassword} onChange={(event) => setDmKeyPassword(event.target.value)} autoComplete="current-password" maxLength={256} required />
                      <label className="dm-e2ee-acknowledge">
                        <input type="checkbox" checked={dmKeyAcknowledged} onChange={(event) => setDmKeyAcknowledged(event.target.checked)} />
                        <span>I understand that resetting will not recover messages that need my old key.</span>
                      </label>
                      <GleanButton type="submit" disabled={dmKeyBusy || !dmKeyPassword || !dmKeyAcknowledged}>
                        {dmKeyBusy ? 'Resetting key…' : 'Reset DM key and enable chat'}
                      </GleanButton>
                    </form>
                    {dmKeyNote ? <p className="dm-settings-note" role="status">{dmKeyNote}</p> : null}
                    {dmKeyError ? <p className="dm-settings-error" role="alert">{dmKeyError}</p> : null}
                  </section>
                  <form className="dm-security-form" onSubmit={savePassword}>
                    <h2>Password</h2>
                    <label className="dm-bio-label" htmlFor="current-password">Current password</label>
                    <input id="current-password" className="dm-username-input" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" />
                    <label className="dm-bio-label" htmlFor="new-password">New password</label>
                    <input id="new-password" className="dm-username-input" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength="10" />
                    <label className="dm-bio-label" htmlFor="confirm-password">Confirm new password</label>
                    <input id="confirm-password" className="dm-username-input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength="10" />
                    {passwordNote ? <p className="dm-settings-note">{passwordNote}</p> : null}
                    {settingsError ? <p className="dm-settings-error" role="alert">{settingsError}</p> : null}
                    <div className="dm-bio-actions">
                      <small>Changing your password signs out every other device.</small>
                      <GleanButton type="submit" disabled={isSavingPassword}>{isSavingPassword ? 'Saving…' : 'Update password'}</GleanButton>
                    </div>
                  </form>
                  {account?.platformAdmin ? (
                    <form className="dm-security-form dm-admin-password-reset" onSubmit={resetUserPasswordForAdmin}>
                      <h2>Reset another user’s password</h2>
                      <p>Use this only to help a user regain access. Resetting signs them out of every device.</p>
                      <label className="dm-bio-label" htmlFor="reset-username">Username</label>
                      <input id="reset-username" className="dm-username-input" value={resetUsername} onChange={(event) => setResetUsername(event.target.value)} placeholder="gruntjvnk" autoComplete="off" required />
                      <label className="dm-bio-label" htmlFor="reset-password">Temporary password</label>
                      <input id="reset-password" className="dm-username-input" type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} autoComplete="new-password" minLength="10" required />
                      {resetNote ? <p className="dm-settings-note">{resetNote}</p> : null}
                      <GleanButton type="submit" disabled={isResettingPassword}>{isResettingPassword ? 'Resetting…' : 'Reset password'}</GleanButton>
                    </form>
                  ) : null}
                  <section className="dm-notify-settings">
                    <h2>Devices</h2>
                    <p>Revoke a device to sign it out immediately.</p>
                    <div className="dm-session-list">
                      {sessions.map((session) => (
                        <div className={`dm-session-row${session.current ? ' is-current' : ''}`} key={session.id}>
                          <span>
                            <strong>{session.device}</strong>
                            <small>Session access control</small>
                          </span>
                          <GleanButton className="is-compact" variant="quiet" type="button" onClick={() => revokeSession(session)} disabled={Boolean(sessionsBusy)}>
                            {sessionsBusy === session.id ? 'Revoking…' : session.current ? 'Sign out' : 'Revoke'}
                          </GleanButton>
                        </div>
                      ))}
                    </div>
                    {sessions.some((session) => !session.current) ? (
                      <GleanButton type="button" onClick={revokeOthers} disabled={Boolean(sessionsBusy)}>
                        {sessionsBusy === 'others' ? 'Revoking…' : 'Revoke other devices'}
                      </GleanButton>
                    ) : null}
                  </section>
                  <section className="dm-delete-account-section" aria-labelledby="delete-account-title">
                    <h2 id="delete-account-title">Delete account</h2>
                    <p>Permanently delete your Glean account, your messages, your direct-message history, and every server you own.</p>
                    <GleanButton type="button" variant="danger" onClick={openDeleteWarning}>Delete my account</GleanButton>
                  </section>
                </>
              )}
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
          allowImage={false}
          previewAccount={account}
          previewTarget="profileBackground"
          saveBanner={updateAccountProfileBackground}
          title="Profile background"
          lead="Choose a solid color or a two-color gradient behind your full profile card."
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
