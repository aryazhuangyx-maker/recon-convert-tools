/**
 * 内销开票核对工具 — 前端交互逻辑
 */
import { getSession, clearSession } from './storage.js?v=20260826q';

const MAX_FILES = 10;
let sessionId = null;
let uploadedFiles = {};
let extractedData = null;
let comparisonData = null;
let reconcileData = null;

// ⚠️ 动态 import frontend-api 加时间戳，彻底避免浏览器缓存旧版本
let API = null;
let frontReady = false;
async function ensureFront() {
  if (!API) API = await import('./frontend-api.js?' + Date.now());
  if (!frontReady) { await API.initFrontend(); frontReady = true; }
  if (!getSession()) API.createSession();
  if (!sessionId) sessionId = 'local';
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let mappingName = null;  // 当前选中的映射表名称

function setStepper(activeStep) {
  $$('.stepper-step').forEach(s => {
    const n = parseInt(s.dataset.step);
    s.classList.remove('active', 'done');
    if (n < activeStep) s.classList.add('done');
    if (n === activeStep) s.classList.add('active');
    // done 步骤的数字替换为 ✓ SVG 图标
    const num = s.querySelector('.stepper-num');
    if (num) {
      if (n < activeStep) {
        num.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      } else {
        num.textContent = String(n);
      }
    }
  });
}

function showStep(n) {
  // 1. 更新步骤条 active
  $$('.stepper-step').forEach(s => s.classList.remove('active'));
  const cur = $(`.stepper-step[data-step="${n}"]`);
  if (cur) cur.classList.add('active');
  // 2. 隐藏所有 step 板块，显示目标（同一 step 可能多个面板，如步骤2=进度+识别结果，全部显示）
  $$('[data-step-panel]').forEach(p => p.classList.add('hidden'));
  $$(`[data-step-panel="${n}"]`).forEach(t => t.classList.remove('hidden'));
}

function setupUploadZones() {
  $$('.upload-zone').forEach(zone => {
    const docType = zone.dataset.type;
    const input = $(`#input-${docType}`);
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files.length > 0) handleFiles(docType, Array.from(input.files));
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleFiles(docType, Array.from(e.dataTransfer.files));
    });
    // ── 每个已上传文件后的红色「−」删除按钮（事件委托，阻止冒泡以免误触发文件选择）──
    const info = $(`#info-${docType}`);
    if (info) {
      info.addEventListener('click', e => {
        const btn = e.target.closest('.zf-del');
        if (!btn) return;
        e.stopPropagation();
        removeUploadedFile(btn.dataset.dt, btn.dataset.key);
      });
    }
  });
}

function handleFiles(docType, newFiles) {
  let existing = uploadedFiles[docType] || [];
  const names = new Set(existing.map(f => f.name + '_' + f.size));
  for (const f of newFiles) {
    if (existing.length >= MAX_FILES) break;
    if (!names.has(f.name + '_' + f.size)) {
      existing.push(f); names.add(f.name + '_' + f.size);
    }
  }
  uploadedFiles[docType] = existing.slice(0, MAX_FILES);
  updateUploadUI(docType);
  checkUploadReady();
}

function updateUploadUI(docType) {
  const files = uploadedFiles[docType] || [];
  const zone = $(`#zone-${docType}`);
  const info = $(`#info-${docType}`);
  if (files.length === 0) {
    zone.classList.remove('has-file'); info.innerHTML = ''; return;
  }
  zone.classList.add('has-file');
  const icon = f => f.name.match(/\.xlsx?$/i) ? '📊' : '📄';
  info.innerHTML = files.map(f => {
    const key = f.name + '_' + f.size;
    return `<span class="zf-item">${icon(f)} ${esc(f.name)} (${formatSize(f.size)})` +
      `<button type="button" class="zf-del" title="删除此文件" data-dt="${docType}" data-key="${esc(key)}">−</button></span>`;
  }).join('');
}

function removeUploadedFile(docType, key) {
  uploadedFiles[docType] = (uploadedFiles[docType] || []).filter(f => (f.name + '_' + f.size) !== key);
  if (!uploadedFiles[docType].length) delete uploadedFiles[docType];
  updateUploadUI(docType);
  checkUploadReady();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + 'KB';
  return (bytes/1048576).toFixed(1) + 'MB';
}

function checkUploadReady() {
  $('#btn-upload').disabled = Object.keys(uploadedFiles).length === 0;
}

function setupButtons() {
  $('#btn-upload').addEventListener('click', doUpload);
  $('#btn-reset').addEventListener('click', doReset);
}

async function doUpload() {
  if (!Object.keys(uploadedFiles).length) return;
  const btn = $('#btn-upload');
  const btnText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span> 上传中…';
  try {
    await ensureFront();
    await API.apiUpload(getSession(), uploadedFiles);

    // 若 Step0 已暂存全局合约选择，上传后立即同步
    if (pendingGlobalSelection && pendingGlobalSelection.length) {
      API.apiContractOverride(getSession(), '*', pendingGlobalSelection);
    }

    // Estimate OCR time（本地按文件数）
    let totalPages = 0, excelCount = 0;
    for (const flist of Object.values(uploadedFiles))
      for (const f of (flist || [])) {
        totalPages += 1;
        if (f.name && /.(xlsx|xls)$/i.test(f.name)) excelCount++;
      }
    const units = Math.max(totalPages + excelCount * 2, 1);
    // 时间驱动：预估识别总时长（每 unit ≈3 秒），下限 8 秒
    const totalSec = Math.max(units * SEC_PER_UNIT, 8);

    showProgressPanel();
    setStepper(3);
    // 点击"开始识别" → 自动切换到步骤 3（处理中 + 识别结果）
    showStep(3);
    await doExtract(totalSec);
  } finally {
    // 无论成功/失败都恢复按钮文字与可用状态：
    // 上传完成后回到上传界面时按钮应显示正常的"开始识别"（禁用与否由 checkUploadReady 决定）
    btn.disabled = false;
    btn.innerHTML = btnText;
    checkUploadReady();
  }
}


async function loadMappings() {
  await ensureFront();
  const list = API.apiMappings();
  {
    const sel = $('#mapping-select');
    sel.innerHTML = '<option value="">— 请选择 —</option>';
    list.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name + '（' + m.contract_count + '项）';
      if (m.name === mappingName) opt.selected = true;
      sel.appendChild(opt);
    });
    updateMappingStatus();
    // ✅ 不自动展开台账明细：上传/选中后先隐藏，等用户点「手动选择合同」再显示（用户2026-08-24明确）
    const _wrap = $('#mapping-preview-wrap');
    if (_wrap) _wrap.style.display = 'none';
  }
}

let mappingContracts = [];  // [{合约编号, 货物名称, 行数, 总数量, 单位}]
function loadMappingPreview() {
  if (!mappingName) return;
  mappingContracts = API.apiMappingDetail(mappingName) || [];
  renderMappingPreview();
}

