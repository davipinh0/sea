-- 096_sea_retirada_avaliacao.sql - retirada avaliada antes de ser feita
-- REQUESTED (espera o avaliador) -> APPROVED (avisa quem faz retirada) -> PICKING (aceita,
-- picked_by prepara) -> READY (quem pediu confirma no terminal) -> DELIVERED (baixa). REJECTED =
-- negada com motivo, a reserva é desfeita. CANCELLED = cancelada.
-- Permissões: "retirada" pede, "retirada-avaliar" aprova ou nega, "retirada-fazer" aceita e separa.
-- Quem já tinha "retirada" ganha "retirada-fazer", para nada parar.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

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
