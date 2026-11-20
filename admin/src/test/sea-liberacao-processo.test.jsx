/* Recebimento, Armazenagem e Retirada no painel só abrem depois da confirmação no celular. */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../api.js', () => ({
  api: { get: (...a) => apiGet(...a), post: (...a) => apiPost(...a) },
}));

const { default: ProcessGate } = await import('../components/ProcessGate.jsx');

const response = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });

function renderGate() {
  return render(<ProcessGate purpose="armazenagem" label="Armazenagem"><p>tela do processo</p></ProcessGate>);
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe('ProcessGate', () => {
  it('opens at once when the session is already released', async () => {
    apiGet.mockImplementation(() => response(200, { required: true, granted: true, seconds_left: 600 }));
    renderGate();
    expect(await screen.findByText('tela do processo')).toBeInTheDocument();
  });

  it('waits for the phone and then opens', async () => {
    let follows = 0;
    apiGet.mockImplementation((path) => {
      if (path === '/sea/confirmacao/armazenagem') return response(200, { required: true, granted: false, seconds_left: 0, has_phone: true });
      follows += 1;
      return follows === 1 ? response(202, { status: 'PENDING', expires_in: 100 }) : response(200, { granted: true });
    });
    apiPost.mockImplementation(() => response(202, { challenge_id: 'c-1', expires_in: 120 }));
    renderGate();
    fireEvent.click(await screen.findByText('Enviar para o celular'));
    expect(apiPost).toHaveBeenCalledWith('/sea/confirmacao/armazenagem', {});
    await screen.findByText(/SIM, SOU EU/);
    expect(screen.queryByText('tela do processo')).toBeNull();
    expect(await screen.findByText('tela do processo', {}, { timeout: 6000 })).toBeInTheDocument();
  }, 10000);

  it('tells a user without a registered phone what to do', async () => {
    apiGet.mockImplementation(() => response(200, { required: true, granted: false, seconds_left: 0, has_phone: false }));
    renderGate();
    expect(await screen.findByText(/cadastre o app SEA no seu celular/)).toBeInTheDocument();
  });

  it('closes again when the release ends', async () => {
    apiGet.mockImplementation(() => response(200, { required: true, granted: true, seconds_left: 1 }));
    renderGate();
    await screen.findByText('tela do processo');
    act(() => { window.dispatchEvent(new CustomEvent('sea:step-up', { detail: { purpose: 'armazenagem' } })); });
    await waitFor(() => expect(screen.queryByText('tela do processo')).toBeNull());
    expect(screen.getByText(/terminou/)).toBeInTheDocument();
  });
});
