-- 095_sea_confirmacao_processo.sql - processos do painel liberados pelo celular
-- Recebimento, Armazenagem e Retirada no painel só funcionam depois da confirmação no celular. Usa
-- a mesma fila do login (purpose = processo, session_jti = sessão que pediu). Aprovada, a sessão
-- fica liberada por 15 minutos sem uso.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE sea_login_challenges ADD COLUMN IF NOT EXISTS purpose VARCHAR(20)
    CHECK (purpose IS NULL OR purpose IN ('recebimento', 'armazenagem', 'retirada'));
ALTER TABLE sea_login_challenges ADD COLUMN IF NOT EXISTS session_jti UUID;

CREATE TABLE IF NOT EXISTS sea_step_up (
    jti           UUID NOT NULL REFERENCES sea_sessions(jti) ON DELETE CASCADE,
    purpose       VARCHAR(20) NOT NULL
                  CHECK (purpose IN ('recebimento', 'armazenagem', 'retirada')),
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (jti, purpose)
);
