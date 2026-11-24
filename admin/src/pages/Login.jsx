import { useEffect, useRef, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import SeaLogo from '../components/SeaLogo.jsx';
import { api } from '../api.js';
import { LoginApprovalCancelled, waitForApproval } from '../utils/loginApproval.js';

export default function Login() {
  const { user, login, finishLogin } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState(null);
  const cancelled = useRef(false);
  // v1.4.2 #98: ChangePassword writes a flash message to sessionStorage
  // before resetting auth state, because React Router's location.state
  // does not survive the AuthProvider state flip that logout() triggers
  // between navigations. Read + clear on mount so the banner shows once
  // and a later login does not re-surface it.
  const [flashMessage, setFlashMessage] = useState(() => {
    try {
      return sessionStorage.getItem('login_flash_message') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!flashMessage) return;
    try {
      sessionStorage.removeItem('login_flash_message');
    } catch { /* noop */ }
  }, [flashMessage]);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    let approving = false;
    try {
      let userData = await login(username, password);
      if (userData?.approval) {
        approving = true;
        cancelled.current = false;
        setWaiting(userData.approval.expires_in);
        const approved = await waitForApproval((path, body) => api.post(path, body), userData.approval, {
          onTick: setWaiting,
          isCancelled: () => cancelled.current,
        });
        userData = await finishLogin(approved);
      }
      if (userData && userData.role !== 'ADMIN') {
        // V-045: the login() context function already called /auth/logout
        // to clear the cookies for non-admin users. Just surface the error.
        setError('Não autorizado, contate o administrador');
        setLoading(false);
        return;
      }
      navigate('/');
    } catch (err) {
      if (err instanceof LoginApprovalCancelled) {
        setError('Login cancelado.');
      } else if (approving) {
        setError(err.message);
      } else {
        setError(err.message === 'Not authorized' ? 'Não autorizado, contate o administrador' : 'Usuário ou senha incorretos');
      }
      setPassword('');
    } finally {
      setWaiting(null);
      setLoading(false);
    }
  }

  if (waiting !== null) {
    return (
      <div className="login-page">
        <div className="login-card" role="status" aria-live="polite">
          <div className="login-logo"><SeaLogo size={72} /></div>
          <div className="login-approval">
            <div className="login-approval-icon" aria-hidden="true">📱</div>
            <h2>Confirme no seu celular</h2>
            <p>
              Enviamos um aviso para o app SEA do seu celular. Abra o app e confirme que é você com a
              digital ou a senha do celular (PIN ou padrão).
            </p>
            <p className="login-approval-time">Tempo restante: {Math.floor(waiting / 60)}:{String(waiting % 60).padStart(2, '0')}</p>
          </div>
          <button className="btn" type="button" onClick={() => { cancelled.current = true; }}>Cancelar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <SeaLogo size={72} />
        </div>
        <div className="login-subtitle">Sistema de Entrada e Armazenamento</div>
        {flashMessage && (
          <div
            role="status"
            className="login-success"
            style={{
              background: 'var(--success-bg, #e6f3ea)',
              color: 'var(--success, #0f5132)',
              padding: '10px 14px',
              borderRadius: 6,
              marginBottom: 16,
              fontSize: 14,
            }}
          >
            {flashMessage}
          </div>
        )}
        {error && <div className="login-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="login-username">Usuário</label>
            <input
              id="login-username" autoComplete="username"
              className="form-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">Senha</label>
            <input
              id="login-password" autoComplete="current-password"
              className="form-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
