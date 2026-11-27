-- 103_sea_historico_aprovacao.sql - processos novos liberados pelo celular
-- historico: o histórico (Estoque > Histórico e log de auditoria) só abre no painel depois da
-- confirmação no celular. aprovacao-retirada: cada aprovação de retirada no painel pede a
-- confirmação (vale para uma aprovação só).
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

-- Só amplia a lista quando ela ainda não tem o processo novo: o deploy reaplica todas as
-- migrações, e recriar a lista antiga falhava com os pedidos dos processos mais novos.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_login_challenges_purpose_check') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_login_challenges_purpose_check' AND pg_get_constraintdef(oid) LIKE '%''aprovacao-retirada''%') THEN
        ALTER TABLE sea_login_challenges DROP CONSTRAINT IF EXISTS sea_login_challenges_purpose_check;
        ALTER TABLE sea_login_challenges ADD CONSTRAINT sea_login_challenges_purpose_check CHECK (purpose IS NULL OR purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario', 'historico', 'aprovacao-retirada'));
    END IF;
END $$;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_step_up_purpose_check') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_step_up_purpose_check' AND pg_get_constraintdef(oid) LIKE '%''aprovacao-retirada''%') THEN
        ALTER TABLE sea_step_up DROP CONSTRAINT IF EXISTS sea_step_up_purpose_check;
        ALTER TABLE sea_step_up ADD CONSTRAINT sea_step_up_purpose_check CHECK (purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario', 'historico', 'aprovacao-retirada'));
    END IF;
END $$;
