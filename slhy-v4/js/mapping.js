// mapping.js — product_mapping.py 直译
export { toSimp };
function toSimp(s) {
  return [...s].map((c) => TRAD_TO_SIMP[c] || c).join('');
}
const TRAD_TO_SIMP = {
  '熱': '热', '軋': '轧', '螺': '螺', '紋': '纹', '鋼': '钢', '筋': '筋', '帶': '带',
  '肋': '肋', '號': '号', '碼': '码', '發': '发', '票': '票', '單': '单', '據': '据',
  '門': '门', '廠': '厂', '場': '场', '廣': '广', '臺': '台', '灣': '湾', '爲': '为',
  '準': '准', '確': '确', '資': '资', '訊': '讯', '網': '网', '線': '线',
};
function buildNameMap() {
  const canonical = '热轧带肋钢筋';
  const aliases = [
    '盘螺', '螺纹钢', '热轧带肋钢筋', '直条螺纹钢', '直条螺纹钢500b',
    '热轧螺纹钢筋', '熱軋螺紋鋼筋', '熱軋螺紋鋼', '热轧螺纹钢', '热扎带肋钢筋',
    '500b螺纹钢', '500b 螺纹钢', '500B螺纹钢', '500B 螺纹钢',
    '螺纹钢500b', '螺纹钢 500b', 'steel rebar', 'rebar',
  ];
  const map = {};
  for (const a of aliases) map[a.toLowerCase().replace(/ /g, '').replace(/\u3000/g, '')] = canonical;
  return { map, canonical };
}
const { map: NAME_MAP, canonical: CANONICAL_NAME } = buildNameMap();
const DIAMETER_CANON = 'Φ';
const DIAMETER_SYMBOL_RE = /(?<![A-Za-z])[Tt](?=\d)/g;
const DIAMETER_OTHER = ['φ', '⊕', '∅', 'ⵟ'];
export function normalizeDiameterSymbol(spec) {
  if (!spec) return spec;
  let s = String(spec);
  s = s.replace(DIAMETER_SYMBOL_RE, DIAMETER_CANON);
  for (const sym of DIAMETER_OTHER) s = s.replaceAll(sym, DIAMETER_CANON);
  return s;
}
export function normalizeProductName(name) {
  if (!name) return '';
  name = String(name).trim();
  name = name.replace(/^\*[^*]+\*/, '');
  name = toSimp(name);
  const norm = name.toLowerCase().replace(/ /g, '').replace(/\u3000/g, '');
  if (norm in NAME_MAP) return NAME_MAP[norm];
  for (const alias in NAME_MAP) {
    if (norm.includes(alias) || alias.includes(norm)) return NAME_MAP[alias];
  }
  if ((norm.includes('螺纹') && norm.includes('钢')) ||
      (norm.includes('带肋') && norm.includes('钢')) ||
      norm.includes('盘螺')) return CANONICAL_NAME;
  return name;
}
export function parseSpec(spec) {
  if (!spec) return null;
  spec = normalizeDiameterSymbol(String(spec).trim());
  const result = { diameters: [], lengths: [], is_range: false, min: null, max: null };
  const rangeMatch = spec.match(/(\d+)\s*[-~—]\s*(\d+)\s*(?:mm)?/i);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    const after = spec.slice(rangeMatch.index + rangeMatch[0].length).trim();
    if (after.startsWith('M') || after.startsWith('m')) { /* 直径-长度 */ }
    else if (lo <= hi) { result.is_range = true; result.min = lo; result.max = hi; return result; }
  }
  for (const m of spec.matchAll(/[YTφΦ](\d{1,2})(?:\s*(?:mm)?)?/gi)) {
    const d = parseInt(m[1], 10);
    if (6 <= d && d <= 100 && !result.diameters.includes(d)) result.diameters.push(d);
  }
  for (const m of spec.matchAll(/(\d{1,2})\s*(?:mm|MM)/g)) {
    const d = parseInt(m[1], 10);
    if (6 <= d && d <= 100 && !result.diameters.includes(d)) result.diameters.push(d);
  }
  if (result.diameters.length === 0 && !result.is_range) {
    for (const m of spec.matchAll(/\b(\d{1,2})\b/g)) {
      const d = parseInt(m[1], 10);
      if (6 <= d && d <= 100) {
        const idx = spec.indexOf(m[1]);
        const after = spec.slice(idx + m[1].length).trim();
        if (after && ['M', '米'].includes(after[0].toUpperCase())) continue;
        if (!result.diameters.includes(d)) result.diameters.push(d);
      }
    }
  }
  for (const m of spec.matchAll(/[×xX\-\s](\d{1,2})\s*(?:[mM]|米)/g)) {
    const l = parseInt(m[1], 10);
    if (6 <= l && l <= 15 && !result.lengths.includes(l)) result.lengths.push(l);
  }
  if (result.diameters.length > 0 || result.is_range) return result;
  return null;
}
function diametersInRange(diameters, lo, hi) { return diameters.some((d) => lo <= d && d <= hi); }
function rangesOverlap(lo1, hi1, lo2, hi2) { return lo1 <= hi2 && lo2 <= hi1; }
function specContainsParsed(text, parsed) {
  const t = text.toLowerCase().replace(/ /g, '');
  if (parsed.is_range) {
    const nums = t.match(/\d{1,2}/g) || [];
    for (const n of nums) { const d = parseInt(n, 10); if (6 <= d && d <= 100 && parsed.min <= d && d <= parsed.max) return true; }
    return false;
  }
  if (parsed.diameters.length) {
    for (const dia of parsed.diameters) { if (t.includes(String(dia))) return true; if (t.includes(dia + 'mm')) return true; }
    return false;
  }
  return false;
}
const CABLE_COLOR_RE = /(棕色|蓝色|黄绿双色|黄绿|双色|黑色|红色|绿色|黄色|白色|灰色|橙色|紫色|各色)/;
const CABLE_CROSS_RE = /(?:(\d+(?:\.\d+)?)\s*[×xX])?\s*(\d+(?:\.\d+)?)\s*(?:mm[²2]|m[²2]|平方毫米|平方)/;
const CABLE_YCODE_RE = /[Yy](\d{1,3})(?!\d)/;
export function isCableSpec(spec) {
  if (!spec) return false;
  const s = String(spec);
  if (/mm[²2]|m[²2]|平方毫米|平方/i.test(s)) return true;
  if (CABLE_COLOR_RE.test(s)) return true;
  if (/\d+\s*m\/卷/i.test(s)) return true;
  if (/(电线|电缆|线缆|导线)/.test(s)) return true;
  return false;
}
export function parseCableSpec(spec) {
  if (!isCableSpec(spec)) return null;
  const s = String(spec);
  const result = { cross_section: null, color: null, length_per_roll: null };
  const m = s.match(CABLE_CROSS_RE);
  if (m) { const cross = m[2] || m[1]; if (cross) result.cross_section = parseFloat(cross); }
  if (result.cross_section === null) { const ym = s.match(CABLE_YCODE_RE); if (ym) result.cross_section = parseFloat(ym[1]); }
  const cm = s.match(CABLE_COLOR_RE);
  if (cm) result.color = cm[1];
  const lm = s.match(/(\d+)\s*m\/卷/i);
  if (lm) result.length_per_roll = parseInt(lm[1], 10);
  if (result.cross_section !== null || result.color !== null) return result;
  return null;
}
function cableColors(spec) { return String(spec).match(new RegExp(CABLE_COLOR_RE.source, 'g')) || []; }
function hasColorSlash(spec) { return String(spec).replace(/\d+\s*[mM]\/卷/g, '').includes('/'); }
function gFormat(n) { return Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(6))); }
function cableContainsParsed(text, parsed) {
  const t = text.toLowerCase().replace(/ /g, '').replace(/\u3000/g, '');
  if (parsed.cross_section !== null) { const cs = gFormat(parsed.cross_section); if (t.includes(cs) || t.includes(cs + 'mm') || t.includes(cs + '平方')) return true; }
  if (parsed.color) return t.includes(parsed.color);
  return false;
}
function cableSpecsMatch(a, b) {
  const pa = parseCableSpec(a), pb = parseCableSpec(b);
  if (pa === null && pb === null) return a.replace(/ /g, '').replace(/\u3000/g, '') === b.replace(/ /g, '').replace(/\u3000/g, '');
  if (pa === null) return cableContainsParsed(a, pb);
  if (pb === null) return cableContainsParsed(b, pa);
  if (pa.cross_section !== null && pb.cross_section !== null && Math.abs(pa.cross_section - pb.cross_section) > 0.001) return false;
  const ca = cableColors(a), cb = cableColors(b);
  const multiA = hasColorSlash(a) || ca.length > 1, multiB = hasColorSlash(b) || cb.length > 1;
  if (!(multiA || multiB) && ca.length && cb.length && ca[0] !== cb[0]) return false;
  if (pa.length_per_roll && pb.length_per_roll && Math.abs(pa.length_per_roll - pb.length_per_roll) > 5) return false;
  return true;
}
export function specsMatch(specA, specB) {
  if (!specA || !specB) return false;
  const a = String(specA).trim(), b = String(specB).trim();
  if (a.toLowerCase() === b.toLowerCase()) return true;
  if (isCableSpec(a) || isCableSpec(b)) return cableSpecsMatch(a, b);
  const COIL_KW = ['盘螺', '盤螺', '热轧螺纹钢筋'];
  const aCoil = COIL_KW.some((k) => a.includes(k)), bCoil = COIL_KW.some((k) => b.includes(k));
  if (aCoil && bCoil) return true;
  if (aCoil || bCoil) {
    const other = aCoil ? b : a;
    const po = parseSpec(other);
    if (po && po.diameters.length && po.diameters.some((d) => d <= 12)) return true;
  }
  const pa = parseSpec(a), pb = parseSpec(b);
  if (pa === null && pb === null) {
    const an = a.toLowerCase().replace(/ /g, '').replace(/\u3000/g, '');
    const bn = b.toLowerCase().replace(/ /g, '').replace(/\u3000/g, '');
    // ⚠️ 灯具/照明/电池规格：要求精确匹配（避免"应急电源"匹配到"应急电源（洗手间）"）
    if (/照明|灯具|LED|电池|Battery/i.test(an) || /照明|灯具|LED|电池|Battery/i.test(bn)) {
      // 去掉前导 * 号再比较（台账中"照明装置*xxx"vs 送货单中"*照明装置*xxx"）
      const anClean = an.replace(/^\*+/, '');
      const bnClean = bn.replace(/^\*+/, '');
      return anClean === bnClean;
    }
    return an === bn || an.includes(bn) || bn.includes(an);
  }
  if (pa === null) return specContainsParsed(a, pb);
  if (pb === null) return specContainsParsed(b, pa);
  if (pa.is_range && pb.is_range) return rangesOverlap(pa.min, pa.max, pb.min, pb.max);
  if (pa.is_range && pb.diameters.length) return diametersInRange(pb.diameters, pa.min, pa.max);
  if (pb.is_range && pa.diameters.length) return diametersInRange(pa.diameters, pb.min, pb.max);
  if (pa.diameters.length && pb.diameters.length) {
    if (!pa.diameters.some((d) => pb.diameters.includes(d))) return false;
    if (pa.lengths.length && pb.lengths.length && !pa.lengths.some((l) => pb.lengths.includes(l))) return false;
    return true;
  }
  return false;
}
export function productsMatch(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const na = normalizeProductName(nameA), nb = normalizeProductName(nameB);
  return !!(na && nb && na === nb);
}
export const MATERIAL_SPEC_MAP = {
  'AA0300': { spec: '8mm', diameter: 8, type: '盘螺', price_range: [3800, 4000] },
  'AA0302': { spec: 'Y12', diameter: 12, type: '螺纹钢', price_range: [3600, 3800] },
  'AA0303': { spec: 'Y16', diameter: 16, type: '螺纹钢', price_range: [3600, 3800] },
  'AA0304': { spec: 'Y20', diameter: 20, type: '螺纹钢', price_range: [3600, 3800] },
  'AA0305': { spec: 'Y25', diameter: 25, type: '螺纹钢', price_range: [3600, 3900] },
  'AA0306': { spec: 'Y32', diameter: 32, type: '螺纹钢', price_range: [3600, 3800] },
  'AA0307': { spec: 'Y40', diameter: 40, type: '螺纹钢', price_range: [3800, 4000] },
  'AA0301': { spec: 'Y10', diameter: 10, type: '螺纹钢', price_range: [3800, 4000] },
};
export const KNOWN_SPECS = [
  '8mm', '10mm', 'Y10', 'Y12', 'Y16', 'Y20', 'Y25', 'Y32', 'Y40',
  '500B 8mm', '500B 10mm', '500B 12-40mm',
  'T10', 'T12', 'T16', 'T20', 'T25', 'T32', 'T40',
  'T10-12M', 'T12-12M', 'T16-12M', 'T20-12M', 'T25-12M', 'T32-12M', 'T40-12M',
  '12mm', '16mm', '20mm', '25mm', '32mm', '40mm',
  'T12mm×12M/500B', 'T16mm×12M/500B', 'T20mm×12M/500B',
  'T25mm×12M/500B', 'T32mm×12M/500B', 'T40mm×12M/500B',
];
const COMMON_DIAMETERS = [8, 10, 12, 16, 20, 25, 32, 40];
const OCR_CORRECTION_SINGLE = { 2: 12, 3: 13, 4: 14, 5: 25, 6: 16, 0: 20, 1: 12, 7: 17, 8: 8, 9: 19 };
const OCR_CORRECTION_MM = { 2: 12, 3: 13, 4: 14, 5: 25, 6: 16, 0: 20, 1: 12, 7: 17 };
export function fuzzyMatchSpec(ocrSpec) {
  if (!ocrSpec) return '';
  let specClean = String(ocrSpec).trim().replace(/ /g, '');
  specClean = normalizeDiameterSymbol(specClean);
  if (isCableSpec(specClean)) return String(ocrSpec).trim();
  // 灯具/照明规格：包含 *照明装置*、LED、灯具、电池 等关键词，直接返回原值
  // （否则 L10-IP20 中的 10/20 会被误判为钢筋直径，输出 Y10）
  if (/[*]|照明装置|照明|灯具|LED|电池|Battery/i.test(String(ocrSpec))) return String(ocrSpec).trim();
  specClean = specClean.replace(/[Oo]/g, '0');
  specClean = specClean.replace(/(?<=[YTyt])[Il](?=\d)/g, '1');
  specClean = specClean.replace(/(?<=[YTyt])[Ss](?=\d)/g, '5');
  specClean = specClean.replace(/(?<=[YTyt])[M](?=\d)/g, '4');
  specClean = specClean.replace(/(\d)[Oo]mm/g, '$10mm');
  if (/^500\s*[Bb]/.test(specClean) || specClean.includes('盘螺')) return String(ocrSpec).trim();
  for (const known of KNOWN_SPECS) {
    if (specClean.toUpperCase() === known.toUpperCase().replace(/ /g, '')) { specClean = known.replace(/ /g, ''); break; }
  }
  const diameters = [];
  const allSmallNums = [...specClean.matchAll(/(\d{1,2})/g)].map((m) => parseInt(m[1], 10));
  for (const m of specClean.matchAll(/[YTyt](\d{1,2})/g)) {
    let d = parseInt(m[1], 10);
    const nearby = allSmallNums.filter((n) => n !== d && 6 <= n && n <= 50);
    if (d < 10) {
      let corrected = false;
      for (const n of nearby) { if (n % 10 === d && COMMON_DIAMETERS.includes(n)) { d = n; corrected = true; break; } }
      if (!corrected && d in OCR_CORRECTION_SINGLE) d = OCR_CORRECTION_SINGLE[d];
    }
    if (8 <= d && d <= 50) diameters.push(d);
  }
  for (const m of specClean.matchAll(/(\d{1,2})\s*mm/gi)) {
    let d = parseInt(m[1], 10);
    if (d < 8 && d in OCR_CORRECTION_MM) d = OCR_CORRECTION_MM[d];
    if (8 <= d && d <= 50 && !diameters.includes(d)) diameters.push(d);
  }
  for (const n of allSmallNums) {
    if (COMMON_DIAMETERS.includes(n) && !diameters.includes(n)) {
      const idx = specClean.indexOf(String(n));
      const after = specClean.slice(idx + String(n).length).trim().slice(0, 1).toUpperCase();
      if (['M', '米', 'X', '*'].includes(after)) continue;
      diameters.push(n);
    }
  }
  const lengths = [];
  for (const m of specClean.matchAll(/[×xX\-\s](\d{1,2})\s*(?:[mM]|米)/g)) {
    const l = parseInt(m[1], 10);
    if (6 <= l && l <= 15 && !lengths.includes(l)) lengths.push(l);
  }
  if (diameters.length) {
    let d = diameters[0];
    for (const dia of diameters) { if (COMMON_DIAMETERS.includes(dia)) { d = dia; break; } }
    if (lengths.length) return 'T' + d + '-' + lengths[0] + 'M';
    if (/^\d{1,2}mm$/i.test(specClean)) return d + 'mm';
    const target = 'Y' + d;
    for (const known of KNOWN_SPECS) { if (known.toUpperCase() === target.toUpperCase()) return known; }
    return 'Y' + d;
  }
  return ocrSpec;
}
export const QTY_MIN = 10, QTY_MAX = 500;
export const UNIT_PRICE_MIN = 3000, UNIT_PRICE_MAX = 5000;
export function isLikelyQuantity(v) { return QTY_MIN <= v && v <= QTY_MAX; }
export function isLikelyUnitPrice(v) { return UNIT_PRICE_MIN <= v && v <= UNIT_PRICE_MAX; }
