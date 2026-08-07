import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await axios.get('/api/auth/me');
      setUser(res.data?.user || null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = () => { window.location.href = '/api/auth/login'; };

  const logout = async () => {
    try { await axios.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
  };

  // Does the signed-in member hold a capability? Hiding a control is a courtesy,
  // not a security boundary — every one of these is enforced again server-side
  // (see backend/permissions.js), so a wrong answer here shows or hides a button
  // rather than granting anything.
  //
  // A session issued before capabilities existed has no permissions array; an
  // old admin token counts as full access until it re-verifies, matching the
  // backend's rule so the two can't disagree mid-session.
  const can = useCallback((permission) => {
    if (!user) return false;
    if (Array.isArray(user.permissions)) return user.permissions.includes(permission);
    return !!user.isAdmin;
  }, [user]);

  // For "does this person belong in the admin area at all" — the sidebar section
  // and page gates. Anything finer must ask can() for a specific capability.
  const canAny = useCallback(
    (...permissions) => permissions.some((p) => can(p)),
    [can],
  );

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, can, canAny }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
