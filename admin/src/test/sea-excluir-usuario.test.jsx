/*
 * Excluir usuário: a exclusão é confirmada no celular de quem exclui, e o erro aparece na própria
 * janela (antes a janela fechava e a falha passava despercebida).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: vi.fn(),
    delete: (...a) => apiDelete(...a),
  },
}));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: { user_id: 1, role: 'ADMIN' } }) }));

import Users from '../pages/Users.jsx';

const res = (status, body) => {
  const r = { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  r.clone = () => r;
  return Promise.resolve(r);
};

const ALVO = { user_id: 32, username: 'ddopinho', full_name: 'Usuário Fictício', role: 'USER', is_active: true, warehouse_ids: [7] };

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
  apiGet.mockImplementation((path) => {
    if (path.startsWith('/admin/warehouses')) return res(200, { warehouses: [] });
    if (path.startsWith('/sea/confirmacao/exclusao-usuario/')) return res(200, { status: 'APPROVED', granted: true });
    return res(200, { users: [ALVO] });
  });
});

async function openDelete() {
  render(<Users />);
  fireEvent.click(await screen.findByLabelText('Excluir'));
  expect(screen.getByText(/confirmada no app SEA do seu celular/)).toBeInTheDocument();
  const buttons = screen.getAllByRole('button', { name: 'Excluir' });
  fireEvent.click(buttons[buttons.length - 1]);
}

describe('Excluir usuário', () => {
  it('asks the phone, then deletes', async () => {
    apiDelete
      .mockImplementationOnce(() => res(403, { error: 'Confirme no app', step_up_required: 'exclusao-usuario' }))
      .mockImplementationOnce(() => res(200, { message: 'Usuário excluído' }));
    apiPost.mockImplementation(() => res(202, { challenge_id: 'abc', expires_in: 120 }));
    await openDelete();
    expect(await screen.findByText(/toque em/)).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith('/sea/confirmacao/exclusao-usuario', {});
    await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText(/confirmada no app SEA do seu celular/)).toBeNull());
  });

  it('shows the reason in the dialog when it cannot delete', async () => {
    apiDelete.mockImplementation(() => res(400, { error: 'Não é possível excluir o último administrador ativo', user_facing: true }));
    await openDelete();
    expect(await screen.findByRole('alert')).toHaveTextContent('último administrador ativo');
    expect(screen.getByText(/confirmada no app SEA do seu celular/)).toBeInTheDocument();
  });

  it('explains when there is no registered phone', async () => {
    apiDelete.mockImplementation(() => res(403, { step_up_required: 'exclusao-usuario' }));
    apiPost.mockImplementation(() => res(409, { error: 'Para usar Exclusão de usuário no painel, cadastre o app SEA no seu celular', user_facing: true }));
    await openDelete();
    expect(await screen.findByRole('alert')).toHaveTextContent('cadastre o app SEA');
    expect(apiDelete).toHaveBeenCalledTimes(1);
  });
});
