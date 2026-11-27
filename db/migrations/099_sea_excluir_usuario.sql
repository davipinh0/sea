-- 099_sea_excluir_usuario.sql - excluir usuário que já tem histórico
-- A exclusão era recusada pelo banco quando o usuário já tinha recebido uma retirada. Agora a
-- retirada guarda o nome de quem recebeu (delivered_to_name) e, ao excluir o usuário, só perde a
-- ligação com ele; o registro continua mostrando o nome. O mesmo vale para os registros de webhook.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS delivered_to_name VARCHAR(200);

UPDATE withdrawals w
SET delivered_to_name = COALESCE(u.full_name, u.username)
FROM users u
WHERE u.user_id = w.delivered_to_user_id AND w.delivered_to_name IS NULL;

ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_delivered_to_user_id_fkey;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_delivered_to_user_id_fkey
    FOREIGN KEY (delivered_to_user_id) REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE webhook_subscriptions_tombstones
    DROP CONSTRAINT IF EXISTS webhook_subscriptions_tombstones_deleted_by_fkey;
ALTER TABLE webhook_subscriptions_tombstones ADD CONSTRAINT webhook_subscriptions_tombstones_deleted_by_fkey
    FOREIGN KEY (deleted_by) REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE webhook_subscriptions_tombstones
    DROP CONSTRAINT IF EXISTS webhook_subscriptions_tombstones_acknowledged_by_fkey;
ALTER TABLE webhook_subscriptions_tombstones ADD CONSTRAINT webhook_subscriptions_tombstones_acknowledged_by_fkey
    FOREIGN KEY (acknowledged_by) REFERENCES users(user_id) ON DELETE SET NULL;

-- Novo processo liberado pelo celular: exclusão de usuário.
-- Só amplia a lista quando ela ainda não tem o processo novo: o deploy reaplica todas as
-- migrações, e recriar a lista antiga falhava com os pedidos dos processos mais novos.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_login_challenges_purpose_check') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_login_challenges_purpose_check' AND pg_get_constraintdef(oid) LIKE '%''exclusao-usuario''%') THEN
        ALTER TABLE sea_login_challenges DROP CONSTRAINT IF EXISTS sea_login_challenges_purpose_check;
        ALTER TABLE sea_login_challenges ADD CONSTRAINT sea_login_challenges_purpose_check CHECK (purpose IS NULL OR purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario'));
    END IF;
END $$;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_step_up_purpose_check') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_step_up_purpose_check' AND pg_get_constraintdef(oid) LIKE '%''exclusao-usuario''%') THEN
        ALTER TABLE sea_step_up DROP CONSTRAINT IF EXISTS sea_step_up_purpose_check;
        ALTER TABLE sea_step_up ADD CONSTRAINT sea_step_up_purpose_check CHECK (purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario'));
    END IF;
END $$;
