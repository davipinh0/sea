-- 084_sea_notificacoes.sql - e-mail dos usuários e notificações
-- - users.email: e-mail corporativo, usado para entrar no terminal e para os administradores
-- receberem as notificações.
-- - sea_notifications: uma linha por evento (retirada, recebimento, armazenagem concluída);
-- email_status registra o envio.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

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
    -- PENDENTE, ENVIADO, SEM_DESTINATARIO (nenhum administrador com e-mail), NAO_CONFIGURADO (sem
    -- servidor SMTP) ou FALHA (motivo em email_error).
    email_status    VARCHAR(20) NOT NULL DEFAULT 'PENDENTE'
        CHECK (email_status IN ('PENDENTE', 'ENVIADO', 'SEM_DESTINATARIO',
                                'NAO_CONFIGURADO', 'FALHA')),
    email_sent_at   TIMESTAMPTZ,
    email_error     VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS ix_sea_notifications_wh
    ON sea_notifications (warehouse_id, notification_id DESC);
