// "Gerenciar Acessos": o que o usuário pode fazer, com os mesmos nomes do painel (Sistema >
// Usuários). Só funções puras, testadas sem o React Native.
import { MODULES } from './sea';

export const ACCESS_GROUPS = [
  { label: 'Estoque', items: [
    { key: 'inventory', label: 'Visão geral do estoque' },
    { key: 'items', label: 'Materiais' },
    { key: 'bins', label: 'Endereços' },
    { key: 'audit-log', label: 'Histórico' },
  ] },
  { label: 'Expedição', items: [
    { key: 'receiving', label: 'Recebimento de ordem' },
    { key: 'putaway', label: 'Armazenagem' },
    { key: 'purchase-orders', label: 'Ordens' },
  ] },
  { label: 'Retirada', items: [
    { key: 'retirada', label: 'Solicitar retirada' },
    { key: 'retirada-avaliar', label: 'Avaliar retirada (aprovar ou negar)' },
    { key: 'retirada-fazer', label: 'Fazer retirada (aceitar e separar)' },
  ] },
  { label: 'Sistema', items: [
    { key: 'users', label: 'Usuários' },
    { key: 'settings', label: 'Configurações' },
    { key: 'material-catalog', label: 'Cadastro de materiais' },
    { key: 'imports', label: 'Importação de dados' },
  ] },
  { label: 'Extras', items: [
    { key: 'export-csv', label: 'Exportar CSV', override: true },
  ] },
];

// Funções do celular (recebimento e armazenagem) também liberam a área correspondente.
const FUNCTION_FOR_PAGE = { receiving: 'receive', putaway: 'putaway' };

export function accessGroups(me) {
  const admin = me?.role === 'ADMIN';
  const pages = me?.allowed_pages || [];
  const overrides = me?.allowed_overrides || [];
  const functions = me?.allowed_functions || [];
  return ACCESS_GROUPS.map((group) => {
    const items = group.items.map((item) => ({
      ...item,
      granted: admin
        || (item.override ? overrides.includes(item.key) : pages.includes(item.key))
        || functions.includes(FUNCTION_FOR_PAGE[item.key]),
    }));
    return { ...group, items, granted: items.filter((i) => i.granted).length };
  });
}

// Telas do app liberadas, sem considerar o local (cada uma diz onde vale).
export function appModules(me) {
  if (!me) return [];
  const admin = me.role === 'ADMIN';
  const pages = me.allowed_pages || [];
  const functions = me.allowed_functions || [];
  return MODULES.map((m) => ({
    label: m.label,
    sub: m.onlyAt ? `${m.sub} (só no local ${m.onlyAt})` : m.sub,
    granted: admin || (m.fn && functions.includes(m.fn)) || m.pages.some((p) => pages.includes(p)),
  }));
}

export function accessSummary(me) {
  if (me?.role === 'ADMIN') return 'Administrador: acesso a tudo, em todos os locais.';
  const total = accessGroups(me).reduce((n, g) => n + g.granted, 0);
  if (total === 0) return 'Nenhuma permissão liberada ainda.';
  return total === 1 ? '1 permissão liberada.' : `${total} permissões liberadas.`;
}
