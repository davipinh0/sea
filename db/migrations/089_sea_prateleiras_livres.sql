-- 089_sea_prateleiras_livres.sql - prateleiras sem limite
-- A API deixou de aplicar tamanho, capacidade e compatibilidade; os valores antigos saem para
-- nenhuma tela mostrar um limite que não vale mais.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

UPDATE bins SET size_class = NULL, capacity_units = NULL
WHERE size_class IS NOT NULL OR capacity_units IS NOT NULL;
