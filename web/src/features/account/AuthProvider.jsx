import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { accountRequest } from './client.js';

const Auth = createContext();

export const useAuth = () => useContext(Auth);

export function AuthProvider({ clearAnswers, children }) {
  const [session, setSession] = useState({ user: null, pending: true });
  const generation = useRef(0);
  const previousUser = useRef(null);

  const setViewer = useCallback(next => {
    if (previousUser.current && previousUser.current !== next.user?.id) clearAnswers(null);
    previousUser.current = next.user?.id ?? null;
    generation.current += 1;
    setSession(next);
  }, [clearAnswers]);

  const refresh = useCallback(async signal => {
    const started = generation.current;
    try {
      const { user } = await accountRequest('/me', { signal });
      if (!signal?.aborted && started === generation.current) setViewer({ user, pending: false });
    } catch (error) {
      if (!signal?.aborted && started === generation.current) {
        setViewer({ user: null, pending: false, error: error.status === 401 ? null : error });
      }
    }
  }, [setViewer]);

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);

  const request = useCallback(async (path, options) => {
    const started = generation.current;
    try {
      return await accountRequest(path, options);
    } catch (error) {
      if (!options?.signal?.aborted && started === generation.current && error.status === 401 &&
          path.startsWith('/me') && previousUser.current) {
        setViewer({ user: null, pending: false });
      }
      throw error;
    }
  }, [setViewer]);

  async function login(data) {
    const { user } = await accountRequest('/auth/login', { method: 'POST', data });
    setViewer({ user, pending: false });
  }

  async function logout() {
    await accountRequest('/auth/logout', { method: 'POST' });
    setViewer({ user: null, pending: false });
  }

  return <Auth.Provider value={{ ...session, request, login, logout, refresh }}>{children}</Auth.Provider>;
}
