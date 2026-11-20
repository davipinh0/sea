-- 088_sea_cadastro_materiais.sql
-- - sap_materials vira o cadastro de materiais consultado ao montar uma OT (descrição, unidade e
-- peso da caixa).
-- - Todas as prateleiras passam a ser GRANDE (aceitam qualquer tamanho).
-- - sea_push_tokens: celulares que recebem as notificações.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

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
