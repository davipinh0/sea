import { useCallback, useEffect, useMemo, useState } from 'react';
import { terminalApi, terminalLogin, terminalLogout } from '../terminalApi.js';
import { api as panelApi } from '../api.js';
import { watchIdle } from '../utils/sessionGuard.js';
import SeaLogo from '../components/SeaLogo.jsx';
import { OtTypeTag } from '../components/sea.jsx';
import { MATERIAL_SITUATION, formatQuantity, orderSituationMessage, readError } from '../utils/sea.js';

// Terminal de retirada (quiosque), aberto pelo usuário do terminal.
// O funcionário escolhe como se identificar: com o login do SEA (sessão própria, separada do
// painel) ou só com o e-mail corporativo, caso em que o pedido sai em nome do usuário do terminal.
// Depois: informa a ordem, escolhe os materiais, espera a separação e confirma o recebimento. Todas
// as regras ficam na API; a tela só guia.

const POLL_MS = 3000;

const WAITING_TEXT = {
  REQUESTED: 'Aguardando a avaliação da solicitação…',
  APPROVED: 'Solicitação aprovada. Aguardando alguém do estoque aceitar…',
  PICKING: 'está preparando os seus materiais…',
};
const RESET_AFTER_MS = 12000;
// Quem sai sem pedir nada é desconectado, para o próximo não agir em nome dele.
export const TERMINAL_IDLE_MS = 2 * 60 * 1000;
const IDLE_STEPS = new Set(['ot', 'materials', 'login', 'email']);
const looksLikeEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());

// Material em KG com peso de caixa anda de caixa em caixa (0 > 18 KG > 36 KG); o resto anda de
// unidade em unidade. ``qty`` guarda o número de toques.
const stockQuantity = (s, count) => count * (s.pack_weight_kg || 1);
const maxCount = (s) => Math.floor(s.available / (s.pack_weight_kg || 1));

// Por que um material da ordem não está disponível, com as quantidades que explicam.
function situationDetail(m) {
  const amount = (n) => formatQuantity(n, m.uom, m.pack_weight_kg);
  switch (m.status) {
    case 'ESGOTADO': return `retirado: ${amount(m.withdrawn)}`;
    case 'AGUARDANDO_RECEBIMENTO': return `previsto: ${amount(m.quantity_ordered)} · recebido: ${amount(m.quantity_received)}`;
    case 'AGUARDANDO_ARMAZENAMENTO': return `${amount(m.awaiting_storage)} na área de recebimento`;
    case 'EM_RETIRADA': return 'reservado em outra solicitação';
    default: return 'sem saldo no estoque';
  }
}

// Círculo que se desenha e o check em seguida (CSS; parado para quem pede menos movimento).
function SuccessCheck() {
  return (
    <svg className="success-check" viewBox="0 0 52 52" width="96" height="96" aria-hidden="true">
      <circle className="success-check-circle" cx="26" cy="26" r="24" fill="none" />
      <path className="success-check-mark" fill="none" d="M14 27l8 8 16-17" />
    </svg>
  );
}

