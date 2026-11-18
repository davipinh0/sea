-- ============================================================
-- 095_sea_confirmacao_processo.sql - SEA: processos do painel web
-- liberados pelo celular
-- ============================================================
-- No painel web, Recebimento, Armazenagem e Retirada (processar) só
-- funcionam depois de confirmados no app SEA do celular cadastrado
-- (digital ou PIN/padrão). A confirmação usa a mesma fila do login
-- confirmado (sea_login_challenges), com o processo em "purpose" e a
-- sessão do painel que pediu em "session_jti". Aprovada, a sessão fica
-- liberada naquele processo (sea_step_up) por 15 minutos sem uso.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

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
