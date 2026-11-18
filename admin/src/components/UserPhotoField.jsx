import { useRef, useState } from 'react';
import { api } from '../api.js';
import UserAvatar from './UserAvatar.jsx';
import { squareJpeg } from '../utils/userPhoto.js';

// Photo of a user in Sistema > Usuários. Only an administrator sees this
// field (the API refuses anyone else). The picture is cut to a square
// and reduced to 256 px JPEG in the browser before it is sent.

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export default function UserPhotoField({ userId, name, version, onChanged }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function choose(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setMessage({ error: true, text: 'Formato não aceito. Use uma foto JPG, PNG ou WEBP.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const image = await squareJpeg(file);
      const res = await api.put(`/admin/users/${userId}/foto`, { image });
      const data = await res?.json().catch(() => ({}));
      if (res?.ok) {
        onChanged(data.photo_version);
        setMessage({ text: 'Foto salva.' });
      } else {
        setMessage({ error: true, text: data?.user_facing ? data.error : 'Não foi possível salvar a foto.' });
      }
    } catch {
      setMessage({ error: true, text: 'Não foi possível abrir essa imagem. Escolha outra foto.' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    const res = await api.delete(`/admin/users/${userId}/foto`);
    setBusy(false);
    if (res?.ok) {
      onChanged(null);
      setMessage({ text: 'Foto removida.' });
    } else {
      setMessage({ error: true, text: 'Não foi possível remover a foto.' });
    }
  }

  return (
    <div className="form-group user-photo-field">
      <label>Foto</label>
      <div className="user-photo-row">
        <UserAvatar userId={userId} version={version} name={name} size={72} />
        <div className="user-photo-actions">
          <input ref={input} type="file" accept={ACCEPTED.join(',')} onChange={choose} hidden aria-label="Arquivo da foto" />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Salvando…' : version ? 'Trocar foto' : 'Colocar foto'}
          </button>
          {version && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={remove}>Remover foto</button>
          )}
        </div>
      </div>
      {message && <div className={message.error ? 'form-error' : 'settings-note'} role={message.error ? 'alert' : 'status'}>{message.text}</div>}
      <div className="settings-note">A foto é salva na hora (não depende do botão Salvar) e aparece no painel e no app.</div>
    </div>
  );
}
