// SEA: user photo (set by an administrator in the panel).

// Image source for the photo, with the session token (the API only shows
// it to the user, an administrator or whoever manages users). ``version``
// changes with each new photo, so a new photo is a new URL.
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
