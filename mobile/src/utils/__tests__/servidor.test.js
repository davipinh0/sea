import { describe, it, expect, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
vi.mock('../../auth/secureStorage', () => ({ getAuthItem: vi.fn() }));
vi.mock('../../auth/identityProof', () => ({ identityHeaders: vi.fn(() => ({})) }));

const { currentServerUrl } = await import('../../api/client');

describe('Endereço do servidor', () => {
  it('troca o endereço antigo (sea-expedicao) salvo no celular pelo atual', () => {
    expect(currentServerUrl('https://sea-expedicao.eastus.cloudapp.azure.com'))
      .toBe('https://sea-recebimento.eastus.cloudapp.azure.com');
  });

  it('não mexe em outro endereço nem no vazio', () => {
    expect(currentServerUrl('http://192.168.0.10:5000')).toBe('http://192.168.0.10:5000');
    expect(currentServerUrl(null)).toBeNull();
  });

  it('o APK aponta para o servidor com o nome novo', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const eas = JSON.parse(readFileSync(fileURLToPath(new URL('../../../eas.json', import.meta.url)), 'utf8'));
    expect(eas.build.preview.env.EXPO_PUBLIC_API_URL).toBe('https://sea-recebimento.eastus.cloudapp.azure.com');
  });
});
