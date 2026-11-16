import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/auth/AuthContext';
import { StatusBar } from 'expo-status-bar';
import { isDark } from './src/theme/styles';
import AppNavigator from './src/navigation/AppNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <AppNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
