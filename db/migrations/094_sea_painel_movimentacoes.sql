-- ============================================================
-- 094_sea_painel_movimentacoes.sql - SEA: "Limpar" as últimas
-- movimentações do Painel, só para quem limpou
-- ============================================================
-- O Painel mostra as movimentações registradas depois deste momento.
-- Nada é apagado do histórico (audit_log): só a lista do Painel daquele
-- usuário recomeça. NULL = mostra tudo.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS movements_cleared_at TIMESTAMPTZ;
