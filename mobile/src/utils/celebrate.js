// Animação de sucesso de cada operação. Só funções puras, testadas sem o React Native.

// ``from`` é de onde o ícone chega: de cima (chegou no recebimento), da esquerda (entrou na
// prateleira) ou de baixo (saiu para quem pediu).
export const CELEBRATIONS = {
  receber: { icon: '📥', title: 'Recebido!', accent: 'accentRed', from: { x: 0, y: -60 } },
  armazenar: { icon: '📦', title: 'Armazenado!', accent: 'copper', from: { x: -70, y: 0 } },
  aprovada: { icon: '👍', title: 'Retirada aprovada!', accent: 'success', from: { x: 0, y: 40 } },
  aceita: { icon: '🧰', title: 'Retirada aceita!', accent: 'copper', from: { x: 0, y: 40 } },
  pronta: { icon: '🤝', title: 'Pronta para retirar!', accent: 'success', from: { x: 0, y: 40 } },
};

// Negar e cancelar não comemoram.
export function withdrawalCelebration(action, body) {
  if (action === 'avaliar') return body?.approve === true ? 'aprovada' : null;
  if (action === 'separar') return 'aceita';
  if (action === 'pronta') return 'pronta';
  return null;
}

let sequence = 0;

export function celebration(kind, detail) {
  const spec = CELEBRATIONS[kind];
  if (!spec) return null;
  sequence += 1;
  return { ...spec, kind, detail: detail || '', id: sequence };
}

// Tempos (ms): entrada, check, quanto fica parado e saída. Com "reduzir movimento" fica só parado.
export const TIMING = { enter: 420, check: 300, hold: 1100, exit: 260 };

export function totalDuration(reduceMotion) {
  return reduceMotion ? TIMING.hold + 400 : TIMING.enter + TIMING.check + TIMING.hold + TIMING.exit;
}
