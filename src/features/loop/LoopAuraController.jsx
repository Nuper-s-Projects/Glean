import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents, updateAccountAccessibility } from '../../app/dmApi';
import { clearLoopAuraReminderHistory, loopAuraSeenKey } from '../../app/loopAuraPreferences';
import { LoopAuraDialog, LoopAuraPanel, LoopAuraTrigger } from './LoopAura';

export default function LoopAuraController({ account, onAccountUpdated }) {
  const [hosts, setHosts] = useState({ actions: null, rightbar: null });
  const [summary, setSummary] = useState(null);
  const [checkIn, setCheckIn] = useState(null);
  const [dialog, setDialog] = useState('');
  const [reminderSaving, setReminderSaving] = useState(false);
  const [reminderError, setReminderError] = useState('');
  const alive = useRef(true);

  useLayoutEffect(() => {
    const app = document.querySelector('.loop-app');
    const actions = app?.querySelector('.loop-top-actions');
    const rightbar = app?.querySelector('.loop-rightbar');
    if (actions && rightbar) setHosts({ actions, rightbar });
    return () => setHosts({ actions: null, rightbar: null });
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    apiRequest('/loop/aura/check-in', { method: 'POST', body: '{}' }).then(data => {
      if (cancelled) return;
      setSummary(data);
      setCheckIn(data.checkIn || null);
      const day = data.checkIn?.date;
      if (!day || account?.accessibility?.showLoopStreakReminder === false) return;
      let seen = false;
      try { seen = window.localStorage.getItem(loopAuraSeenKey(account.id, day)) === '1'; } catch {}
      if (!seen) {
        try { window.localStorage.setItem(loopAuraSeenKey(account.id, day), '1'); } catch {}
        setDialog('claim');
      }
    }).catch(() => {});
    const subscription = subscribeToDmEvents((event, payload) => {
      if (event !== 'loop-aura-updated' || !payload) return;
      setSummary(current => current ? { ...current, balance: Number(payload.balance ?? current.balance), streakDays: Number(payload.streakDays ?? current.streakDays), lastCheckinDate: payload.lastCheckinDate ?? current.lastCheckinDate } : current);
    });
    return () => { cancelled = true; alive.current = false; subscription.close(); };
  }, [account?.id]);

  const openLeaderboard = useCallback(async () => {
    setDialog('leaderboard');
    try { const fresh = await apiRequest('/loop/aura'); if (alive.current) setSummary(fresh); } catch {}
  }, []);
  const closeDialog = useCallback(() => setDialog(''), []);
  const showLeaderboard = useCallback(() => { openLeaderboard(); }, [openLeaderboard]);
  const disableReminder = useCallback(async () => {
    if (reminderSaving) return;
    setReminderSaving(true);
    setReminderError('');
    try {
      const preferences = account?.accessibility || {};
      const nextAccount = await updateAccountAccessibility(
        preferences.contrast ?? 100,
        preferences.saturation ?? 100,
        preferences.reduceMotion === true,
        preferences.glassFrost ?? 50,
        preferences.glassDepth ?? 20,
        preferences.glassRefraction ?? 100,
        preferences.theme || 'system',
        false,
      );
      if (!alive.current) return;
      onAccountUpdated?.(nextAccount);
      setDialog('');
    } catch (error) {
      setReminderError(error.message || 'Could not save this reminder preference.');
    } finally {
      if (alive.current) setReminderSaving(false);
    }
  }, [account, onAccountUpdated, reminderSaving]);

  return <>
    {hosts.actions ? createPortal(<LoopAuraTrigger summary={summary} onClick={openLeaderboard} />, hosts.actions) : null}
    {hosts.rightbar ? createPortal(<LoopAuraPanel summary={summary} onOpen={openLeaderboard} />, hosts.rightbar) : null}
    {dialog ? createPortal(<LoopAuraDialog summary={summary} checkIn={checkIn} mode={dialog} onClose={closeDialog} onOpenLeaderboard={showLeaderboard} onDisableReminder={disableReminder} reminderSaving={reminderSaving} reminderError={reminderError} />, document.body) : null}
  </>;
}
