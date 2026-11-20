-- 087_sea_peso_por_caixa.sql - material em KG retirado por caixa
-- items.pack_weight_kg é o peso de uma caixa: 150 KG em caixas de 15 KG = 10 caixas; retirar 1
-- caixa baixa 15 KG. Só vale para unidade KG. NULL = não vai por caixa.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE items ADD COLUMN IF NOT EXISTS pack_weight_kg INT
    CHECK (pack_weight_kg IS NULL OR pack_weight_kg > 0);
