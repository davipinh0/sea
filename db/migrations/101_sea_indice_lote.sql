-- 101_sea_indice_lote.sql - índice do estoque pelo lote
-- No SEA o lote do estoque é o número da OT, e quase toda tela procura o estoque por ele (lista de
-- OTs, terminal de retirada, painel, armazenagem). Sem índice, cada OT da lista varria o estoque
-- inteiro: na simulação de carga (qa/carga) a lista de OTs levava 553 ms com 800 OTs e passou a 26 ms.
-- Pode rodar mais de uma vez. Espelhada em db/schema.sql.

CREATE INDEX IF NOT EXISTS ix_inventory_lot ON inventory (lot_number, item_id);
