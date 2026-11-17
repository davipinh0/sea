-- ============================================================
-- 089_sea_prateleiras_livres.sql - SEA: prateleiras sem limites
-- ============================================================
-- As prateleiras passam a aceitar qualquer material, de qualquer ordem,
-- em qualquer quantidade. A API deixou de aplicar classe de tamanho,
-- capacidade e compatibilidade; aqui os valores antigos são removidos
-- para que nenhuma tela mostre um limite que não vale mais.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

UPDATE bins SET size_class = NULL, capacity_units = NULL
WHERE size_class IS NOT NULL OR capacity_units IS NOT NULL;
