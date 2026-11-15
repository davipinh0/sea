-- ============================================================
-- 088_sea_cadastro_materiais.sql - SEA: cadastro de materiais,
-- prateleiras e notificações no celular
-- ============================================================
--   * sap_materials passa a ser o cadastro de materiais consultado ao
--     montar uma OT: o código traz a descrição, a unidade e o peso por
--     caixa. É mantido em Sistema > Cadastro de materiais por quem tem
--     a permissão 'material-catalog'.
--   * Prateleiras: todas passam a ser GRANDE, que aceita material de
--     qualquer tamanho (PEQUENO continua restrito a material pequeno).
--   * sea_push_tokens: aparelhos que recebem as notificações do SEA.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE sap_materials ADD COLUMN IF NOT EXISTS pack_weight_kg INT
    CHECK (pack_weight_kg IS NULL OR pack_weight_kg > 0);

UPDATE bins SET size_class = 'GRANDE'
WHERE bin_type NOT IN ('Staging', 'PickableStaging')
  AND size_class IS DISTINCT FROM 'GRANDE';

CREATE TABLE IF NOT EXISTS sea_push_tokens (
    token      VARCHAR(200) PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_sea_push_tokens_user ON sea_push_tokens(user_id);
