-- 086_sea_notificacoes_limpar.sql - cada usuário limpa a própria lista de notificações; os
-- registros continuam.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_cleared_id INT NOT NULL DEFAULT 0;
