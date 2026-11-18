import { useCallback, useEffect, useMemo, useState } from 'react';
import { terminalApi, terminalLogin, terminalLogout } from '../terminalApi.js';
import { watchIdle } from '../utils/sessionGuard.js';
import SeaLogo from '../components/SeaLogo.jsx';
import { OtTypeTag } from '../components/sea.jsx';
import { formatQuantity, readError } from '../utils/sea.js';

// Touchscreen withdrawal terminal (kiosk). Flow:
//   0. the employee identifies with the corporate login (e-mail or
//      user + password). The terminal always opens on this screen and
//      ends the session after each withdrawal.
//      The terminal session is its own (terminalApi.js): it does not
//      replace or end a panel session open in the same browser.
//   1. types the number of the order (PM11 / PM12)
//   2. picks the materials/quantities available in storage
//   3. waits while the stock keeper separates the request
//   4. confirms receipt -> stock is decremented by the API
// The API enforces every rule (available balance, single decrement,
// only the requester confirms); this screen only guides the operator.
//
// Identification is the login itself. When the company directory is
// integrated (services/identity_provider.py in the API) this screen
// stays the same: only where the credentials are checked changes.

const POLL_MS = 3000;
const RESET_AFTER_MS = 12000;
// SEA (mig 093): an employee who walks away before asking for material
// is signed out, so the next person cannot act in their name.
export const TERMINAL_IDLE_MS = 2 * 60 * 1000;
const IDLE_STEPS = new Set(['ot', 'materials']);

