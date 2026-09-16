// ocr-doc.js — 文档级识别编排
import { fuzzyMatchSpec } from './mapping.js?v=20260915e';
import { safeFloat } from './reconcile.js?v=20260915e';
import { parseProductsFromText } from './parse-lines-v4.js?v=20260915e';
import { applyWhitelistConstraints } from './whitelist.js?v=20260915e';
import { extractContractNo } from './contract-no.js?v=20260915e';
import { extractHybrid } from './extract.js?v=20260915e';
export function isGenericSpec(spec) {
  if (!spec) return true;
  return !/[YTΦφ]\d|\d\s*mm/.test(String(spec));
}
function extractDocNo(text, prefix) {
  const m = String(text || '').match(new RegExp(prefix + '[/\\\\7|][\\w/\\\\7|\\-]+'));
  if (!m) return '';
  let s = m[0].replace(/ /g, '').replace(/\|/g, '/').replace(/\\/g, '/');
  const parts = s.split('/');
  const fixed = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) fixed.push(fixed.length ? '/' + p : p);
    else fixed.push(p);
  }
  return fixed.join('').trim();
}
export async function ocrDocument({ file, docType, extractHybridFn }) {
  const result = { doc_type: docType, text_length: 0, products: [], raw_fields: {} };
  const ext = (file.ext || '').toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    const excel = await import('./parse-excel.js');
    return docType === 'contract' ? excel.parseContractLedger(file.data) : excel.parseExcel(file.data, docType);
  }
  const hybrid = await (extractHybridFn || extractHybrid)(file.data, {
    maxOcrPages: docType === 'contract' ? 10 : undefined,
    earlyStopFn: docType === 'contract' ? (frag) => extractContractNo(frag).length > 0 : undefined,
  });
  let text = hybrid.merged_text || '';
  result.text_length = text.trim().length;
  result.raw_text_layer = hybrid.text_layer;
  result.raw_ocr = hybrid.ocr_text;
  result.cross_diffs = hybrid.diffs;
  if (!result.products.length && (text || hybrid.ocr_text)) {
    const parseSrc = hybrid.ocr_text || text;
    result.text_length = parseSrc.trim().length;
    result.raw_text = parseSrc.slice(0, 3000);
    if (docType === 'delivery') {
      const dnMatches = [...parseSrc.matchAll(/(DN[/\\7|][\w/\\7|\-]+)/g)];
      const dnNos = dnMatches.map((m) => m[1].replace(/ /g, '').replace(/\|/g, '/').replace(/\\/g, '/').replace(/7/g, '/'));
      if (new Set(dnNos).size > 1) {
        result.products = [];
        for (let i = 0; i < dnMatches.length; i++) {
          const segStart = dnMatches[i].index;
          const segEnd = i + 1 < dnMatches.length ? dnMatches[i + 1].index : parseSrc.length;
          const seg = parseSrc.slice(segStart, segEnd);
          for (const p of parseProductsFromText(seg, docType)) { p['送货单编号'] = dnNos[i]; result.products.push(p); }
        }
      } else {
        const parsed = parseProductsFromText(parseSrc, docType);
        if (parsed.length) result.products = parsed;
      }
    } else {
      const parsed = parseProductsFromText(parseSrc, docType);
      if (parsed.length) result.products = parsed;
    }
  }
  result.review_flags = result.products.length ? applyWhitelistConstraints(result.products, text) : [];
  const existingCn = result.raw_fields['客户合约编号'] || result.raw_fields['合约编号'];
  if (existingCn && !result['合约编号']) result['合约编号'] = existingCn;
  else {
    const contractNos = extractContractNo(text);
    if (contractNos.length) { result['合约编号'] = contractNos[0]; result['合约编号_全部'] = contractNos; }
  }
  if (result['合约编号'] && !result.raw_fields['合约编号']) result.raw_fields['合约编号'] = result['合约编号'];
  if (docType === 'delivery') {
    let docNo = result.raw_fields['送货单编号'] || result['送货单编号'] || '';
    if (!docNo) docNo = extractDocNo(text, 'DN');
    if (docNo) {
      result['送货单编号'] = docNo;
      for (const p of result.products) { if (!p['送货单编号']) p['送货单编号'] = docNo; }
    }
  } else if (docType === 'pi') {
    let docNo = result.raw_fields['发票编号'] || result['发票编号'] || '';
    if (!docNo) docNo = extractDocNo(text, 'IN');
    if (docNo) {
      result['发票编号'] = docNo;
      for (const p of result.products) { if (!p['发票编号']) p['发票编号'] = docNo; }
    }
    let dnNos = (result.raw_fields['送货单编号_全部'] || (result.raw_fields['送货单编号'] ? [result.raw_fields['送货单编号']] : []) || []).map((x) => String(x).trim()).filter(Boolean);
    // ⚠️ 如果 raw_fields 中没有 送货单编号，从文本中提取（格式：送貨單編號 DN/GAB/...）
    if (!dnNos.length) {
      const dnNo = extractDocNo(text, 'DN');
      if (dnNo) dnNos = [dnNo];
    }
    if (dnNos.length) {
      result['送货单编号_全部'] = dnNos;
      for (const p of result.products) { if (!p['送货单编号_全部']) p['送货单编号_全部'] = dnNos; }
    }
  }
  if ((docType === 'delivery' || docType === 'pi') && result.products.length) {
    const ocrText = hybrid.ocr_text || text;
    if (ocrText) {
      // ⚠️ 灯具守卫：后处理只为钢筋做规格增强，遇到灯具/电池产品直接跳过
      // （否则 Tesseract.js 把 "total 59.0000" 渲染到一行时，fallback 正则 [YTytΦφ]\d{1,2}\S* 会
      //   误匹配 "t59.0000"，fuzzyMatchSpec 又把它原样返回，导致覆盖正确的灯具规格）
      const LAMP_GUARD = /照明装置|照明|灯具|燈具|電池|电池|应急电源|應急電源|筒射灯|筒射燈|线条灯|線條燈|LED\s*Linear|LED\s*Downlight|Linear\s*Light/i;
      for (const oldP of result.products) {
        if (oldP._missed) continue;
        const oldName = String(oldP['货物名称'] || '');
        const oldSpec = String(oldP['规格'] || '');
        // 灯具/电池产品：直接跳过规格增强
        if (LAMP_GUARD.test(oldName) || LAMP_GUARD.test(oldSpec) || /[*]/.test(oldSpec)) continue;
        if (/[TtΦφ]\d{1,2}[Oo0-9A-Za-z]*\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]/.test(oldSpec) || /[TtΦφ]\d{1,2}-\d{1,2}M/.test(oldSpec)) continue;
        const oldQty = safeFloat(oldP['数量'], 0);
        const qtyStr = oldQty.toFixed(3).replace('.000', '').replace('.00', '');
        const oldSpecN = oldSpec.replace(/ /g, '');
        for (const line0 of ocrText.split('\n')) {
          const ln = line0.replace(/ /g, '');
          if (!ln) continue;
          if (!ln.includes(qtyStr) && (!oldSpecN || !ln.includes(oldSpecN))) continue;
          let m = ln.match(/(?:[YTΦφ]\d{1,2}\s*)?[TtΦφ]\d{1,2}[Oo0-9A-Za-z]{0,3}\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]\s*(?:\/\s*[A-Za-z0-9]+)?/);
          if (!m) m = ln.match(/[TtΦφ]\d{1,2}[Oo0-9A-Za-z]{0,3}\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]/);
          if (m) {
            const full = m[0].trim();
            oldP['规格原文'] = full;
            const nspec = fuzzyMatchSpec(full);
            if (nspec && nspec !== oldSpec) oldP['规格'] = nspec;
            else if (!nspec) oldP['规格'] = full;
            break;
          }
          const yt = ln.match(/[YTytΦφ]\d{1,2}\S*/);
          if (yt) { const nspec = fuzzyMatchSpec(yt[0].trim()); if (nspec && nspec !== oldSpec) oldP['规格'] = nspec; break; }
        }
      }
    }
  }
  if ((docType === 'delivery' || docType === 'pi') && result['合约编号']) {
    for (const p of result.products) p['合约编号'] = result['合约编号'];
  }
  if (docType === 'contract' && !result.ledger && result.products.length) {
    const cno = result['合约编号'] || '__UNKNOWN__';
    result.ledger = { [cno]: result.products };
    if (!result['合约编号_全部']) result['合约编号_全部'] = [cno];
  }
  return result;
}
export function enrichMissingSpecs(results) {
  const dLines = (results.delivery || {}).products || [];
  const pLines = (results.pi || {}).products || [];
  if (!dLines.length && !pLines.length) return;
  const idx = (lines) => {
    const m = {};
    for (const ln of lines) {
      const q = safeFloat(ln['数量'], 0);
      const spec = String(ln['规格'] || '');
      if (q && spec && !isGenericSpec(spec)) {
        const cno = String(ln['合约编号'] || '');
        const qk = Math.round(q * 1000) / 1000;
        if (!m[qk]) m[qk] = [];
        m[qk].push([cno, spec]);
      }
    }
    return m;
  };
  const dIdx = idx(dLines), pIdx = idx(pLines);
  for (const d of dLines) {
    if (!isGenericSpec(String(d['规格'] || ''))) continue;
    const q = Math.round(safeFloat(d['数量'], 0) * 1000) / 1000;
    if (q <= 0) continue;
    const cands = pIdx[q] || [];
    if (!cands.length) continue;
    const cno = String(d['合约编号'] || '');
    const cnoCands = cands.filter((c) => c[0] === cno).length ? cands.filter((c) => c[0] === cno) : cands;
    const pspec = cnoCands[0][1];
    const dm = pspec.match(/[YTΦφ](\d{1,2})/);
    if (dm) {
      let len = '12M';
      for (const x of dLines) {
        if (x === d) continue;
        const mx = String(x['规格'] || '').match(/-(\d{1,2}[Mm])/);
        if (mx) { len = mx[1]; break; }
      }
      d['规格'] = 'T' + dm[1] + '-' + len;
    } else d['规格'] = pspec;
  }
  for (const p of pLines) {
    if (!isGenericSpec(String(p['规格'] || ''))) continue;
    const q = Math.round(safeFloat(p['数量'], 0) * 1000) / 1000;
    if (q <= 0) continue;
    const cands = dIdx[q] || [];
    if (!cands.length) continue;
    const cno = String(p['合约编号'] || '');
    const cnoCands = cands.filter((c) => c[0] === cno).length ? cands.filter((c) => c[0] === cno) : cands;
    p['规格'] = cnoCands[0][1];
  }
  const piDiams = new Set();
  for (const p of pLines) {
    if (isGenericSpec(String(p['规格'] || ''))) continue;
    const md = String(p['规格'] || '').match(/[YTΦφ](\d{1,2})/);
    if (md) piDiams.add(parseInt(md[1], 10));
  }
  for (const d of dLines) {
    const spec = String(d['规格'] || '');
    if (isGenericSpec(spec)) continue;
    const md = spec.match(/[YTΦφ](\d{1,2})/);
    if (!md) continue;
    const diam = parseInt(md[1], 10);
    if (piDiams.has(diam)) continue;
    const q = Math.round(safeFloat(d['数量'], 0) * 1000) / 1000;
    if (q <= 0) continue;
    let best = null, bestDiff = 0.51;
    for (const p of pLines) {
      if (isGenericSpec(String(p['规格'] || ''))) continue;
      const pq = Math.round(safeFloat(p['数量'], 0) * 1000) / 1000;
      const diff = Math.abs(pq - q);
      if (diff < bestDiff) { bestDiff = diff; best = p; }
    }
    if (best && bestDiff <= 0.5) {
      const pm = String(best['规格'] || '').match(/[YTΦφ](\d{1,2})/);
      if (pm) {
        if (/[Tt]\d{1,2}-\d{1,2}[Mm]/.test(spec)) {
          let len = '12M';
          const mx = spec.match(/-(\d{1,2}[Mm])/);
          if (mx) len = mx[1];
          d['规格'] = 'T' + pm[1] + '-' + len;
        } else d['规格'] = 'Y' + pm[1];
      }
    }
  }
}
export async function runExtract(session, onProgress) {
  const results = {};
  for (const docType of ['contract', 'delivery', 'pi']) {
    const fileList = session[docType] || [];
    if (!fileList.length) {
      if (docType === 'contract') {
        const mapping = session.activeMapping;
        if (mapping && mapping.ledger) {
          results.contract = { doc_type: 'contract', text_length: 0, products: [], raw_fields: {}, ledger: mapping.ledger, contract_nos: Object.keys(mapping.ledger), files_processed: 0 };
          continue;
        }
      }
      results[docType] = null;
      continue;
    }
    const merged = { doc_type: docType, text_length: 0, products: [], raw_fields: {}, ledger: {}, contract_nos: [], files_processed: 0 };
    for (const finfo of fileList) {
      if (onProgress) onProgress({ stage: docType, file: finfo.name });
      const docResult = await ocrDocument({ file: finfo, docType });
      if (docResult.products) { for (const p of docResult.products) p._source = finfo.name; merged.products.push(...docResult.products); }
      if (docResult.raw_fields) Object.assign(merged.raw_fields, docResult.raw_fields);
      for (const extra of ['review_flags', '合约编号', '合约编号_全部']) {
        if (docResult[extra] !== undefined && docResult[extra] !== null) merged[extra] = docResult[extra];
      }
      if (docType === 'contract') {
        let led = docResult.ledger || {};
        const mapping = session.activeMapping;
        if (mapping && mapping.ledger) led = mapping.ledger;
        for (const k in led) { if (!merged.ledger[k]) merged.ledger[k] = []; merged.ledger[k].push(...led[k]); }
        const cnos = docResult['合约编号_全部'] || Object.keys(led);
        const seen = new Set(merged.contract_nos);
        for (const c of cnos) { if (!seen.has(c)) { merged.contract_nos.push(c); seen.add(c); } }
      }
      merged.text_length += docResult.text_length || 0;
      merged.files_processed += 1;
    }
    results[docType] = merged;
  }
  try { enrichMissingSpecs(results); } catch (e) { /* 不阻断 */ }
  return results;
}
