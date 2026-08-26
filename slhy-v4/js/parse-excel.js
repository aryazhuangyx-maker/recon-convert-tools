// parse-excel.js — SheetJS 台账/Excel 解析
import { fuzzyMatchSpec, MATERIAL_SPEC_MAP } from './mapping.js';
import { normContractNo, extractContractNo } from './contract-no.js';
import { applyWhitelistConstraints } from './whitelist.js';
let XLSX = null;
export function setXLSX(lib) { XLSX = lib; }
function getXLSX() { if (!XLSX) throw new Error('XLSX 未初始化'); return XLSX; }
export function safeFloat(val, def = 0.0) {
  if (typeof val === 'string') val = val.replace(/,/g, '').replace(/，/g, '').trim();
  if (val === null || val === undefined || val === '' || val === 'nan' || (typeof val === 'number' && Number.isNaN(val))) return def;
  const v = parseFloat(val);
  return Number.isNaN(v) ? def : v;
}
function notNa(val) { return val !== null && val !== undefined && !(typeof val === 'number' && Number.isNaN(val)); }
function sheetRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return getXLSX().utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}
export function parseContractLedger(arrayBuffer) {
  const result = { doc_type: 'contract', ledger: {}, contract_nos: [], text_length: 0, products: [], raw_fields: {}, review_flags: [], _diag: { sheets: [], headerRows: [], acceptedColumns: {} } };
  const LEDGER_ALIAS = {
    '合同编号': ['合同编号', '合约编号', '合约号', '合同号', '合同编码'],
    '货物名称': ['物料名称', '货物名称', '产品名称', '名称', '品名', '货名'],
    '规格': ['规格型号', '规格', '型号', '材料属性二', '尺寸'],
    '数量': ['数量', '重量', '吨数', '件数', '合同数量'],
    '单位': ['单位', '计量单位', '包装单位'],
    '单价': ['单价', '含税单价', '不含税单价', '价格'],
    '金额': ['金额', '总价', '合计', '价税合计', '含税金额'],
    '备注': ['备注', '说明', '摘要'],
  };
  const NAME_BLOCK = ['报关'];
  let wb;
  // ⚠️ 浏览器 file.arrayBuffer() 返回 ArrayBuffer，但 type: 'array' 需要 Uint8Array
  const input = (arrayBuffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && arrayBuffer instanceof SharedArrayBuffer))
    ? new Uint8Array(arrayBuffer) : arrayBuffer;
  try { wb = getXLSX().read(input, { type: 'array' }); } catch (e) { return result; }
  const allLines = [];
  let lastCno = '';
  for (const sheetName of wb.SheetNames) {
    let df;
    try { df = sheetRows(wb, sheetName); } catch (e) { continue; }
    if (!df.length || df.length < 2) continue;
    let headerRow = -1;
    for (let i = 0; i < Math.min(25, df.length); i++) {
      const rowVals = (df[i] || []).filter((v) => notNa(v)).map((v) => String(v).trim());
      const rowStr = rowVals.join(' ');
      const hits = ['合同', '物料', '货物', '产品', '规格', '型号', '数量', '单价'].filter((k) => rowStr.includes(k)).length;
      if (hits >= 2) { headerRow = i; break; }
    }
    if (headerRow < 0) { result._diag.reason = 'no_header'; continue; }
    result._diag.headerRows.push(headerRow);
    const colIndex = {};
    const headerRowData = df[headerRow] || [];
    for (let j = 0; j < headerRowData.length; j++) {
      const val = String(headerRowData[j] ?? '').trim();
      if (!notNa(headerRowData[j]) || val === 'nan' || !val) continue;
      for (const stdName in LEDGER_ALIAS) {
        if (stdName in colIndex) continue;
        if (stdName === '货物名称' && NAME_BLOCK.some((b) => val.includes(b))) continue;
        if (LEDGER_ALIAS[stdName].some((a) => val.includes(a))) { colIndex[stdName] = j; break; }
      }
    }
    if (!('合同编号' in colIndex)) {
      if (!result._diag.reason) result._diag.reason = 'no_cno_col';
      Object.assign(result._diag.acceptedColumns, colIndex);
      continue;
    }
    const cnoCol = colIndex['合同编号'];
    for (let i = headerRow + 1; i < df.length; i++) {
      const row = df[i] || [];
      if (!row.some((v) => notNa(v))) continue;
      const firstVal = notNa(row[0]) ? String(row[0]) : '';
      if (firstVal.includes('合计') || firstVal.includes('小计')) continue;
      let rawCno = '';
      if (cnoCol < row.length && notNa(row[cnoCol])) rawCno = String(row[cnoCol]).trim();
      const cno = rawCno ? normContractNo(rawCno) : lastCno;
      if (!cno) continue;
      lastCno = cno;
      const dispCno = rawCno || cno;
      const line = { '货物名称': '', '规格': '', '数量': 0.0, '单位': '', '单价': 0.0, '金额': 0.0, '备注': '', '合约编号': dispCno, _norm_cno: cno };
      for (const stdName in colIndex) {
        if (stdName === '合同编号') continue;
        const colIdx = colIndex[stdName];
        if (colIdx >= row.length) continue;
        const val = row[colIdx];
        if (!notNa(val)) continue;
        if (['货物名称', '规格', '单位', '备注'].includes(stdName)) line[stdName] = String(val).trim();
        else line[stdName] = safeFloat(val);
      }
      if (!line['货物名称'] && line['数量'] <= 0) continue;
      allLines.push(line);
    }
  }
  if (allLines.length) {
    result.review_flags = applyWhitelistConstraints(allLines, '');
  } else if (!result._diag.reason) {
    result._diag.reason = 'no_data';
  }
  for (const ln of allLines) {
    ln['规格原文'] = String(ln['规格']);  // 保存原始规格（用于核对表格显示，不提 fuzzyMatchSpec 的归一化）
    ln['规格'] = fuzzyMatchSpec(String(ln['规格']));
  }
  const ledger = {};
  const order = [];
  for (const ln of allLines) {
    const k = ln._norm_cno;
    if (!(k in ledger)) { ledger[k] = []; order.push(k); }
    const clean = {};
    for (const kk in ln) { if (!kk.startsWith('_')) clean[kk] = ln[kk]; }
    ledger[k].push(clean);
  }
  result.ledger = ledger;
  result.contract_nos = order;
  result.text_length = allLines.length;
  if (order.length) { result['合约编号'] = order[0]; result['合约编号_全部'] = order; result.raw_fields['合约编号'] = order[0]; }
  // 诊断信息（用于上传时给出精确错误）——只补 sheets，不清空已收集的 headerRows/acceptedColumns/reason
  if (!result._diag) result._diag = { headerRows: [], acceptedColumns: {} };
  if (!Array.isArray(result._diag.headerRows)) result._diag.headerRows = [];
  if (!result._diag.acceptedColumns || typeof result._diag.acceptedColumns !== 'object') result._diag.acceptedColumns = {};
  result._diag.sheets = wb.SheetNames;
  // 极端兜底：如果 ledger 仍空但 _diag 也没填 reason，标注 no_diag（调试用）
  if (!Object.keys(ledger).length && !result._diag.reason) {
    result._diag.reason = 'no_diag';
    result._diag.totalRows = df.length;
    result._diag.headerRow = headerRow;
  }
  return result;
}
export function parseExcel(arrayBuffer, docType) {
  const result = { doc_type: docType, text_length: 0, products: [], raw_fields: {} };
  const COL_MAP = {
    '货物名称': ['货物名称', '产品名称', '名称', '货名', '品名', '材料名称', '物料名称'],
    '规格': ['规格', '规格型号', '型号', '规格尺寸', '尺寸', '材料属性二'],
    '数量': ['数量', '重量', '吨数', '件数', '总量', '实发数量'],
    '单位': ['单位', '计量单位', '包装单位', '库存单位'],
    '单价': ['单价', '含税单价', '不含税单价', '价格'],
    '总价': ['总价', '金额', '合计', '价税合计', '含税金额', '不含税金额', '金额（本位币）'],
    '物料编码': ['物料编码'],
  };
  let wb;
  // ⚠️ 同样：浏览器 ArrayBuffer → Uint8Array
  const input2 = (arrayBuffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && arrayBuffer instanceof SharedArrayBuffer))
    ? new Uint8Array(arrayBuffer) : arrayBuffer;
  try { wb = getXLSX().read(input2, { type: 'array' }); } catch (e) { return result; }
  const allProducts = [];
  for (const sheetName of wb.SheetNames) {
    let df;
    try { df = sheetRows(wb, sheetName); } catch (e) { continue; }
    if (!df.length || df.length < 2) continue;
    let headerRow = -1;
    for (let i = 0; i < Math.min(20, df.length); i++) {
      const rowVals = (df[i] || []).filter((v) => notNa(v)).map((v) => String(v).trim());
      const rowStr = rowVals.join(' ');
      const hits = ['货物', '产品', '名称', '规格', '型号', '数量'].filter((k) => rowStr.includes(k)).length;
      if (hits >= 2) { headerRow = i; break; }
    }
    if (headerRow < 0) continue;
    const colIndex = {};
    const headerRowData = df[headerRow] || [];
    for (let j = 0; j < headerRowData.length; j++) {
      const val = String(headerRowData[j] ?? '').trim();
      if (!notNa(headerRowData[j]) || val === 'nan' || !val) continue;
      for (const stdName in COL_MAP) {
        if (stdName in colIndex) continue;
        if (stdName === '货物名称' && val.includes('报关')) continue;
        if (COL_MAP[stdName].some((a) => val.includes(a))) { colIndex[stdName] = j; break; }
      }
    }
    for (let i = headerRow + 1; i < df.length; i++) {
      const row = df[i] || [];
      if (!row.some((v) => notNa(v))) continue;
      const firstVal = notNa(row[0]) ? String(row[0]) : '';
      if (firstVal.includes('合计') || firstVal.includes('小计')) continue;
      const product = { '货物名称': '', '规格': '', '数量': 0, '单位': '吨', '单价': 0, '总价': 0 };
      for (const stdName in colIndex) {
        const colIdx = colIndex[stdName];
        if (colIdx >= row.length) continue;
        const val = row[colIdx];
        if (!notNa(val)) continue;
        product[stdName] = ['货物名称', '规格', '单位', '物料编码'].includes(stdName) ? String(val).trim() : safeFloat(val);
      }
      const matCode = product['物料编码'] || '';
      if (!product['规格'] && matCode) {
        const info = MATERIAL_SPEC_MAP[String(matCode).trim().toUpperCase()];
        if (info) product['规格'] = info.spec;
      }
      if (!product['货物名称'] && product['数量'] <= 0) continue;
      delete product['物料编码'];
      allProducts.push(product);
    }
  }
  result.review_flags = applyWhitelistConstraints(allProducts, '');
  try {
    const cellText = [];
    for (const sn of wb.SheetNames) {
      for (const row of sheetRows(wb, sn)) {
        for (const v of row) { if (notNa(v)) cellText.push(String(v)); }
      }
    }
    const cnos = extractContractNo(cellText.join(' '));
    if (cnos.length) { result['合约编号'] = cnos[0]; result['合约编号_全部'] = cnos; if (!result.raw_fields['合约编号']) result.raw_fields['合约编号'] = cnos[0]; }
  } catch (e) { /* ignore */ }
  result.products = allProducts;
  result.text_length = allProducts.length;
  return result;
}
