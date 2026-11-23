import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SplashScreen from 'expo-splash-screen';
import { useAuth } from '../auth/AuthContext';
import { colors } from '../theme/styles';

// Keep splash visible while auth state loads
SplashScreen.preventAutoHideAsync().catch(() => {});

import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import ChangePasswordScreen from '../screens/ChangePasswordScreen';
import ReceberScreen from '../screens/ReceberScreen';
import ArmazenarScreen from '../screens/ArmazenarScreen';
import RetiradaScreen from '../screens/RetiradaScreen';
import TransferirScreen from '../screens/TransferirScreen';
import EstoqueScreen from '../screens/EstoqueScreen';
import OrdensScreen from '../screens/OrdensScreen';
import NotificacoesScreen from '../screens/NotificacoesScreen';
import HistoricoScreen from '../screens/HistoricoScreen';
import AcessosScreen from '../screens/AcessosScreen';
import { onNotificationTap, registerDevice, startPolling } from '../notifications';
import AppLock from '../components/AppLock';
import LoginApproval from '../components/LoginApproval';

const Stack = createNativeStackNavigator();

// Telas entram deslizando da direita; o login e a troca obrigatória de senha só aparecem.
const SCREEN_OPTIONS = { headerShown: false, animation: 'slide_from_right', animationDuration: 280 };

export default function AppNavigator() {
  const { user, isLoading, needsEnrollment } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [isLoading]);

  // Forced password change: when the user dict rehydrated from SecureStore
  // (or returned from login) carries must_change_password=true, route only
  // the change-password screen and nothing else. The force-kill + reopen
  // bypass is blocked because the flag survives in SecureStore until the
  // server-side column flips to false and we mirror that via
  // completePasswordChange.
  //
  // ChangePassword is only registered in the forced-mode branch. It is
  // not voluntarily accessible from the mobile app in v1.4.1 (no Settings
  // entry for it). When must_change_password flips false, removing the
  // route from the config is what lets native-stack fall through to the
  // initial route (Home) instead of preserving a stuck ChangePassword
  // state with its spinner still showing.
  //
  // When mobile adds a voluntary password-change flow (v1.5+), this will
  // need revisiting -- likely a manual navigation reset() call after
  // completePasswordChange() or a different navigator structure entirely.
  // See issue #67 for the source-of-truth refactor that touches this area.
  const forced = !!user?.must_change_password;

  const navigation = useRef(null);
  const active = !!user && !forced;
  const secureLock = active && !needsEnrollment;
  useEffect(() => {
    if (active) registerDevice({ secureLock });
  }, [active, secureLock]);
  useEffect(() => {
    if (!active) return undefined;
    const stopPolling = startPolling();
    const stopTaps = onNotificationTap((screen) => {
      if (navigation.current?.isReady()) navigation.current.navigate(screen);
    });
    return () => { stopPolling(); stopTaps(); };
  }, [active]);

  // Todo hook fica acima desta linha: um return antes de um hook faz o React quebrar e fecha o app
  // no build de produção.
  if (isLoading) {
    return null; // Splash screen stays visible
  }

  // O AppLock cobre as telas sem desmontá-las; o que estava em andamento sobrevive ao bloqueio.
  return (
    <>
    <NavigationContainer ref={navigation}>
      <Stack.Navigator screenOptions={SCREEN_OPTIONS}>
        {user ? (
          forced ? (
            <Stack.Screen
              name="ChangePassword"
              component={ChangePasswordScreen}
              options={{ gestureEnabled: false, animation: 'fade' }}
            />
          ) : (
            <>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen name="Receber" component={ReceberScreen} />
              <Stack.Screen name="Armazenar" component={ArmazenarScreen} />
              <Stack.Screen name="Retirada" component={RetiradaScreen} />
              <Stack.Screen name="Transferir" component={TransferirScreen} />
              <Stack.Screen name="Estoque" component={EstoqueScreen} />
              <Stack.Screen name="Ordens" component={OrdensScreen} />
              <Stack.Screen name="Notificacoes" component={NotificacoesScreen} />
              <Stack.Screen name="Historico" component={HistoricoScreen} />
              <Stack.Screen name="Acessos" component={AcessosScreen} options={{ animation: 'slide_from_bottom' }} />
            </>
          )
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} options={{ animation: 'fade' }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
    <AppLock />
    <LoginApproval />
    </>
  );
}
