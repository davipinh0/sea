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
import { onNotificationTap, registerDevice, startPolling } from '../notifications';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [isLoading]);

  if (isLoading) {
    return null; // Splash screen stays visible
  }

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

  // Notifications while a user is logged in: this phone is registered,
  // new ones are shown as they arrive and a tap opens the related screen.
  const navigation = useRef(null);
  const active = !!user && !forced;
  useEffect(() => {
    if (!active) return undefined;
    registerDevice();
    const stopPolling = startPolling();
    const stopTaps = onNotificationTap((screen) => {
      if (navigation.current?.isReady()) navigation.current.navigate(screen);
    });
    return () => { stopPolling(); stopTaps(); };
  }, [active]);

  return (
    <NavigationContainer ref={navigation}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {user ? (
          forced ? (
            <Stack.Screen
              name="ChangePassword"
              component={ChangePasswordScreen}
              options={{ gestureEnabled: false }}
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
            </>
          )
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
