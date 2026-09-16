// garble.js — app.py 错字词典 直译（清洗版：不含公司名条目）
import { normalizeDiameterSymbol } from './mapping.js?v=20260915e';
const GARBLE_FIX_BASE = {
  '敷量': '數量', '聊络': '聯絡', '料怯': '科技', '覃位': '單位',
  '收货覃位': '收货單位', '客户聊络人': '客户聯絡人',
  '料怯直限': '科技有限公司', '直限': '有限',
};
const GARBLE_REGEX = [[/mm\*(\d+)/g, 'mm×$1']];
let GARBLE_FIX = { ...GARBLE_FIX_BASE };
export function loadGarbleFix(userData) {
  const d = { ...GARBLE_FIX_BASE };
  if (userData && typeof userData === 'object') Object.assign(d, userData);
  GARBLE_FIX = d;
  return d;
}
export function getGarbleFix() { return GARBLE_FIX; }
export function learnGarbleFixes(pairs) {
  if (!pairs || !pairs.length) return false;
  let changed = false;
  for (const [bad, good] of pairs) {
    if (!bad || !good || bad === good) continue;
    if (bad in GARBLE_FIX) continue;
    GARBLE_FIX[bad] = good;
    changed = true;
  }
  return changed;
}
function spaceInsensitiveReplace(text, bad, good) {
  const nb = bad.replace(/\s+/g, '');
  if (!nb) return text;
  let out = text;
  let start = 0;
  for (;;) {
    const norm = out.replace(/\s+/g, '');
    const nidx = norm.indexOf(nb, start);
    if (nidx === -1) break;
    const nend = nidx + nb.length;
    const origForNorm = [];
    for (let i = 0; i < out.length; i++) { if (!/\s/.test(out[i])) origForNorm.push(i); }
    if (nend > origForNorm.length) break;
    const oStart = origForNorm[nidx];
    const oEnd = origForNorm[nend - 1];
    out = out.slice(0, oStart) + good + out.slice(oEnd + 1);
    start = nidx + good.replace(/\s+/g, '').length;
  }
  return out;
}
export function applyGarbleFix(text) {
  for (const bad in GARBLE_FIX) text = spaceInsensitiveReplace(text, bad, GARBLE_FIX[bad]);
  for (const [rx, repl] of GARBLE_REGEX) text = text.replace(rx, repl);
  return normalizeDiameterSymbol(text);
}
