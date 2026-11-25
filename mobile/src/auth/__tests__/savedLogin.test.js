import { describe, it, expect, vi } from 'vitest';
import {
  SAVED_LOGIN_KEY, clearSavedLogin, forgetOtherUser, loadSavedLogin, saveLogin,
} from '../savedLogin';

function makeSecureStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItemAsync: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItemAsync: vi.fn(async (k, v) => { store.set(k, v); }),
    deleteItemAsync: vi.fn(async (k) => {
      if (!store.has(k)) throw new Error('not found');
      store.delete(k);
    }),
    has: (k) => store.has(k),
  };
}

const saved = (username, password) => ({ [SAVED_LOGIN_KEY]: JSON.stringify({ username, password }) });

describe('saveLogin / loadSavedLogin', () => {
  it('returns the saved login for the user who enabled the lock on this phone', async () => {
    const store = makeSecureStore();
    await saveLogin(store, 'qa.oper', 'Senha-123');
    expect(await loadSavedLogin(store, 'qa.oper')).toEqual({ username: 'qa.oper', password: 'Senha-123' });
    expect(await loadSavedLogin(store, 'QA.OPER')).toEqual({ username: 'qa.oper', password: 'Senha-123' });
  });

  it('ignores the saved login when another user (or nobody) enabled the lock', async () => {
    const store = makeSecureStore(saved('qa.oper', 'Senha-123'));
    expect(await loadSavedLogin(store, 'qa.almox')).toBeNull();
    expect(await loadSavedLogin(store, null)).toBeNull();
  });

  it('does not save without a user or a password', async () => {
    const store = makeSecureStore();
    await saveLogin(store, 'qa.oper', '');
    await saveLogin(store, '', 'Senha-123');
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  it('treats missing, corrupted or incomplete content as no saved login', async () => {
    expect(await loadSavedLogin(makeSecureStore(), 'qa.oper')).toBeNull();
    expect(await loadSavedLogin(makeSecureStore({ [SAVED_LOGIN_KEY]: '{oops' }), 'qa.oper')).toBeNull();
    expect(await loadSavedLogin(makeSecureStore(saved('qa.oper', '')), 'qa.oper')).toBeNull();
    expect(await loadSavedLogin(makeSecureStore({ [SAVED_LOGIN_KEY]: 'null' }), 'qa.oper')).toBeNull();
  });

  it('treats a keystore read failure as no saved login', async () => {
    const store = makeSecureStore();
    store.getItemAsync.mockRejectedValueOnce(new Error('keystore'));
    expect(await loadSavedLogin(store, 'qa.oper')).toBeNull();
  });
});

describe('clearSavedLogin', () => {
  it('removes the saved login and is idempotent', async () => {
    const store = makeSecureStore(saved('qa.oper', 'Senha-123'));
    await clearSavedLogin(store);
    expect(store.has(SAVED_LOGIN_KEY)).toBe(false);
    await expect(clearSavedLogin(store)).resolves.toBeUndefined();
  });
});

describe('forgetOtherUser', () => {
  it('keeps the saved login when the same user logs in', async () => {
    const store = makeSecureStore(saved('qa.oper', 'Senha-123'));
    await forgetOtherUser(store, 'QA.Oper');
    expect(store.has(SAVED_LOGIN_KEY)).toBe(true);
  });

  it('removes the saved login when another user logs in on this phone', async () => {
    const store = makeSecureStore(saved('qa.oper', 'Senha-123'));
    await forgetOtherUser(store, 'qa.almox');
    expect(store.has(SAVED_LOGIN_KEY)).toBe(false);
  });

  it('removes corrupted content and does nothing without a saved login', async () => {
    const corrupted = makeSecureStore({ [SAVED_LOGIN_KEY]: '{oops' });
    await forgetOtherUser(corrupted, 'qa.oper');
    expect(corrupted.has(SAVED_LOGIN_KEY)).toBe(false);

    const empty = makeSecureStore();
    await forgetOtherUser(empty, 'qa.oper');
    expect(empty.deleteItemAsync).not.toHaveBeenCalled();
  });
});
