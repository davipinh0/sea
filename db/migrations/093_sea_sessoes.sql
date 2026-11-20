-- 093_sea_sessoes.sql - sessões controladas pelo servidor
-- Cada login abre uma linha, pelo jti do token. Assim o "Sair" encerra de verdade (mesmo com o
-- cookie copiado) e a sessão do painel cai depois de SEA_WEB_IDLE_MINUTES sem uso.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

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
