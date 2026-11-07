// Mirror of api/services/webhook_dispatcher/error_catalog.py for the
// places in the admin UI that need to render description / triage_hint
// without a server round-trip (notably the per-subscription DLQ viewer,
// whose endpoint has not been extended to return catalog fields).
//
// The cross-subscription /admin/webhook-errors endpoint joins the
// server catalog at response time and ships description + triage_hint
// per row, so it does NOT consult this mirror.
//
// Keep in sync with the python module. Adding a new error_kind there
// without updating here lands a "(no description)" placeholder in the
// DLQ tooltip, which is operator-visible but harmless.

export const ERROR_CATALOG = {
  timeout: {
    short_message: 'O endpoint do consumidor não respondeu a tempo',
    description: 'O endpoint de webhook do consumidor não respondeu dentro do tempo limite de envio (padrão 10s). O dispatcher abandonou a tentativa e tentará novamente com backoff exponencial.',
  },
  connection: {
    short_message: 'Não foi possível conectar ao endpoint do consumidor',
    description: 'A conexão TCP com o endpoint do consumidor falhou antes de qualquer troca HTTP. O hostname pode não resolver, a porta pode estar fechada ou um firewall pode estar bloqueando a requisição.',
  },
  tls: {
    short_message: 'Falha no handshake TLS',
    description: 'O handshake TLS com o endpoint do consumidor falhou. O consumidor pode estar apresentando um certificado expirado ou autoassinado, as cifras podem não ser compatíveis ou o hostname pode não corresponder ao certificado.',
  },
  ssrf_rejected: {
    short_message: 'A URL de entrega resolveu para um IP privado ou interno',
    description: 'A proteção contra SSRF do dispatcher rejeitou a delivery_url porque a resolução DNS retornou um endereço privado (RFC1918), de loopback ou de IMDS da nuvem. O dispatcher se recusa a enviar para destinos internos para se defender de ataques de DNS rebinding e split-horizon DNS.',
  },
  redirected: {
    short_message: 'O endpoint do consumidor retornou um redirecionamento 3xx',
    description: 'O endpoint do consumidor retornou um redirecionamento 3xx. O dispatcher não segue redirecionamentos (allow_redirects=False é uma regra de segurança). A entrega é tratada como falha e a política de novas tentativas se aplica.',
  },
  '4xx': {
    short_message: 'O consumidor rejeitou a requisição (resposta 4xx)',
    description: 'O endpoint do consumidor retornou uma resposta HTTP 4xx. O consumidor rejeitou o payload, a assinatura, os cabeçalhos ou o formato da requisição.',
  },
  '5xx': {
    short_message: 'O endpoint do consumidor retornou um erro de servidor (5xx)',
    description: 'O endpoint do consumidor retornou uma resposta HTTP 5xx. O consumidor aceitou a requisição, mas falhou ao processá-la. O dispatcher tentará novamente com backoff exponencial; 5xx persistentes pausam a assinatura automaticamente pelo limite da DLQ.',
  },
  unknown: {
    short_message: 'Falha na entrega (não classificada)',
    description: 'O dispatcher não conseguiu classificar a falha em nenhum dos error_kinds documentados. Isso geralmente indica uma exceção de biblioteca que a camada de classificação não reconheceu.',
  },
};

export function catalogEntry(kind) {
  return ERROR_CATALOG[kind] || ERROR_CATALOG.unknown;
}
