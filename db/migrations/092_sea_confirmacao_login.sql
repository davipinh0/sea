-- 092_sea_confirmacao_login.sql - login confirmado no celular
-- Com a confirmação ligada e um celular cadastrado (app com trava), o login com senha em outro
-- lugar só abre a sessão depois da confirmação no celular. Quem iniciou acompanha com um segredo
-- próprio (só o hash fica no banco).
-- O celular continua cadastrado depois de "sair" do app (signed_in = FALSE): não recebe avisos, mas
-- confirma logins.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

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
