"""Interpretation of the receiving label that travels with each material.

Pure text -> structured data: no database, no HTTP. The input is the
text printed on the label (typed, pasted, or produced by any future
reader); the output separates it into the receipt header (OT, reserva,
ordem de serviço, logistics, people) and the material (code,
description, quantity, unit, lot, expiry).

Rules, straight from the operation:
  * nothing is guessed: a field that is missing or unreadable stays
    ``None`` and is listed in ``pending`` for the operator to fill in;
  * nothing is thrown away silently: text that matches no known field
    goes to ``unrecognized`` so it can be reviewed;
  * print information (who printed, when) is not operational data and is
    dropped;
  * identifiers are kept as text, so leading zeros survive;
  * OT, reserva and ordem de serviço are three different identifiers.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

SERVICE_ORDER_TYPES = ("PM11", "PM12")

HEADER_FIELDS = (
    "ot_code",
    "barcode",
    "origin_company",
    "label_date",
    "reservation_number",
    "needed_date",
    "department",
    "pickup_location",
    "unload_location",
    "requester_name",
    "receiver_name",
    "service_order_type",
    "service_order_number",
)
MATERIAL_FIELDS = (
    "material_code",
    "description",
    "quantity",
    "uom",
    "lot_number",
    "expiry_date",
)
# Optional by nature: their absence is not something to chase.
_NEVER_PENDING = {"barcode", "expiry_date"}

_IGNORE = "_ignore"
_SERVICE_ORDER = "_service_order"

# Label caption (accents and case already folded) -> field.
_CAPTIONS: dict[str, str] = {
    "empresa": "origin_company",
    "empresa de origem": "origin_company",
    "data": "label_date",
    "data da etiqueta": "label_date",
    "data necessaria": "needed_date",
    "data de necessidade": "needed_date",
    "ot": "ot_code",
    "codigo da ot": "ot_code",
    "ordem de transferencia": "ot_code",
    "codigo de barras": "barcode",
    "reserva": "reservation_number",
    "numero da reserva": "reservation_number",
    "codigo": "material_code",
    "codigo do material": "material_code",
    "descricao": "description",
    "descricao do material": "description",
    "quantidade": "quantity",
    "qtd": "quantity",
    "qtde": "quantity",
    "unidade": "uom",
    "unidade de medida": "uom",
    "um": "uom",
    "lote": "lot_number",
    "numero do lote": "lot_number",
    "vencimento": "expiry_date",
    "data de vencimento": "expiry_date",
    "validade": "expiry_date",
    "departamento": "department",
    "depto": "department",
    "local de retirada": "pickup_location",
    "local de descarga": "unload_location",
    "solicitante": "requester_name",
    "recebedor": "receiver_name",
    "ordem de servico": _SERVICE_ORDER,
    "ordem": _SERVICE_ORDER,
    # Print information: not operational data.
    "impresso por": _IGNORE,
    "impresso em": _IGNORE,
    "impressao": _IGNORE,
    "data de impressao": _IGNORE,
    "hora de impressao": _IGNORE,
    "usuario": _IGNORE,
    "usuario de impressao": _IGNORE,
    "hora": _IGNORE,
    "horario": _IGNORE,
    "anotacao": _IGNORE,
}

# Section titles of the label: structure, not data.
_HEADINGS = {
    "dados gerais",
    "material",
    "materiais",
    "logistica",
    "solicitacao",
    "identificacao",
}

_NOT_INFORMED = {"", "-", "--", "n/a", "na", "nao informado", "nao informada", "nao aplicavel"}

_CAPTION_RE = re.compile(
    r"(?<![a-z0-9])("
    + "|".join(
        re.escape(c).replace(r"\ ", r"\s+")
        for c in sorted(_CAPTIONS, key=len, reverse=True)
    )
    + r")\s*[:=]\s*"
)
_DATE_FORMATS = ("%d/%m/%Y", "%d.%m.%Y", "%d-%m-%Y", "%Y-%m-%d")
_QUANTITY_RE = re.compile(r"^([\d.,]+)\s*([A-Za-z]{1,6})?$")
_SERVICE_ORDER_RE = re.compile(r"^(PM\s?\d{2})\s*[-–—:/]?\s*(.*)$", re.IGNORECASE)
_BARE_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


@dataclass
class ParsedLabel:
    header: dict[str, object] = field(default_factory=lambda: dict.fromkeys(HEADER_FIELDS))
    material: dict[str, object] = field(default_factory=lambda: dict.fromkeys(MATERIAL_FIELDS))
    pending: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    unrecognized: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "header": self.header,
            "materials": [self.material],
            "pending": self.pending,
            "warnings": self.warnings,
            "unrecognized": self.unrecognized,
        }


def _fold(text: str) -> str:
    """Lower-case, accent-free copy of ``text`` with the same length, so
    match positions on the folded string index the original one."""
    out = []
    for ch in text:
        base = "".join(
            c for c in unicodedata.normalize("NFD", ch) if not unicodedata.combining(c)
        ).lower()
        out.append(base if len(base) == 1 else "?")
    return "".join(out)


def _clean(value: str) -> str | None:
    value = " ".join(value.split()).strip(" |;")
    return None if _fold(value) in _NOT_INFORMED else value


def parse_date(value: str) -> date | None:
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value.strip(), fmt).date()
        except ValueError:
            continue
    return None


def parse_quantity(value: str) -> tuple[int | None, str | None, str | None]:
    """Return (quantity, unit, problem). Brazilian number format: '.' is
    the thousands separator and ',' the decimal one."""
    match = _QUANTITY_RE.match(value.strip())
    if not match:
        return None, None, f"Quantidade não reconhecida: {value!r}."
    number, unit = match.group(1), match.group(2)
    if "," in number:
        number = number.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", number):
        number = number.replace(".", "")
    try:
        quantity = Decimal(number)
    except InvalidOperation:
        return None, unit, f"Quantidade não reconhecida: {value!r}."
    if quantity != quantity.to_integral_value():
        return None, unit, (
            f"Quantidade fracionada ({value.strip()}): o SEA controla quantidades inteiras. "
            "Confirme a quantidade manualmente."
        )
    if quantity <= 0:
        return None, unit, f"Quantidade deve ser maior que zero: {value!r}."
    return int(quantity), unit, None


def parse_service_order(value: str) -> tuple[str | None, str | None, str | None]:
    """Split 'PM12 – 2005113840' into (type, number, problem)."""
    match = _SERVICE_ORDER_RE.match(value.strip())
    if not match:
        return None, value.strip() or None, (
            "Tipo da ordem de serviço (PM11 ou PM12) não identificado."
        )
    order_type = match.group(1).upper().replace(" ", "")
    number = match.group(2).strip() or None
    if order_type not in SERVICE_ORDER_TYPES:
        return None, number, (
            f"Tipo de ordem de serviço desconhecido: {order_type}. Esperado PM11 ou PM12."
        )
    return order_type, number, None


def parse_label(text: str) -> ParsedLabel:
    result = ParsedLabel()
    raw: dict[str, str] = {}

    lines = [ln.strip() for ln in unicodedata.normalize("NFC", text or "").splitlines()]
    lines = [ln for ln in lines if ln]

    # A bare code (what the barcode reader types) is the OT itself.
    if len(lines) == 1 and _BARE_CODE_RE.match(lines[0]):
        result.header["ot_code"] = lines[0]
        result.header["barcode"] = lines[0]
        lines = []

    for line in lines:
        folded = _fold(line)
        matches = list(_CAPTION_RE.finditer(folded))
        if not matches:
            if folded.strip(" :#*-") not in _HEADINGS:
                result.unrecognized.append(line)
            continue
        leading = line[: matches[0].start()].strip(" |;#*-")
        if leading:
            result.unrecognized.append(leading)
        for i, match in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
            key = _CAPTIONS[" ".join(match.group(1).split())]
            value = _clean(line[match.end():end])
            if key == _IGNORE or value is None:
                continue
            if key in raw and raw[key] != value:
                result.warnings.append(
                    f"Campo repetido na etiqueta com valores diferentes "
                    f"({raw[key]!r} e {value!r}); mantido o primeiro."
                )
                continue
            raw[key] = value

    for key in ("ot_code", "barcode", "origin_company", "reservation_number", "department",
                "pickup_location", "unload_location", "requester_name", "receiver_name"):
        if key in raw:
            result.header[key] = raw[key]
    for key in ("material_code", "description", "lot_number"):
        if key in raw:
            result.material[key] = raw[key]
    if "uom" in raw:
        result.material["uom"] = raw["uom"].upper()

    for key, target in (("label_date", result.header), ("needed_date", result.header),
                        ("expiry_date", result.material)):
        if key in raw:
            parsed = parse_date(raw[key])
            if parsed is None:
                result.warnings.append(f"Data não reconhecida: {raw[key]!r}.")
            else:
                target[key] = parsed.isoformat()

    if "quantity" in raw:
        quantity, unit, problem = parse_quantity(raw["quantity"])
        result.material["quantity"] = quantity
        if unit and not result.material["uom"]:
            result.material["uom"] = unit.upper()
        if problem:
            result.warnings.append(problem)

    if _SERVICE_ORDER in raw:
        order_type, number, problem = parse_service_order(raw[_SERVICE_ORDER])
        result.header["service_order_type"] = order_type
        result.header["service_order_number"] = number
        if problem:
            result.warnings.append(problem)

    result.pending = [
        key
        for source in (result.header, result.material)
        for key, value in source.items()
        if value is None and key not in _NEVER_PENDING
    ]
    return result
