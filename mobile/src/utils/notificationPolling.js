// Decide o que a consulta periódica anuncia como notificação do aparelho.
//
// A primeira consulta depois de abrir o app só marca até onde já existe: o que aconteceu com o app
// fechado já chegou pelo push (ou foi visto no painel) e fica no contador do sino da tela inicial.
// Anunciar de novo repetia avisos já vistos ou já descartados.
//
// `last` é o maior id já conhecido nesta execução (null antes da primeira consulta). `list` vem da
// API em ordem decrescente de id.
export function pickNew(list, last) {
  const items = Array.isArray(list) ? list : [];
  const top = items.reduce((max, n) => Math.max(max, Number(n?.notification_id) || 0), 0);
  if (last === null || last === undefined) {
    return { last: top, fresh: [] };
  }
  const fresh = items.filter((n) => Number(n?.notification_id) > last);
  return { last: Math.max(last, top), fresh };
}
