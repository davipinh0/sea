-- 102_sea_local_recebimento.sql - o local Expedição passa a se chamar Recebimento
-- A área só faz o recebimento das OTs (não a expedição). O código do local é o que o painel e o app
-- usam para mostrar Recebimento e Armazenagem, então muda junto com eles. Ids não mudam: estoque,
-- recebimentos, retiradas e permissões continuam ligados ao mesmo local. O log de auditoria guarda o
-- texto da época e não é alterado.
-- Pode rodar mais de uma vez. Espelhada em db/seed-sea.sql.

UPDATE warehouses SET warehouse_code = 'Recebimento', warehouse_name = 'Área de Recebimento'
WHERE warehouse_code = 'Expedição';

UPDATE bins SET bin_code = 'RECEBIMENTO', bin_barcode = 'RECEBIMENTO',
       description = 'Área de Recebimento (endereço único)'
WHERE bin_code = 'EXPEDICAO'
  AND warehouse_id = (SELECT warehouse_id FROM warehouses WHERE warehouse_code = 'Recebimento');

UPDATE zones SET zone_name = 'Área de Recebimento'
WHERE zone_name = 'Área da Expedição'
  AND warehouse_id = (SELECT warehouse_id FROM warehouses WHERE warehouse_code = 'Recebimento');
