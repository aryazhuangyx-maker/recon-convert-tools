// frontend-api.js — 本地 API 层
import * as storage from './storage.js?v=20260826q';
import { parseContractLedger, parseExcel, setXLSX } from './parse-excel.js?v=20260826q';
import { runExtract } from './ocr-doc.js?v=20260826q';
import { buildReconcileGroups } from './reconcile.js?v=20260826q';
import { loadGarbleFix, getGarbleFix } from './garble.js?v=20260826q';
import { loadWhitelist } from './whitelist.js?v=20260826q';
export async function initFrontend() {
  const wlResp = await fetch('data/whitelist.json');
  loadWhitelist(await wlResp.json());
  const userGarble = storage.loadGarbleFixUser();
  const baseResp = await fetch('data/garble_fix.json');
  const baseGarble = await baseResp.json();
  loadGarbleFix({ ...baseGarble, ...(userGarble || {}) });
  if (window.XLSX) setXLSX(window.XLSX);
  return true;
}
export function persistGarble() { storage.saveGarbleFixUser(getGarbleFix()); }
export function apiMappings() { return storage.loadMappingsList(); }
export async function apiUploadMapping(file) {
  // 1) 文件类型校验：必须是 Excel
  if (!/\.(xlsx|xls)$/i.test(file.name || '')) {
    return { error: '该文件不是 Excel（' + (file.name || '').slice(-30) + '）。请上传 .xlsx 或 .xls 格式的合同台账——不是合同 PDF。' };
  }
  const buf = await file.arrayBuffer();
  let parsed;
  try { parsed = parseContractLedger(buf); }
  catch (e) { return { error: '文件解析失败：' + (e.message || e) }; }
  // 2) 细分错误
  if (!Object.keys(parsed.ledger || {}).length) {
    const hint = parsed._diag || {};
    let msg = '未解析出合同台账';
    if (hint.reason === 'no_header') msg += '：在文件前 25 行未找到含「合同/物料/规格/数量」关键词的表头行';
    else if (hint.reason === 'no_cno_col') msg += '：找到了表头但缺少「合同编号/合约编号/合同号」列';
    else if (hint.reason === 'no_data') msg += '：找到了表头和合同编号列，但没有有效数据行';
    else if (hint.reason === 'no_diag') msg += '（诊断无原因，sheets=' + JSON.stringify(hint.sheets) + ' totalRows=' + hint.totalRows + ' headerRow=' + hint.headerRow + '）';
    else msg += '（请检查表头是否为 合同编号/物料名称/规格型号/数量）';
    return { error: msg, diag: hint };
  }
  const item = storage.saveMapping(file.name.replace(/\.(xlsx|xls)$/i, ''), parsed);
  return { item, parsed };
}
export function apiMappingSelect(name, session) {
  // 用户首次选台账时 session 可能还没建（仅在上传文件时才 createSession），自动补建
  if (!session) session = createSession();
  const data = storage.loadMapping(name);
  if (data) session.activeMapping = data;
  return !!data;
}
export function apiMappingClear(session) {
  if (!session) return;
  session.activeMapping = null;
}
export function apiMappingActive(session) { return session.activeMapping || null; }
export function apiMappingDelete(name) { storage.deleteMapping(name); }
export function apiMappingDetail(name) { return storage.mappingDetail(name); }
export function createSession() {
  const s = { contract: [], delivery: [], pi: [], extracted: null, reconcile: null, overrides: {}, activeMapping: null };
  storage.setSession(s);
  return s;
}
export async function apiUpload(session, filesByType) {
  for (const type of ['contract', 'delivery', 'pi']) {
    session[type] = [];
    for (const file of (filesByType[type] || [])) {
      const data = await file.arrayBuffer();
      const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
      session[type].push({ name: file.name, data, ext });
    }
  }
  return session;
}
export function apiCleanup() { storage.clearSession(); }
export async function apiExtract(session, onProgress) {
  const results = await runExtract(session, onProgress);
  session.extracted = results;
  return results;
}
export function apiReconcile(session) {
  if (!session.extracted) return { error: '请先执行识别提取' };
  const contractDoc = session.extracted.contract || {};
  let ledger = contractDoc.ledger || {};
  // ⚠️ 如果合同PDF没有上传（用户只上传了送货单/发票），回退到手动选择的映射表
  // 否则映射表合同号被丢弃，引擎会从 pinnedCnos 硬编码 YB-WLP-004 匹配到钢筋
  if (!Object.keys(ledger).length && session.activeMapping && session.activeMapping.ledger) {
    ledger = session.activeMapping.ledger;
  }
  const deliveryDoc = session.extracted.delivery || {};
  const piDoc = session.extracted.pi || {};
  // pinnedCnos 改为从映射表合同号动态获取，而非硬编码 YB-WLP-004
  const pinnedCnos = Object.keys(ledger);
  const result = buildReconcileGroups({
    ledger,
    deliveryLines: (deliveryDoc.products || []).map((x) => ({ ...x })),
    piLines: (piDoc.products || []).map((x) => ({ ...x })),
    overrides: session.overrides || {},
    pinnedCnos,
    deliveryDoc: { '合约编号': deliveryDoc['合约编号'], '合约编号_全部': deliveryDoc['合约编号_全部'] },
    piDoc: { '合约编号': piDoc['合约编号'], '合约编号_全部': piDoc['合约编号_全部'] },
  });
  session.reconcile = result;
  return result;
}
export function apiReconcileEdit(session, payload) {
  const contractDoc = session.extracted.contract || {};
  let ledger = { ...(contractDoc.ledger || {}) };
  // 同样回退到映射表
  if (!Object.keys(ledger).length && session.activeMapping && session.activeMapping.ledger) {
    ledger = { ...session.activeMapping.ledger };
  }
  const cLines = payload.contract_rows || [];
  if (cLines.length) {
    for (const cl of cLines) {
      const cno = cl['合约编号'] || '';
      if (!cno) continue;
      if (!ledger[cno]) ledger[cno] = [];
      const seen = new Set();
      for (const existing of ledger[cno]) seen.add(String(existing['规格'] || ''));
      if (!seen.has(String(cl['规格'] || ''))) ledger[cno].push({ ...cl });
    }
  }
  const deliveryDoc = session.extracted.delivery || {};
  const piDoc = session.extracted.pi || {};
  const pinnedCnos = Object.keys(ledger);
  const result = buildReconcileGroups({
    ledger,
    deliveryLines: payload.delivery_rows || [],
    piLines: payload.pi_rows || [],
    overrides: session.overrides || {},
    pinnedCnos,
    deliveryDoc: { '合约编号': deliveryDoc['合约编号'], '合约编号_全部': deliveryDoc['合约编号_全部'] },
    piDoc: { '合约编号': piDoc['合约编号'], '合约编号_全部': piDoc['合约编号_全部'] },
  });
  session.reconcile = result;
  return result;
}
export function apiContractOverride(session, cno, contractKey) {
  if (!session) return false;   // 防御：session 缺失时静默失败，不阻断流程
  if (!session.overrides) session.overrides = {};
  if (contractKey === null || contractKey === undefined) delete session.overrides[cno];
  else session.overrides[cno] = contractKey;
  return true;
}
export function apiContractOverrideGet(session) { return session.overrides || {}; }
