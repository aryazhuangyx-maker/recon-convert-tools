// contract-no.js — app.py _extract_contract_no / _norm_contract_no / _fuzzy_contract_no_match 直译
import { toSimp } from './mapping.js?v=20260826q';
export function extractContractNo(text) {
  if (!text) return [];
  const norm = text.replace(/ /g, '').replace(/\u3000/g, '');
  const found = [];
  const KW = [['客户合约编号', 0], ['客户合約編號', 0],
              ['合约编号', 1], ['合約編號', 1], ['合同编号', 1],
              ['合约号', 2], ['合納編號', 2], ['合纳编号', 2]];
  const kwUnique = [];
  for (const item of KW) { if (!kwUnique.some((x) => x[0] === item[0])) kwUnique.push(item); }
  kwUnique.sort((a, b) => (b[0].length - a[0].length) || (a[1] - b[1]));
  for (const [kw, pri] of kwUnique) {
    let idx = norm.indexOf(kw);
    while (idx >= 0) {
      let rest = norm.slice(idx + kw.length, idx + kw.length + 60);
      rest = rest.replace(/^[^\w\u4e00-\u9fff]+/, '');
      const m = rest.match(/[\w\u4e00-\u9fff\[\]\(\)\-\/\._]{3,60}/);
      if (m) {
        const v = m[0].replace(/[，,.;； ]+$/, '');
        if (v && v.length >= 3 && !/^\d+$/.test(v) && /\d/.test(v)) found.push([pri, v]);
      }
      idx = norm.indexOf(kw, idx + 1);
    }
  }
  const regexes = [
    [1, /WZ\[\d{4}\][\u4e00-\u9fff\-\u2010]*\d+(?:-\d+)*/g],
    [1, /JMHL-SC\(\d{2}\)-\d+/g],
    [1, /S\/GAB\/\S+/g],
    [1, /P\/GAB\/\S+/g],
  ];
  for (const [pri, re] of regexes) {
    let m;
    while ((m = re.exec(norm)) !== null) {
      const v = m[0].replace(/[，,.;； ]+$/, '');
      if (/\d/.test(v)) found.push([pri, v]);
    }
  }
  const uniq = [];
  for (const [pri, v] of found) { if (!uniq.some((u) => u[1] === v)) uniq.push([pri, v]); }
  const kept = uniq.filter(([pri, v]) => !uniq.some(([_, u]) => v !== u && v.includes(u)));
  if (!kept.length) return [];
  kept.sort(([priA, vA], [priB, vB]) => {
    const score = (pri, v) => {
      const idx = norm.indexOf(v);
      let kwDist = 9999;
      for (const k of ['客户合约', '合约', '合約', '合同']) {
        const p = norm.indexOf(k);
        if (p >= 0) kwDist = Math.min(kwDist, Math.abs(p - idx));
      }
      return [pri, kwDist < 9999 ? 0 : 1, -v.length];
    };
    const sa = score(priA, vA), sb = score(priB, vB);
    return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2];
  });
  return kept.map(([_, v]) => v);
}
export function normContractNo(s) {
  if (!s) return '';
  s = String(s).trim().replace(/\u3000/g, ' ');
  s = toSimp(s);
  s = s.replace(/／/g, '/').replace(/＼/g, '/');
  s = s.replace(/\s+/g, '').toUpperCase();
  return s;
}
function findLongestMatch(a, b, alo, ahi, blo, bhi) {
  let besti = alo, bestj = blo, bestSize = 0;
  const j2len = {};
  for (let i = alo; i < ahi; i++) {
    const newj2len = {};
    for (let j = blo; j < bhi; j++) {
      if (a[i] === b[j]) {
        const k = (j2len[j - 1] || 0) + 1;
        newj2len[j] = k;
        if (k > bestSize) { besti = i - k + 1; bestj = j - k + 1; bestSize = k; }
      }
    }
    for (const j in j2len) delete j2len[j];
    Object.assign(j2len, newj2len);
  }
  return [besti, bestj, bestSize];
}
function getMatchingBlocks(a, b) {
  const queue = [[0, a.length, 0, b.length]];
  const blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return blocks;
}
function sequenceRatio(a, b) {
  if (!a.length || !b.length) return 0;
  const matches = getMatchingBlocks(a, b).reduce((s, x) => s + x[2], 0);
  return (2.0 * matches) / (a.length + b.length);
}
export function fuzzyContractNoMatch(cno, keyList, threshold = 0.85) {
  const n = normContractNo(cno);
  if (!n) return null;
  let best = null, bestR = 0.0;
  for (const k of keyList) {
    const r = sequenceRatio(n, normContractNo(k));
    if (r > bestR) { bestR = r; best = k; }
  }
  return bestR >= threshold ? best : null;
}
