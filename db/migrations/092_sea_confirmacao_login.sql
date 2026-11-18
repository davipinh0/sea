-- ============================================================
-- 092_sea_confirmacao_login.sql - SEA: login confirmado no celular
-- ============================================================
-- Com users.web_login_approval ligado e um aparelho cadastrado (app SEA
-- com bloqueio por digital ou PIN/padrão), o login por senha fora desse
-- aparelho (painel web, terminal, outro celular) só libera a sessão
-- depois de confirmado no aparelho. Cada tentativa fica em
-- sea_login_challenges; quem iniciou a tentativa acompanha com um
-- segredo próprio (só o hash fica no banco).
--
-- sea_push_tokens passa a guardar o aparelho mesmo após o "sair" do app
-- (signed_in = FALSE: não recebe os avisos do dia a dia, mas continua
-- podendo confirmar um login).
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS web_login_approval BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE sea_push_tokens ADD COLUMN IF NOT EXISTS secure_lock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sea_push_tokens ADD COLUMN IF NOT EXISTS signed_in BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sea_push_tokens ADD COLUMN IF NOT EXISTS device_name VARCHAR(100);

CREATE TABLE IF NOT EXISTS sea_login_challenges (
    challenge_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    poll_hash     CHAR(64) NOT NULL,
    status        VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'USED')),
    client_ip     VARCHAR(64),
    user_agent    VARCHAR(300),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_sea_login_challenges_user
    ON sea_login_challenges(user_id, status, expires_at);
