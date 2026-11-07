/**
 * V-021: tests for the friendly-error helper.
 */

import { describe, it, expect } from 'vitest';
import { friendlyError } from '../utils/friendlyError.js';

describe('friendlyError', () => {
  it('maps known error codes to user-friendly strings', () => {
    expect(friendlyError({ error: 'validation_error' })).toBe(
      'Um ou mais campos têm valores inválidos.'
    );
    expect(friendlyError({ error: 'Usuário ou senha inválidos' })).toBe(
      'Usuário ou senha incorretos.'
    );
    expect(friendlyError({ error: 'Token CSRF ausente ou inválido' })).toBe(
      'Sua sessão está dessincronizada. Atualize a página e tente novamente.'
    );
  });

  it('returns fallback for unknown error codes', () => {
    expect(friendlyError({ error: 'some_internal_code' })).toBe(
      'Algo deu errado. Tente novamente.'
    );
  });

  it('never echoes raw backend error strings', () => {
    const leakyPayload = {
      error: 'UNIQUE_CONSTRAINT_VIOLATION on users_username_key',
      stack: 'Traceback: /app/routes/admin_users.py line 42',
    };
    const result = friendlyError(leakyPayload);
    expect(result).not.toContain('UNIQUE_CONSTRAINT_VIOLATION');
    expect(result).not.toContain('Traceback');
    expect(result).not.toContain('admin_users.py');
  });

  it('uses the custom fallback when provided', () => {
    expect(friendlyError({ error: 'mystery' }, 'Could not save item.')).toBe(
      'Could not save item.'
    );
  });

  it('handles null/non-object payloads safely', () => {
    expect(friendlyError(null)).toBe('Algo deu errado. Tente novamente.');
    expect(friendlyError(undefined)).toBe('Algo deu errado. Tente novamente.');
    expect(friendlyError('some string')).toBe('Algo deu errado. Tente novamente.');
  });

  it('handles payload with no error field', () => {
    expect(friendlyError({})).toBe('Algo deu errado. Tente novamente.');
  });
});
