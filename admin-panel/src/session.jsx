import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, onSessionExpired, tokens } from './api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out

  const load = useCallback(async () => {
    if (!tokens.access) return setSession(null);
    try {
      const data = await api.get('/admin/session');
      setSession({ user: data.user, permissions: new Set(data.permissions) });
    } catch {
      tokens.clear();
      setSession(null);
    }
  }, []);

  useEffect(() => {
    onSessionExpired.handler = () => setSession(null);
    load();
  }, [load]);

  const login = async (email, password) => {
    tokens.save(await api.post('/auth/login', { email, password }));
    try {
      const data = await api.get('/admin/session');
      setSession({ user: data.user, permissions: new Set(data.permissions) });
    } catch (err) {
      tokens.clear();
      throw err;
    }
  };

  const logout = async () => {
    const refreshToken = tokens.refresh;
    tokens.clear();
    setSession(null);
    if (refreshToken) await api.post('/auth/logout', { refreshToken }).catch(() => {});
  };

  const can = (permission) => Boolean(session?.permissions.has(permission));

  return <SessionContext.Provider value={{ session, login, logout, can }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
