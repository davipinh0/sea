import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { colors, fonts, radii } from '../theme/styles';
import { withoutLock } from '../auth/appLock';

// Digitar o código ou ler o código de barras com a câmera. O ScanInput antigo é para coletores com
// leitor embutido; este é para celular comum.

const BARCODE_TYPES = ['code128', 'code39', 'code93', 'ean13', 'ean8', 'itf14', 'qr', 'datamatrix'];

export default function CodeInput({ placeholder, onSubmit, disabled = false, autoFocus = false, buttonLabel = 'OK' }) {
  const [value, setValue] = useState('');
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraNote, setCameraNote] = useState('');

  function submit(raw) {
    const code = String(raw ?? '').replace(/[\r\n\t]/g, '').trim();
    if (!code || disabled) return;
    setValue('');
    onSubmit(code);
  }

  async function openCamera() {
    setCameraNote('');
    let granted = permission?.granted;
    if (!granted) granted = (await withoutLock(requestPermission))?.granted;
    if (!granted) {
      setCameraNote('Sem permissão para usar a câmera. Libere nas configurações do aparelho ou digite o código.');
      return;
    }
    setScanning(true);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, disabled && styles.disabled]}
          placeholder={placeholder}
          placeholderTextColor={colors.textPlaceholder}
          value={value}
          onChangeText={setValue}
          onSubmitEditing={() => submit(value)}
          editable={!disabled}
          autoFocus={autoFocus}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={placeholder}
        />
        <TouchableOpacity style={[styles.button, disabled && styles.disabled]} disabled={disabled} onPress={() => submit(value)} accessibilityLabel="Confirmar código">
          <Text style={styles.buttonText}>{buttonLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, styles.camera, disabled && styles.disabled]} disabled={disabled} onPress={openCamera} accessibilityLabel="Ler código com a câmera">
          <Text style={styles.buttonText}>CÂMERA</Text>
        </TouchableOpacity>
      </View>
      {cameraNote ? <Text style={styles.note}>{cameraNote}</Text> : null}

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.cameraScreen}>
          {scanning && (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
              onBarcodeScanned={({ data }) => { setScanning(false); submit(data); }}
            />
          )}
          <View style={styles.cameraHint}>
            <Text style={styles.cameraHintText}>Aponte a câmera para o código de barras</Text>
          </View>
          <TouchableOpacity style={styles.cameraClose} onPress={() => setScanning(false)}>
            <Text style={styles.cameraCloseText}>FECHAR</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  row: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1, minHeight: 48, paddingHorizontal: 12, fontFamily: fonts.mono, fontSize: 15,
    color: colors.textPrimary, backgroundColor: colors.inputBg, borderWidth: 1.5,
    borderColor: colors.inputBorder, borderRadius: radii.input,
  },
  button: {
    minHeight: 48, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.copper, borderRadius: radii.button,
  },
  // Cinza escuro fixo: no tema escuro textPrimary é branco.
  camera: { backgroundColor: '#455A64' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 12, letterSpacing: 0.5 },
  disabled: { opacity: 0.5 },
  note: { marginTop: 6, fontSize: 12, color: colors.danger },
  cameraScreen: { flex: 1, backgroundColor: '#000', justifyContent: 'flex-end' },
  cameraHint: { position: 'absolute', top: 60, left: 0, right: 0, alignItems: 'center' },
  cameraHintText: { color: '#fff', fontSize: 15, fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  cameraClose: { margin: 24, minHeight: 52, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.copper, borderRadius: radii.button },
  cameraCloseText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
