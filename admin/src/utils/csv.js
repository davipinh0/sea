// Uma célula de CSV. Texto que começa com =, +, -, @, tab ou retorno vira fórmula no Excel e no
// LibreOffice (nome de material vindo de importação, por exemplo): ganha um apóstrofo na frente e
// sai entre aspas. O resto só vai entre aspas quando precisa.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  if (FORMULA_START.test(s)) return `"'${s.replace(/"/g, '""')}"`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
