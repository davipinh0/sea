// SEA: user photo helpers (Sistema > Usuários, top bar).

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// The panel is authenticated by cookie, so a plain <img> can load it;
// ``version`` (photo_version from the API) makes a new photo a new URL.
export function photoUrl(userId, version) {
  return userId && version ? `/api/admin/users/${userId}/foto?v=${version}` : null;
}

const SIZE = 256;

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('arquivo ilegível'));
    reader.readAsDataURL(file);
  });
}

// Regression: a blob: URL is refused by the panel's CSP (img-src 'self'
// data:), so the photo never loaded and was never sent. A data: URL is
// allowed.
async function readImage(file) {
  const url = await readDataUrl(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagem inválida'));
    img.src = url;
  });
}

// Centre square of the picture, reduced to 256 x 256, as a JPEG data URL.
export async function squareJpeg(file) {
  const img = await readImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
  return canvas.toDataURL('image/jpeg', 0.85);
}
