import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { getStoredApiUrl } from '../api/client';
import { getAuthItem } from '../auth/secureStorage';
import { initialsOf, photoSource } from '../utils/userPhoto';
import { colors } from '../theme/styles';

// User photo set by an administrator or, without one, the initials.

export default function UserPhoto({ userId, version, name, size = 40 }) {
  const [source, setSource] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    (async () => {
      const [base, token] = await Promise.all([getStoredApiUrl(), getAuthItem('jwt_token')]);
      if (alive) setSource(photoSource(base, token, userId, version));
    })().catch(() => { if (alive) setSource(null); });
    return () => { alive = false; };
  }, [userId, version]);

  const round = { width: size, height: size, borderRadius: size / 2 };
  if (source && !failed) {
    return (
      <Image
        source={source} style={[round, { backgroundColor: colors.inputBg }]} onError={() => setFailed(true)}
        accessibilityLabel={`Foto de ${name || 'usuário'}`}
      />
    );
  }
  return (
    <View style={[round, { backgroundColor: colors.buttonBg, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ color: colors.onAccent, fontSize: Math.round(size * 0.4), fontWeight: '800' }}>{initialsOf(name)}</Text>
    </View>
  );
}
