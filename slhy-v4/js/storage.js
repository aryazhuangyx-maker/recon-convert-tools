// storage.js — 前端化持久化层
const MAPPINGS_KEY = 'slhy_mappings_list';
const MAPPING_PREFIX = 'slhy_mapping_';
const GARBLE_KEY = 'slhy_garble_fix';
function lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { console.error('[storage] lsSet 失败:', key, e.message); throw e; }  // 不静默，让错误浮出
}
export function loadMappingsList() { return lsGet(MAPPINGS_KEY, []); }
function saveMappingsList(list) { lsSet(MAPPINGS_KEY, list); }
export function saveMapping(name, data) {
  lsSet(MAPPING_PREFIX + name, data);
  const list = loadMappingsList();
  const idx = list.findIndex((m) => m.name === name);
  const item = { name, contract_count: Object.keys(data.ledger || {}).length, created_at: data.created_at || new Date().toISOString().slice(0, 10) };
  if (idx >= 0) list[idx] = item; else list.unshift(item);
  saveMappingsList(list);
  return item;
}
export function loadMapping(name) { return lsGet(MAPPING_PREFIX + name, null); }
export function deleteMapping(name) {
  try { localStorage.removeItem(MAPPING_PREFIX + name); } catch (e) {}
  saveMappingsList(loadMappingsList().filter((m) => m.name !== name));
}
export function mappingDetail(name) {
  const data = loadMapping(name);
  if (!data || !data.ledger) return [];
  const out = [];
  for (const cno in data.ledger) {
    const lines = data.ledger[cno] || [];
    let total = 0, unit = '', goods = '';
    for (const ln of lines) {
      total += Number(ln['数量'] || 0);
      if (!unit) unit = ln['单位'] || '';
      if (!goods) goods = ln['货物名称'] || '';
    }
    out.push({ '合约编号': cno, '货物名称': goods, 行数: lines.length, 总数量: Math.round(total * 1000) / 1000, 单位: unit });
  }
  return out;
}
export function loadGarbleFixUser() { return lsGet(GARBLE_KEY, null); }
export function saveGarbleFixUser(data) { lsSet(GARBLE_KEY, data); }
let sessionState = null;
export function getSession() { return sessionState; }
export function setSession(s) { sessionState = s; }
export function clearSession() { sessionState = null; }
