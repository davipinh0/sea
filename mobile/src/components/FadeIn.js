import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import reduceMotion from './reduceMotion';

// Entra subindo e aparecendo; ``index`` escalona uma lista. Sem animação com "reduzir movimento".
export default function FadeIn({ index = 0, style, children }) {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion()) { value.setValue(1); return undefined; }
    const animation = Animated.timing(value, {
      toValue: 1, duration: 320, delay: Math.min(index, 10) * 55,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [index, value]);

  const translateY = value.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  return <Animated.View style={[style, { opacity: value, transform: [{ translateY }] }]}>{children}</Animated.View>;
}
