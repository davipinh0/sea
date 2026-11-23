import { AccessibilityInfo } from 'react-native';

// "Reduzir movimento" do celular, lido uma vez ao abrir o app e atualizado quando muda. A consulta
// é assíncrona; guardada aqui, as animações começam na hora em vez de esperar a resposta.
let reduce = false;
AccessibilityInfo.isReduceMotionEnabled?.().then((value) => { reduce = !!value; }).catch(() => {});
AccessibilityInfo.addEventListener?.('reduceMotionChanged', (value) => { reduce = !!value; });

export default function reduceMotion() {
  return reduce;
}