function renderMappingPreview() {
  const wrap = $('#mapping-preview-wrap');
  const tbody = $('#mapping-preview-tbody');
  if (!wrap || !tbody) return;
  if (!mappingContracts.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  tbody.innerHTML = mappingContracts.map((c, i) => `
    <tr ondblclick="quickSelectContract(${i})" style="cursor:pointer" title="双击直接确认该合同并去上传">
      <td><input type="checkbox" class="mapping-preview-cb" data-idx="${i}" onchange="updateMappingCount()"></td>
      <td><code>${esc(c.合约编号)}</code></td>
      <td>${esc(c.货物名称)}</td>
      <td>${c.行数}</td>
      <td>${c.总数量}</td>
      <td>${esc(c.单位)}</td>
    </tr>`).join('');
  $('#mapping-select-all').checked = false;
  updateMappingCount();
}

function quickSelectContract(i) {
  // 只选中这一行（清掉其它勾选）
  document.querySelectorAll('.mapping-preview-cb').forEach(cb => cb.checked = false);
  const cb = document.querySelector(`.mapping-preview-cb[data-idx="${i}"]`);
  if (cb) cb.checked = true;
  $('#mapping-select-all').checked = false;
  updateMappingCount();
  goUploadFromMapping();   // 校验(已选1个✓) + 保存勾选 + 隐藏合同区 + 跳上传
}

function toggleSelectAllMapping() {
  const on = $('#mapping-select-all').checked;
  document.querySelectorAll('.mapping-preview-cb').forEach(cb => cb.checked = on);
  updateMappingCount();
}

function updateMappingCount() {
  const n = document.querySelectorAll('.mapping-preview-cb:checked').length;
  const el = $('#mapping-selected-count');
  if (el) el.textContent = '已选 ' + n + ' / ' + mappingContracts.length + ' 个合约';
}

let pendingGlobalSelection = null;  // 尚未创建 session 时暂存

function confirmContractSelection() {
  const selected = [];
  document.querySelectorAll('.mapping-preview-cb:checked').forEach(cb => {
    const c = mappingContracts[parseInt(cb.dataset.idx)];
    if (c) selected.push(c.合约编号);
  });
  pendingGlobalSelection = selected;
  if (!sessionId) { return; }   // 静默暂存（上传文件后自动生效），不弹窗
  API.apiContractOverride(getSession(), '*', selected);
  if (reconcileData) rerunReconcile();
}

function updateMappingStatus() {
  const st = $('#mapping-status');
  const delBtn = $('#btn-delete-mapping');
  if (mappingName) {
    st.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M20 6 9 17l-5-5"/></svg>当前映射：<strong>' + mappingName + '</strong>';
    if (delBtn) delBtn.disabled = false;
  } else {
    st.innerHTML = '⚠ 请选择或上传一个台账映射表';
    if (delBtn) delBtn.disabled = true;
  }
}

let modeManual = false;   // true=手动选择合同（隐藏合同上传区），false=PDF识别合同（显示三类）

function showModePicker() {
  const picker = $('#mode-picker');
  if (picker) picker.classList.remove('hidden');
  // 折叠台账明细，等用户选「手动选择合同」再展开
  const wrap = $('#mapping-preview-wrap');
  if (wrap) wrap.style.display = 'none';
  showStep(1);   // 停留在映射步骤，让用户看到模式卡片
}

function setUploadGridMode(n) {
  const g = document.querySelector('.upload-grid');
  if (!g) return;
  g.classList.toggle('grid-2', n === 2);
  g.classList.toggle('grid-3', n !== 2);
}

function chooseManualMode() {
  modeManual = true;
  $('#mode-picker').classList.add('hidden');
  // 显示台账明细（默认不全选），停留在步骤 1 让用户勾选
  if (mappingContracts.length === 0) loadMappingPreview();
  else renderMappingPreview();
  hideContractZone();
  setUploadGridMode(2);
  setStepper(1);
  showStep(1);
}

function choosePdfMode() {
  modeManual = false;
  $('#mode-picker').classList.add('hidden');
  showContractZone();
  setUploadGridMode(3);
  setStepper(2);
  showStep(2);
}

async function goUploadFromMapping() {
  console.log('goUploadFromMapping called');
  await ensureFront();   // ⚠️ 修复：必须先初始化 API，否则 API=null 导致后续全跳步
  const checked = document.querySelectorAll('.mapping-preview-cb:checked');
  console.log('checked count:', checked.length);
  if (!checked.length) { alert('请至少勾选一个合同，再点击「去上传」'); return; }
  confirmContractSelection();   // 保存选中合约到 pendingGlobalSelection / contract_override
  modeManual = true;
  $('#mode-picker').classList.add('hidden');
  hideContractZone();
  setUploadGridMode(2);
  setStepper(2);
  showStep(2);
  console.log('showStep(2) done');
}

function hideContractZone() {
  const zone = $('#zone-contract');
  if (zone) zone.style.display = 'none';
  // 只显示送货单 + 形式发票
  ['zone-delivery', 'zone-pi'].forEach(id => {
    const el = $('#' + id);
    if (el) el.style.display = '';
  });
}

function showContractZone() {
  const zone = $('#zone-contract');
  if (zone) zone.style.display = '';
}

function selectMapping() {
  const name = $('#mapping-select').value;
  if (!name) { mappingName = null; updateMappingStatus(); return; }
  const ok = API.apiMappingSelect(name, getSession());
  if (ok) {
    mappingName = name;
    updateMappingStatus();
    setStepper(1);
    showModePicker();
  }
}

// 上传处理函数（实际业务逻辑），暴露给 window._uploadMappingFile 供 index.html 内联调用
window._uploadMappingFile = async function(file, name) {
  await ensureFront();
  return API.apiUploadMapping(file, name);
};

function deleteMapping() {
  const name = mappingName;
  if (!name) return;
  if (!confirm('确定要删除映射表「' + name + '」吗？此后需要重新上传才能使用。')) return;
  API.apiMappingDelete(name);
  mappingName = null;
  loadMappings();
  updateMappingStatus();
  setStepper(1);
}

document.addEventListener('DOMContentLoaded', () => {
  // 先初始化单步视图，确保页面只显示步骤 1（映射表）——放在最前，避免后续初始化异常影响
  showStep(1);
  try { loadMappings(); } catch (e) { console.error('loadMappings:', e); }
  // 映射表下拉切换事件
  const sel = $('#mapping-select');
  if (sel) sel.addEventListener('change', selectMapping);

  // ── 步骤条：点击圆点/文字切换到对应单步视图 ──
  $$('.stepper-step').forEach(el => {
    const num = el.querySelector('.stepper-num');
    const lbl = el.querySelector('.stepper-label');
    const handler = () => showStep(parseInt(el.dataset.step || '1', 10));
    if (num) { num.style.cursor = 'pointer'; num.addEventListener('click', handler); }
    if (lbl) { lbl.style.cursor = 'pointer'; lbl.addEventListener('click', handler); }
  });
});

const PROGRESS_STEPS = [
  { id: 'ocr', label: '识别处理中', detail: '等待开始…', pct: 0, cls: 'waiting' },
];
const SEC_PER_UNIT = 3;                    // 时间驱动：每 unit（1 页或 1 个 Excel）预估耗时（秒）
let progressTimers = {};
let progressInited = false;              // 进度 DOM 只构建一次
let lastPctByStep = {};                  // 活度检测：stepId -> 上次 pct
let stallCount = {};                     // 活度检测：stepId -> 连续未变次数
const STALL_THRESHOLD = 8;               // 连续 8 次轮询(~3.2s)pct 未变 -> indeterminate

function showProgressPanel() {
  $('#step1').classList.add('hidden');
  $('#progress-panel').classList.remove('hidden');
}

function ensureProgressPanel() {
  if (progressInited) return;
  progressInited = true;
  $('#progress-steps').innerHTML = PROGRESS_STEPS.map(s => `
    <div class="progress-item" data-id="${s.id}">
      <div class="pi-header">
        <span class="pi-label">${s.label}</span>
      </div>
      <div class="pi-detail" data-role="detail"></div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill waiting" data-role="bar" style="width:5%"></div>
        <div class="progress-bar-center-pct" data-role="center-pct">0%</div>
      </div>
    </div>`).join('');
}

function renderAllProgress() {
  ensureProgressPanel();
  for (const s of PROGRESS_STEPS) {
    const item = document.querySelector(`#progress-steps .progress-item[data-id="${s.id}"]`);
    if (!item) continue;
    const bar  = item.querySelector('[data-role="bar"]');
    const cpct = item.querySelector('[data-role="center-pct"]');
    const detEl = item.querySelector('[data-role="detail"]');
    const cls = s.cls || (s.pct >= 100 ? 'done' : 'running');
    bar.className = 'progress-bar-fill ' + cls;
    bar.style.width = Math.max(s.pct, 5) + '%';
    // 百分数文字跟随填充条：位置 = pct/2%（始终在条纹区中央，pct=45% 时在 22.5%）
    cpct.style.left = (s.pct / 2) + '%';
    cpct.textContent = s.pct + '%';
    detEl.textContent = s.detail;
  }
}

function updateStep(id, pct, detail, cls) {
  const s = PROGRESS_STEPS.find(x => x.id === id);
  if (!s) return;
  pct = Math.min(pct, 100);
  // 活度检测：pct 连续 STALL_THRESHOLD 次未变 -> 疑似无真实进度 -> 流动动画
  if (lastPctByStep[id] === pct && s.cls !== 'done') {
    stallCount[id] = (stallCount[id] || 0) + 1;
  } else {
    stallCount[id] = 0;
    lastPctByStep[id] = pct;
  }
  s.pct = pct;
  s.detail = detail || s.detail;
  s.cls = cls || (stallCount[id] >= STALL_THRESHOLD
      ? 'indeterminate'
      : (pct >= 100 ? 'done' : 'running'));
  renderAllProgress();
}

function finishStep(id, detail) {
  if (progressTimers[id]) { clearInterval(progressTimers[id]); delete progressTimers[id]; }
  updateStep(id, 100, detail);
}

async function doExtract(totalSec) {
  // 纯前端：直接 await 本地引擎执行
  const startTime = Date.now();
  // 重置步骤状态（清空之前可能的错误文字）
  updateStep('ocr', 0, '准备识别…', 'running');
  updateStep('ocr', 3, '排队等待中…');
  let results;
  try {
    results = await API.apiExtract(getSession(), ({ stage, page, total, file }) => {
      const elapsed = (Date.now() - startTime) / 1000;
      const virtualPct = Math.min(Math.round(elapsed / totalSec * 100), 98);
      let detail = stage === 'contract' ? '识别合同' : stage === 'delivery' ? '识别送货单' : stage === 'pi' ? '识别形式发票' : (stage || '处理中…');
      if (file) detail += '：' + file;
      if (total > 0) detail += ' 第 ' + (page || 0) + '/' + total + ' 页';
      const remain = Math.max(0, Math.round(totalSec - elapsed));
      detail += '，预计还需 ' + remain + ' 秒';
      updateStep('ocr', Math.max(virtualPct, 3), detail + '…', 'running');
    });
  } catch (e) {
    console.error('[doExtract] 全栈:', e);
    const msg = (e && e.message) || (e && e.toString()) || '未知错误';
    const stack = (e && e.stack) ? e.stack.split(String.fromCharCode(10)).slice(0,3).join(' | ') : '';
    updateStep('ocr', 0, '识别失败: ' + msg + (stack ? ' [' + stack + ']' : ''));
    return;
  }
  extractedData = results;
  const cnt = Object.values(extractedData).filter(Boolean)
    .reduce((s, d) => s + (d.products ? d.products.length : 0), 0);
  finishStep('ocr', '识别完成，共提取 ' + cnt + ' 个产品行');
  updateStep('ocr', 100, '识别完成，共提取 ' + cnt + ' 个产品行', 'done');
  renderExtractStatus();
  $('#step2').classList.remove('hidden');
  showStep(3);
  setStepper(3);
  await doReconcile();
}

function renderExtractStatus() {
  const ICON_SVG = {
    contract: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 2h8v4H8z"/></svg>',
    delivery: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14M5 12h14M5 16h8"/><path d="M3 4h18v16H3z"/></svg>',
    pi: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M20 6 9 17l-5-5"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  };
  const labels = { contract: '销售合同', delivery: '送货单', pi: '形式发票' };
  $('#ocr-status').innerHTML = Object.entries(labels).map(([dt, label]) => {
    const doc = extractedData[dt];
    const ico = ICON_SVG[dt];
    const htmlLabel = `<span style="display:inline-flex;align-items:center;gap:6px">${ico}${label}</span>`;
    if (!doc) return `<div class="empty-state"><div class="es-icon">—</div>未上传</div>`;
    const n = doc.products ? doc.products.length : 0;
    const nf = doc.files_processed || 0;
    return `<div style="background:#f8fafc;border-radius:8px;padding:1rem;">
      <strong>${htmlLabel}</strong><br>
      <small style="color:var(--color-text-dim)">${ICON_SVG.folder}${nf} 个文件 · ${n > 0 ? ICON_SVG.check + n + ' 个产品行' : '0 个产品行'}</small>
    </div>`;
  }).join('');

  // ── 送货单/形式发票的合约编号（台账的全部合约号不展示，太长）──
  const cnoRows = [];
  for (const [dt, label] of Object.entries(labels)) {
    const doc = extractedData[dt];
    if (!doc) continue;
    if (dt === 'contract') continue;  // 台账合约号列表太长，不展示
    const ico = ICON_SVG[dt];
    let cnoContent = '';
    if (doc['contract_nos'] && doc['contract_nos'].length) {
      cnoContent = `台账合约号（${doc['contract_nos'].length}）：<code>${doc['contract_nos'].map(c => esc(c)).join('、')}</code>`;
    } else {
      const cnos = [];
      if (doc['合约编号']) cnos.push(doc['合约编号']);
      if (doc['合约编号_全部']) doc['合约编号_全部'].forEach(c => { if (c !== doc['合约编号']) cnos.push(c); });
      if (cnos.length) cnoContent = `合约编号：<code>${cnos.map(c => esc(c)).join('、')}</code>`;
    }
    if (cnoContent) {
      // grid 布局：左列 110px 固定对齐（图标+标签），右列合约编号占剩余
      cnoRows.push(`<div style="display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;padding:4px 0">
        <span style="display:inline-flex;align-items:center;gap:6px;color:var(--color-heading);font-weight:600">${ico}${label}</span>
        <span style="color:var(--color-text-dim);font-size:0.85rem">${cnoContent}</span>
      </div>`);
    }
  }
  const cnoBox = $('#cno-status');
  cnoBox.innerHTML = cnoRows.length
    ? `<div style="font-size:0.85rem;line-height:1.9">${cnoRows.join('')}</div>`
    : '';
}

async function doReconcile() {
  updateStep('compare', 5, '正在按合约编号关联合同…');
  const t0 = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (elapsed > 2) {
      updateStep('compare', Math.min(5 + elapsed * 5, 85),
        '正在核对中，已处理 ' + elapsed + ' 秒…');
    }
  }, 1000);
  try {
    const data = API.apiReconcile(getSession());
    clearInterval(timer);
    if (data.error) { updateStep('compare', 0, '核对失败：' + data.error); return; }
    reconcileData = data;

    const { summary } = data;
    const parts = [summary.ok + ' 核对无误', summary.not_shipped + ' 未发货', summary.error + ' 核对有误'];
    if (summary.new) parts.push(summary.new + ' 新合同');
    finishStep('compare', '核对完成：' + parts.join(' / '));
    if (progressTimers['compare']) { clearInterval(progressTimers['compare']); delete progressTimers['compare']; }

    renderReconcile(data);
    setStepper(4);
    renderReconcileSummary(data);

    // 三流核对完成 → 自动跳到步骤 4（showStep(4) 统一处理 panel 显隐）
    showStep(4);
  } catch (e) {
    clearInterval(timer);
    updateStep('compare', 0, '核对异常：' + (e.message||e));
  }
}

