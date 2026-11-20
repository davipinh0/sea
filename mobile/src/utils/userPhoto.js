
// A API só mostra a foto ao próprio usuário, ao administrador ou a quem gerencia usuários.
// ``version`` muda a cada foto nova, então a URL muda.
export function photoSource(baseUrl, token, userId, version) {
  if (!baseUrl || !token || !userId || !version) return null;
  return {
    uri: `${String(baseUrl).replace(/\/+$/, '')}/api/admin/users/${userId}/foto?v=${version}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (parts[0][0] + last).toUpperCase();
}
