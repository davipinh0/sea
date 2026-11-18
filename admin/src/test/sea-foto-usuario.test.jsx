/**
 * SEA: user photo. Only an administrator sets or removes it, in
 * Sistema > Usuários; the list and the top bar show it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
let currentUser = null;

vi.mock('../api.js', () => ({
  api: {
    get: (...a) => apiGet(...a),
    post: vi.fn(),
    put: (...a) => apiPut(...a),
    delete: (...a) => apiDelete(...a),
  },
}));
vi.mock('../auth.jsx', () => ({ useAuth: () => ({ user: currentUser, refreshUser: vi.fn() }) }));

import UserAvatar from '../components/UserAvatar.jsx';
import { initialsOf, photoUrl } from '../utils/userPhoto.js';
import UserPhotoField from '../components/UserPhotoField.jsx';
import Users from '../pages/Users.jsx';

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

describe('UserAvatar', () => {
  it('shows the initials without a photo', () => {
    expect(initialsOf('Caique Souza Lima')).toBe('CL');
    expect(initialsOf('admin')).toBe('A');
    expect(initialsOf('')).toBe('?');
    render(<UserAvatar userId={3} version={null} name="Caique Lima" />);
    expect(screen.getByText('CL')).toBeInTheDocument();
  });

  it('loads the photo by a URL that changes with each new photo', () => {
    expect(photoUrl(3, 1700000000)).toBe('/api/admin/users/3/foto?v=1700000000');
    expect(photoUrl(3, null)).toBeNull();
    render(<UserAvatar userId={3} version={1700000000} name="Caique Lima" />);
    expect(screen.getByAltText('Foto de Caique Lima')).toHaveAttribute('src', '/api/admin/users/3/foto?v=1700000000');
  });

  it('falls back to the initials when the photo does not load', () => {
    render(<UserAvatar userId={3} version={5} name="Caique Lima" />);
    fireEvent.error(screen.getByAltText('Foto de Caique Lima'));
    expect(screen.getByText('CL')).toBeInTheDocument();
  });
});

describe('UserPhotoField', () => {
  beforeEach(() => { apiPut.mockReset(); apiDelete.mockReset(); });

  it('refuses a file that is not a photo without sending it', async () => {
    render(<UserPhotoField userId={3} name="Caique" version={null} onChanged={() => {}} />);
    const file = new File(['GIF89a'], 'anim.gif', { type: 'image/gif' });
    fireEvent.change(screen.getByLabelText('Arquivo da foto'), { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Formato não aceito');
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('removes the photo', async () => {
    apiDelete.mockImplementation(() => ok({ photo_version: null }));
    const onChanged = vi.fn();
    render(<UserPhotoField userId={3} name="Caique" version={99} onChanged={onChanged} />);
    fireEvent.click(screen.getByText('Remover foto'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null));
    expect(apiDelete).toHaveBeenCalledWith('/admin/users/3/foto');
    expect(screen.getByRole('status')).toHaveTextContent('Foto removida.');
  });
});

describe('Foto em Sistema > Usuários', () => {
  const USERS = [{ user_id: 3, username: 'caique', full_name: 'Caique Lima', role: 'USER', warehouse_ids: [7], photo_version: 42 }];

  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/admin/warehouses')) return ok({ warehouses: [{ warehouse_id: 7, warehouse_code: 'SP12', warehouse_name: 'Prateleiras' }] });
      if (path.includes('/permissions')) return ok({ page_keys: [] });
      return ok({ users: USERS });
    });
  });

  it('lists the users with their photo', async () => {
    currentUser = { user_id: 1, role: 'ADMIN' };
    render(<Users />);
    expect(await screen.findByAltText('Foto de Caique Lima')).toHaveAttribute('src', '/api/admin/users/3/foto?v=42');
  });

  it('lets an administrator change the photo of a user', async () => {
    currentUser = { user_id: 1, role: 'ADMIN' };
    render(<Users />);
    fireEvent.click(await screen.findByLabelText('Editar'));
    expect(await screen.findByText('Trocar foto')).toBeInTheDocument();
    expect(screen.getByText('Remover foto')).toBeInTheDocument();
  });

  it('does not offer it to a user who only manages users', async () => {
    currentUser = { user_id: 2, role: 'USER', allowed_pages: ['users'] };
    render(<Users />);
    fireEvent.click(await screen.findByLabelText('Editar'));
    await screen.findByText('Editar usuário');
    expect(screen.queryByText('Trocar foto')).toBeNull();
    expect(screen.queryByText('Colocar foto')).toBeNull();
  });
});

describe('reading the chosen photo', () => {
  it('loads the picture from a data: URL, which the panel CSP allows', async () => {
    // Regression: a blob: URL is refused by "img-src 'self' data:" and the
    // photo was never loaded nor sent.
    const { squareJpeg } = await import('../utils/userPhoto.js');
    const sources = [];
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      set src(value) { sources.push(value); setTimeout(() => this.onerror?.(), 0); }
    };
    const createObjectURL = vi.fn(() => 'blob:x');
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = createObjectURL;
    try {
      const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'foto.jpg', { type: 'image/jpeg' });
      await expect(squareJpeg(file)).rejects.toThrow();
      expect(sources).toHaveLength(1);
      expect(sources[0].startsWith('data:image/jpeg')).toBe(true);
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      globalThis.Image = RealImage;
      URL.createObjectURL = realCreate;
    }
  });
});