async function doRecheck() {
  // 从编辑后的对比表格收集数据
  const rows = [];
  const trs = $$('#compare-table tr');

  let currentContract = null;
  trs.forEach(tr => {
    if (tr.classList.contains('group-header-row')) return;

    // 合并后行内 td 数量不同，改用 class 定位读取
    function readCls(cls) {
      const td = tr.querySelector('td.' + cls);
      if (!td) return null;
      const span = td.querySelector('.cell-editable');
      const val = span ? span.textContent.trim() : (td.textContent || '').trim();
      return val === '' || val === '—' ? null : val;
    }

    const cName = readCls('col-c1'), cSpec = readCls('col-c2'), cQty = readCls('col-c3'), cUnit = readCls('col-c4'), cPrice = readCls('col-c5');
    // 检查此行是否有合同数据（合并行首行才有 col-c1；非首行继承上一行）
    const hasContract = !!cName || !!cSpec || !!cQty;

    let contract = null, delivery = null, pi = null;

    if (hasContract) {
      contract = { '货物名称': cName || '', '规格': cSpec || '', '数量': cQty, '单位': cUnit || '', '单价': cPrice };
      currentContract = contract;
    } else {
      contract = currentContract; // 继承上一行的合同
    }

    delivery = { '货物名称': readCls('col-d1') || '', '规格': readCls('col-d2') || '', '数量': readCls('col-d3'), '单位': readCls('col-d6') || '' };
    pi = { '货物名称': readCls('col-p1') || '', '规格': readCls('col-p2') || '', '数量': readCls('col-p3'), '单位': readCls('col-p7') || '', '单价': readCls('col-p8') };

    // Determine mapped status
    const statusBadge = tr.querySelector('.badge-sm');
    const statusText = statusBadge ? statusBadge.textContent.trim() : '';

    rows.push({
      contract: contract && contract['规格'] ? contract : null,
      delivery: delivery && delivery['规格'] ? delivery : null,
      pi: pi && pi['规格'] ? pi : null,
      mapped: statusText === '已对齐',
    });
  });

  // Send to recheck API
  try {
    const result = API.apiReconcile(getSession());
    if (result.error) { alert('重新核对失败: ' + result.error); return; }

    // Update check results
    renderCheckResult(result);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    alert('重新核对出错: ' + err.message);
  }
}