function QtyPicker({ value, max, onChange, label, unit, step = 1 }) {
  return (
    <div className="terminal-qty" role="group" aria-label={label}>
      <button type="button" aria-label={`Diminuir ${label}`} onClick={() => onChange(Math.max(0, value - 1))} disabled={value <= 0}>−</button>
      <output aria-live="polite">{value * step}{unit ? ` ${unit}` : ''}</output>
      <button type="button" aria-label={`Aumentar ${label}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</button>
    </div>
  );
}

export default function TerminalRetirada() {
  const [employee, setEmployee] = useState(null);
  const [token, setToken] = useState(null);
  // E-mail de quem não tem acesso ao SEA; o pedido vai pela sessão do usuário do terminal.
  const [email, setEmail] = useState('');
  const [byEmail, setByEmail] = useState(false);
  const api = useMemo(() => (byEmail ? panelApi : terminalApi(token)), [byEmail, token]);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('choose');
  const [code, setCode] = useState('');
  const [order, setOrder] = useState(null);
  const [stock, setStock] = useState([]);
  const [qty, setQty] = useState({});
  const [withdrawal, setWithdrawal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingPhone, setWaitingPhone] = useState(null);
  const [picker, setPicker] = useState(null);

  const clearRequest = useCallback(() => {
    setCode(''); setOrder(null); setStock([]); setQty({}); setWithdrawal(null); setError(''); setBusy(false);
    setPicker(null);
  }, []);

  // O próximo funcionário sempre começa na escolha. A sessão do funcionário também termina no
  // servidor; a do terminal continua.
  const signOut = useCallback(() => {
    if (token) terminalLogout(token);
    clearRequest();
    setEmployee(null); setToken(null); setIdentifier(''); setPassword('');
    setEmail(''); setByEmail(false);
    setStep('choose');
  }, [clearRequest, token]);

  function continueWithEmail(e) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!looksLikeEmail(clean)) { setError('Informe um e-mail corporativo válido (ex.: nome@empresa.com).'); return; }
    setError('');
    setEmail(clean);
    setByEmail(true);
    setEmployee({ full_name: clean, email: clean });
    setStep('ot');
  }

  useEffect(() => {
    if (!IDLE_STEPS.has(step)) return undefined;
    return watchIdle({ onIdle: signOut, limitMs: TERMINAL_IDLE_MS, checkMs: 5000 });
  }, [step, signOut]);

  async function signIn(e) {
    e.preventDefault();
    if (!identifier.trim() || !password) return;
    setBusy(true); setError('');
    try {
      const session = await terminalLogin(identifier.trim(), password, { onWaiting: setWaitingPhone });
      const me = session.user;
      if (me.must_change_password) {
        throw new Error('Este usuário precisa trocar a senha no painel antes de usar o terminal.');
      }
      if (me.role !== 'ADMIN' && !(me.allowed_pages || []).includes('retirada')) {
        throw new Error('Este usuário não tem permissão para retirar materiais.');
      }
      setToken(session.token);
      setEmployee(me);
      setPassword('');
      setStep('ot');
    } catch (err) {
      setError(err.message);
    } finally {
      setWaitingPhone(null);
      setBusy(false);
    }
  }

  function expired(res) {
    if (!res || res.status !== 401) return false;
    signOut();
    setError('Sessão encerrada. Identifique-se novamente.');
    return true;
  }

  async function lookup(e) {
    e.preventDefault();
    const clean = code.trim();
    if (!clean) return;
    setBusy(true); setError('');
    const res = await api.get(`/sea/ordens/${encodeURIComponent(clean)}`);
    setBusy(false);
    if (!res || expired(res)) return;
    if (!res.ok) { setError(res.status === 404 ? `Ordem ${clean} não encontrada.` : await readError(res, 'Não foi possível consultar a ordem.')); return; }
    const data = await res.json();
    setOrder(data);
    setStock(data.stock);
    setQty(Object.fromEntries(data.stock.map((s) => [s.inventory_id, 0])));
    setStep('materials');
  }

  async function request() {
    const chosen = stock.filter((s) => qty[s.inventory_id] > 0);
    if (chosen.length === 0) { setError('Escolha a quantidade de pelo menos um material.'); return; }
    // Um pedido cobre uma entrega num só local (quem separa).
    if (new Set(chosen.map((s) => `${s.ot}|${s.warehouse_id}`)).size > 1) {
      setError('Os materiais escolhidos estão em locais ou entregas diferentes. Solicite um grupo de cada vez.');
      return;
    }
    const lines = chosen.map((s) => ({ inventory_id: s.inventory_id, quantity: stockQuantity(s, qty[s.inventory_id]) }));
    setBusy(true); setError('');
    const res = await api.post('/sea/retiradas', { ot: chosen[0].ot, lines, ...(byEmail && { requester_email: email }) });
    setBusy(false);
    if (!res || expired(res)) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível solicitar a retirada.')); return; }
    setWithdrawal((await res.json()).withdrawal);
    setStep('waiting');
  }

  const withdrawalId = withdrawal?.withdrawal_id;
  useEffect(() => {
    if (step !== 'waiting' || !withdrawalId) return undefined;
    let stopped = false;
    async function poll() {
      const res = await api.get(`/sea/retiradas/${withdrawalId}`);
      if (stopped || !res || !res.ok) return;
      const current = (await res.json()).withdrawal;
      if (!current) return;
      setWithdrawal(current);
      if (current.status === 'READY') setStep('confirm');
      if (current.status === 'REJECTED') {
        setError(`A solicitação foi negada${current.evaluation_note ? `: ${current.evaluation_note}` : '.'}`);
        setStep('done-cancelled');
      }
      if (current.status === 'CANCELLED') {
        setError(`A solicitação foi cancelada pelo responsável do estoque${current.cancel_reason ? `: ${current.cancel_reason}` : '.'}`);
        setStep('done-cancelled');
      }
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [step, withdrawalId, api]);

  const pickedBy = withdrawal?.picked_by;
  useEffect(() => {
    if (!pickedBy || !withdrawalId) return undefined;
    let stopped = false;
    api.get(`/sea/retiradas/${withdrawalId}/responsavel`).then(async (res) => {
      if (stopped || !res || !res.ok) return;
      const data = await res.json();
      if (!stopped) setPicker(data);
    });
    return () => { stopped = true; };
  }, [pickedBy, withdrawalId, api]);

  async function confirm() {
    setBusy(true); setError('');
    const res = await api.post(`/sea/retiradas/${withdrawal.withdrawal_id}/entregar`, {});
    setBusy(false);
    if (!res || expired(res)) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível confirmar a entrega.')); return; }
    setWithdrawal((await res.json()).withdrawal);
    setStep('done');
  }

  async function cancelRequest() {
    if (withdrawal) {
      setBusy(true);
      const res = await api.post(`/sea/retiradas/${withdrawal.withdrawal_id}/cancelar`, { reason: 'Cancelada pelo solicitante no terminal' });
      setBusy(false);
      if (!res || expired(res)) return;
      if (!res.ok) { setError(await readError(res, 'Não foi possível cancelar a solicitação.')); return; }
    }
    clearRequest();
    setStep('ot');
  }

  useEffect(() => {
    if (step !== 'done' && step !== 'done-cancelled') return undefined;
    const timer = setTimeout(signOut, RESET_AFTER_MS);
    return () => clearTimeout(timer);
  }, [step, signOut]);

  const selectedCount = Object.values(qty).filter((n) => n > 0).length;
  const unavailable = (order?.materials || []).filter((m) => m.status !== 'DISPONIVEL');

  return (
    <div className="terminal">
      <header className="terminal-header">
        <SeaLogo size={36} />
        <div>
          SEA · Terminal de Retirada
          <div className="terminal-sub">{employee ? `Identificado: ${employee.full_name || employee.username}${byEmail ? ' (sem acesso ao SEA)' : ''}` : 'Identifique-se para retirar materiais'}</div>
        </div>
        {employee && <button type="button" className="terminal-btn secondary terminal-exit" onClick={signOut}>Sair</button>}
      </header>

      <main className="terminal-body">
        {error && <div className="terminal-msg error" role="alert">{error}</div>}

        {step === 'choose' && (
          <div>
            <div className="terminal-title">Como você quer se identificar?</div>
            <div className="terminal-choice">
              <button type="button" className="terminal-btn" onClick={() => { setError(''); setStep('login'); }}>
                Tenho acesso ao SEA
                <span className="terminal-choice-sub">Entrar com o login corporativo e a senha</span>
              </button>
              <button type="button" className="terminal-btn secondary" onClick={() => { setError(''); setStep('email'); }}>
                Não tenho acesso ao SEA
                <span className="terminal-choice-sub">Informar só o e-mail corporativo</span>
              </button>
            </div>
          </div>
        )}

        {step === 'email' && (
          <form onSubmit={continueWithEmail}>
            <div className="terminal-title">Informe o seu e-mail corporativo</div>
            <div className="terminal-badge-pad">
              <input
                autoFocus className="terminal-input" aria-label="E-mail corporativo" type="text" inputMode="email"
                style={{ maxWidth: 520 }} placeholder="nome@empresa.com"
                value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off"
              />
            </div>
            <div className="terminal-actions">
              <button type="submit" className="terminal-btn" disabled={!email.trim()}>Continuar</button>
              <button type="button" className="terminal-btn secondary" onClick={signOut}>Voltar</button>
            </div>
          </form>
        )}

        {step === 'login' && (
          <form onSubmit={signIn}>
            <div className="terminal-title">Entre com o seu login corporativo</div>
            <div className="terminal-badge-pad">
              <input
                autoFocus className="terminal-input" aria-label="E-mail corporativo ou usuário"
                style={{ maxWidth: 520, marginBottom: 14 }} placeholder="E-mail corporativo ou usuário"
                value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username"
              />
              <input
                className="terminal-input" aria-label="Senha" type="password"
                style={{ maxWidth: 520 }} placeholder="Senha"
                value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
              />
            </div>
            {waitingPhone !== null && (
              <div className="terminal-msg" role="status">
                Confirme no app SEA do seu celular (digital ou senha do celular). Tempo restante: {waitingPhone} s.
              </div>
            )}
            <div className="terminal-actions">
              <button type="submit" className="terminal-btn" disabled={busy || !identifier.trim() || !password}>{busy ? 'Entrando…' : 'Entrar'}</button>
              <button type="button" className="terminal-btn secondary" disabled={busy} onClick={signOut}>Voltar</button>
            </div>
          </form>
        )}

        {step === 'ot' && (
          <form onSubmit={lookup}>
            <div className="terminal-step">Passo 1 de 4</div>
            <div className="terminal-title">Informe a ordem</div>
            <input
              autoFocus className="terminal-input" aria-label="Ordem"
              placeholder="Digite o número da ordem"
              value={code} onChange={(e) => setCode(e.target.value)}
            />
            <div className="terminal-actions">
              <button type="submit" className="terminal-btn" disabled={busy || !code.trim()}>Consultar ordem</button>
            </div>
          </form>
        )}

        {step === 'materials' && order && (
          <div>
            <div className="terminal-step">Passo 2 de 4</div>
            <div className="terminal-title">
              Ordem <OtTypeTag type={order.order_type} /> {order.order_number}{stock.length > 0 ? ' · materiais disponíveis' : ''}
            </div>
            {orderSituationMessage(order) && (
              <div className={`terminal-msg ${order.status === 'RETIRADA' ? 'error' : 'warn'}`} role="status">
                {orderSituationMessage(order)}
              </div>
            )}
            {stock.length > 0 && (
              <div className="terminal-card">
                {stock.map((s) => (
                  <div key={s.inventory_id} className="terminal-line">
                    <div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>{s.item_name}</div>
                      <div className="settings-note" style={{ fontSize: 15 }}>
                        Código {s.sku} · endereço {s.warehouse_code ? `${s.warehouse_code} · ` : ''}{s.bin_code} · disponível: {formatQuantity(s.available, s.uom, s.pack_weight_kg)}
                        {s.pack_weight_kg ? ` · caixa de ${s.pack_weight_kg} KG` : ''}
                      </div>
                      {qty[s.inventory_id] > 0 && s.pack_weight_kg && (
                        <div style={{ fontSize: 15, fontWeight: 600 }}>
                          Retirando {formatQuantity(stockQuantity(s, qty[s.inventory_id]), s.uom, s.pack_weight_kg)}; ficam {s.available - stockQuantity(s, qty[s.inventory_id])} KG.
                        </div>
                      )}
                    </div>
                    <QtyPicker label={s.sku} value={qty[s.inventory_id] || 0} max={maxCount(s)} unit={s.uom} step={s.pack_weight_kg || 1}
                      onChange={(n) => setQty((q) => ({ ...q, [s.inventory_id]: n }))} />
                  </div>
                ))}
              </div>
            )}
            {unavailable.length > 0 && (
              <div className="terminal-card">
                <div className="terminal-others-title">{stock.length > 0 ? 'Outros materiais desta ordem' : 'Materiais desta ordem'}</div>
                {unavailable.map((m) => {
                  const situation = MATERIAL_SITUATION[m.status] || MATERIAL_SITUATION.INDISPONIVEL;
                  return (
                    <div key={`${m.ot}-${m.sku}`} className="terminal-line">
                      <div>
                        <div style={{ fontSize: 20, fontWeight: 700 }}>{m.item_name}</div>
                        <div className="settings-note" style={{ fontSize: 15 }}>Código {m.sku} · OT {m.ot} · {situationDetail(m)}</div>
                      </div>
                      <span className={`terminal-status ${situation.tone}`}>{situation.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="terminal-actions">
              {stock.length > 0 && (
                <button type="button" className="terminal-btn" disabled={busy || selectedCount === 0} onClick={request}>Solicitar retirada</button>
              )}
              <button type="button" className="terminal-btn secondary" onClick={() => { clearRequest(); setStep('ot'); }}>Voltar</button>
            </div>
          </div>
        )}

        {step === 'waiting' && withdrawal && (
          <div>
            <div className="terminal-step">Passo 3 de 4</div>
            <div className="terminal-title">Solicitação nº {withdrawal.withdrawal_id} enviada ao estoque</div>
            <div className="terminal-card" aria-live="polite">
              {withdrawal.status === 'PICKING' && picker ? (
                <div className="terminal-picker">
                  {picker.photo
                    ? <img src={picker.photo} alt={`Foto de ${picker.name}`} className="terminal-picker-photo" />
                    : <div className="terminal-picker-photo terminal-picker-initials" aria-hidden="true">{(picker.name || '?').slice(0, 1).toUpperCase()}</div>}
                  <p style={{ fontSize: 20 }}><strong>{picker.name}</strong> {WAITING_TEXT.PICKING}</p>
                </div>
              ) : (
                <p style={{ fontSize: 20 }}>{WAITING_TEXT[withdrawal.status] || 'Aguardando o estoque…'}</p>
              )}
              {withdrawal.lines.map((l) => <div key={l.inventory_id} style={{ fontSize: 17 }}>{formatQuantity(l.quantity, l.uom, l.pack_weight_kg)} · {l.item_name} ({l.bin_code})</div>)}
            </div>
            <div className="terminal-actions">
              <button type="button" className="terminal-btn secondary" disabled={busy} onClick={cancelRequest}>Cancelar solicitação</button>
            </div>
          </div>
        )}

        {step === 'confirm' && withdrawal && (
          <div>
            <div className="terminal-step">Passo 4 de 4</div>
            <div className="terminal-title">Materiais separados. {employee?.full_name || employee?.username}, confirme o recebimento</div>
            <div className="terminal-card">
              {picker && (
                <div className="terminal-picker">
                  {picker.photo && <img src={picker.photo} alt={`Foto de ${picker.name}`} className="terminal-picker-photo" />}
                  <p style={{ fontSize: 18 }}>Preparado por <strong>{picker.name}</strong></p>
                </div>
              )}
              {withdrawal.lines.map((l) => <div key={l.inventory_id} style={{ fontSize: 20, padding: '6px 0' }}>{formatQuantity(l.quantity, l.uom, l.pack_weight_kg)} · {l.item_name}</div>)}
            </div>
            <div className="terminal-actions">
              <button type="button" className="terminal-btn" disabled={busy} onClick={confirm}>{busy ? 'Confirmando…' : 'Confirmo que recebi os materiais'}</button>
              <button type="button" className="terminal-btn secondary" disabled={busy} onClick={cancelRequest}>Cancelar solicitação</button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="terminal-card" style={{ textAlign: 'center', padding: 40 }}>
            <SuccessCheck />
            <div className="terminal-msg ok success-pop" style={{ fontSize: 26, fontWeight: 700 }}>Retirada concluída</div>
            <p style={{ fontSize: 18 }}>Entrega registrada para {byEmail ? email : (withdrawal?.delivered_to || employee?.full_name)} e baixa realizada no estoque.</p>
            <div className="terminal-actions" style={{ justifyContent: 'center' }}>
              <button type="button" className="terminal-btn" onClick={() => { clearRequest(); setStep('ot'); }}>Nova retirada</button>
              <button type="button" className="terminal-btn secondary" onClick={signOut}>Encerrar sessão</button>
            </div>
          </div>
        )}

        {step === 'done-cancelled' && (
          <div className="terminal-actions">
            <button type="button" className="terminal-btn" onClick={() => { clearRequest(); setStep('ot'); }}>Nova retirada</button>
            <button type="button" className="terminal-btn secondary" onClick={signOut}>Encerrar sessão</button>
          </div>
        )}
      </main>
    </div>
  );
}
