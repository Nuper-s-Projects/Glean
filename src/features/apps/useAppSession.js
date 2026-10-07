import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export default function useAppSession({ scope, accountId, send, bind, active = true }) {
  const [session, setSession] = useState(null);
  const [joined, setJoined] = useState(false);
  const [appId, setAppId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const opListeners = useRef(new Set());
  const scopeKey = scope?.key || null;
  const sendRef = useRef(send);
  sendRef.current = send;

  const emit = useCallback((event, payload = {}) => {
    if (!scopeKey) return;
    sendRef.current?.(event, { scopeKey, ...payload });
  }, [scopeKey]);

  useEffect(() => {
    setSession(null);
    setJoined(false);
    setAppId(null);
    setSnapshot(null);
    setState(null);
    setError('');
  }, [scopeKey]);

  useEffect(() => {
    if (!scopeKey || !active || !bind) return undefined;
    const handler = (eventName, payload = {}) => {
      if (payload.scopeKey && payload.scopeKey !== scopeKey) return;
      if (eventName === 'app-session') {
        setSession(payload.session || null);
        if (!payload.session) {
          setJoined(false);
          setAppId(null);
          setSnapshot(null);
          setState(null);
        }
        return;
      }
      if (eventName === 'app-ready') {
        setAppId(payload.appId || null);
        setSession(payload.session || null);
        setSnapshot(payload.snapshot || null);
        setState(payload.state || null);
        setJoined(true);
        setError('');
        return;
      }
      if (eventName === 'app-presence') {
        setSession(payload.session || null);
        return;
      }
      if (eventName === 'app-state') {
        setState(payload.state || null);
        return;
      }
      if (eventName === 'app-event') {
        if (payload.op) opListeners.current.forEach((listener) => listener(payload.op, payload.fromId));
        return;
      }
      if (eventName === 'app-closed') {
        setJoined(false);
        setAppId(null);
        setSnapshot(null);
        setState(null);
        return;
      }
      if (eventName === 'app-error') {
        setError(payload.error || 'That app could not start.');
      }
    };
    return bind(handler);
  }, [active, bind, scopeKey]);

  const start = useCallback((nextAppId) => {
    setError('');
    emit('app-start', { appId: nextAppId });
  }, [emit]);

  const join = useCallback(() => {
    setError('');
    emit('app-join');
  }, [emit]);

  const leave = useCallback(() => {
    emit('app-leave');
    setJoined(false);
    setAppId(null);
    setSnapshot(null);
    setState(null);
  }, [emit]);

  const end = useCallback(() => {
    emit('app-end');
  }, [emit]);

  const sendOp = useCallback((op) => {
    emit('app-event', { op });
  }, [emit]);

  const subscribeOps = useCallback((listener) => {
    opListeners.current.add(listener);
    return () => opListeners.current.delete(listener);
  }, []);

  const isHost = Boolean(session && Number(session.hostId) === Number(accountId));

  return useMemo(() => ({
    scopeKey,
    session,
    joined,
    appId,
    snapshot,
    state,
    error,
    isHost,
    setError,
    start,
    join,
    leave,
    end,
    sendOp,
    subscribeOps,
  }), [appId, end, error, isHost, join, joined, leave, scopeKey, sendOp, session, snapshot, start, state, subscribeOps]);
}
