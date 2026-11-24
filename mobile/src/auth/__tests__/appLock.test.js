import { describe, it, expect, vi } from 'vitest';
import {
  authenticate, biometricError, identityError, isLockSuspended, sameUser, shouldLock, suspendLock, unlockMode, withoutLock,
} from '../appLock';

describe('shouldLock', () => {
  it('locks when the app goes to the background', () => {
    expect(shouldLock('background', { enabled: true })).toBe(true);
  });

  it('does not lock while the app stays open or without a registered user', () => {
    expect(shouldLock('active', { enabled: true })).toBe(false);
    expect(shouldLock('inactive', { enabled: true })).toBe(false);
    expect(shouldLock('background', { enabled: false })).toBe(false);
  });

  it('does not lock while a system dialog opened by the app is up', () => {
    const release = suspendLock();
    expect(isLockSuspended()).toBe(true);
    expect(shouldLock('background', { enabled: true })).toBe(false);
    release();
    release(); // a second release does not unbalance the counter
    expect(isLockSuspended()).toBe(false);
    expect(shouldLock('background', { enabled: true })).toBe(true);
  });
});

describe('withoutLock', () => {
  it('keeps the lock off during the call and a moment after it', async () => {
    vi.useFakeTimers();
    let during = null;
    const value = await withoutLock(async () => { during = isLockSuspended(); return 7; }, 500);
    expect(value).toBe(7);
    expect(during).toBe(true);
    expect(isLockSuspended()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(isLockSuspended()).toBe(false);
    vi.useRealTimers();
  });

  it('releases the lock even when the call fails', async () => {
    vi.useFakeTimers();
    await expect(withoutLock(async () => { throw new Error('x'); }, 10)).rejects.toThrow('x');
    vi.advanceTimersByTime(10);
    expect(isLockSuspended()).toBe(false);
    vi.useRealTimers();
  });
});

describe('unlockMode', () => {
  it('uses the fingerprint when the phone has one registered', () => {
    expect(unlockMode({ isEnrolled: true, securityLevel: 3 })).toBe('biometric');
  });

  it("uses the phone's PIN or pattern when there is no fingerprint", () => {
    // Regressão: celular sem digital não conseguia usar o app.
    expect(unlockMode({ isEnrolled: false, securityLevel: 1 })).toBe('device');
  });

  it('asks for a screen lock when the phone has none', () => {
    expect(unlockMode({ isEnrolled: false, securityLevel: 0 })).toBe('none');
    expect(unlockMode({ isEnrolled: false })).toBe('none');
  });
});

describe('sameUser', () => {
  it('compares the registered user without case', () => {
    expect(sameUser('Caique', 'caique')).toBe(true);
    expect(sameUser('caique', 'admin')).toBe(false);
    expect(sameUser(null, 'caique')).toBe(false);
    expect(sameUser('caique', undefined)).toBe(false);
  });
});

describe('biometricError', () => {
  it('stays quiet when the user cancels', () => {
    expect(biometricError({ success: true })).toBeNull();
    expect(biometricError({ success: false, error: 'user_cancel' })).toBeNull();
    expect(biometricError({ success: false, error: 'system_cancel' })).toBeNull();
  });

  it('explains the other failures', () => {
    expect(biometricError({ success: false, error: 'lockout' })).toMatch(/Muitas tentativas/);
    expect(biometricError({ success: false, error: 'authentication_failed' })).toMatch(/não reconhecida/);
  });
});

describe('identityError', () => {
  it('lets the process go on only when confirmed', () => {
    expect(identityError({ success: true })).toBeNull();
    expect(identityError({ success: false, error: 'user_cancel' })).toMatch(/cancelada/);
    expect(identityError({ success: false, error: 'passcode_not_set' })).toMatch(/PIN ou padrão/);
    expect(identityError({ success: false, error: 'lockout' })).toMatch(/Muitas tentativas/);
    expect(identityError(undefined)).toMatch(/Não foi possível/);
  });
});

describe('authenticate', () => {
  const OPTIONS = { promptMessage: 'Confirme que é você' };

  it('regressão: um pedido de digital preso não faz o "SIM, SOU EU" parecer cancelado', async () => {
    const localAuth = {
      authenticateAsync: vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'app_cancel' })
        .mockResolvedValueOnce({ success: true }),
      cancelAuthenticate: vi.fn().mockResolvedValue(undefined),
    };
    const result = await authenticate(localAuth, OPTIONS, { retryDelayMs: 0 });
    expect(result).toEqual({ success: true });
    expect(localAuth.cancelAuthenticate).toHaveBeenCalledTimes(1);
    expect(localAuth.authenticateAsync).toHaveBeenCalledTimes(2);
    expect(localAuth.authenticateAsync).toHaveBeenLastCalledWith(OPTIONS);
  });

  it('não repete quando o usuário cancelou ou confirmou', async () => {
    for (const answer of [{ success: true }, { success: false, error: 'user_cancel' }]) {
      const localAuth = { authenticateAsync: vi.fn().mockResolvedValue(answer), cancelAuthenticate: vi.fn() };
      expect(await authenticate(localAuth, OPTIONS, { retryDelayMs: 0 })).toEqual(answer);
      expect(localAuth.authenticateAsync).toHaveBeenCalledTimes(1);
      expect(localAuth.cancelAuthenticate).not.toHaveBeenCalled();
    }
  });

  it('tenta só uma vez de novo e explica se ainda houver outro pedido aberto', async () => {
    const localAuth = {
      authenticateAsync: vi.fn().mockResolvedValue({ success: false, error: 'app_cancel' }),
      cancelAuthenticate: vi.fn().mockRejectedValue(new Error('nada para cancelar')),
    };
    const result = await authenticate(localAuth, OPTIONS, { retryDelayMs: 0 });
    expect(localAuth.authenticateAsync).toHaveBeenCalledTimes(2);
    expect(biometricError(result)).toMatch(/Outra confirmação/);
    expect(identityError(result)).toMatch(/Outra confirmação/);
  });
});
