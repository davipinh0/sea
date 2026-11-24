/* Alteração no painel: motivo e confirmação no celular antes de salvar; excluir OT só com permissão. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const releaseOnPhone = vi.fn();
vi.mock('../utils/phoneRelease.js', () => ({ releaseOnPhone: (...a) => releaseOnPhone(...a) }));

import { api } from '../api.js';
import ChangeConfirmDialog from '../components/ChangeConfirmDialog.jsx';
import { confirmChange, forgetRecentChange, setChangeConfirmHandler } from '../utils/changeConfirm.js';
import { canDeleteOt } from '../utils/permissions.js';

const REASON = 'Descrição corrigida conforme a nota fiscal';

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  forgetRecentChange();
  vi.unstubAllGlobals();
  releaseOnPhone.mockReset();
});

describe('api.js com alteração que pede motivo', () => {
  it('pergunta o motivo e manda de novo com ele no cabeçalho', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(428, { change_confirmation_required: 'alteracao', error: 'Informe o motivo' }))
      .mockResolvedValueOnce(reply(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const ask = vi.fn().mockResolvedValue(REASON);
    const stop = setChangeConfirmHandler(ask);
    try {
      const res = await api.put('/admin/items/7', { item_name: 'Peça' });
      expect(res.status).toBe(200);
      expect(ask).toHaveBeenCalledWith({ method: 'PUT', path: '/admin/items/7' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, retry] = fetchMock.mock.calls[1];
      expect(decodeURIComponent(retry.headers['X-SEA-Motivo'])).toBe(REASON);
      expect(retry.body).toBe(JSON.stringify({ item_name: 'Peça' }));
    } finally {
      stop();
    }
  });

  it('quem desiste recebe a resposta da API e nada é reenviado', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(428, { change_confirmation_required: 'alteracao', error: 'Informe o motivo' }));
    vi.stubGlobal('fetch', fetchMock);
    const stop = setChangeConfirmHandler(() => Promise.resolve(null));
    try {
      const res = await api.delete('/sea/ots/3');
      expect(res.status).toBe(428);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

describe('Um salvamento, uma confirmação', () => {
  it('os pedidos logo depois usam o mesmo motivo; salvar de novo pergunta', async () => {
    let clock = 1000;
    const ask = vi.fn().mockResolvedValue(REASON);
    const stop = setChangeConfirmHandler(ask);
    try {
      expect(await confirmChange({ method: 'PUT', path: '/admin/users/5' }, () => clock)).toBe(REASON);
      clock += 2000;
      expect(await confirmChange({ method: 'PUT', path: '/admin/users/5/permissions' }, () => clock)).toBe(REASON);
      expect(ask).toHaveBeenCalledTimes(1);
      clock += 60000;
      await confirmChange({ method: 'PUT', path: '/admin/users/5' }, () => clock);
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('quem desiste não deixa motivo guardado', async () => {
    const ask = vi.fn().mockResolvedValue(null);
    const stop = setChangeConfirmHandler(ask);
    try {
      expect(await confirmChange({ method: 'PUT', path: '/a' })).toBeNull();
      expect(await confirmChange({ method: 'PUT', path: '/a' })).toBeNull();
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});

describe('Janela do motivo', () => {
  it('exige um motivo, espera o celular e devolve o motivo', async () => {
    releaseOnPhone.mockResolvedValue(undefined);
    render(<ChangeConfirmDialog />);
    let answer;
    act(() => { answer = confirmChange({ method: 'PUT', path: '/admin/items/7' }); });
    expect(await screen.findByText('Motivo da alteração')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'curto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar no celular' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('pelo menos 10');
    expect(releaseOnPhone).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: `  ${REASON}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar no celular' }));
    await expect(answer).resolves.toBe(REASON);
    expect(releaseOnPhone).toHaveBeenCalledWith('alteracao', expect.any(Object));
    await waitFor(() => expect(screen.queryByText('Motivo da alteração')).not.toBeInTheDocument());
  });

  it('mostra a recusa do celular e cancelar devolve nada', async () => {
    releaseOnPhone.mockRejectedValue(new Error('O acesso foi negado no celular.'));
    render(<ChangeConfirmDialog />);
    let answer;
    act(() => { answer = confirmChange({ method: 'DELETE', path: '/sea/ots/3' }); });
    expect(await screen.findByText('Motivo da exclusão')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar no celular' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('negado no celular');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await expect(answer).resolves.toBeNull();
  });
});

describe('Excluir OT', () => {
  it('só o administrador ou quem tem a permissão extra', () => {
    expect(canDeleteOt({ role: 'ADMIN' })).toBe(true);
    expect(canDeleteOt({ role: 'USER', allowed_overrides: ['excluir-ot'] })).toBe(true);
    expect(canDeleteOt({ role: 'USER', allowed_pages: ['purchase-orders'], allowed_overrides: [] })).toBe(false);
    expect(canDeleteOt(null)).toBe(false);
  });
});
