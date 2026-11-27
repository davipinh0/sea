// Auditoria de 27/11/2026: o APK aceitava servidor http://, e a troca de servidor mandava usuário e
// senha de administrador sem criptografia.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serverUrlAllowed } from '../serverUrl';

describe('serverUrlAllowed', () => {
  it('aceita HTTPS sempre', () => {
    expect(serverUrlAllowed('https://sea-recebimento.eastus.cloudapp.azure.com', { allowHttp: false })).toBe(true);
    expect(serverUrlAllowed('HTTPS://10.0.0.5:8443', { allowHttp: false })).toBe(true);
  });

  it('recusa HTTP no APK e aceita só no desenvolvimento', () => {
    expect(serverUrlAllowed('http://192.168.0.10:8080', { allowHttp: false })).toBe(false);
    expect(serverUrlAllowed('http://192.168.0.10:8080', { allowHttp: true })).toBe(true);
  });

  it('sem __DEV__ (testes, APK) o padrão é recusar HTTP', () => {
    expect(serverUrlAllowed('http://192.168.0.10:8080')).toBe(false);
  });

  it('recusa endereço vazio, sem host ou com outro esquema', () => {
    for (const url of ['', 'https://', 'ftp://x', 'javascript:alert(1)', null, undefined, 42]) {
      expect(serverUrlAllowed(url, { allowHttp: true })).toBe(false);
    }
  });
});

describe('endereço salvo no celular', () => {
  const storage = new Map();
  beforeEach(() => {
    storage.clear();
    vi.resetModules();
    vi.doMock('@react-native-async-storage/async-storage', () => ({
      default: {
        getItem: vi.fn(async (k) => (storage.has(k) ? storage.get(k) : null)),
        setItem: vi.fn(async (k, v) => { storage.set(k, v); }),
      },
    }));
    vi.doMock('../../auth/secureStorage', () => ({ getAuthItem: vi.fn() }));
    vi.doMock('../../auth/identityProof', () => ({ identityHeaders: vi.fn(() => ({})) }));
  });

  it('um http:// salvo antes não é usado: volta ao servidor padrão', async () => {
    storage.set('sea_api_url', 'http://192.168.0.10:5000');
    const client = await import('../../api/client');
    await client.initApiUrl();
    expect(await client.getApiUrl()).not.toContain('http://192.168.0.10');
  });

  it('um https:// salvo continua valendo', async () => {
    storage.set('sea_api_url', 'https://outro.exemplo.com');
    const client = await import('../../api/client');
    await client.initApiUrl();
    expect(await client.getApiUrl()).toBe('https://outro.exemplo.com');
  });
});
