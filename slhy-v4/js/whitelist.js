// whitelist.js — app.py 白名单约束式提取 直译
import { normalizeProductName, toSimp } from './mapping.js?v=20260826q';
import { normalizeQuantity, setQuantityNorm } from './quantity.js?v=20260826q';
let WHITELIST = {};
let PRODUCT_ALIAS_INDEX = {};
let UNIT_VALID = new Set();
let UNIT_CONFUSION = {};
const UNIT_TRAD = { '噸': '吨', '個': '个', '隻': '只', '圓': '元' };
export function loadWhitelist(data) {
  WHITELIST = data || {};
  PRODUCT_ALIAS_INDEX = {};
  const products = WHITELIST.products || {};
  for (const canon in products) {
    const info = products[canon] || {};
    const aliases = new Set([canon, ...(info.aliases || [])]);
    for (const a of aliases) {
      const k = normAlias(a);
      if (!(k in PRODUCT_ALIAS_INDEX)) PRODUCT_ALIAS_INDEX[k] = canon;
    }
  }
  const units = WHITELIST.units || {};
  UNIT_VALID = new Set(units.valid || []);
  for (const valid of Object.keys(units.ocr_confusion || {})) UNIT_VALID.add(valid);
  UNIT_CONFUSION = {};
  for (const valid in (units.ocr_confusion || {})) {
    for (const c of units.ocr_confusion[valid]) UNIT_CONFUSION[c] = valid;
  }
  setQuantityNorm(WHITELIST.quantity_normalize || {});
  return WHITELIST;
}
export function normAlias(a) {
  a = (a || '').trim();
  a = toSimp(a);
  return a.replace(/\s+/g, '').toLowerCase();
}
export function matchProductName(raw) {
  if (!raw) return [raw, false];
  const key = normAlias(raw);
  if (key in PRODUCT_ALIAS_INDEX) return [PRODUCT_ALIAS_INDEX[key], true];
  const norm = normalizeProductName(raw);
  return [norm, norm !== raw];
}
export function inferUnitFromLine(line) {
  if (!line) return '';
  for (const u of ['吨', '噸', '米', '支', '件', '公斤', '千克', '卷', '捆', '盘', '个', '箱', '套']) {
    if (line.includes(u)) return u;
  }
  return '';
}
export function correctUnit(raw) {
  if (!raw) return [raw, false, false];
  let s = [...String(raw).trim()].map((ch) => UNIT_TRAD[ch] || ch).join('');
  if (UNIT_VALID.has(s)) return [s, s !== String(raw).trim(), true];
  for (const c in UNIT_CONFUSION) {
    if (c && s.includes(c)) {
      const fixed = s.replaceAll(c, UNIT_CONFUSION[c]);
      if (UNIT_VALID.has(fixed)) return [fixed, true, true];
    }
  }
  for (const ch of s) {
    if (UNIT_VALID.has(ch)) return [ch, ch !== s, true];
    if (ch in UNIT_CONFUSION) return [UNIT_CONFUSION[ch], true, true];
  }
  return [s, false, false];
}
export function applyWhitelistConstraints(products, sourceText = '') {
  const review = [];
  for (let idx = 0; idx < products.length; idx++) {
    const p = products[idx];
    if (p._missed) {
      review.push({ row: idx, field: '货物名称', value: String(p['规格原文'] || '').slice(0, 30), reason: 'OCR 未识别出规格/数量，请手工补充' });
      continue;
    }
    const rawName = p['货物名称'] || '';
    const [name, inWl] = matchProductName(rawName);
    if (name !== rawName) p['货物名称'] = name;
    if (rawName && !inWl) review.push({ row: idx, field: '货物名称', value: rawName, reason: '不在白名单，已按别名归一并标记复核' });
    const rawUnit = p['单位'] || '';
    const [unit, corrected, unitInWl] = correctUnit(rawUnit);
    if (unit !== rawUnit) p['单位'] = unit;
    if (rawUnit && !unitInWl) review.push({ row: idx, field: '单位', value: rawUnit, reason: '不在白名单合法单位，请核对' });
    p['数量'] = normalizeQuantity(p['数量'] ?? 0);
  }
  return review;
}
export { WHITELIST };
export function getAliasIndex() { return PRODUCT_ALIAS_INDEX; }
