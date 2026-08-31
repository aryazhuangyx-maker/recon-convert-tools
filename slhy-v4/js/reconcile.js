// reconcile.js — app.py _build_reconcile_groups 直译（三流核对引擎）
import { fuzzyMatchSpec, specsMatch, isCableSpec, parseSpec, productsMatch, normalizeProductName } from './mapping.js?v=20260826q';
import { normContractNo, fuzzyContractNoMatch } from './contract-no.js?v=20260826q';
import { matchProductName } from './whitelist.js?v=20260826q';
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
    const _dn = String((d || {}).送货单编号 || '').trim();
    const _piDnNos = ((p || {}).送货单编号_全部 || []).map((x) => String(x).trim()).filter(Boolean);
    if (d && p && _dn && _piDnNos.length) {
      const _dnNorm = _dn.toUpperCase().replace(/ /g, '').replace(/\\/g, '/');
      _dnFlag = _piDnNos.some((x) => _dnNorm === x.toUpperCase().replace(/ /g, '').replace(/\\/g, '/'));
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
    for (const cl of cLines) {
      const parsed = parseSpec(String(cl.规格 || ''));
      if (parsed && parsed.is_range) {
        const cq = safeFloat(cl.数量, 0);
        const dIdxList = [];
        for (let i = 0; i < dLines.length; i++) { if (usedD.has(i)) continue; if (rangeLineMatch(dLines[i], cl, parsed.min, parsed.max)) { dIdxList.push(i); usedD.add(i); } }
        const pIdxList = [];
        for (let j = 0; j < pLines.length; j++) { if (usedP.has(j)) continue; if (rangeLineMatch(pLines[j], cl, parsed.min, parsed.max)) { pIdxList.push(j); usedP.add(j); } }
        const totalD = dIdxList.reduce((s, i) => s + safeFloat(dLines[i].数量, 0), 0);
        const totalP = pIdxList.reduce((s, j) => s + safeFloat(pLines[j].数量, 0), 0);
        const totals = { d_sum: Math.round(totalD * 1000) / 1000, p_sum: Math.round(totalP * 1000) / 1000 };
        if (!dIdxList.length) {
          if (!pIdxList.length) emit(cl, null, null, '未发货', ['合同有此货物，但无对应送货单'], totals);
          else for (const j of pIdxList) emit(cl, null, pLines[j], '核对有误', ['发票有，但无对应送货单'], totals);
        } else {
          const classReasons = [];
          if (!pIdxList.length) classReasons.push('送货单有，但形式发票缺失');
          else if (Math.abs(totalD - totalP) > QTY_TOL) classReasons.push('数量不一致：送货合计 ' + totalD.toFixed(3) + ' ≠ 发票合计 ' + totalP.toFixed(3));
          if (totalD > cq + 1e-9) classReasons.push('数量超合同：送货合计 ' + totalD.toFixed(3) + ' > 合同 ' + cq.toFixed(3));
          if (totalP > cq + 1e-9) classReasons.push('数量超合同：发票合计 ' + totalP.toFixed(3) + ' > 合同 ' + cq.toFixed(3));
          const classResult = classReasons.length ? '核对有误' : '核对无误';
          if (!classReasons.length && (dIdxList.length || pIdxList.length)) classReasons.push('合计 ' + (Math.round(Math.max(totalD, totalP) * 1000) / 1000).toFixed(3) + ' ≤ 合同 ' + cq.toFixed(3) + '，分批发货');
          const dItems = dIdxList.map((i) => [i, safeFloat(dLines[i].数量, 0)]).sort((x, y) => y[1] - x[1]);
          const pItems = pIdxList.map((j) => [j, safeFloat(pLines[j].数量, 0)]).sort((x, y) => y[1] - x[1]);
          const usedPInner = new Set();
          const pairRange = (di, dqty) => {
            for (const [j, pqty] of pItems) { if (usedPInner.has(j)) continue; if (Math.abs(pqty - dqty) < QTY_TOL) { usedPInner.add(j); return [pLines[j], pqty]; } }
            return [null, null];
          };
          for (const [di, dqty] of dItems) {
            const [p, pqty] = pairRange(di, dqty);
            const reasons = [...classReasons];
            if (p && Math.abs(dqty - pqty) > QTY_TOL) reasons.push('数量不一致：送货 ' + dqty.toFixed(3) + ' ≠ 发票 ' + pqty.toFixed(3));
            emit(cl, dLines[di], p, classResult, reasons, totals);
          }
          for (const [j, pqty] of pItems) { if (!usedPInner.has(j)) emit(cl, null, pLines[j], '核对有误', [...classReasons, '发票数量无对应送货单'], totals); }
        }
        continue;
      }
      const ts = fuzzyMatchSpec(String(cl.规格 || ''));
      const cq = safeFloat(cl.数量, 0);
      const dIdxList = [];
      for (let i = 0; i < dLines.length; i++) { if (usedD.has(i)) continue; if (specsMatch(ts, fuzzyMatchSpec(String(dLines[i].规格 || '')))) { dIdxList.push(i); usedD.add(i); } }
      const pIdxList = [];
      for (let j = 0; j < pLines.length; j++) { if (usedP.has(j)) continue; if (specsMatch(ts, fuzzyMatchSpec(String(pLines[j].规格 || '')))) { pIdxList.push(j); usedP.add(j); } }
      const totalD = dIdxList.reduce((s, i) => s + safeFloat(dLines[i].数量, 0), 0);
      const totalP = pIdxList.reduce((s, j) => s + safeFloat(pLines[j].数量, 0), 0);
      const totals = { d_sum: Math.round(totalD * 1000) / 1000, p_sum: Math.round(totalP * 1000) / 1000 };
      if (!dIdxList.length) {
        if (!pIdxList.length) emit(cl, null, null, '未发货', ['合同有此货物，但无对应送货单'], totals);
        else for (const j of pIdxList) emit(cl, null, pLines[j], '核对有误', ['发票有，但无对应送货单'], totals);
      } else if (!pIdxList.length) {
        for (const di of dIdxList) emit(cl, dLines[di], null, '核对有误', ['送货单有，但形式发票缺失'], totals);
      } else {
        const dItems = dIdxList.map((i) => [i, safeFloat(dLines[i].数量, 0)]).sort((x, y) => y[1] - x[1]);
        const pItems = pIdxList.map((j) => [j, safeFloat(pLines[j].数量, 0)]).sort((x, y) => y[1] - x[1]);
        const usedPInner = new Set();
        const pairOne = (di, dqty) => {
          for (const [j, pqty] of pItems) { if (usedPInner.has(j)) continue; if (Math.abs(pqty - dqty) < QTY_TOL) { usedPInner.add(j); return [pLines[j], pqty]; } }
          return [null, null];
        };
        for (const [di, dqty] of dItems) {
          const [p, pqty] = pairOne(di, dqty);
          const d = dLines[di];
          const reasons = [];
          if (!nameEq(cl.货物名称 || '', d.货物名称 || '')) reasons.push('货物名称不一致');
          if (p) {
            if (!nameEq(cl.货物名称 || '', p.货物名称 || '')) reasons.push('货物名称不一致');
            if (Math.abs(dqty - pqty) > QTY_TOL) reasons.push('数量不一致：送货 ' + dqty.toFixed(3) + ' ≠ 发票 ' + pqty.toFixed(3));
          }
          const result = reasons.some((r) => r.includes('未识别')) ? '未识别' : (reasons.length ? '核对有误' : '核对无误');
          emit(cl, d, p, result, reasons, totals);
        }
        for (const [j, pqty] of pItems) { if (!usedPInner.has(j)) emit(cl, null, pLines[j], '核对有误', ['发票数量无对应送货单'], totals); }
      }
    }
    for (let i = 0; i < dLines.length; i++) {
      if (usedD.has(i)) continue;
      const [, p] = findMatch(dLines[i].规格 || '', pLines, usedP);
      emit(null, dLines[i], p, '核对有误', ['送货单规格在合同中不存在']);
    }
    for (let j = 0; j < pLines.length; j++) {
      if (usedP.has(j)) continue;
      emit(null, null, pLines[j], '核对有误', ['形式发票规格在合同中不存在']);
    }
    groups.push({ '合约编号': dispCno(contractKey, cLines), matched: true, group_cno: cno, 'contract_合约编号': dispCno(contractKey, cLines), 'delivery_合约编号': dispCno(cno, dLines), 'pi_合约编号': dispCno(cno, pLines), lines: linesOut });
  }
  summary.total = summary.ok + summary.not_shipped + summary.error;
  return { groups, new_contracts: newContracts, summary };
}
