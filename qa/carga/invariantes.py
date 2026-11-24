"""Regras que precisam valer no banco depois da simulação, por mais pesada que ela seja.

Só leitura. Cada regra devolve quantas linhas a violam e alguns exemplos; zero é o esperado.
Considera só as OTs da empresa fictícia (número começando com 90).
"""

from __future__ import annotations

from sqlalchemy import text

REGRAS = [
    (
        "Estoque nunca negativo nem reservado além do que existe",
        """
        SELECT inventory_id, quantity_on_hand, quantity_allocated FROM inventory
        WHERE quantity_on_hand < 0 OR quantity_allocated < 0
           OR quantity_allocated > quantity_on_hand
        """,
    ),
    (
        "Reserva do estoque = soma das retiradas em andamento",
        """
        SELECT inv.inventory_id, inv.quantity_allocated, COALESCE(o.qtd, 0) AS em_andamento
        FROM inventory inv
        LEFT JOIN (
            SELECT wl.inventory_id, SUM(wl.quantity) AS qtd
            FROM withdrawal_lines wl JOIN withdrawals w ON w.withdrawal_id = wl.withdrawal_id
            WHERE w.status IN ('REQUESTED', 'APPROVED', 'PICKING', 'READY')
            GROUP BY wl.inventory_id
        ) o ON o.inventory_id = inv.inventory_id
        WHERE inv.lot_number LIKE '90%' AND inv.quantity_allocated <> COALESCE(o.qtd, 0)
        """,
    ),
    (
        "Nada some nem aparece: recebido = em estoque + entregue",
        """
        WITH rec AS (
            SELECT p.po_id, p.po_number, r.item_id, SUM(r.quantity_received) AS recebido
            FROM item_receipts r JOIN purchase_orders p ON p.po_id = r.po_id
            WHERE p.po_number LIKE '90%' GROUP BY 1, 2, 3
        ), est AS (
            SELECT lot_number, item_id, SUM(quantity_on_hand) AS estoque
            FROM inventory WHERE lot_number LIKE '90%' GROUP BY 1, 2
        ), ent AS (
            SELECT w.po_id, wl.item_id, SUM(wl.quantity) AS entregue
            FROM withdrawals w JOIN withdrawal_lines wl ON wl.withdrawal_id = w.withdrawal_id
            WHERE w.status = 'DELIVERED' GROUP BY 1, 2
        )
        SELECT rec.po_number, rec.item_id, rec.recebido, COALESCE(est.estoque, 0) AS estoque,
               COALESCE(ent.entregue, 0) AS entregue
        FROM rec
        LEFT JOIN est ON est.lot_number = rec.po_number AND est.item_id = rec.item_id
        LEFT JOIN ent ON ent.po_id = rec.po_id AND ent.item_id = rec.item_id
        WHERE rec.recebido <> COALESCE(est.estoque, 0) + COALESCE(ent.entregue, 0)
        """,
    ),
    (
        "Recebido na linha da OT = soma dos recebimentos",
        """
        SELECT l.po_line_id, l.quantity_received, COALESCE(SUM(r.quantity_received), 0) AS recibos
        FROM purchase_order_lines l JOIN purchase_orders p ON p.po_id = l.po_id
        LEFT JOIN item_receipts r ON r.po_line_id = l.po_line_id
        WHERE p.po_number LIKE '90%'
        GROUP BY l.po_line_id, l.quantity_received
        HAVING l.quantity_received <> COALESCE(SUM(r.quantity_received), 0)
        """,
    ),
    (
        "Nunca recebido além do previsto na OT",
        """
        SELECT l.po_line_id, l.quantity_ordered, l.quantity_received
        FROM purchase_order_lines l JOIN purchase_orders p ON p.po_id = l.po_id
        WHERE p.po_number LIKE '90%' AND l.quantity_received > l.quantity_ordered
        """,
    ),
    (
        "Uma OT da base do SAP vira um único cadastro",
        """
        SELECT po_number, COUNT(*) FROM purchase_orders
        WHERE po_number LIKE '90%' GROUP BY po_number HAVING COUNT(*) > 1
        """,
    ),
    (
        "Cada retirada entregue tem uma única entrega no log",
        """
        SELECT w.withdrawal_id, COUNT(a.log_id) AS registros
        FROM withdrawals w
        LEFT JOIN audit_log a ON a.action_type = 'WITHDRAWAL_DELIVERED'
                             AND a.entity_id = w.withdrawal_id
        WHERE w.status = 'DELIVERED'
        GROUP BY w.withdrawal_id HAVING COUNT(a.log_id) <> 1
        """,
    ),
    (
        "Retirada entregue tem data e quem recebeu",
        """
        SELECT withdrawal_id FROM withdrawals
        WHERE status = 'DELIVERED' AND (delivered_at IS NULL OR delivered_to_name IS NULL)
        """,
    ),
    (
        "Corrente de hashes do log de auditoria íntegra",
        "SELECT verify_audit_log_chain() AS primeira_quebra "
        "WHERE verify_audit_log_chain() IS NOT NULL",
    ),
]


def conferir(db) -> list[dict]:
    resultado = []
    for nome, sql in REGRAS:
        linhas = db.execute(text(sql)).fetchall()
        resultado.append(
            {
                "regra": nome,
                "violacoes": len(linhas),
                "exemplos": [dict(r._mapping) for r in linhas[:5]],
            }
        )
    return resultado


def resumo_do_banco(db) -> dict:
    """Tamanho do que a simulação deixou no banco."""
    consultas = {
        "materiais na base do SAP": "SELECT COUNT(*) FROM sap_materials",
        "ordens na base do SAP": "SELECT COUNT(*) FROM sap_orders",
        "linhas de OT na base do SAP": "SELECT COUNT(*) FROM sap_reservation_items",
        "OTs cadastradas no SEA": "SELECT COUNT(*) FROM purchase_orders WHERE po_number LIKE '90%'",
        "recebimentos": "SELECT COUNT(*) FROM item_receipts",
        "linhas de estoque com saldo": "SELECT COUNT(*) FROM inventory WHERE quantity_on_hand > 0",
        "retiradas": "SELECT COUNT(*) FROM withdrawals",
        "retiradas entregues": "SELECT COUNT(*) FROM withdrawals WHERE status = 'DELIVERED'",
        "notificações": "SELECT COUNT(*) FROM sea_notifications",
        "registros no log de auditoria": "SELECT COUNT(*) FROM audit_log",
        "sessões abertas": "SELECT COUNT(*) FROM sea_sessions",
    }
    return {nome: db.execute(text(sql)).scalar() for nome, sql in consultas.items()}
