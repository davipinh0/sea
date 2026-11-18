import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import client, { setLogoutHandler, initApiUrl } from '../api/client';
import { BIOMETRIC_USER_KEY, sameUser, shouldLock, withoutLock } from './appLock';
import { getDeviceToken } from '../notifications';
import {
  clearAllAuth,
  getAuthItem,
  runAuthStorageMigration,
  setAuthItem,
} from './secureStorage';

const AuthContext = createContext(null);

const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000;

// The browser build (only for checking screens on a computer) has no
// fingerprint sensor nor background: it does not lock.
const LOCK_SUPPORTED = Platform.OS !== 'web';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [warehouseId, setWarehouseId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const appState = useRef(AppState.currentState);
  // App lock (see appLock.js): ``locked`` covers the screens with the lock
  // screen; ``needsEnrollment`` asks for the fingerprint after the first
  // password login of this user on this phone.
  const [locked, setLocked] = useState(false);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const lockEnabled = useRef(false);

  // After a session starts (password login or reopening the app): lock
  // from now on when this user already registered the fingerprint here,
  // otherwise ask to register it.
  const startLock = useCallback(async (username, { lockNow }) => {
    if (!LOCK_SUPPORTED) return;
    const registered = sameUser(await getAuthItem(BIOMETRIC_USER_KEY), username);
    lockEnabled.current = registered;
    setNeedsEnrollment(!registered);
    setLocked(registered && lockNow);
  }, []);

  const logout = useCallback(async () => {
    // mig 093: the session also ends on the server, so a copy of the token
    // stops working. Best effort: offline, it still dies with the token.
    await client.post('/api/auth/logout', {}, { keepSession: true, timeout: 4000 }).catch(() => {});
    await clearAllAuth();
    lockEnabled.current = false;
    setLocked(false);
    setNeedsEnrollment(false);
    setUser(null);
    setWarehouseId(null);
  }, []);

  useEffect(() => {
    setLogoutHandler(logout);
  }, [logout]);

  const checkSession = useCallback(async () => {
    const timestamp = await getAuthItem('login_timestamp');
    if (timestamp && Date.now() - parseInt(timestamp, 10) > SESSION_TIMEOUT_MS) {
      await logout();
      return false;
    }
    return true;
  }, [logout]);

  useEffect(() => {
    (async () => {
      try {
        // Load saved API URL from AsyncStorage BEFORE any API calls
        await initApiUrl();
        // V-047: lift any plaintext auth keys left over from a prior install
        // out of AsyncStorage and into the keystore before reading them.
        await runAuthStorageMigration();
        const valid = await checkSession();
        if (!valid) {
          setIsLoading(false);
          return;
        }
        const token = await getAuthItem('jwt_token');
        const userData = await getAuthItem('user_data');
        const wId = await getAuthItem('warehouse_id');
        if (token && userData) {
          const saved = JSON.parse(userData);
          // Reopening the app with a session: it opens locked.
          await startLock(saved.username, { lockNow: true });
          setUser(saved);
          setWarehouseId(wId ? parseInt(wId, 10) : null);
        }
      } catch {
        await logout();
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        checkSession();
      }
      if (shouldLock(nextState, { enabled: lockEnabled.current })) setLocked(true);
      appState.current = nextState;
    });
    return () => sub.remove();
  }, [checkSession]);

  // Password login. Returns { approval } when the login waits for the
  // confirmation on the user's registered phone (mig 092); the caller
  // waits for it and then calls completeLogin.
  const login = async (username, password) => {
    const deviceToken = await getDeviceToken();
    const resp = await client.post('/api/auth/login', {
      username, password, ...(deviceToken ? { device_token: deviceToken } : {}),
    });
    if (resp.status === 202) return { approval: resp.data };
    await completeLogin(resp.data);
    return {};
  };

  const completeLogin = async ({ token, user: userData }) => {
    await setAuthItem('jwt_token', token);
    // userData already carries must_change_password from the backend; we
    // store the whole dict so the flag survives a force-kill + reopen and
    // the navigator can enforce forced-mode on rehydrate.
    await setAuthItem('user_data', JSON.stringify(userData));
    await setAuthItem('login_timestamp', String(Date.now()));
    // The password was just typed: no lock now, but the fingerprint is
    // asked for when this user has not registered it on this phone.
    await startLock(userData.username, { lockNow: false });
    setUser(userData);
    // warehouseId stays null - HomeScreen will prompt for selection
  };

  // Turns the app lock on for the logged-in user on this phone, confirmed
  // with the fingerprint or, without one, the phone's PIN/pattern.
  const enrollFingerprint = useCallback(async () => {
    const result = await withoutLock(() => LocalAuthentication.authenticateAsync({
      promptMessage: 'Ativar o bloqueio do SEA',
      cancelLabel: 'Cancelar',
      disableDeviceFallback: false,
    }));
    if (!result.success) return result;
    await setAuthItem(BIOMETRIC_USER_KEY, user?.username || '');
    lockEnabled.current = true;
    setNeedsEnrollment(false);
    return { success: true };
  }, [user]);

  const unlockWithFingerprint = useCallback(async () => {
    const result = await withoutLock(() => LocalAuthentication.authenticateAsync({
      promptMessage: 'Desbloquear o SEA',
      cancelLabel: 'Usar senha do SEA',
      // The phone's PIN or pattern also unlocks (phones without a
      // fingerprint, or a finger that is not read).
      disableDeviceFallback: false,
    }));
    if (result.success) setLocked(false);
    return result;
  }, []);

  // The account password, checked by the server, also unlocks; the
  // session is renewed. A wrong password keeps the app locked (and the
  // session alive): the caller shows the error.
  // Regression (mig 092): this login did not send the phone's token, so the
  // registered phone itself was asked to confirm the login (202, no token),
  // an empty token was saved and the app logged out.
  const unlockWithPassword = useCallback(async (password) => {
    const deviceToken = await getDeviceToken();
    const resp = await client.post(
      '/api/auth/login',
      { username: user?.username, password, ...(deviceToken ? { device_token: deviceToken } : {}) },
      { keepSession: true },
    );
    if (resp.status === 202 || !resp.data?.token) {
      throw Object.assign(new Error('not trusted'), {
        userMessage: 'Este celular não está cadastrado para confirmar logins. Desbloqueie com a digital ou o PIN do celular.',
      });
    }
    await setAuthItem('jwt_token', resp.data.token);
    await setAuthItem('login_timestamp', String(Date.now()));
    setLocked(false);
  }, [user]);

  const switchWarehouse = async (newWarehouseId) => {
    // The screen changes at once; saving the choice follows.
    setWarehouseId(newWarehouseId);
    await setAuthItem('warehouse_id', String(newWarehouseId));
  };

  // Called by ChangePasswordScreen after a successful forced password
  // change. Backend has already cleared must_change_password; we mirror
  // that in state + SecureStore so the navigator exits forced mode.
  const completePasswordChange = useCallback(async () => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, must_change_password: false };
      // Write-through to SecureStore so a resume after this returns the
      // cleared flag, not the stale forced state.
      setAuthItem('user_data', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        warehouseId,
        isLoading,
        login,
        logout,
        switchWarehouse,
        completePasswordChange,
        completeLogin,
        locked,
        needsEnrollment,
        enrollFingerprint,
        unlockWithFingerprint,
        unlockWithPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