function extractRowData(tds, startIdx, count) {
  const fields = ['货物名称', '规格', '数量', '单位', '单价'];
  const item = {};
  let hasData = false;
  for (let i = 0; i < count; i++) {
    const val = tds[startIdx + i] ? tds[startIdx + i].textContent.trim() : '';
    if (val && val !== '—') hasData = true;
    item[fields[i]] = val;
  }
  return hasData ? item : null;
}

async function doReset() {
  API.apiCleanup();
  API.createSession();
  sessionId = 'local';
  uploadedFiles = {}; extractedData = null; comparisonData = null; reconcileData = null;
  PROGRESS_STEPS.forEach(s => { s.pct = 0; s.detail = '等待开始…'; s.cls = 'waiting'; });
  lastPctByStep = {}; stallCount = {};
  progressInited = false;
  Object.values(progressTimers).forEach(clearInterval); progressTimers = {};
  ['contract','delivery','pi'].forEach(t => { uploadedFiles[t] = []; updateUploadUI(t); $(`#input-${t}`).value = ''; });
  $('#progress-panel').classList.add('hidden');
  $('#btn-upload').disabled = true;
  $('#stat-cards').innerHTML = '';
  if ($('#anomaly-table')) $('#anomaly-table').innerHTML = '';
  $('#cno-status').innerHTML = '';
  $('#new-contract-banner').innerHTML = '';
  // 恢复默认：合同来源模式复位、合同上传区显示、模式卡片隐藏（下次重新走选择流程）
  modeManual = false;
  showContractZone();
  setUploadGridMode(3);
  $('#mode-picker').classList.add('hidden');
  // 清空已选择的台账：前端状态 + 下拉框 + 后端全局待选映射（防止下次上传继承旧台账）
  mappingName = null;
  mappingContracts = [];
  pendingGlobalSelection = null;
  const _sel = $('#mapping-select');
  if (_sel) _sel.value = '';
  updateMappingStatus();
  const _wrap = $('#mapping-preview-wrap');
  if (_wrap) _wrap.style.display = 'none';
  API.apiMappingClear(getSession());
  // 直接返回映射界面（步骤 1）
  setStepper(1);
  showStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderReconcile(data) {
  const groups = data.groups || [];

  // 合约编号"组头"行：渲染到表头最上方（绿色框位置）
  const groupHeadersHtml = groups.map((g, gIdx) => {
    const cCno = g.contract_合约编号 || '（无）';
    const dCno = g.delivery_合约编号 || '（无）';
    const pCno = g.pi_合约编号 || '（无）';
    const matchTag = (g.contract_合约编号 && g.delivery_合约编号 && _normCno(g.contract_合约编号) === _normCno(g.delivery_合约编号))
      ? '' : ' ⚠ 编号不完全一致';
    return `<tr class="group-header-row" data-gidx="${gIdx}"><th colspan="24" style="text-align:left;padding:0.7rem 1rem;font-size:0.8rem">
      <span style="display:inline-flex;align-items:center;gap:8px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M7 2h10v4H7zM5 6h14v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/></svg> 合约编号 — 合同：<code>${esc(cCno)}</code> ｜ 送货单：<code>${esc(dCno)}</code> ｜ 形式发票：<code>${esc(pCno)}</code>${matchTag}</span>
      <button class="btn btn-outline-primary btn-sm" style="margin-left:1rem;font-size:0.8rem" onclick="openContractPicker(${gIdx})"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M12 3v18M3 12h18"/></svg>更换合约</button>
    </th></tr>`;
  }).join('');

  // 表头（固定一次）+ 合约编号组合头行在上方
  const thead = `<tr class="section-head-row">
    <th rowspan="2">结果</th>
    <th rowspan="2">规格型号</th>
    <th colspan="5" class="section-header">合 同</th>
    <th colspan="6" class="section-header">送 货 单</th>
    <th colspan="8" class="section-header">形 式 发 票</th>
    <th rowspan="2">说明</th>
    <th rowspan="2" style="background:#fff7e6;color:#b45309;border-left:2px solid #f59e0b">单价核对</th>
    <th rowspan="2" style="background:#ecfdf5;color:#047857;border-left:2px solid #10b981">数量核对</th>
  </tr><tr class="col-head-row">
    <th>名称</th><th>规格</th><th>数量</th><th>单位</th><th>单价</th>
    <th>名称</th><th>规格</th><th>数量</th><th>数量汇总</th><th>送货单编号</th><th>单位</th>
    <th>名称</th><th>规格</th><th>数量</th><th>数量汇总</th><th>送货单编号</th><th>发票编号</th><th>单位</th><th>单价</th>
  </tr>`;
  $('#compare-thead').innerHTML = groupHeadersHtml + thead;

  function td(v, cls) { return `<td class="${cls||''}">${v===''||v===null||v===undefined?'—':v}</td>`; }

  // ── 单价核对 / 数量核对 单元格：显示具体数值 + 标记 ──
  // 数字格式化：按截图样式保留固定小数位(单价 2 位、数量 3 位),不裁尾零
  function _fmtPrice(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v.toFixed(2);
  }
  function _fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v.toFixed(3);
  }
  function priceCheckHtml(line) {
    const state = line['单价核对'];
    const c = line.contract || {}, p = line.pi || {};
    const cPrice = c.单价, pPrice = p.单价, pUnit = p.单位 || '';
    if (state === 'na') {
      return '<div class="check-cell na">—</div>';
    }
    if (state === 'pass') {
      const cps = _fmtPrice(cPrice), pps = _fmtPrice(pPrice);
      return `<div class="check-cell pass">✓ 合同 ${cps} = 发票 ${pps}${pUnit ? '/' + pUnit : ''}</div>`;
    }
    // fail
    const cps = _fmtPrice(cPrice), pps = _fmtPrice(pPrice);
    return `<div class="check-cell fail">✗ 合同 ${cps} ≠ 发票 ${pps}${pUnit ? '/' + pUnit : ''}</div>`;
  }
  function qtyCheckHtml(line) {
    const state = line['数量核对'];
    const c = line.contract || {};
    const totalD = Number(line['数量汇总送货'] || 0);
    const totalP = Number(line['数量汇总发票'] || 0);
    const cq = Number(c.数量 || 0);
    if (state === 'na') {
      return '<div class="check-cell na">—</div>';
    }
    const dOk = totalD <= cq + 1e-9;
    const pOk = totalP <= cq + 1e-9;
    const dSym = dOk ? '✓' : '✗', pSym = pOk ? '✓' : '✗';
    const dOp = dOk ? ' ≤ ' : ' > ';
    const pOp = pOk ? ' ≤ ' : ' > ';
    const ds = _fmt(totalD), ps = _fmt(totalP), cs = _fmt(cq);
    const dCls = dOk ? 'pass' : 'fail';
    const pCls = pOk ? 'pass' : 'fail';
    // 全 pass → 整块标记 pass；任一 fail → 整块 fail
    const blockCls = (dOk && pOk) ? 'pass' : 'fail';
    return `<div class="check-cell ${blockCls}">
      <span class="check-row ${dCls}">${dSym} 送货 ${ds}${dOp}合同 ${cs}</span>
      <span class="check-row ${pCls}">${pSym} 发票 ${ps}${pOp}合同 ${cs}</span>
    </div>`;
  }

  function tdEditable(v, cls) {
    const val = v===''||v===null||v===undefined?'—':esc(String(v));
    return `<td class="${cls||''}"><span class="cell-editable" contenteditable="true">${val}</span></td>`;
  }

  // 规格单元格：只剩品类名（无直径型号，如"热轧带肋钢筋"）→ 黄色警示，提示需重新识别或手工补全
  // ⚠️ 非钢筋品类（灯具/照明/电池）不标黄——钢筋直径匹配规则不适用于它们（用户2026-08-24明确）
  function specCell(v, cls) {
    const s = String(v || '');
    const isNonSteel = /照明|灯具|LED|电池|Battery/i.test(s);
    const generic = !isNonSteel && s && s !== '—' && !/[YTΦφ]\d|\d\s*mm/.test(s);
    return tdEditable(v, (cls || '') + (generic ? ' cell-generic' : ''));
  }

  // 跨行合并单元格（rowspan）——合并组首行使用，后续行不再输出该列
  function tdMerge(v, cls, rowspan) {
    const val = v===''||v===null||v===undefined?'—':esc(String(v));
    return `<td class="${cls||''}" rowspan="${rowspan}"><span class="cell-editable" contenteditable="true">${val}</span></td>`;
  }

  function aggTd(o, colspan, withPrice) {
    const details = (o._details || []).map(x => '·' + esc(x)).join('<br>');
    let h = `<b>Σ ${o._n} 行</b> = ${o.数量} ${esc(o.单位)}`;
    if (withPrice && o.单价 !== null && o.单价 !== '' && o.单价 !== undefined) h += `<br>单价 ${o.单价}`;
    h += `<br><span style="color:#64748b;font-size:0.72rem">${details}</span>`;
    return `<td colspan="${colspan}" class="col-c1" style="background:var(--color-primary-lt)">${h}</td>`;
  }

  function badge(result) {
    const map = {
      '核对无误': '<span class="badge-sm badge-ok">核对无误</span>',
      '未发货':   '<span class="badge-sm badge-warn">未发货</span>',
      '核对有误': '<span class="badge-sm badge-danger">核对有误</span>',
      '新合同':   '<span class="badge-sm badge-info">新合同</span>',
      '编号错误': '<span class="badge-sm badge-danger">编号错误</span>',
      '未识别':   '<span class="badge-sm badge-unk">未识别</span>',
    };
    return map[result] || `<span class="badge-sm badge-wait">${result}</span>`;
  }

  let tbody = '';
  if (!groups.length) {
    tbody = '<tr><td colspan="24" class="text-muted" style="padding:3rem"><div class="empty-state"><div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg></div>未匹配到任何合约编号</div></td></tr>';
  }

  groups.forEach((g, gIdx) => {
    if (!g.lines.length) {
      tbody += `<tr><td colspan="24" class="text-muted" style="padding:1rem">本合约编号下暂无明细行</td></tr>`;
    }

    // 按连续相同 规格型号 分组
    const lineGroups = [];
    for (const line of g.lines) {
      const spec = line.规格型号 || '';
      const last = lineGroups[lineGroups.length - 1];
      if (last && last.spec === spec) {
        last.lines.push(line);
      } else {
        lineGroups.push({ spec, lines: [line] });
      }
    }

    lineGroups.forEach((group, lgIdx) => {
      // 不同规格组之间加分隔线（第一个规格组不加）；用 box-shadow 模拟（不受行底色影响）
      const groupSepStyle = lgIdx > 0 ? 'box-shadow:inset 0 1px 0 #cbd5e1;' : '';
      // 进一步按"合并键"分组：规格型号+合同5列+数量汇总(送/发) 全部相同 → 跨行合并
      const mergeGroups = [];
      for (const line of group.lines) {
        const c = line.contract || {};
        const key = [
          line.规格型号 || '', c.货物名称 || '', c.规格原文 || c.规格 || '', c.数量 || '', c.单位 || '', c.单价 || '',
          line['数量汇总送货'] || '', line['数量汇总发票'] || '',
        ].join('|');
        const last = mergeGroups[mergeGroups.length - 1];
        if (last && last.key === key && !c._agg) {
          last.lines.push(line);
        } else {
          mergeGroups.push({ key, lines: [line] });
        }
      }

      mergeGroups.forEach(mg => {
        const n = mg.lines.length;
        mg.lines.forEach((line, li) => {
          const first = li === 0;
          const c = line.contract, d = line.delivery, p = line.pi;
          const baseCls = line.result === '核对有误' || line.result === '编号错误' ? 'row-unmapped'
                         : line.result === '未发货' ? 'row-wait'
                         : 'row-mapped';
          // 编号不对应（送货单编号↔发票编号）→ 极浅暖色高亮整行
          const noMatchNo = line['编号对应'] === false;
          // 每个规格组的首行加上分隔线（与上一规格组视觉隔离）
          const sepStyle = first ? groupSepStyle : '';
          if (noMatchNo) {
            tbody += `<tr class="${baseCls}" style="background:var(--color-warning-lt);${sepStyle}">`;
          } else if (sepStyle) {
            tbody += `<tr class="${baseCls}" style="${sepStyle}">`;
          } else {
            tbody += `<tr class="${baseCls}">`;
          }
          tbody += `<td>${badge(line.result)}</td>`;
          // 规格型号（跨行合并）
          if (first) {
            tbody += tdMerge(line.规格型号, 'col-spec', n);
          }
          // 合同（跨行合并：名称/规格/数量/单位/单价）
          if (first) {
            tbody += c ? (c._agg ? aggTd(c, 5, true) : tdMerge(c.货物名称, 'col-c1', n) + tdMerge(c.规格原文 || c.规格, 'col-c2', n) + tdMerge(c.数量, 'col-c3', n) + tdMerge(c.单位, 'col-c4', n) + tdMerge(c.单价, 'col-c5', n))
                       : tdMerge(null, 'col-c1', n) + tdMerge(null, 'col-c2', n) + tdMerge(null, 'col-c3', n) + tdMerge(null, 'col-c4', n) + tdMerge(null, 'col-c5', n);
          }
          // 送货单（名称/规格/数量/单号/单位 独立；数量汇总 跨行合并）
          tbody += d ? (tdEditable(d.货物名称, 'col-d1') + specCell(d.规格原文 || d.规格, 'col-d2') + tdEditable(d.数量, 'col-d3') + (first ? tdMerge(line['数量汇总送货'], 'col-d4', n) : '') + tdEditable(d.送货单编号 || null, 'col-d5') + tdEditable(d.单位, 'col-d6'))
                     : tdEditable(null, 'col-d1') + tdEditable(null, 'col-d2') + tdEditable(null, 'col-d3') + (first ? tdMerge(null, 'col-d4', n) : '') + tdEditable(null, 'col-d5') + tdEditable(null, 'col-d6');
          // 形式发票（名称/规格/数量/编号/单位/单价 独立；数量汇总 跨行合并）
          tbody += p ? (tdEditable(p.货物名称, 'col-p1') + specCell(p.规格原文 || p.规格, 'col-p2') + tdEditable(p.数量, 'col-p3') + (first ? tdMerge(line['数量汇总发票'], 'col-p4', n) : '') + tdEditable(p.送货单编号 || null, 'col-p5') + tdEditable(p.发票编号 || null, 'col-p6') + tdEditable(p.单位, 'col-p7') + tdEditable(p.单价, 'col-p8'))
                     : tdEditable(null, 'col-p1') + tdEditable(null, 'col-p2') + tdEditable(null, 'col-p3') + (first ? tdMerge(null, 'col-p4', n) : '') + tdEditable(null, 'col-p5') + tdEditable(null, 'col-p6') + tdEditable(null, 'col-p7') + tdEditable(null, 'col-p8');
          tbody += `<td class="col-rsn" style="text-align:left;font-size:0.8rem;color:var(--color-text-dim)">${(line.reasons||[]).map(esc).join('<br>')}</td>`;
          tbody += `<td class="col-price-check">${priceCheckHtml(line)}</td>`;
          tbody += `<td class="col-qty-check">${qtyCheckHtml(line)}</td>`;
          tbody += '</tr>';
        });
      });
    });
  });

  $('#compare-tbody').innerHTML = tbody;

  // ��新核对按钮（仅在没有时添加）
  let btnContainer = $('#recheck-reconcile-bar');
  if (!btnContainer) {
    const bar = document.createElement('div');
    bar.id = 'recheck-reconcile-bar';
    bar.style.cssText = 'margin-top:0.8rem;display:flex;align-items:center;justify-content:flex-end;gap:0.8rem;flex-wrap:wrap';
    bar.innerHTML = `
      <button class="btn btn-success" onclick="exportReconcileToExcel()" style="display:inline-flex;align-items:center;gap:0.4rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>导出 Excel
      </button>
      <button class="btn btn-secondary" onclick="doRecheckReconcile()" style="display:inline-flex;align-items:center;gap:0.4rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>重新核对 <span style="font-size:0.75rem;opacity:0.6">（需先手动修改表格中识别的数据）</span>
      </button>`;
    $('#compare-table').after(bar);
  }

  // 新合同提示横幅
  const banner = $('#new-contract-banner');
  if (data.new_contracts && data.new_contracts.length) {
    banner.innerHTML = `<div class="banner-warn">
      ⚠ <strong>新合同提示：</strong>以下 ${data.new_contracts.length} 个合约编号在台账中不存在，疑似新合同，请确认或补充台账：
      ${data.new_contracts.map(c => `<code>${esc(c.合约编号)}</code>（送货${c.delivery_count}/发票${c.pi_count}）`).join('、')}
    </div>`;
  } else {
    banner.innerHTML = '';
  }
}

