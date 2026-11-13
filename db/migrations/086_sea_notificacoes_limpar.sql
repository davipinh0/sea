-- ============================================================
-- 086_sea_notificacoes_limpar.sql - SEA: limpar notificações
-- ============================================================
-- Cada usuário pode limpar a sua lista de notificações do painel. O que
-- foi limpo deixa de aparecer para ele; os registros (e o histórico de
-- envio de e-mail) continuam em sea_notifications.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_cleared_id INT NOT NULL DEFAULT 0;
