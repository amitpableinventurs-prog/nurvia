import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, sessionEvents, tokens } from './api.js';

const SessionContext = createContext(null);

// session: undefined while loading, null when signed out, otherwise { user, vendor }.
// vendor is null for a signed-in person who has not registered a business yet.
export function SessionProvider({ children }) {
  const [session, setSession] = useState(undefined);

  const load = useCallback(async () => {
    if (!tokens.current.accessToken) return setSession(null);
    try {
      const user = await api.get('/users/me');
      const vendor = user.roles.includes('vendor') ? await api.get('/vendors/me').catch((e) => (e.status === 404 ? null : Promise.reject(e))) : null;
      setSession({ user, vendor });
    } catch (err) {
      if (err.status === 401) {
        tokens.clear();
        setSession(null);
      } else {
        setSession((s) => s ?? null);
      }
    }
  }, []);

  useEffect(() => {
    sessionEvents.onExpired = () => setSession(null);
    load();
  }, [load]);

  const signIn = async (result) => {
    tokens.save(result);
    await load();
  };

  const signOut = async () => {
    const { refreshToken } = tokens.current;
    tokens.clear();
    setSession(null);
    if (refreshToken) await api.post('/auth/logout', { refreshToken }).catch(() => {});
  };

  // Pages call this after changing the business profile so the shell (name, status) stays current.
  const refreshVendor = async () => {
    const vendor = await api.get('/vendors/me');
    setSession((s) => ({ ...s, vendor }));
    return vendor;
  };

  return <SessionContext.Provider value={{ session, signIn, signOut, refreshVendor, reload: load }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