/** 从 DOM 收集编辑后的核对数据，发送后端重新核对 */
let pickerGroupIdx = -1;
let pickerGroupCno = '';

function openContractPicker(gIdx) {
  const groups = (reconcileData && reconcileData.groups) || [];
  const g = groups[gIdx];
  if (!g) { alert('找不到该合约分组'); return; }
  pickerGroupIdx = gIdx;
  pickerGroupCno = g.group_cno || '';
  const info = $('#contract-picker-info');
  if (info) info.innerHTML = '当前分组：<code>' + esc(g.合约编号 || g.delivery_合约编号 || '') + '</code>　请选择要用于匹配的合同行（单选）';

  const fetchDetail = () => {
    mappingContracts = API.apiMappingDetail(mappingName) || [];
    {
      const tbody = $('#contract-picker-tbody');
      tbody.innerHTML = mappingContracts.map((c, i) => `
        <tr ondblclick="quickPickContract(${i})" style="cursor:pointer" title="双击直接应用该合同">
          <td><input type="radio" name="picker-radio" data-idx="${i}" value="${esc(c.合约编号)}"></td>
          <td><code>${esc(c.合约编号)}</code></td>
          <td>${esc(c.货物名称)}</td>
          <td>${c.行数}</td>
          <td>${c.总数量}</td>
          <td>${esc(c.单位)}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="text-muted">暂无合同</td></tr>';
      const modal = new bootstrap.Modal($('#contract-picker-modal'));
      modal.show();
    }
  };
  fetchDetail();
}

function quickPickContract(i) {
  const radios = document.querySelectorAll('#contract-picker-tbody input[name="picker-radio"]');
  if (radios[i]) radios[i].checked = true;
  applyContractOverride();
}

async function applyContractOverride() {
  const checked = document.querySelector('#contract-picker-tbody input[name="picker-radio"]:checked');
  if (!checked) { alert('请先选择一个合同行'); return; }
  const contractKey = checked.value;
  const groups = (reconcileData && reconcileData.groups) || [];
  const g = groups[pickerGroupIdx];
  if (!g) return;
  const key = g.group_cno || g.delivery_合约编号 || g.pi_合约编号;
  try {
    API.apiContractOverride(getSession(), key, contractKey);
    bootstrap.Modal.getInstance($('#contract-picker-modal'))?.hide();
    await rerunReconcile();
  } catch (e) { alert('保存失败：' + e.message); }
}

async function clearContractOverride() {
  const groups = (reconcileData && reconcileData.groups) || [];
  const g = groups[pickerGroupIdx];
  if (!g) return;
  const key = g.group_cno || g.delivery_合约编号 || g.pi_合约编号;
  try {
    API.apiContractOverride(getSession(), key, null);
    bootstrap.Modal.getInstance($('#contract-picker-modal'))?.hide();
    await rerunReconcile();
  } catch (e) { alert('清除失败：' + e.message); }
}

async function rerunReconcile() {
  if (!sessionId) { alert('请先上传文件'); return; }
  try {
    const data = API.apiReconcile(getSession());
    if (data.error) { alert('核对失败：' + data.error); return; }
    reconcileData = data;
    renderReconcile(data);
    renderReconcileSummary(data);
    showStep(4);
  } catch (e) {
    alert('核对异常：' + (e.message || e));
  }
}

async function doRecheckReconcile() {
  // 「重新核对」：读取修改后的全部三流数据 → 后端用新数据重新走完整核对（重新分组匹配）。
  const table = $('#compare-table');
  const trs = table.querySelectorAll('tr');
  if (!trs.length) return;
  if (!reconcileData || !reconcileData.groups) {
    alert('核对数据不可用，请重新上传文件');
    return;
  }

  const groups = JSON.parse(JSON.stringify(reconcileData.groups));
  const deliveryRows = [];
  const piRows = [];
  const contractRows = [];
  const contractSeen = {};
  let currentCno = '';
  let currentGIdx = -1;
  let dataRowIdx = 0;

  for (const tr of trs) {
    if (tr.classList.contains('group-header-row')) {
      currentGIdx = parseInt(tr.getAttribute('data-gidx') || '-1');
      const g = groups[currentGIdx];
      currentCno = g ? (g.contract_合约编号 || g.合约编号 || '') : '';
      dataRowIdx = 0;
      continue;
    }
    if (currentGIdx < 0 || !groups[currentGIdx]) continue;

    const line = groups[currentGIdx].lines && groups[currentGIdx].lines[dataRowIdx];
    if (!line) { dataRowIdx++; continue; }

    // 合并后行内 td 数量不同（首行 21 个，后续行无合并列），改用 class 定位读取
    function readCls(cls) {
      const td = tr.querySelector('td.' + cls);
      if (!td) return null;
      const span = td.querySelector('.cell-editable');
      if (!span) return null;
      const val = span.textContent.trim();
      return val === '' || val === '—' ? null : val;
    }

    const cName = readCls('col-c1'), cSpec = readCls('col-c2'), cQty = readCls('col-c3'), cUnit = readCls('col-c4'), cPrice = readCls('col-c5');
    if (cName || cSpec || cQty) {
      const cKey = currentCno + '||' + (cSpec || '');
      if (!contractSeen[cKey]) {
        contractSeen[cKey] = true;
        contractRows.push({ 货物名称: cName || '', 规格: cSpec || '', 规格原文: cSpec || '', 数量: cQty, 单位: cUnit || '', 单价: cPrice, 合约编号: currentCno });
      }
    }

    const dName = readCls('col-d1'), dSpecRaw = readCls('col-d2'), dQty = readCls('col-d3'), dNo = readCls('col-d5'), dUnit = readCls('col-d6');
    if (dSpecRaw || dQty) {
      const oldRaw = (line.delivery && line.delivery.规格原文) || '';
      const oldSpec = (line.delivery && line.delivery.规格) || '';
      const dSpec = (dSpecRaw === oldRaw || !oldSpec) ? (oldSpec || dSpecRaw) : dSpecRaw;
      deliveryRows.push({ 货物名称: dName || '', 规格: dSpec, 规格原文: dSpecRaw || oldRaw, 数量: dQty, 单位: dUnit || '', 送货单编号: dNo || '', 合约编号: currentCno });
    }

    const pName = readCls('col-p1'), pSpecRaw = readCls('col-p2'), pQty = readCls('col-p3'), pDnNo = readCls('col-p5'), pNo = readCls('col-p6'), pUnit = readCls('col-p7'), pPrice = readCls('col-p8');
    if (pSpecRaw || pQty) {
      const oldRaw = (line.pi && line.pi.规格原文) || '';
      const oldSpec = (line.pi && line.pi.规格) || '';
      const pSpec = (pSpecRaw === oldRaw || !oldSpec) ? (oldSpec || pSpecRaw) : pSpecRaw;
      piRows.push({ 货物名称: pName || '', 规格: pSpec, 规格原文: pSpecRaw || oldRaw, 数量: pQty, 单位: pUnit || '', 单价: pPrice, 发票编号: pNo || '', 合约编号: currentCno });
    }

    dataRowIdx++;
  }

  if (!deliveryRows.length && !piRows.length && !contractRows.length) {
    alert('没有可重新核对的数据');
    return;
  }

  const btn = $('#recheck-reconcile-bar') ? $('#recheck-reconcile-bar').querySelector('button') : null;
  if (btn) { btn.disabled = true; btn.textContent = '核对中…'; }

  try {
    const data = API.apiReconcileEdit(getSession(), {
      delivery_rows: deliveryRows,
      pi_rows: piRows,
      contract_rows: contractRows,
    });
    if (data.error) { alert('重新核对失败: ' + data.error); return; }

    reconcileData = data;
    renderReconcile(data);
    renderReconcileSummary(data);
  } catch (err) {
    alert('重新核对出错: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>重新核对 <span style="font-size:0.75rem;opacity:0.6">（修改后点此按新数据重新核对）</span>`; }
  }
}

function _normCno(s) { return (s || '').toString().replace(/\s+/g, '').toUpperCase(); }

function renderReconcileSummary(data) {
  const s = data.summary || {};
  const ICONS = {
    ok: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    warn: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>',
    fail: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    info: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    total: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  };
  $('#stat-cards').innerHTML = `
    <div class="stat-item s-pass"><div class="si">${ICONS.ok}</div><div><div class="stat-val">${s.ok||0}</div><div class="stat-lbl">核对无误</div></div></div>
    <div class="stat-item s-warn"><div class="si">${ICONS.warn}</div><div><div class="stat-val">${s.not_shipped||0}</div><div class="stat-lbl">未发货</div></div></div>
    <div class="stat-item s-fail"><div class="si">${ICONS.fail}</div><div><div class="stat-val">${s.error||0}</div><div class="stat-lbl">核对有误</div></div></div>
    <div class="stat-item s-info"><div class="si">${ICONS.info}</div><div><div class="stat-val">${s.new||0}</div><div class="stat-lbl">新合同</div></div></div>
    <div class="stat-item s-total"><div class="si">${ICONS.total}</div><div><div class="stat-val">${s.total||0}</div><div class="stat-lbl">合计行</div></div></div>`;
  if ($('#anomaly-table')) $('#anomaly-table').innerHTML = '';
}

function renderCheckResult(result) {
  const { summary, anomalies } = result;
  const pass = summary.pass;
  const I = {
    ok: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    fail: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    info: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>',
    warn: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/></svg>',
  };
  $('#stat-cards').innerHTML = `
    <div class="stat-item ${pass?'s-pass':'s-fail'}"><div class="si">${pass?I.ok:I.fail}</div><div><div class="stat-val">${pass ? '✓' : '✗'}</div><div class="stat-lbl">${pass ? '全部通过' : '发现问题'}</div></div></div>
    <div class="stat-item s-info"><div class="si">${I.info}</div><div><div class="stat-val">${summary.mapped_rows}/${summary.total_rows}</div><div class="stat-lbl">已对齐 / 总行数</div></div></div>
    <div class="stat-item s-fail"><div class="si">${I.fail}</div><div><div class="stat-val">${summary.severe}</div><div class="stat-lbl">严重异常</div></div></div>
    <div class="stat-item s-warn"><div class="si">${I.warn}</div><div><div class="stat-val">${summary.warnings}</div><div class="stat-lbl">警告</div></div></div>`;

  // Recheck button
  const recheckBtn = '<div style="text-align:center;margin:1rem 0"><button class="btn-go" id="btn-recheck" onclick="doRecheck()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>修改数据后重新核对</button><br><small style="color:var(--color-text-dim)">在上方表格中修改有误的单元格，然后点击此处重新核对</small></div>';

  if (!anomalies.length) {
    const _at = $('#anomaly-table');
    if (_at) _at.innerHTML = recheckBtn + '<div class="empty-state" style="padding:2rem"><div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.8 11.3 1 6l3-3 5 4 2-2"/><path d="M18 8v3a4 4 0 0 1-4 4H8.5l-3.5 3.5L11 19h7a4 4 0 0 0 4-4V4"/></svg></div><strong>未发现任何异常，所有核对项均通过！</strong></div>';
  } else {
    let html = `<div class="table-wrap" style="margin-top:1rem"><table>
      <thead><tr><th>级别</th><th>检查类型</th><th>问题描述</th><th>期望</th><th>实际</th></tr></thead><tbody>`;
    anomalies.forEach(a => {
      let bg = 'var(--color-warning-lt)';  // default: warning
      if (a.level === '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 21V4h13l-1 5h3v12z"/></svg>') bg = 'var(--color-danger-lt)';      // severe: red
      else if (a.level === 'ℹ️') bg = 'var(--color-primary-lt)';  // info: blue
      html += `<tr style="background:${bg}">
        <td>${a.level}</td><td style="text-align:left">${esc(a.check_type)}</td>
        <td style="text-align:left">${esc(a.detail)}</td>
        <td>${esc(a.expected)}</td><td>${esc(a.actual)}</td></tr>`;
    });
    html += '</tbody></table></div>';
    const _at = $('#anomaly-table');
    if (_at) _at.innerHTML = recheckBtn + html;
  }
}

function esc(v) { if (!v) return ''; const d = document.createElement('div'); d.textContent = v; return d.innerHTML; }

document.addEventListener('DOMContentLoaded', () => {
  setupUploadZones();
  setupButtons();
});


window.applyContractOverride = applyContractOverride;
window.chooseManualMode = chooseManualMode;
window.choosePdfMode = choosePdfMode;
window.clearContractOverride = clearContractOverride;
window.deleteMapping = deleteMapping;
window.goUploadFromMapping = goUploadFromMapping;
window.toggleSelectAllMapping = toggleSelectAllMapping;
// ⚠️ 20260825o 修复：uploadMapping 变量从未定义，此处抛 ReferenceError 会中断模块求值，
// 导致下方 loadMappingsRef / selectMappingRef 等挂载不生效，且 index.html 改绑按钮后点击无反应。
// 实际上传业务逻辑在 window._uploadMappingFile（见 353 行），这里改挂同一引用。
window.uploadMapping = window._uploadMappingFile;
window.quickSelectContract = quickSelectContract;
window.quickPickContract = quickPickContract;
window.updateMappingCount = updateMappingCount;
// 供 index.html 内联脚本调用的引用函数（绕过 ES Module 作用域）
window.loadMappingsRef = loadMappings;
window.selectMappingRef = function(name) { selectMapping(name || mappingName); };
// 把核对数据暴露给非 module 脚本（导出 Excel 按钮 + 调试面板使用）
// 通过 defineProperty 让外部对 window.reconcileData 的读写都映射到 module 内的 reconcileData 变量
Object.defineProperty(window, 'reconcileData', {
  configurable: true,
  get() { return reconcileData; },
  set(v) { reconcileData = v; }
});
