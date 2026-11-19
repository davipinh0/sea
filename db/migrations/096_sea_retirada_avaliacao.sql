-- ============================================================
-- 096_sea_retirada_avaliacao.sql - SEA: retirada avaliada antes de
-- ser feita
-- ============================================================
-- Fluxo novo da retirada:
--   REQUESTED  solicitada no terminal, aguardando o avaliador
--   APPROVED   aprovada; os usuários com "Fazer retirada" são avisados
--   PICKING    aceita por um deles (picked_by), que prepara o material
--   READY      pronta; o solicitante confirma no terminal
--   DELIVERED  entregue (baixa no estoque)
--   REJECTED   negada pelo avaliador (com motivo); a reserva é desfeita
--   CANCELLED  cancelada
--
-- Permissões: "retirada" = solicitar; "retirada-avaliar" = aprovar ou
-- negar; "retirada-fazer" = aceitar e separar. Quem já tinha
-- "retirada" recebe também "retirada-fazer", para nada parar.
--
-- Idempotent: safe to run more than once. Mirrored in db/schema.sql.
-- ============================================================

ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check
    CHECK (status IN ('REQUESTED', 'APPROVED', 'PICKING', 'READY', 'DELIVERED',
                      'REJECTED', 'CANCELLED'));
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS evaluated_by VARCHAR(100);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS evaluation_note VARCHAR(500);

ALTER TABLE sea_notifications DROP CONSTRAINT IF EXISTS sea_notifications_kind_check;
ALTER TABLE sea_notifications ADD CONSTRAINT sea_notifications_kind_check
    CHECK (kind IN ('RETIRADA_SOLICITADA', 'RETIRADA_APROVADA', 'RECEBIMENTO',
                    'ARMAZENAGEM_CONCLUIDA'));

INSERT INTO user_page_permissions (user_id, page_key)
SELECT user_id, 'retirada-fazer' FROM user_page_permissions WHERE page_key = 'retirada'
ON CONFLICT DO NOTHING;
