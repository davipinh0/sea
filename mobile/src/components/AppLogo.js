import React from 'react';
import { Image, StyleSheet } from 'react-native';

// A logo do aplicativo (o mesmo ícone da tela inicial do celular), no login e no bloqueio.
export default function AppLogo({ size = 96, style }) {
  return (
    <Image
      source={require('../../assets/icon.png')}
      style={[styles.logo, { width: size, height: size, borderRadius: Math.round(size * 0.23) }, style]}
      accessibilityRole="image" accessibilityLabel="SEA"
    />
  );
}

const styles = StyleSheet.create({
  logo: { alignSelf: 'center' },
});
