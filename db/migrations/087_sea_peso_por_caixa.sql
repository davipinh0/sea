-- ============================================================
-- 087_sea_peso_por_caixa.sql - SEA: material em KG retirado por caixa
-- ============================================================
-- Um material cuja unidade é KG (ex.: arame de soldagem) fica no estoque
-- em quilos, mas é retirado por caixa. items.pack_weight_kg guarda o peso
-- de uma caixa: 150 KG com caixas de 15 KG = 10 caixas; retirar 1 caixa
-- baixa 15 KG. NULL = o material não é controlado por caixa.
--
-- Vale só para materiais com unidade KG. Para PC, PAR etc. a retirada de
-- 1 continua sendo 1 unidade.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE items ADD COLUMN IF NOT EXISTS pack_weight_kg INT
    CHECK (pack_weight_kg IS NULL OR pack_weight_kg > 0);
