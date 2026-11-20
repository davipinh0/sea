import { useState } from 'react';
import { initialsOf, photoUrl } from '../utils/userPhoto.js';

export default function UserAvatar({ userId, version, name, size = 32, className = '' }) {
  const url = photoUrl(userId, version);
  const [failedUrl, setFailedUrl] = useState(null);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) };
  if (url && failedUrl !== url) {
    return (
      <img
        className={`user-avatar ${className}`} style={style} src={url} alt={`Foto de ${name || 'usuário'}`}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <span className={`user-avatar user-avatar-initials ${className}`} style={style} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
