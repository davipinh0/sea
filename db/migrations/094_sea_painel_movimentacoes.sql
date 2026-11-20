-- 094_sea_painel_movimentacoes.sql - "Limpar" as últimas movimentações do Painel, só para quem
-- limpou. Nada sai do histórico. NULL = mostra tudo.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE users ADD COLUMN IF NOT EXISTS movements_cleared_at TIMESTAMPTZ;
