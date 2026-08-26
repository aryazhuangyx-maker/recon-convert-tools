// quantity.js — app.py _normalize_quantity / _raw_number_tokens 直译
let QTY_NORM = { round_decimals: 4 };
export function setQuantityNorm(cfg) { if (cfg) QTY_NORM = { ...QTY_NORM, ...cfg }; }
export function normalizeQuantity(raw) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    const r = Math.round(raw * 10 ** QTY_NORM.round_decimals) / 10 ** QTY_NORM.round_decimals;
    return Number.isInteger(r) ? r : r;
  }
  let s = String(raw).trim();
  if (!s) return raw;
  s = s.replace(/([.,，])\s+/g, '$1');
  s = s.replace(/，/g, ',');
  s = s.replace(/(\d{1,3}),(\d{4})\b/g, (m, intp, frac) => {
    if (frac.length === 4 && parseFloat(intp) < 1000) return intp + '.' + frac;
    return m;
  });
  s = s.replace(/,/g, '');
  s = s.replace(/\s+/g, '');
  const v = parseFloat(s);
  if (Number.isNaN(v)) return raw;
  const rounded = Math.round(v * 10 ** QTY_NORM.round_decimals) / 10 ** QTY_NORM.round_decimals;
  return Number.isInteger(rounded) ? rounded : rounded;
}
export function rawNumberTokens(text) {
  if (!text) return [];
  return text.match(/\d{1,3}(?:[，,]\d{1,4})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || [];
}
