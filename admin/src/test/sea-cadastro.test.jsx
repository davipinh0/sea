/**
 * SEA: material catalogue (Sistema), OT put together in the SAP tab and
 * screens that refresh on their own.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: (...a) => apiPut(...a),
    delete: (...a) => apiDelete(...a),
  },
}));

import CadastroMateriais from '../pages/CadastroMateriais.jsx';
import NovaOtSapModal from '../components/NovaOtSapModal.jsx';
import { announceChange, useLiveRefresh } from '../utils/useLiveRefresh.js';

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = (status, body) => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });
const WIRE = { material_code: '70000001', description: 'Arame de solda', uom: 'KG', pack_weight_kg: 18 };

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset(); apiPut.mockReset(); apiDelete.mockReset();
});

describe('Cadastro de materiais', () => {
  beforeEach(() => {
    apiGet.mockImplementation(() => ok({ materials: [WIRE], total: 1, page: 1, pages: 1 }));
  });

  it('lists the catalogue with unit and box weight', async () => {
    render(<CadastroMateriais />);
    expect(await screen.findByText('Arame de solda')).toBeInTheDocument();
    expect(screen.getByText('18 kg')).toBeInTheDocument();
  });

  it('creates a material; the box weight is only asked for KG', async () => {
    apiPost.mockImplementation(() => ok({ material_code: '70000009' }));
    render(<CadastroMateriais />);
    fireEvent.click(await screen.findByText('Novo material'));
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o código do material.');

    fireEvent.change(screen.getByLabelText('Código *'), { target: { value: '70000009' } });
    fireEvent.change(screen.getByLabelText('Descrição *'), { target: { value: 'Eletrodo' } });
    expect(screen.queryByLabelText('Peso por caixa (kg)')).toBeNull();
    fireEvent.change(screen.getByLabelText('Unidade'), { target: { value: 'KG' } });
    fireEvent.change(screen.getByLabelText('Peso por caixa (kg)'), { target: { value: '15' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/catalogo', {
      material_code: '70000009', description: 'Eletrodo', uom: 'KG', pack_weight_kg: 15,
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Material 70000009 cadastrado.');
  });

  it('changes a material without letting the code be edited', async () => {
    apiPut.mockImplementation(() => ok({}));
    render(<CadastroMateriais />);
    fireEvent.click(await screen.findByLabelText('Alterar 70000001'));
    expect(screen.getByLabelText('Código *')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Peso por caixa (kg)'), { target: { value: '20' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/sea/catalogo/70000001', {
      description: 'Arame de solda', uom: 'KG', pack_weight_kg: 20,
    }));
  });

  it('explains why a material cannot be deleted', async () => {
    apiDelete.mockImplementation(() => fail(409, { error: 'O material 70000001 está em OT(s) da base do SAP (1000000101) e não pode ser excluído.', user_facing: true }));
    render(<CadastroMateriais />);
    fireEvent.click(await screen.findByLabelText('Excluir 70000001'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Excluir' }).at(-1));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/sea/catalogo/70000001'));
    expect(await screen.findByRole('alert')).toHaveTextContent('não pode ser excluído');
  });
});

describe('Nova OT na aba SAP', () => {
  it('the material code brings description, unit and box weight', async () => {
    apiGet.mockImplementation((path) => (path.endsWith('/70000001') ? ok({ ...WIRE, source: 'cadastro' }) : fail(404, {})));
    apiPost.mockImplementation(() => ok({ ot: '1000000500' }));
    const onCreated = vi.fn();
    render(<NovaOtSapModal onClose={() => {}} onCreated={onCreated} />);

    fireEvent.click(screen.getByText('Criar OT'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o número da OT.');

    fireEvent.change(screen.getByLabelText('Número da OT *'), { target: { value: '1000000500' } });
    fireEvent.change(screen.getByLabelText('Solicitante'), { target: { value: 'Fulano' } });
    fireEvent.change(screen.getByLabelText('Ordem do material 1'), { target: { value: '2000000500' } });
    const code = screen.getByLabelText('Código do material 1');
    fireEvent.change(code, { target: { value: '70000001' } });
    fireEvent.blur(code);
    expect(await screen.findByText(/Arame de solda · unidade KG · caixa de 18 kg/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Quantidade do material 1'), { target: { value: '36' } });
    fireEvent.click(screen.getByText('Criar OT'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/sea/sap/ots', {
      ot_number: '1000000500', reservation_number: null, requester_name: 'Fulano', needed_date: null,
      materials: [{ order_number: '2000000500', order_type: 'PM11', material_code: '70000001', quantity: 36 }],
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('1000000500'));
  });

  it('warns when the material is not in the catalogue', async () => {
    apiGet.mockImplementation(() => fail(404, {}));
    render(<NovaOtSapModal onClose={() => {}} onCreated={() => {}} />);
    const code = screen.getByLabelText('Código do material 1');
    fireEvent.change(code, { target: { value: '999' } });
    fireEvent.blur(code);
    expect(await screen.findByRole('alert')).toHaveTextContent('Material não está no cadastro');
  });
});

describe('useLiveRefresh', () => {
  function Probe({ onRefresh }) {
    useLiveRefresh(onRefresh, 5000);
    return null;
  }

  it('refreshes after a change and on its interval', () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      const { unmount } = render(<Probe onRefresh={refresh} />);
      expect(refresh).not.toHaveBeenCalled();
      act(() => announceChange());
      expect(refresh).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(refresh).toHaveBeenCalledTimes(2);
      unmount();
      act(() => announceChange());
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
