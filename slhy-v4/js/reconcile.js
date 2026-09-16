// reconcile.js — app.py _build_reconcile_groups 直译（三流核对引擎）
import { fuzzyMatchSpec, specsMatch, isCableSpec, parseSpec, productsMatch, normalizeProductName } from './mapping.js?v=20260915e';
import { normContractNo, fuzzyContractNoMatch } from './contract-no.js?v=20260915e';
import { matchProductName } from './whitelist.js?v=20260915e';
export function safeFloat(val, def = 0.0) {
  if (typeof val === 'string') val = val.replace(/,/g, '').replace(/，/g, '').trim();
  if (val === null || val === undefined || val === '' || val === 'nan') return def;
  const v = parseFloat(val);
  return Number.isNaN(v) ? def : v;
}
function nameEq(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return normalizeProductName(matchProductName(a)[0]) === normalizeProductName(matchProductName(b)[0]);
}
export function buildReconcileGroups({ ledger = {}, deliveryLines = [], piLines = [], overrides = {}, pinnedCnos = [], deliveryDoc = {}, piDoc = {} }) {
  const QTY_TOL = 1.0;
  function groupByCno(lines) {
    const g = {};
    for (const ln of lines) {
      let cno = normContractNo(ln['合约编号'] || '');
      if (!cno) cno = '__NONE__';
      if (!g[cno]) g[cno] = [];
      g[cno].push(ln);
    }
    return g;
  }
  let ledgerKeys = Object.keys(ledger);
  function effCno(cands) {
    if (!cands || !cands.length) return null;
    for (const c of cands) { if (normContractNo(c) in ledger) return c; }
    for (const c of cands) { const m = fuzzyContractNoMatch(normContractNo(c), ledgerKeys, 0.85); if (m) return c; }
    return cands[0];
  }
  const delCands = [deliveryDoc['合约编号'], ...(deliveryDoc['合约编号_全部'] || [])].filter(Boolean);
  const piCands = [piDoc['合约编号'], ...(piDoc['合约编号_全部'] || [])].filter(Boolean);
  const delEff = effCno(delCands), piEff = effCno(piCands);
  if (delEff) {
    deliveryLines = deliveryLines.map((ln) => {
      const orig = String(ln['合约编号'] || '').trim();
      return { ...ln, 合约编号: delEff, _no_original_cno: !orig || orig === '暂无' || orig === '无' };
    });
  }
  if (piEff) {
    piLines = piLines.map((ln) => {
      const orig = String(ln['合约编号'] || '').trim();
      return { ...ln, 合约编号: piEff, _no_original_cno: !orig || orig === '暂无' || orig === '无' };
    });
  }
  const delGroups = groupByCno(deliveryLines), piGroups = groupByCno(piLines);
  const cnoSet = new Set([...Object.keys(delGroups), ...Object.keys(piGroups)]);
  cnoSet.delete('__NONE__');
  function findMatch(targetSpec, pool, used) {
    const ts = fuzzyMatchSpec(String(targetSpec));
    if (isCableSpec(ts)) {
      for (let idx = 0; idx < pool.length; idx++) {
        if (used.has(idx)) continue;
        if (specsMatch(ts, fuzzyMatchSpec(String((pool[idx] || {}).规格 || '')))) return [idx, pool[idx]];
      }
      return [-1, null];
    }
    for (let idx = 0; idx < pool.length; idx++) {
      if (used.has(idx)) continue;
      if (specsMatch(ts, fuzzyMatchSpec(String((pool[idx] || {}).规格 || '')))) return [idx, pool[idx]];
    }
    return [-1, null];
  }
  function dispCno(cnoNorm, lines) {
    for (const ln of lines) { const v = (ln && typeof ln === 'object') ? ln['合约编号'] : null; if (v) return v; }
    return cnoNorm;
  }
  function buildLine(cl, d, p, result, reasons, totals) {
    const _totals = totals || {};
    let _dnFlag = null;
    const _dnList = ((d || {}).送货单编号_全部 || (String((d || {}).送货单编号 || '').trim() ? [String(d.送货单编号)] : [])).map((x) => String(x).trim()).filter(Boolean);
    const _piDnNos = ((p || {}).送货单编号_全部 || []).map((x) => String(x).trim()).filter(Boolean);
    if (d && p && _dnList.length && _piDnNos.length) {
      const _nf = (x) => x.toUpperCase().replace(/ /g, '').replace(/\\/g, '/');
      const _piSet = new Set(_piDnNos.map(_nf));
      _dnFlag = _dnList.map(_nf).every((x) => _piSet.has(x));
      reasons.push(_dnFlag ? '送货单编号和形式发票编号匹配' : '送货单编号与发票不对应');
    }
    if (p !== null && p !== undefined) {
      if (!String(p.发票编号 || '').trim()) reasons.push('未识别形式发票编号');
      if (!safeFloat(p.单价, 0)) reasons.push('未识别形式发票单价');
    }
    // ── 单价核对：合同单价 vs 形式发票单价（送货单没有单价） ──
    let _priceCheck = 'na';
    if (cl && p) {
      const cp = safeFloat(cl.单价, 0), pp = safeFloat(p.单价, 0);
      if (cp && pp) _priceCheck = (Math.abs(cp - pp) < 0.01) ? 'pass' : 'fail';
    }
    // ── 数量核对：送货汇总 d_sum 是否 ≤ 合同数量 cq ──
    let _qtyCheck = 'na';
    if (cl) {
      const totalD = safeFloat(_totals.d_sum, 0);
      const cq = safeFloat(cl.数量, 0);
      if (cq) _qtyCheck = (totalD <= cq + 1e-9) ? 'pass' : 'fail';
    }
    return {
      '规格型号': (cl || d || p || {}).规格原文 || (cl || d || p || {}).规格 || '',
      'contract': cl ? { '货物名称': cl.货物名称 || '', '规格': cl.规格 || '', '规格原文': cl.规格原文 || cl.规格 || '', '数量': cl.数量 ?? 0, '单位': cl.单位 || '', '单价': cl.单价 ?? 0 } : null,
      'delivery': d ? { '货物名称': d.货物名称 || '', '规格': d.规格 || '', '规格原文': d.规格原文 || d.规格 || '', '数量': d.数量 ?? 0, '单位': d.单位 || '', '送货单编号': d.送货单编号 || '' } : null,
      'pi': p ? { '货物名称': p.货物名称 || '', '规格': p.规格 || '', '规格原文': p.规格原文 || p.规格 || '', '数量': p.数量 ?? 0, '单位': p.单位 || '', '单价': p.单价 ?? 0, '发票编号': p.发票编号 || '', '送货单编号': (p['送货单编号_全部'] || []).join(', ') || '' } : null,
      '数量汇总送货': _totals.d_sum || 0, '数量汇总发票': _totals.p_sum || 0,
      'result': result, 'reasons': reasons, '编号对应': _dnFlag,
      '单价核对': _priceCheck, '数量核对': _qtyCheck,
    };
  }
  function rangeLineMatch(line, cl, minD, maxD) {
    if (!productsMatch(String(cl.货物名称 || ''), String(line.货物名称 || ''))) return false;
    const cp = safeFloat(cl.单价), lp = safeFloat(line.单价);
    if (cp && lp && Math.abs(cp - lp) > Math.max(cp * 0.05, 50)) return false;
    const parsed = parseSpec(String(line.规格 || ''));
    if (!parsed) return true;
    if (parsed.is_range) return !(maxD < parsed.min || minD > parsed.max);
    if (parsed.diameters.length) return parsed.diameters.some((d) => minD <= d && d <= maxD);
    return true;
  }
  const groups = [], newContracts = [];
  const summary = { total: 0, ok: 0, not_shipped: 0, error: 0, new: 0 };
  function cnoOrder(c) {
    const idx = pinnedCnos.indexOf(c);
    return [idx >= 0 ? idx : pinnedCnos.length, c];
  }
  const globalSel = overrides['*'];
  if (Array.isArray(globalSel) && globalSel.length) {
    const gsNorm = {};
    for (const x of globalSel) gsNorm[normContractNo(x)] = x;
    ledger = Object.fromEntries(Object.entries(ledger).filter(([k]) => normContractNo(k) in gsNorm));
    ledgerKeys = Object.keys(ledger);
  }
  const sortedCnos = [...cnoSet].sort((a, b) => {
    const sa = cnoOrder(a), sb = cnoOrder(b);
    return sa[0] - sb[0] || (sa[1] < sb[1] ? -1 : sa[1] > sb[1] ? 1 : 0);
  });
  for (const cno of sortedCnos) {
    let contractKey;
    if (overrides[cno]) contractKey = overrides[cno];
    else contractKey = cno in ledger ? cno : fuzzyContractNoMatch(cno, ledgerKeys, 0.85);
    const dLines = delGroups[cno] || [], pLines = piGroups[cno] || [];
    let cnoMismatch = false;
    if (overrides[cno] && cno !== '__NONE__' && cno !== '') cnoMismatch = normContractNo(overrides[cno]) !== cno;
    if (!contractKey) {
      const seen = new Set(), linesOut = [];
      for (const d of dLines) {
        const spec = fuzzyMatchSpec(String(d.规格 || ''));
        let p = null;
        for (let j = 0; j < pLines.length; j++) {
          if (seen.has(j)) continue;
          if (specsMatch(spec, fuzzyMatchSpec(String(pLines[j].规格 || '')))) { p = pLines[j]; seen.add(j); break; }
        }
        linesOut.push(buildLine(null, d, p, '新合同', ['台账中无对应合同，疑似新合同，请确认/补充台账']));
      }
      for (let j = 0; j < pLines.length; j++) {
        if (seen.has(j)) continue;
        linesOut.push(buildLine(null, null, pLines[j], '新合同', ['台账中无对应合同，疑似新合同，请确认/补充台账']));
      }
      let disp = dispCno(cno, [...dLines, ...pLines]);
      if (disp === '__NONE__') disp = '（未识别合约编号）';
      newContracts.push({ '合约编号': disp, delivery_count: dLines.length, pi_count: pLines.length });
      summary.new += linesOut.length;
      groups.push({ '合约编号': disp, matched: false, group_cno: cno, 'contract_合约编号': '', 'delivery_合约编号': dispCno(cno, dLines), 'pi_合约编号': dispCno(cno, pLines), lines: linesOut });
      continue;
    }
    const cLines = ledger[contractKey] || [];
    const usedD = new Set(), usedP = new Set(), linesOut = [];
    const emit = (cl, d, p, result, reasons, totals) => {
      if (cnoMismatch) {
        result = '编号错误';
        reasons = ['合同编号与送货单/发票编号不一致：' + contractKey + ' ≠ ' + dispCno(cno, [...dLines, ...pLines])].concat(reasons);
      }
      // 无合同编号的送货单/发票：标记为核对有误
      if (d && d._no_original_cno) { result = '核对有误'; if (!reasons.includes('无合同编号')) reasons.push('无合同编号'); }
      if (p && p._no_original_cno) { result = '核对有误'; if (!reasons.includes('无合同编号')) reasons.push('无合同编号'); }
      linesOut.push(buildLine(cl, d, p, result, reasons, totals));
      if (result === '核对无误') summary.ok += 1;
      else if (result === '未发货') summary.not_shipped += 1;
      else if (result === '未识别') { summary.error += 1; summary.unrecognized = (summary.unrecognized || 0) + 1; }
      else summary.error += 1;
    };
    // ── 按台账行做精确匹配（规格严格匹配；钢筋区间规格走 rangeLineMatch）──
    const usedD2 = usedD, usedP2 = usedP;
    const slots = cLines.map((cl) => {
      const parsed = parseSpec(String(cl.规格 || ''));
      const isRange = !!(parsed && parsed.is_range);
      const ts = fuzzyMatchSpec(String(cl.规格 || ''));
      const slot = { cl, ts, dIdx: [], pIdx: [], dFuzzy: [], pFuzzy: [] };
      for (let i = 0; i < dLines.length; i++) {
        if (usedD2.has(i)) continue;
        const ok = isRange ? rangeLineMatch(dLines[i], cl, parsed.min, parsed.max)
                           : specsMatch(ts, fuzzyMatchSpec(String(dLines[i].规格 || '')));
        if (ok) { slot.dIdx.push(i); usedD2.add(i); }
      }
      for (let j = 0; j < pLines.length; j++) {
        if (usedP2.has(j)) continue;
        const ok = isRange ? rangeLineMatch(pLines[j], cl, parsed.min, parsed.max)
                           : specsMatch(ts, fuzzyMatchSpec(String(pLines[j].规格 || '')));
        if (ok) { slot.pIdx.push(j); usedP2.add(j); }
      }
      return slot;
    });
    // ── 台账外行归并：确保「表格行数 = 台账行数」，不再出现合同列为空的额外行 ──
    // 规则：品类相同 + 尺寸串近似 → 并入最接近的台账行，并在说明里标注规格不一致
    const gUnassigned = [];
    function gDimTuples(spec) {
      const out = [];
      const re = /\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:\.\d+)?)+/g;
      let m;
      while ((m = re.exec(String(spec || ''))) !== null) {
        const t = m[0].split('*').map((x) => parseFloat(x.trim())).filter((v) => !Number.isNaN(v));
        if (t.length >= 2) out.push(t);
      }
      return out;
    }
    function gTupleScore(a, b) {
      if (a.length !== b.length) return 0;
      let same = true, diff = 0;
      for (let k = 0; k < a.length; k++) { if (a[k] !== b[k]) same = false; diff += Math.abs(a[k] - b[k]); }
      if (same) return 100;
      if (a[0] === b[0]) return Math.max(25, 60 - Math.min(35, diff / 20));
      return Math.max(3, 20 - Math.min(17, diff / 50));
    }
    function gSpecSimilarity(a, b) {
      const ta = gDimTuples(a), tb = gDimTuples(b);
      let best = 0;
      for (const x of ta) for (const y of tb) best = Math.max(best, gTupleScore(x, y));
      return best;
    }
    function gBestSlot(line) {
      const spec = String(line.规格原文 || line.规格 || '');
      let best = null, bestScore = 0;
      for (const s of slots) {
        const dimScore = gSpecSimilarity(spec, String(s.cl.规格原文 || s.cl.规格 || ''));
        if (dimScore <= 0) continue;
        // 尺寸串相似度为主，品类相同只作同分时的微小加权（避免品类加权盖过精确尺寸匹配）
        const score = dimScore + (line.货物名称 && s.cl.货物名称 && nameEq(String(s.cl.货物名称), String(line.货物名称)) ? 5 : 0);
        if (score > bestScore) { best = s; bestScore = score; }
      }
      return best;
    }
    for (let i = 0; i < dLines.length; i++) {
      if (usedD2.has(i)) continue;
      const s = gBestSlot(dLines[i]);
      if (s) { s.dIdx.push(i); s.dFuzzy.push(i); }
      else gUnassigned.push({ kind: '送货单', 货物名称: dLines[i].货物名称 || '', 规格: dLines[i].规格原文 || dLines[i].规格 || '', 数量: dLines[i].数量 || 0, 单位: dLines[i].单位 || '' });
    }
    for (let j = 0; j < pLines.length; j++) {
      if (usedP2.has(j)) continue;
      const s = gBestSlot(pLines[j]);
      if (s) { s.pIdx.push(j); s.pFuzzy.push(j); }
      else gUnassigned.push({ kind: '形式发票', 货物名称: pLines[j].货物名称 || '', 规格: pLines[j].规格原文 || pLines[j].规格 || '', 数量: pLines[j].数量 || 0, 单位: pLines[j].单位 || '' });
    }
    const gR3 = (x) => Math.round(x * 1000) / 1000;
    const gUniq = (arr) => [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))];
    const gSpecs = (idxs, src) => gUniq(idxs.map((i) => String(src[i].规格原文 || src[i].规格 || '')));
    const emitSlot = (slot) => {
      const cl = slot.cl;
      const cq = safeFloat(cl.数量, 0);
      const cSpec = String(cl.规格原文 || cl.规格 || '');
      const totalD = gR3(slot.dIdx.reduce((s, i) => s + safeFloat(dLines[i].数量, 0), 0));
      const totalP = gR3(slot.pIdx.reduce((s, j) => s + safeFloat(pLines[j].数量, 0), 0));
      const dFirst = slot.dIdx.length ? dLines[slot.dIdx[0]] : null;
      const pFirst = slot.pIdx.length ? pLines[slot.pIdx[0]] : null;
      const dDn = gUniq(slot.dIdx.map((i) => dLines[i].送货单编号));
      const pDn = gUniq(slot.pIdx.map((j) => pLines[j].送货单编号));
      const pNo = gUniq(slot.pIdx.map((j) => pLines[j].发票编号));
      const dAgg = dFirst ? {
        '货物名称': dFirst.货物名称 || '', '规格': dFirst.规格 || '', '规格原文': dFirst.规格原文 || dFirst.规格 || '',
        '数量': totalD, '单位': dFirst.单位 || '', '送货单编号': dDn.join('、'), '送货单编号_全部': dDn,
      } : null;
      const pAgg = pFirst ? {
        '货物名称': pFirst.货物名称 || '', '规格': pFirst.规格 || '', '规格原文': pFirst.规格原文 || pFirst.规格 || '',
        '数量': totalP, '单位': pFirst.单位 || '', '单价': pFirst.单价 || 0,
        '发票编号': pNo.join('、'), '送货单编号': pDn.join('、'), '送货单编号_全部': pDn,
      } : null;
      const hard = [];
      if ((dFirst && !nameEq(cl.货物名称 || '', dFirst.货物名称 || '')) || (pFirst && !nameEq(cl.货物名称 || '', pFirst.货物名称 || ''))) {
        hard.push('货物名称不一致');
      }
      const dFz = gSpecs(slot.dFuzzy, dLines).filter((s) => s !== cSpec);
      const pFz = gSpecs(slot.pFuzzy, pLines).filter((s) => s !== cSpec);
      if (dFz.length) hard.push('送货单规格与台账不一致：' + dFz.join(' / ') + ' ≠ 合同 ' + cSpec);
      if (pFz.length) hard.push('发票规格与台账不一致：' + pFz.join(' / ') + ' ≠ 合同 ' + cSpec);
      let result;
      if (!dAgg && !pAgg) { result = '未发货'; hard.push('合同有此货物，但无对应送货单'); }
      else if (!dAgg) { result = '核对有误'; hard.push('发票有，但无对应送货单'); }
      else if (!pAgg) { result = '核对有误'; hard.push('送货单有，但形式发票缺失'); }
      else {
        if (Math.abs(totalD - totalP) > QTY_TOL) hard.push('数量不一致：送货合计 ' + totalD.toFixed(3) + ' ≠ 发票合计 ' + totalP.toFixed(3));
        if (totalD > cq + 1e-9) hard.push('数量超合同：送货合计 ' + totalD.toFixed(3) + ' > 合同 ' + cq.toFixed(3));
        if (totalP > cq + 1e-9) hard.push('数量超合同：发票合计 ' + totalP.toFixed(3) + ' > 合同 ' + cq.toFixed(3));
        result = hard.length ? '核对有误' : '核对无误';
      }
      const reasons = [...hard];
      if (result === '核对无误' && (slot.dIdx.length > 1 || slot.pIdx.length > 1)) {
        reasons.push('分批发货：合计 ' + gR3(Math.max(totalD, totalP)).toFixed(3) + ' ≤ 合同 ' + cq.toFixed(3));
      }
      if (slot.dIdx.length > 1) reasons.push('送货单共 ' + slot.dIdx.length + ' 行，合计 ' + totalD.toFixed(3) + ' ' + (cl.单位 || ''));
      if (slot.pIdx.length > 1) reasons.push('形式发票共 ' + slot.pIdx.length + ' 行，合计 ' + totalP.toFixed(3) + ' ' + (cl.单位 || ''));
      emit(cl, dAgg, pAgg, result, reasons, { d_sum: totalD, p_sum: totalP });
    };
    for (const slot of slots) emitSlot(slot);
    groups.push({ '合约编号': dispCno(contractKey, cLines), matched: true, group_cno: cno, 'contract_合约编号': dispCno(contractKey, cLines), 'delivery_合约编号': dispCno(cno, dLines), 'pi_合约编号': dispCno(cno, pLines), lines: linesOut, unmatched_extra: gUnassigned, unmatched_extra_n: gUnassigned.length });
  }
  summary.total = summary.ok + summary.not_shipped + summary.error;
  return { groups, new_contracts: newContracts, summary };
}