// A material kept in KG with a box weight goes box by box: each press adds
// the weight of one box (0 > 18 KG > 36 KG). Everything else goes unit by
// unit (1 = 1 PC, 1 PAR ...). ``qty`` holds the number of presses;
// ``stockQuantity`` turns it into the quantity of the stock.
const stockQuantity = (s, count) => count * (s.pack_weight_kg || 1);
const maxCount = (s) => Math.floor(s.available / (s.pack_weight_kg || 1));

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
  const api = useMemo(() => terminalApi(token), [token]);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('login');
  const [code, setCode] = useState('');
  const [order, setOrder] = useState(null);
  const [stock, setStock] = useState([]);
  const [qty, setQty] = useState({});
  const [withdrawal, setWithdrawal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // SEA (mig 092): seconds left for the employee to confirm on the phone.
  const [waitingPhone, setWaitingPhone] = useState(null);

  const clearRequest = useCallback(() => {
    setCode(''); setOrder(null); setStock([]); setQty({}); setWithdrawal(null); setError(''); setBusy(false);
  }, []);

  // End the session: the next employee always starts at the login.
  // The session also ends on the server (mig 093).
  const signOut = useCallback(() => {
    if (token) terminalLogout(token);
    clearRequest();
    setEmployee(null); setToken(null); setIdentifier(''); setPassword('');
    setStep('login');
  }, [clearRequest, token]);

  useEffect(() => {
    if (!IDLE_STEPS.has(step)) return undefined;
    return watchIdle({ onIdle: signOut, limitMs: TERMINAL_IDLE_MS, checkMs: 5000 });
  }, [step, signOut]);

  // 0 -> 1: corporate login.
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

  // Session ended on the server (expired): back to the login screen.
  function expired(res) {
    if (res.status !== 401) return false;
    signOut();
    setError('Sessão encerrada. Identifique-se novamente.');
    return true;
  }

  // 1 -> 2: look up the order and its available stock in storage addresses.
  async function lookup(e) {
    e.preventDefault();
    const clean = code.trim();
    if (!clean) return;
    setBusy(true); setError('');
    const res = await api.get(`/sea/ordens/${encodeURIComponent(clean)}`);
    setBusy(false);
    if (expired(res)) return;
    if (!res.ok) { setError(res.status === 404 ? `Ordem ${clean} não encontrada.` : await readError(res, 'Não foi possível consultar a ordem.')); return; }
    const data = await res.json();
    setOrder(data);
    setStock(data.stock);
    setQty(Object.fromEntries(data.stock.map((s) => [s.inventory_id, 0])));
    setStep('materials');
  }

  // 2 -> 3: request the withdrawal (stock is reserved by the API).
  async function request() {
    const chosen = stock.filter((s) => qty[s.inventory_id] > 0);
    if (chosen.length === 0) { setError('Escolha a quantidade de pelo menos um material.'); return; }
    // One request covers one delivery in one location (who separates it).
    if (new Set(chosen.map((s) => `${s.ot}|${s.warehouse_id}`)).size > 1) {
      setError('Os materiais escolhidos estão em locais ou entregas diferentes. Solicite um grupo de cada vez.');
      return;
    }
    const lines = chosen.map((s) => ({ inventory_id: s.inventory_id, quantity: stockQuantity(s, qty[s.inventory_id]) }));
    setBusy(true); setError('');
    const res = await api.post('/sea/retiradas', { ot: chosen[0].ot, lines });
    setBusy(false);
    if (expired(res)) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível solicitar a retirada.')); return; }
    setWithdrawal((await res.json()).withdrawal);
    setStep('waiting');
  }

  // 3: follow the request until the stock keeper marks it READY.
  const withdrawalId = withdrawal?.withdrawal_id;
  useEffect(() => {
    if (step !== 'waiting' || !withdrawalId) return undefined;
    let stopped = false;
    async function poll() {
      const res = await api.get(`/sea/retiradas/${withdrawalId}`);
      if (stopped || !res.ok) return;
      const current = (await res.json()).withdrawal;
      if (!current) return;
      setWithdrawal(current);
      if (current.status === 'READY') setStep('confirm');
      if (current.status === 'CANCELLED') {
        setError(`A solicitação foi cancelada pelo responsável do estoque${current.cancel_reason ? `: ${current.cancel_reason}` : '.'}`);
        setStep('done-cancelled');
      }
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [step, withdrawalId, api]);

  // 4: confirm receipt -> single stock decrement.
  async function confirm() {
    setBusy(true); setError('');
    const res = await api.post(`/sea/retiradas/${withdrawal.withdrawal_id}/entregar`, {});
    setBusy(false);
    if (expired(res)) return;
    if (!res.ok) { setError(await readError(res, 'Não foi possível confirmar a entrega.')); return; }
    setWithdrawal((await res.json()).withdrawal);
    setStep('done');
  }

  // The request stays on record as cancelled, with who cancelled and why.
  async function cancelRequest() {
    if (withdrawal) {
      setBusy(true);
      const res = await api.post(`/sea/retiradas/${withdrawal.withdrawal_id}/cancelar`, { reason: 'Cancelada pelo solicitante no terminal' });
      setBusy(false);
      if (expired(res)) return;
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

  return (
    <div className="terminal">
      <header className="terminal-header">
        <SeaLogo size={36} />
        <div>
          SEA · Terminal de Retirada
          <div className="terminal-sub">{employee ? `Identificado: ${employee.full_name || employee.username}` : 'Identifique-se para retirar materiais'}</div>
        </div>
        {employee && <button type="button" className="terminal-btn secondary terminal-exit" onClick={signOut}>Sair</button>}
      </header>

      <main className="terminal-body">
        {error && <div className="terminal-msg error" role="alert">{error}</div>}

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
              Ordem <OtTypeTag type={order.order_type} /> {order.order_number} · materiais disponíveis
            </div>
            {stock.length === 0 ? (
              <div className="terminal-card">Nenhum material desta ordem está disponível no estoque no momento.</div>
            ) : (
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
            <div className="terminal-actions">
              <button type="button" className="terminal-btn" disabled={busy || selectedCount === 0} onClick={request}>Solicitar retirada</button>
              <button type="button" className="terminal-btn secondary" onClick={() => { clearRequest(); setStep('ot'); }}>Voltar</button>
            </div>
          </div>
        )}

        {step === 'waiting' && withdrawal && (
          <div>
            <div className="terminal-step">Passo 3 de 4</div>
            <div className="terminal-title">Solicitação nº {withdrawal.withdrawal_id} enviada ao estoque</div>
            <div className="terminal-card" aria-live="polite">
              <p style={{ fontSize: 20 }}>
                {withdrawal.status === 'PICKING' ? 'O responsável pelo estoque está separando os materiais…' : 'Aguardando o responsável pelo estoque iniciar a separação…'}
              </p>
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
            <div className="terminal-msg ok" style={{ fontSize: 26, fontWeight: 700 }}>Retirada concluída</div>
            <p style={{ fontSize: 18 }}>Entrega registrada para {withdrawal?.delivered_to || employee?.full_name} e baixa realizada no estoque.</p>
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
