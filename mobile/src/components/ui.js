import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Modal, StyleSheet } from 'react-native';
import { colors, fonts, radii, buttonStyles } from '../theme/styles';
import { groupByLocation } from '../utils/sea';

// Small building blocks shared by the SEA screens.

export function Message({ message }) {
  if (!message) return null;
  const ok = message.type === 'ok';
  return (
    <View style={[styles.message, ok ? styles.messageOk : styles.messageError]} accessibilityRole={ok ? 'text' : 'alert'}>
      <Text style={[styles.messageText, { color: ok ? colors.success : colors.danger }]}>{message.text}</Text>
    </View>
  );
}

export function Card({ title, children, style }) {
  return (
    <View style={[styles.card, style]}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Field({ label, value }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value || '-'}</Text>
    </View>
  );
}

export function Button({ label, onPress, disabled, secondary, danger, style }) {
  return (
    <TouchableOpacity
      style={[secondary ? buttonStyles.buttonSecondary : buttonStyles.buttonPrimary, danger && { backgroundColor: colors.danger }, disabled && buttonStyles.buttonDisabled, style]}
      onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
    >
      <Text style={secondary ? buttonStyles.buttonSecondaryText : buttonStyles.buttonPrimaryText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function QuantityInput({ label = 'QUANTIDADE', value, onChangeText, hint }) {
  return (
    <View style={{ marginVertical: 10 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.quantity} value={value} onChangeText={onChangeText} keyboardType="number-pad"
        placeholderTextColor={colors.textPlaceholder} accessibilityLabel={label} selectTextOnFocus
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

// Destination picker: storage addresses of every location, grouped.
export function AddressPicker({ visible, bins, excludeBinId, suggestedBinId, onPick, onClose }) {
  const groups = groupByLocation(bins, excludeBinId);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.cardTitle}>ESCOLHA O DESTINO</Text>
          <ScrollView style={{ maxHeight: 420 }}>
            {groups.length === 0 && <Text style={styles.hint}>Nenhum endereço de armazenagem disponível.</Text>}
            {groups.map((group) => (
              <View key={group.code} style={{ marginBottom: 10 }}>
                <Text style={styles.groupTitle}>{group.code} · {group.name}</Text>
                <View style={styles.binGrid}>
                  {group.bins.map((bin) => (
                    <TouchableOpacity
                      key={bin.bin_id}
                      style={[styles.bin, bin.bin_id === suggestedBinId && styles.binSuggested]}
                      onPress={() => onPick(bin)}
                      accessibilityLabel={`${group.code} ${bin.bin_code}`}
                    >
                      <Text style={styles.binText}>{bin.bin_code}</Text>
                      {bin.bin_id === suggestedBinId ? <Text style={styles.binTag}>sugerido</Text> : null}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>
          <Button label="CANCELAR" secondary onPress={onClose} style={{ marginTop: 8 }} />
        </View>
      </View>
    </Modal>
  );
}

export function ConfirmModal({ visible, title, message, confirmLabel = 'CONFIRMAR', danger, onConfirm, onClose, children }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.cardTitle}>{title}</Text>
          {message ? <Text style={styles.body}>{message}</Text> : null}
          {children}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Button label={confirmLabel} danger={danger} onPress={onConfirm} style={{ flex: 1 }} />
            <Button label="VOLTAR" secondary onPress={onClose} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export const ui = StyleSheet.create({
  line: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
  },
  code: { fontFamily: fonts.mono, fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  name: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  meta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  empty: { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginTop: 24 },
  tag: {
    alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.badge,
    backgroundColor: colors.cream, color: colors.accentRed, fontSize: 11, fontWeight: '700', overflow: 'hidden',
  },
});

const styles = StyleSheet.create({
  message: { padding: 12, borderRadius: radii.small, marginBottom: 12, borderWidth: 1 },
  messageOk: { backgroundColor: '#EAF6EC', borderColor: colors.success },
  messageError: { backgroundColor: '#FDECEA', borderColor: colors.danger },
  messageText: { fontSize: 14, fontWeight: '600' },
  card: {
    backgroundColor: colors.cardBg, borderWidth: 1, borderColor: colors.cardBorder,
    borderRadius: radii.card, padding: 14, marginBottom: 12,
  },
  cardTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5, color: colors.textPrimary, marginBottom: 8 },
  field: { marginBottom: 6 },
  fieldLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted },
  fieldValue: { fontSize: 14, color: colors.textPrimary },
  quantity: {
    minHeight: 52, marginTop: 4, paddingHorizontal: 12, fontFamily: fonts.mono, fontSize: 22,
    fontWeight: '700', color: colors.textPrimary, backgroundColor: colors.background,
    borderWidth: 1.5, borderColor: colors.inputBorder, borderRadius: radii.input,
  },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  body: { fontSize: 14, color: colors.textPrimary },
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: colors.background, borderRadius: radii.card, padding: 16 },
  groupTitle: { fontSize: 12, fontWeight: '800', color: colors.textSecondary, marginBottom: 6 },
  binGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bin: {
    minWidth: 72, minHeight: 48, paddingHorizontal: 10, justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.cardBg, borderWidth: 1.5, borderColor: colors.cardBorder, borderRadius: radii.small,
  },
  binSuggested: { borderColor: colors.copper, backgroundColor: colors.cream },
  binText: { fontFamily: fonts.mono, fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  binTag: { fontSize: 10, color: colors.accentRed, fontWeight: '700' },
});
