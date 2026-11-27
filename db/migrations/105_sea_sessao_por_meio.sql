-- 105_sea_sessao_por_meio.sql - cada sessão vale só pelo meio em que foi usada primeiro
-- channel: 'cookie' (painel) ou 'header' (app e terminal, token Bearer). O login devolve o mesmo
-- token nos dois; sem esta coluna, o token do cookie do painel usado como Bearer pulava a
-- confirmação no celular, o motivo da alteração e o fim da sessão por inatividade.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE sea_sessions ADD COLUMN IF NOT EXISTS channel VARCHAR(10)
    CHECK (channel IS NULL OR channel IN ('cookie', 'header'));
