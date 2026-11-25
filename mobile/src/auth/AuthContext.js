import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import client, { setLogoutHandler, initApiUrl } from '../api/client';
import { BIOMETRIC_USER_KEY, authenticate, sameUser, shouldLock, withoutLock } from './appLock';
import { clearSavedLogin, forgetOtherUser, loadSavedLogin, saveLogin } from './savedLogin';
import { clearIdentityConfirmed } from './identityProof';
import { getDeviceToken } from '../notifications';
import {
  clearAllAuth,
  getAuthItem,
  runAuthStorageMigration,
  setAuthItem,
} from './secureStorage';

const AuthContext = createContext(null);

const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000;

// A versão para navegador (só para ver as telas no computador) não tem digital nem segundo plano:
// não trava.
const LOCK_SUPPORTED = Platform.OS !== 'web';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [warehouseId, setWarehouseId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const appState = useRef(AppState.currentState);
  const [locked, setLocked] = useState(false);
  // A tela de bloqueio pede a digital quando o app volta para a frente; esse aviso pode chegar logo
  // depois de desbloquear. Sem esta conferência abria um pedido a mais, que ficava aberto e fazia o
  // Android recusar o seguinte (o "SIM, SOU EU" do login no terminal).
  const lockedRef = useRef(false);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const lockEnabled = useRef(false);
  // Senha digitada no último login, só na memória, até ir para o login salvo (savedLogin.js): na
  // hora, se o bloqueio já está ativo neste celular; senão, quando o usuário ativar.
  const pendingPassword = useRef(null);

  // Depois de iniciar a sessão: trava se este usuário já cadastrou a digital aqui; senão, pede o
  // cadastro.
  const startLock = useCallback(async (username, { lockNow }) => {
    if (!LOCK_SUPPORTED) return false;
    const registered = sameUser(await getAuthItem(BIOMETRIC_USER_KEY), username);
    lockEnabled.current = registered;
    setNeedsEnrollment(!registered);
    setLocked(registered && lockNow);
    return registered;
  }, []);

  const savePendingPassword = useCallback(async (username) => {
    const password = pendingPassword.current;
    pendingPassword.current = null;
    if (LOCK_SUPPORTED && password) await saveLogin(SecureStore, username, password);
  }, []);

  const logout = useCallback(async () => {
    // A sessão também termina no servidor, então uma cópia do token para de funcionar. Sem conexão,
    // ela morre com o token.
    await client.post('/api/auth/logout', {}, { keepSession: true, timeout: 4000 }).catch(() => {});
    // O login salvo continua: o próximo login pode ser com a digital ou o PIN.
    await clearAllAuth();
    clearIdentityConfirmed();
    pendingPassword.current = null;
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

  // Retorna { approval } quando o login espera a confirmação no celular cadastrado.
  const login = async (username, password) => {
    pendingPassword.current = LOCK_SUPPORTED ? password : null;
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
    // A senha acabou de ser digitada: não trava agora, mas pede a digital se o usuário ainda não
    // cadastrou neste celular.
    const registered = await startLock(userData.username, { lockNow: false });
    if (LOCK_SUPPORTED) {
      // Outro usuário entrou neste celular: o login salvo do anterior não vale mais.
      await forgetOtherUser(SecureStore, userData.username);
      // Bloqueio já ativo: guarda (ou atualiza) a senha agora; senão, ao ativar.
      if (registered) await savePendingPassword(userData.username);
    }
    setUser(userData);
    // warehouseId stays null - HomeScreen will prompt for selection
  };

  // Usuário com login salvo neste celular (null se não houver). A tela de login usa para oferecer
  // a entrada com a digital ou o PIN.
  const savedLoginUser = useCallback(async () => {
    if (!LOCK_SUPPORTED) return null;
    const saved = await loadSavedLogin(SecureStore, await getAuthItem(BIOMETRIC_USER_KEY));
    return saved?.username ?? null;
  }, []);

  // Entra com o login salvo depois da digital ou do PIN. Retorna { biometric } quando a confirmação
  // não passou, { missing } sem login salvo, ou o mesmo que login(). Senha recusada pelo servidor
  // (ela mudou) apaga o login salvo e o erro segue para a tela, que pede para digitar.
  const loginWithSavedPassword = async () => {
    const result = await withoutLock(() => authenticate(LocalAuthentication, {
      promptMessage: 'Entrar no SEA',
      cancelLabel: 'Digitar a senha',
      disableDeviceFallback: false,
    }));
    if (!result.success) return { biometric: result };
    const saved = await loadSavedLogin(SecureStore, await getAuthItem(BIOMETRIC_USER_KEY));
    if (!saved) return { missing: true };
    try {
      return await login(saved.username, saved.password);
    } catch (err) {
      if (err.response?.status === 401) await clearSavedLogin(SecureStore);
      throw err;
    }
  };

  const enrollFingerprint = useCallback(async () => {
    const result = await withoutLock(() => authenticate(LocalAuthentication, {
      promptMessage: 'Ativar o bloqueio do SEA',
      cancelLabel: 'Cancelar',
      disableDeviceFallback: false,
    }));
    if (!result.success) return result;
    await setAuthItem(BIOMETRIC_USER_KEY, user?.username || '');
    lockEnabled.current = true;
    setNeedsEnrollment(false);
    if (user?.username) await savePendingPassword(user.username);
    return { success: true };
  }, [user, savePendingPassword]);

  const unlockWithFingerprint = useCallback(async () => {
    if (!lockedRef.current) return { success: true };
    const result = await withoutLock(() => authenticate(LocalAuthentication, {
      promptMessage: 'Desbloquear o SEA',
      cancelLabel: 'Usar senha do SEA',
      // O PIN ou padrão do celular também destrava (celular sem digital, ou dedo que não é lido).
      disableDeviceFallback: false,
    }));
    if (result.success) setLocked(false);
    return result;
  }, []);

  // A senha da conta também destrava e renova a sessão; senha errada mantém o app travado.
  // Regressão: este login não mandava o token do celular, então o próprio celular era chamado a
  // confirmar, um token vazio era salvo e o app saía.
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
    // A senha acabou de ser aceita pelo servidor: atualiza o login salvo (pode ter mudado).
    if (LOCK_SUPPORTED && lockEnabled.current && user?.username) {
      await saveLogin(SecureStore, user.username, password);
    }
    setLocked(false);
  }, [user]);

  const switchWarehouse = async (newWarehouseId) => {
    setWarehouseId(newWarehouseId);
    await setAuthItem('warehouse_id', String(newWarehouseId));
  };

  // Called by ChangePasswordScreen after a successful forced password
  // change. Backend has already cleared must_change_password; we mirror
  // that in state + SecureStore so the navigator exits forced mode.
  const completePasswordChange = useCallback(async (newPassword) => {
    // A senha temporária do login não serve mais: o login salvo passa a usar a nova.
    if (LOCK_SUPPORTED && newPassword) {
      if (lockEnabled.current && user?.username) await saveLogin(SecureStore, user.username, newPassword);
      else pendingPassword.current = newPassword;
    }
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, must_change_password: false };
      // Write-through to SecureStore so a resume after this returns the
      // cleared flag, not the stale forced state.
      setAuthItem('user_data', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [user]);

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
        savedLoginUser,
        loginWithSavedPassword,
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
