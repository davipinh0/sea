-- 104_sea_alteracao_justificada.sql - alteração no painel confirmada no celular
-- alteracao: salvar uma alteração no painel (material, OT, usuário, endereço, armazém,
-- configurações) e excluir uma OT pedem o motivo e a confirmação no app SEA do celular. O motivo
-- vai para o log de auditoria.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

-- Só amplia a lista quando ela ainda não tem o processo novo: o deploy reaplica todas as
-- migrações, e recriar a lista antiga falhava com os pedidos dos processos mais novos.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_login_challenges_purpose_check' AND pg_get_constraintdef(oid) LIKE '%''alteracao''%') THEN
        ALTER TABLE sea_login_challenges DROP CONSTRAINT IF EXISTS sea_login_challenges_purpose_check;
        ALTER TABLE sea_login_challenges ADD CONSTRAINT sea_login_challenges_purpose_check CHECK (purpose IS NULL OR purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario', 'historico', 'aprovacao-retirada', 'alteracao'));
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sea_step_up_purpose_check' AND pg_get_constraintdef(oid) LIKE '%''alteracao''%') THEN
        ALTER TABLE sea_step_up DROP CONSTRAINT IF EXISTS sea_step_up_purpose_check;
        ALTER TABLE sea_step_up ADD CONSTRAINT sea_step_up_purpose_check CHECK (purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario', 'historico', 'aprovacao-retirada', 'alteracao'));
    END IF;
END $$;
