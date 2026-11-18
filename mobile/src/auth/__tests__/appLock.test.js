import { describe, it, expect, vi } from 'vitest';
import {
  biometricError, isLockSuspended, sameUser, shouldLock, suspendLock, unlockMode, withoutLock,
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
    expect(unlockMode({ hasHardware: true, isEnrolled: true })).toBe('biometric');
  });

  it('asks to register one in the phone settings when the sensor is empty', () => {
    expect(unlockMode({ hasHardware: true, isEnrolled: false })).toBe('enroll-device');
  });

  it('falls back to the password without a sensor', () => {
    expect(unlockMode({ hasHardware: false, isEnrolled: false })).toBe('password');
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
