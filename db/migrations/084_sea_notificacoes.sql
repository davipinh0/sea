-- ============================================================
-- 084_sea_notificacoes.sql - SEA: e-mail dos usuários e notificações
-- ============================================================
--   * users.email: e-mail corporativo do usuário. Serve para (a) entrar
--     no terminal de retirada com o e-mail e (b) receber as notificações
--     por e-mail (somente administradores ativos com e-mail cadastrado).
--   * sea_notifications: uma linha por evento operacional (retirada
--     solicitada, recebimento, armazenagem concluída). O painel lê esta
--     tabela para avisar o operador; email_status registra o envio.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(254);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
    ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS sea_notifications (
    notification_id SERIAL PRIMARY KEY,
    warehouse_id    INT NOT NULL REFERENCES warehouses(warehouse_id),
    kind            VARCHAR(30) NOT NULL
        CHECK (kind IN ('RETIRADA_SOLICITADA', 'RECEBIMENTO', 'ARMAZENAGEM_CONCLUIDA')),
    title           VARCHAR(200) NOT NULL,
    message         VARCHAR(1000) NOT NULL,
    ot              VARCHAR(50),
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- PENDENTE: aguardando envio. ENVIADO. SEM_DESTINATARIO: nenhum
    -- administrador com e-mail. NAO_CONFIGURADO: servidor SMTP não
    -- configurado. FALHA: o envio falhou (email_error guarda o motivo).
    email_status    VARCHAR(20) NOT NULL DEFAULT 'PENDENTE'
        CHECK (email_status IN ('PENDENTE', 'ENVIADO', 'SEM_DESTINATARIO',
                                'NAO_CONFIGURADO', 'FALHA')),
    email_sent_at   TIMESTAMPTZ,
    email_error     VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS ix_sea_notifications_wh
    ON sea_notifications (warehouse_id, notification_id DESC);
