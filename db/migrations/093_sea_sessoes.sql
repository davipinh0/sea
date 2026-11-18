-- ============================================================
-- 093_sea_sessoes.sql - SEA: sessões controladas pelo servidor
-- ============================================================
-- Cada login (painel, terminal, app) abre uma linha aqui, identificada
-- pelo jti do token. Com isso o servidor consegue:
--   * encerrar a sessão de verdade no "Sair" (o token deixa de valer,
--     mesmo que alguém tenha copiado o cookie);
--   * derrubar a sessão do painel web depois de um tempo sem uso
--     (SEA_WEB_IDLE_MINUTES), por exemplo quando o navegador foi
--     fechado sem sair.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS sea_sessions (
    jti           UUID PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    client_ip     VARCHAR(64),
    user_agent    VARCHAR(300),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    ended_at      TIMESTAMPTZ,
    end_reason    VARCHAR(20)
                  CHECK (end_reason IN ('LOGOUT', 'IDLE', 'REFRESH'))
);
CREATE INDEX IF NOT EXISTS ix_sea_sessions_user ON sea_sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sea_sessions_expires ON sea_sessions(expires_at);
