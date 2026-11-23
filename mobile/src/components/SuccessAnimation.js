import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/styles';
import { TIMING, totalDuration } from '../utils/celebrate';

// Comemoração curta quando a operação dá certo. Some sozinha ou com um toque; com "reduzir
// movimento" ligado no celular aparece sem animar.
export default function SuccessAnimation({ event, onDone }) {
  const [shown, setShown] = useState(null);
  const backdrop = useRef(new Animated.Value(0)).current;
  const circle = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const icon = useRef(new Animated.Value(0)).current;
  const check = useRef(new Animated.Value(0)).current;
  const text = useRef(new Animated.Value(0)).current;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!event) return undefined;
    setShown(event);
    let cancelled = false;
    let timer = null;
    let animation = null;
    const values = [backdrop, circle, ring, icon, check, text];
    values.forEach((v) => v.setValue(0));
    const finish = () => {
      if (cancelled) return;
      setShown(null);
      done.current?.();
    };
    AccessibilityInfo.announceForAccessibility?.(`${event.title} ${event.detail}`);

    AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduce) => {
      if (cancelled) return;
      if (reduce) {
        [backdrop, circle, icon, check, text].forEach((v) => v.setValue(1));
        timer = setTimeout(finish, totalDuration(true));
        return;
      }
      const spring = (value, delay = 0) => Animated.spring(value, {
        toValue: 1, friction: 5, tension: 90, delay, useNativeDriver: true,
      });
      const timing = (value, toValue, duration, delay = 0) => Animated.timing(value, {
        toValue, duration, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      });
      animation = Animated.sequence([
        Animated.parallel([
          timing(backdrop, 1, 180),
          spring(circle),
          spring(icon, 80),
          timing(text, 1, 300, 160),
        ]),
        Animated.parallel([spring(check), timing(ring, 1, 650)]),
        Animated.delay(TIMING.hold),
        timing(backdrop, 0, TIMING.exit),
      ]);
      animation.start(({ finished }) => { if (finished) finish(); });
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      animation?.stop();
    };
  }, [event, backdrop, circle, ring, icon, check, text]);

  if (!shown) return null;
  const accent = colors[shown.accent] || colors.success;
  const from = shown.from || { x: 0, y: 0 };
  const close = () => { setShown(null); done.current?.(); };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={close}>
      <Pressable style={styles.fill} onPress={close} accessibilityLabel={`${shown.title} Tocar para fechar`}>
        <Animated.View style={[styles.fill, styles.backdrop, { opacity: backdrop }]}>
          <View style={styles.stage}>
            <Animated.View
              style={[styles.ring, { borderColor: accent, opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }), transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }] }]}
            />
            <Animated.View style={[styles.circle, { backgroundColor: accent, transform: [{ scale: circle }] }]}>
              <Animated.Text
                style={[styles.icon, {
                  opacity: icon,
                  transform: [
                    { translateX: icon.interpolate({ inputRange: [0, 1], outputRange: [from.x, 0] }) },
                    { translateY: icon.interpolate({ inputRange: [0, 1], outputRange: [from.y, 0] }) },
                  ],
                }]}
              >
                {shown.icon}
              </Animated.Text>
            </Animated.View>
            <Animated.View style={[styles.badge, { transform: [{ scale: check }] }]}>
              <Text style={[styles.badgeText, { color: accent }]}>✓</Text>
            </Animated.View>
          </View>
          <Animated.View style={{ opacity: text, transform: [{ translateY: text.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }}>
            <Text style={styles.title}>{shown.title}</Text>
            {shown.detail ? <Text style={styles.detail}>{shown.detail}</Text> : null}
          </Animated.View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const SIZE = 132;
const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.overlay },
  stage: { width: SIZE + 40, height: SIZE + 40, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 4 },
  circle: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  icon: { fontSize: 58 },
  badge: { position: 'absolute', right: 16, bottom: 16, width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', elevation: 9, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  badgeText: { fontSize: 28, fontWeight: '900' },
  title: { fontSize: 26, fontWeight: '900', color: '#fff', textAlign: 'center', letterSpacing: 0.5 },
  detail: { fontSize: 15, color: '#fff', textAlign: 'center', marginTop: 8, opacity: 0.92 },
});
