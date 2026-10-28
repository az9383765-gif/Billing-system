import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, setToken } from './api.js';
import { syncActiveUser } from './rbac.js';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// ---------- tiny hash router ----------
export function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/dashboard');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || '/dashboard');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path) {
  window.location.hash = path;
}

// ---------- toast messages ----------
let toastSeq = 0;
export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState({});
  const [toasts, setToasts] = useState([]);
  const [booting, setBooting] = useState(Boolean(getToken()));

  // keep the permission mirror in step with whoever is signed in, and tick the
  // context so the router re-evaluates its gates — module vars alone render nothing
  const [, setPermsTick] = useState(0);
  useEffect(() => { syncActiveUser(user); setPermsTick(t => t + 1); }, [user]);

  const toast = useCallback((message, type = 'info') => {
    const id = ++toastSeq;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);

  const loadMeta = useCallback(async () => {
    const data = await api('/meta');
    // sync BEFORE the render that reveals the router — a granted module must
    // be visible on the very first frame, not one effect-tick later
    syncActiveUser(data.user);
    setUser(data.user);
    setSettings(data.settings);
  }, []);

  const logout = useCallback(async (expired = false) => {
    try {
      if (!expired) await api('/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    setToken('');
    syncActiveUser(null);
    setUser(null);
    setSettings({});
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setToken('');
      syncActiveUser(null);
      setUser(null);
    };
    window.addEventListener('shopbill:unauthorized', onUnauthorized);
    return () => window.removeEventListener('shopbill:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    loadMeta()
      .catch(() => setToken(''))
      .finally(() => setBooting(false));
  }, [loadMeta]);

  // duty heartbeat — while anyone is signed in on this device, tell the server
  // once a minute that the till is still open. That is what lets the Users
  // screen separate hours genuinely worked from a screen left switched on.
  useEffect(() => {
    if (!user) return;
    const beat = () => api('/auth/ping', { method: 'POST' }).catch(() => { /* offline: duty pauses, resumes on return */ });
    const t = setInterval(beat, 60000);
    return () => clearInterval(t);
  }, [user]);

  const login = useCallback(async (username, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    setToken(data.token);
    const meta = await api('/meta');
    syncActiveUser(meta.user);
    setUser(meta.user);
    setSettings(meta.settings);
    // whoever signs in online picks up any bills the shop queued offline
    window.dispatchEvent(new CustomEvent('shopbill:login'));
    return meta.user;
  }, []);

  // Google sign-in hands the session over directly
  const loginWithToken = useCallback(async token => {
    setToken(token);
    const meta = await api('/meta');
    syncActiveUser(meta.user);
    setUser(meta.user);
    setSettings(meta.settings);
    window.dispatchEvent(new CustomEvent('shopbill:login'));
    return meta.user;
  }, []);

  const value = {
    user, settings, toasts, toast, booting,
    login, loginWithToken, logout,
    refreshSettings: async () => {
      try {
        const meta = await api('/meta');
        setSettings(meta.settings);
      } catch { /* ignore */ }
    },
    setSettings
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
