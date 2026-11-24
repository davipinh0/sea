-- 103_sea_historico_aprovacao.sql - processos novos liberados pelo celular
-- historico: o histórico (Estoque > Histórico e log de auditoria) só abre no painel depois da
-- confirmação no celular. aprovacao-retirada: cada aprovação de retirada no painel pede a
-- confirmação (vale para uma aprovação só).
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

ALTER TABLE sea_login_challenges DROP CONSTRAINT IF EXISTS sea_login_challenges_purpose_check;
ALTER TABLE sea_login_challenges ADD CONSTRAINT sea_login_challenges_purpose_check
    CHECK (purpose IS NULL OR purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario',
                                          'historico', 'aprovacao-retirada'));
ALTER TABLE sea_step_up DROP CONSTRAINT IF EXISTS sea_step_up_purpose_check;
ALTER TABLE sea_step_up ADD CONSTRAINT sea_step_up_purpose_check
    CHECK (purpose IN ('recebimento', 'armazenagem', 'retirada', 'exclusao-usuario',
                       'historico', 'aprovacao-retirada'));
