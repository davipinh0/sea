import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/auth/AuthContext';
import { ScanSettingsProvider } from './src/context/ScanSettingsContext';
import AppNavigator from './src/navigation/AppNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ScanSettingsProvider>
          <AppNavigator />
        </ScanSettingsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
