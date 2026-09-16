// parse-lines.js — app.py 行解析器直译
import { fuzzyMatchSpec, toSimp, isLikelyQuantity, isLikelyUnitPrice, UNIT_PRICE_MAX, UNIT_PRICE_MIN } from './mapping.js?v=20260915e';
import { normalizeQuantity, rawNumberTokens } from './quantity.js?v=20260915e';
import { matchProductName, correctUnit, inferUnitFromLine, getAliasIndex } from './whitelist.js?v=20260915e';
function safeFloat2(val, def = 0.0) {
  if (typeof val === 'string') val = val.replace(/,/g, '').replace(/，/g, '').trim();
  if (val === null || val === undefined || val === '' || val === 'nan') return def;
  const v = parseFloat(val);
  return Number.isNaN(v) ? def : v;
}
export function extractPriceFromRest(rest) {
  const toks = [];
  const re = /\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    const raw = m[0];
    const v = normalizeQuantity(raw);
    if (typeof v === 'number' && v > 0) toks.push([raw, v]);
  }
  if (!toks.length) return ['', ''];
  if (toks.length >= 2) { toks.sort((a, b) => a[1] - b[1]); return [toks[0][0], toks[toks.length - 1][0]]; }
  return [toks[0][0], ''];
}
function nearDup(lastKey, lastIdx, key, lineIdx) {
  return lastKey !== null && JSON.stringify(key) === JSON.stringify(lastKey) && (lineIdx - lastIdx) <= 2;
}
const ROLL_RE = /(\d+(?:\.\d+)?)\s*(?:m|M|米)?\s*\/([卷盘捲盤圈])/;
const ROLL_RE_G = /(\d+(?:\.\d+)?)\s*(?:m|M|米)?\s*\/([卷盘捲盤圈])/g;
// ── 型材/板材解析器（2026-09-15 新增；同日二次修正：适配浏览器真实行结构）──
// 覆盖：方矩管 / 槽钢 / 角钢 / 工字钢 / 钢板 / 镀锌板 等
//
// ⚠️ 二次修正原因：extract.js 的文字层是 pdf.js 取词后由 tlWordsToLines 按 y 坐标
//   合并成行（|Δy| <= 6 归为同一行），所以同一表格行的各单元格会被合并成【一整行】，
//   并不是"每个字段独占一行"：
//     送货单  ：`1 方形鋼管 200*100*10 Q355B 9.9500 噸 20支`
//     形式发票：`1 方形鋼管 200*100*10 Q355 9.950 噸 4,423.000 44,008.85`
//   上一版按"每字段独占一行"写 → 真实文档解析出 0 行。故改为以单行表格行为主。
const STEEL_KW = /鋼管|钢管|方矩|矩形管|方管|槽钢|槽鋼|角钢|角鋼|工字|H型钢|h型钢|鋼板|钢板|镀锌|鍍鋅|型钢|型鋼|扁钢|扁鋼|圓鋼|圆钢|不鏽鋼|不锈钢|檩条|C型钢|Z型钢/;
const STEEL_UNIT_RE = /^(噸|吨|千克|公斤|米|m|支|件|块|塊|套|个|個|张|張|卷|捆|根|条|條|片)$/;
const STEEL_SIZE_RE = /\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?/;
const STEEL_NUM_RE = /^\d[\d,]*(?:\.\d+)?$/;
const STEEL_INT_RE = /^\d{1,3}$/;
// 规格规范化：只在数字之间的 x/X 转 *（保护 DX51D / Z80 这类材质牌号），保留逗号
export function normSteelSpec(s) {
  return String(s || '')
    .replace(/\u3000/g, ' ')
    .replace(/(\d)\s*[×xX]\s*(?=\d)/g, '$1*')
    .replace(/\s*\*\s*/g, '*')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}
// 【主】单行表格行解析：`序号 货物名称 规格 数量 单位 [备注] [单价 总价]`
export function parseSteelLineRows(text, docType = 'delivery') {
  const products = [];
  let lastSeq = 0;
  for (const raw0 of String(text).split('\n')) {
    const raw = raw0.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const toks = raw.split(' ');
    if (toks.length < 4) continue;
    if (!STEEL_INT_RE.test(toks[0])) continue;          // 必须由序号开头
    const seq = parseInt(toks[0], 10);
    if (!products.length) { if (seq !== 1) continue; }  // 首行必须是 1
    else if (seq <= lastSeq) continue;                  // 之后严格递增
    // 定位「数量 + 单位」：单位前必须是数字（兼容 `3.3800吨` 粘连写法）
    let qIdx = -1, uIdx = -1, glued = null;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (STEEL_NUM_RE.test(t) && i + 1 < toks.length && STEEL_UNIT_RE.test(toks[i + 1])) {
        qIdx = i; uIdx = i + 1; break;
      }
      const g = t.match(/^(\d[\d,]*(?:\.\d+)?)([^\d\s]{1,2})$/);
      if (g && STEEL_UNIT_RE.test(g[2])) { qIdx = i; uIdx = i; glued = g; break; }
    }
    if (qIdx < 1 || uIdx < 0) continue;
    const qty = safeFloat2(glued ? glued[1] : toks[qIdx], 0);
    if (!(qty > 0)) continue;
    const unitStr = glued ? glued[2] : toks[uIdx];
    const middle = toks.slice(1, qIdx);                 // 名称 + 规格
    if (!middle.length) continue;
    let ni = 0;
    while (ni < middle.length && !/\d/.test(middle[ni])) ni++;   // 名称 = 开头不含数字的部分
    let name = middle.slice(0, ni).join('');
    if (!name) name = (middle[0].match(/[\u4e00-\u9fff]+/) || [''])[0];
    const spec = normSteelSpec(middle.slice(ni).join(' '));
    // 尾部：送货单为备注（如 `20支`）；形式发票为「单价 总价」
    const rest = toks.slice(uIdx + 1).filter((t) => t);
    let price = 0;
    if (docType === 'pi') {
      const nums = rest.filter((t) => STEEL_NUM_RE.test(t)).map((t) => safeFloat2(t, 0)).filter((v) => v > 0);
      if (nums.length) price = nums[0];
    }
    products.push({
      '货物名称': matchProductName(name)[0] || name,
      '规格': spec ? (fuzzyMatchSpec(spec) || spec) : '',
      '规格原文': spec,
      '单位': correctUnit(unitStr)[0] || '吨',
      '数量': Math.round(qty * 10000) / 10000,
      '单价': price,
    });
    lastSeq = seq;
  }
  return products;
}
// 【兜底】块解析：字段逐行版式（序号行 / 名称行 / 规格行 / 数量行 / 单位行 ...）
export function parseSteelBlockRows(text, docType = 'delivery') {
  const lines = text.split('\n').map((l) => l.replace(/\u3000/g, ' ').trim());
  // 序号行：从 1 起严格递增的整数（避免把数量行/单价行误判成序号）
  const seqIdx = [];
  let expect = 1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/\s/g, '');
    if (!STEEL_INT_RE.test(t)) continue;
    const v = parseInt(t, 10);
    if (v === 0 || v > 150) continue;
    if (v === expect) { seqIdx.push(i); expect = v + 1; }
  }
  if (!seqIdx.length) return [];
  const products = [];
  for (let k = 0; k < seqIdx.length; k++) {
    const s0 = seqIdx[k] + 1;
    const e0 = k + 1 < seqIdx.length ? seqIdx[k + 1] : lines.length;
    const block = lines.slice(s0, e0).filter((l) => l);
    let unitIdx = -1;
    for (let i = 0; i < block.length; i++) {
      if (STEEL_UNIT_RE.test(block[i].replace(/\s/g, ''))) { unitIdx = i; break; }
    }
    if (unitIdx < 0) continue;                       // 块内没有单位行 → 不是有效明细块
    let name = '', qty = 0;
    const specs = [];
    for (let i = 0; i < unitIdx; i++) {
      const l = block[i];
      const lc = l.replace(/\s/g, '');
      if (STEEL_NUM_RE.test(lc)) { const v = parseFloat(lc.replace(/,/g, '')); if (v > 0) qty = v; continue; }
      if (STEEL_SIZE_RE.test(l)) { specs.push(normSteelSpec(l)); continue; }
      if (!name && /[\u4e00-\u9fff]/.test(l)) name = lc;
    }
    if (qty <= 0) continue;
    const unit = correctUnit(block[unitIdx].replace(/\s/g, ''))[0];
    let price = 0;
    if (docType === 'pi') {
      const nums = block.slice(unitIdx + 1)
        .map((l) => l.replace(/\s/g, ''))
        .filter((l) => STEEL_NUM_RE.test(l))
        .map((l) => parseFloat(l.replace(/,/g, '')));
      if (nums.length) price = nums[0];
    }
    const specText = specs.join('；');
    products.push({
      '货物名称': matchProductName(name)[0] || name,
      '规格': specText ? fuzzyMatchSpec(specText) : '',
      '规格原文': specText,
      '单位': unit || '吨',
      '数量': Math.round(qty * 10000) / 10000,
      '单价': price,
    });
  }
  return products;
}
export function parseSteelRows(text, docType = 'delivery') {
  if (!text || !STEEL_KW.test(text)) return [];
  const byLine = parseSteelLineRows(text, docType);   // 浏览器真实版式：单行表格行
  if (byLine.length) return byLine;
  return parseSteelBlockRows(text, docType);          // 兜底：字段逐行版式
}
export function parseRebarRows(text, docType = 'delivery') {
  const products = [];
  let lastKey = null, lastIdx = -100;
  const lines = text.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const ls = line.replace(/ /g, '').replace(/\u3000/g, '');
    const hasLen = /[Xx×]\s*\d{1,2}\s*[Mm]/.test(ls);
    let mDiam = ls.match(/[YTΦφ](\d{1,2})/);
    let diamFrom = 'YT';
    if (!mDiam) { const mCoil = ls.match(/[盘盤φ]\s*(\d{1,2})/); if (mCoil) { mDiam = mCoil; diamFrom = 'COIL'; } }
    if (!mDiam) {
      const mBare = ls.match(/(?<![×xX])(\d{1,2})\s*[mM]/);
      if (mBare && 6 <= parseInt(mBare[1], 10) && parseInt(mBare[1], 10) <= 40) { mDiam = mBare; diamFrom = hasLen ? 'BARE_BAR' : 'BARE_COIL'; }
    }
    const gradeM = ls.match(/50[0O][Bb8]/);
    const hasKw = ['盘螺', '螺纹', '盤螺', '螺紋'].some((k) => ls.includes(k));
    if (!mDiam && !gradeM && !hasKw) continue;
    let diam, specNum;
    if (mDiam) {
      diam = parseInt(mDiam[1], 10);
      const full = ls.match(/\d{1,2}\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]\s*\/\s*50[0O][Bb8]/);
      specNum = full ? full[0] : 'Y' + diam;
    } else { diam = 0; specNum = null; }
    let after;
    if (gradeM) after = ls.slice(gradeM.index + gradeM[0].length);
    else if (mDiam) after = ls.slice(mDiam.index + mDiam[0].length);
    else after = ls;
    let weight = null;
    const numRe = /\d[\d,]*(?:\.\d+)?/g;
    for (const tok of after.matchAll(numRe)) {
      if (tok[0].includes('.') || tok[0].includes(',')) {
        const v = normalizeQuantity(tok[0]);
        if (typeof v === 'number' && 0.5 < v && v < 2000) { weight = v; break; }
      }
    }
    if (weight === null) {
      for (const tok of after.matchAll(numRe)) {
        const v = normalizeQuantity(tok[0]);
        if (typeof v === 'number' && 0.5 < v && v < 2000) { weight = v; break; }
      }
    }
    if (weight === null || weight <= 0.1) continue;
    let price = 0;
    if (docType === 'pi') {
      const gmWs = line.match(/50[0O][Bb8]/);
      const baseWs = gmWs ? line.slice(gmWs.index + gmWs[0].length) : line;
      let wpos = -1;
      for (const mm of baseWs.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
        const v = normalizeQuantity(mm[0]);
        if (0.5 < v && v < 2000) { wpos = mm.index + mm[0].length; break; }
      }
      if (wpos >= 0) price = extractPriceFromRest(baseWs.slice(wpos))[0];
    }
    const isCoil = (diamFrom === 'COIL' || diamFrom === 'BARE_COIL' || ls.includes('盘螺') || ls.includes('盤螺')
      || /[盘盤]\s*\d{1,2}\s*mm/.test(ls) || (mDiam === null && gradeM && !hasLen));
    const name = isCoil ? '盘螺' : '热轧带肋钢筋';
    const spec = isCoil ? '盘螺' : (specNum || '热轧带肋钢筋');
    const specNorm = fuzzyMatchSpec(spec);
    const key = [name, specNorm, Math.round(weight * 100) / 100];
    if (nearDup(lastKey, lastIdx, key, lineIdx)) continue;
    products.push({ '货物名称': name, '规格': specNorm, '规格原文': spec, '单位': '吨', '数量': Math.round(weight * 10000) / 10000, '单价': price });
    lastKey = key; lastIdx = lineIdx;
  }
  if (docType === 'delivery') {
    const SKIP_WORDS = ['炉', '日期', '单位', '盖章', '簽章', '签名', '簽名', '電話', '电话', '地址', '銀行', '银行', '客戶', '客户', '聯絡人', '联系人', '深圳', '海旭', '绿碳', '送貨', '送货', '收貨', '收货', '有限公司'];
    let hdrIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const l2 = lines[i].replace(/ /g, '').replace(/\u3000/g, '');
      if (l2.includes('数量') || l2.includes('數量')) {
        let hasProd = false;
        for (let k = i + 1; k < Math.min(i + 20, lines.length); k++) {
          const l3 = lines[k].replace(/ /g, '').replace(/\u3000/g, '');
          if (/[YTΦφ](\d{1,2})|50[0O][Bb8]/.test(l3)) { hasProd = true; break; }
        }
        if (hasProd) { hdrIdx = i; break; }
      }
    }
    if (hdrIdx >= 0) {
      let footIdx = lines.length;
      for (let i = hdrIdx + 1; i < lines.length; i++) {
        const l4 = lines[i].replace(/ /g, '').replace(/\u3000/g, '');
        if (['送貨單位', '送货单位', '送貨人', '送货人', '收貨人', '收货人', '蓋章', '盖章'].some((w) => l4.includes(w))) { footIdx = i; break; }
      }
      let block = [], blockHadNum = false;
      const flushBlock = () => {
        if (block.length && blockHadNum) {
          const joined = block.join('').replace(/ /g, '').replace(/\u3000/g, '');
          if (block.length >= 2 && joined.length >= 8 && /[A-Za-z\u4e00-\u9fff]/.test(joined) && !SKIP_WORDS.some((w) => joined.includes(w))) {
            products.push({ '货物名称': '（未识别）', '规格': '（未识别）', '规格原文': block.join(' ').slice(0, 80), '单位': '吨', '数量': 0, '单价': 0, '_missed': true });
          }
        }
        block = []; blockHadNum = false;
      };
      for (let i = hdrIdx + 1; i < footIdx; i++) {
        const l5 = lines[i], l6 = l5.replace(/ /g, '').replace(/\u3000/g, '');
        if (!l6.trim()) continue;
        if (/[YTΦφ](\d{1,2})|50[0O][Bb8]/.test(l6)) flushBlock();
        else { if (/\d/.test(l6)) blockHadNum = true; block.push(l5); }
      }
      flushBlock();
    }
  }
  return products;
}
const CABLE_KW = ['电线', '電線', '电缆', '電纜', '導線', '导线', '线缆', '線纜'];
const CN_UNITS = ['米', '卷', '盘', '支', '根', '个', '箱', '捆', '圈', '套'];
const COLOR_RE = /(黄绿双色|黃綠雙色|红色|紅色|蓝色|藍色|棕色|黑色|黄色|黃色|绿色|綠色|灰色|白色|橙色|紫色|双色|雙色)/;

// ── 灯具/照明装置 解析器（2026-08-21 新增：灯具 LED筒射灯/线条灯 + 应急电源）──
// 行格式（文字层）：`1 灯具 *照明装置*LED筒射灯L10-IP20，Bidanli LED 1190.0000 套`
// 或发票行：`1 灯具 *照明装置*LED筒射灯L10-IP20，Bidanli LED 6.000 套 173.000 1,038.00`
const LAMP_KW_LIST = ['灯具', '燈具', '電池', '电池', '照明装置', '照明裝置', '应急电源', '應急電源', 'LED', '筒射灯', '筒射燈', '线条灯', '線條燈', 'Downlight', 'Linear', 'Light'];
const LAMP_UNIT_RE = /(套|個|个|台|只|件|支)/;
const LAMP_SPEC_TRUNC = /Bidanli|Battery|Downlight|Fixture|Item|Linear|Light|LED\s*Downlight/i;
export function parseLampRows(text, docType = 'delivery') {
  const products = [];
  const seen = new Set();
  const lines = text.split('\n');
  const QTY_RE = new RegExp('(\\d[\\d,]*(?:\\.\\d+)?)\\s+(套|個|个|台|只|件|支|米|吨|公斤|千克|卷|盘|箱)', 'g');
  // ── Pass 1: 严格匹配 "序号 灯具/電池" 格式 ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ls = line.replace(/ /g, '').replace(/\u3000/g, '');
    const m = ls.match(/^(\d{1,3})(灯具|燈具|電池|电池)(.*)$/);
    if (!m) continue;
    const parsed = tryParseLampLine(line, m, QTY_RE, docType);
    if (parsed) {
      const key = parsed['货物名称'] + '|' + parsed['规格'] + '|' + parsed['单位'] + '|' + parsed['数量'];
      if (!seen.has(key)) { seen.add(key); products.push(parsed); }
    }
  }
  if (products.length) return products;
  // ── Pass 2: 宽松匹配 —— 行含灯具关键词 + 数量单位，但缺 "序号 灯具" 前缀 ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ls = line.replace(/ /g, '').replace(/\u3000/g, '');
    // 必须含灯具/电池关键词
    const kw = LAMP_KW_LIST.find(k => ls.includes(k));
    if (!kw) continue;
    // 且不能是已匹配的严格行
    if (ls.match(/^(\d{1,3})(灯具|燈具|電池|电池)/)) continue;
    // 查找数量+单位：优先当前行，若无则往下找（跨行数据如规格描述独立一行）
    let qtyLine = line, qtyLineIdx = i;
    let qtyMatches = [];
    let qm;
    while ((qm = QTY_RE.exec(qtyLine)) !== null) qtyMatches.push(qm);
    if (!qtyMatches.length) {
      // 当前行没数量，往下找（最多找 6 行）
      for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
        const nextLine = lines[j];
        qtyMatches = [];
        QTY_RE.lastIndex = 0;
        while ((qm = QTY_RE.exec(nextLine)) !== null) qtyMatches.push(qm);
        if (qtyMatches.length) { qtyLine = nextLine; qtyLineIdx = j; break; }
      }
      // 如果还是没找到，尝试数字行和单位行分开的情况（如 "59.0000" 一行，"套" 下一行）
      if (!qtyMatches.length) {
        for (let j = i + 1; j < Math.min(i + 7, lines.length - 1); j++) {
          const numLine = lines[j].trim();
          const unitLine = lines[j + 1].trim();
          if (!numLine || !unitLine) continue;
          const numM = numLine.match(/^(\d[\d,]*(?:\.\d+)?)$/);
          if (!numM) continue;
          const unitM = unitLine.match(/^(套|個|个|台|只|件|支|米|吨|公斤|千克|卷|盘|箱)$/);
          if (!unitM) continue;
          qtyLine = numLine; qtyLineIdx = j;
          qtyMatches = [[numLine + ' ' + unitLine, numM[1], unitM[1]]];
          break;
        }
      }
    }
    if (!qtyMatches.length) continue;
    const lastQty = qtyMatches[qtyMatches.length - 1];
    const qty = normalizeQuantity(lastQty[1]);
    if (!(typeof qty === 'number' && qty > 0)) continue;
    const unit = lastQty[2];
    // 规格：从关键词行到数量行之前，合并所有行文本
    const kwIdx = line.indexOf(kw);
    const qtyFull = lastQty[0];
    const qtyIdx = qtyLine.lastIndexOf(qtyFull);
    let spec = '';
    if (qtyLineIdx === i) {
      // 数量在当前行
      if (kwIdx >= 0 && qtyIdx > kwIdx) {
        spec = line.slice(kwIdx + kw.length, qtyIdx).trim();
      } else {
        spec = line.slice(0, qtyIdx >= 0 ? qtyIdx : line.length).trim();
      }
    } else {
      // 数量在后续行：合并关键词行到数量行前一行
      const specLines = [];
      for (let j = i; j < qtyLineIdx; j++) {
        const l = lines[j].trim();
        if (l) specLines.push(l);
      }
      spec = specLines.join(' ').replace(/\s+/g, ' ').trim();
      // 去掉关键词前缀
      const ki = spec.indexOf(kw);
      if (ki >= 0) spec = spec.slice(ki + kw.length).trim();
      // 从数量行中取数量前的内容作为规格补充
      if (qtyIdx > 0) {
        const beforeQty = qtyLine.slice(0, qtyIdx).trim();
        if (beforeQty) spec += ' ' + beforeQty;
      }
    }
    const truncAt = spec.search(LAMP_SPEC_TRUNC);
    if (truncAt > 0) spec = spec.slice(0, truncAt);
    spec = spec.replace(/[，,]\s*$/, '').replace(/^[：:，,\s*]+/, '').trim();
    if (!spec) spec = kw;
    const name = (kw === '電池' || kw === '电池' || kw === '应急电源' || kw === '應急電源') ? '电池' : '灯具';
    // 单价（发票）：数量之后的数字
    let price = 0;
    if (docType === 'pi') {
      const rest = qtyLine.slice(qtyIdx + qtyFull.length).trim();
      if (rest) { const pr = extractPriceFromRest(rest); price = pr[0] ? parseFloat(pr[0]) : 0; }
      // 如果价格还是 0，尝试从后续行取
      if (price <= 0) {
        for (let j = qtyLineIdx + 1; j < Math.min(qtyLineIdx + 4, lines.length); j++) {
          const r = lines[j].trim();
          if (r) { const pr = extractPriceFromRest(r); if (pr[0]) { price = parseFloat(pr[0]); break; } }
        }
      }
    }
    const key = name + '|' + spec + '|' + unit + '|' + qty;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({ '货物名称': name, '规格': spec, '单位': unit, '数量': Math.round(qty * 10000) / 10000, '单价': price });
  }
  return products;
}

// 提取严格格式灯具行的共用逻辑
function tryParseLampLine(line, m, QTY_RE, docType) {
  const qtyMatches = [];
  let qm;
  while ((qm = QTY_RE.exec(line)) !== null) qtyMatches.push(qm);
  if (!qtyMatches.length) return null;
  const lastQty = qtyMatches[qtyMatches.length - 1];
  const qty = normalizeQuantity(lastQty[1]);
  if (!(typeof qty === 'number' && qty > 0)) return null;
  const unit = lastQty[2];
  const seqStr = m[1] + ' ' + m[2];
  const seqIdx = line.indexOf(seqStr);
  if (seqIdx < 0) return null;
  const after = line.slice(seqIdx + seqStr.length).trim();
  const qtyFull = lastQty[0];
  const qtyIdxInAfter = after.lastIndexOf(qtyFull);
  let spec = qtyIdxInAfter >= 0 ? after.slice(0, qtyIdxInAfter).trim() : after;
  const truncAt = spec.search(LAMP_SPEC_TRUNC);
  if (truncAt > 0) spec = spec.slice(0, truncAt);
  spec = spec.replace(/[，,]\s*$/, '').trim();
  if (!spec) spec = m[2];
  const name = (m[2] === '電池' || m[2] === '电池') ? '电池' : '灯具';
  let price = 0;
  if (docType === 'pi') {
    const rest = after.slice(qtyIdxInAfter + qtyFull.length).trim();
    if (rest) { const pr = extractPriceFromRest(rest); price = pr[0] ? parseFloat(pr[0]) : 0; }
  }
  return { '货物名称': name, '规格': spec, '单位': unit, '数量': Math.round(qty * 10000) / 10000, '单价': price };
}

export function parseCableRows(text, docType = 'delivery') {
  const products = [];
  let lastKey = null, lastIdx = -100;
  const lines = text.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const ls = line.replace(/ /g, '').replace(/\u3000/g, '');
    if (!CABLE_KW.some((k) => ls.includes(k))) continue;
    if (['螺纹', '螺紋', '钢筋', '鋼筋', '盘螺', '盤螺'].some((k) => ls.includes(k))) continue;
    const secM = ls.match(/(\d+(?:\.\d+)?)\s*(?:mm²|mm2|m²|m2|ma2|Sm)/i);
    const coreM = ls.match(/(\d+)\s*芯/);
    const colorM = ls.match(COLOR_RE);
    const rollM = ls.match(ROLL_RE);
    const specParts = [];
    if (secM) specParts.push(secM[1] + 'mm²');
    if (colorM) specParts.push(colorM[1]);
    if (rollM) specParts.push(rollM[1] + 'm/' + rollM[2]);
    if (coreM) specParts.push(coreM[1] + '芯');
    const spec = specParts.join('，');
    let name = null;
    const normLine = toSimp(ls).toLowerCase();
    let bestLen = 0;
    const aliasIdx = getAliasIndex();
    for (const aliasKey in aliasIdx) {
      if (aliasKey && normLine.includes(aliasKey) && aliasKey.length > bestLen) { name = aliasIdx[aliasKey]; bestLen = aliasKey.length; }
    }
    if (!name) name = normLine.includes('电线') ? '电线' : '电缆';
    let qty = null;
    let unit = '米';
    const lsQty = ls.replace(ROLL_RE_G, '');
    const mQ = lsQty.match(new RegExp('(\\d[\\d,]*(?:\\.\\d+)?)[^\\d/A-Za-z]{0,2}(' + CN_UNITS.join('|') + ')'));
    if (mQ) { qty = normalizeQuantity(mQ[1]); unit = mQ[2]; }
    else {
      const afterStr = secM ? ls.replace(ROLL_RE_G, '').slice(secM.index + secM[0].length) : lsQty;
      for (const mm of afterStr.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
        const v = normalizeQuantity(mm[0]);
        if (typeof v === 'number' && v > 0.1) { qty = v; break; }
      }
    }
    if (qty === null || qty <= 0.1) continue;
    let price = 0;
    if (docType === 'pi') {
      const lineWs = line.replace(ROLL_RE_G, '');
      const mqWs = lineWs.match(new RegExp('(\\d[\\d,]*(?:\\.\\d+)?)[^\\d/A-Za-z]{0,2}(' + CN_UNITS.join('|') + ')'));
      if (mqWs) price = extractPriceFromRest(lineWs.slice(mqWs.index + mqWs[0].length))[0];
      else {
        const afterWs = secM ? line.replace(ROLL_RE_G, '').slice(secM.index + secM[0].length) : lineWs;
        for (const mm of afterWs.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
          const v = normalizeQuantity(mm[0]);
          if (typeof v === 'number' && v > 0.1) { price = extractPriceFromRest(afterWs.slice(mm.index + mm[0].length))[0]; break; }
        }
      }
    }
    const key = [name, spec, unit, Math.round(qty * 100) / 100];
    if (nearDup(lastKey, lastIdx, key, lineIdx)) continue;
    products.push({ '货物名称': name, '规格': spec, '单位': unit, '数量': Math.round(qty * 10000) / 10000, '单价': price });
    lastKey = key; lastIdx = lineIdx;
  }
  return products;
}
export function parseTableRows(text) {
  const products = [];
  const lines = text.split('\n');
  const HEADER_KW = ['货物', '名称', '规格', '型号', '数量', '重量', '单位', '单价', '总价', '金额', '序号'];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const hits = HEADER_KW.filter((k) => lines[i].includes(k)).length;
    if (hits >= 3) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return products;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 8) continue;
    if (['页', '共', '合计', '小计', '总计', '签字', '盖章', '付款', '银行', '账号'].some((k) => line.includes(k))) continue;
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;
    let specToken = null;
    const numberTokens = [];
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j];
      if (/^[YT]\d{1,2}/i.test(t) || /^500\s*[Bb]/i.test(t)) { if (specToken === null) specToken = t.replace(/ /g, ''); }
      const val = normalizeQuantity(t);
      if (typeof val === 'number') numberTokens.push([val, j, t]);
    }
    if (!numberTokens.length) continue;
    let qty = 0.0, price = 0.0, total = 0.0;
    let unitJ = -1;
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j];
      const isUnit = t.includes('吨') || t.includes('噸') || (t.length === 1 && /[一-鿿]/.test(t) && j > 0);
      if (isUnit && j > 0) {
        const prev = tokens[j - 1].replace(/,/g, '').replace(/，/g, '');
        const v = parseFloat(prev);
        if (!Number.isNaN(v) && 10 < v && v < 5000) { qty = v; unitJ = j; break; }
      }
    }
    if (unitJ >= 2) {
      const v2 = parseFloat(tokens[unitJ - 2].replace(/,/g, '').replace(/，/g, ''));
      const v1 = parseFloat(tokens[unitJ - 1].replace(/,/g, '').replace(/，/g, ''));
      if (!Number.isNaN(v2) && !Number.isNaN(v1)) {
        const combined = parseFloat(parseInt(v2, 10) + '.' + parseInt(v1, 10));
        if (10 < combined && combined < 5000) qty = Math.round(combined * 1000) / 1000;
      }
    }
    if (unitJ >= 0 && price <= 0) {
      for (let j = unitJ + 1; j < Math.min(unitJ + 4, tokens.length); j++) {
        const v = parseFloat(tokens[j].replace(/,/g, '').replace(/，/g, ''));
        if (!Number.isNaN(v) && isLikelyUnitPrice(v)) { price = v; break; }
      }
    }
    const qtyCandidates = numberTokens.filter(([v]) => isLikelyQuantity(v));
    const priceCandidates = numberTokens.filter(([v]) => isLikelyUnitPrice(v));
    const totalCandidates = numberTokens.filter(([v]) => v > UNIT_PRICE_MAX && !isLikelyQuantity(v)).sort((a, b) => b[0] - a[0]);
    if (qty <= 0 && qtyCandidates.length) qty = qtyCandidates[0][0];
    if (qty <= 0) { for (const [v] of numberTokens) { if (isLikelyQuantity(v)) { qty = v; break; } } }
    if (qty <= 0) { for (const [v] of numberTokens) { if (!isLikelyUnitPrice(v) && 10 < v && v < 5000) { qty = v; break; } } }
    if (qty <= 0) continue;
    if (qty <= 20 && qty === Math.floor(qty)) {
      const firstNum = numberTokens.length ? numberTokens[0][0] : 0;
      if (firstNum === qty) {
        let found = false;
        for (const [v] of qtyCandidates) { if (v > 20) { qty = v; found = true; break; } }
        if (!found) continue;
      }
    }
    if (priceCandidates.length) price = priceCandidates[0][0];
    if (totalCandidates.length) total = totalCandidates[0][0];
    let spec = specToken || '';
    let fullSpecM = line.match(/[Tt]\d{1,2}[Oo0-9A-Za-z]{0,3}\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]\s*\/\s*500\s*[Bb]/);
    if (!fullSpecM) fullSpecM = line.match(/[Tt]\d{1,2}[Oo0-9A-Za-z]{0,3}\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]/);
    if (fullSpecM) spec = fullSpecM[0];
    else if (!spec) { const specM = line.match(/[YT]\d{1,2}\S*|500\s*[Bb]\s*\S*/); if (specM) spec = specM[0].replace(/ /g, ''); }
    const nameToken = tokens.length > 1 ? tokens[1] : '';
    let name = matchProductName(nameToken)[0];
    if (!name) name = '热轧带肋钢筋';
    const unitStr = correctUnit(inferUnitFromLine(line) || '吨')[0];
    products.push({ '货物名称': name, '规格': fuzzyMatchSpec(spec), '单位': unitStr, '数量': qty, '单价': price });
  }
  const valid = [];
  for (const p of products) {
    const spec = p['规格'] || '';
    const qty = p['数量'] || 0;
    const hasValidSpec = /[YT]\d|500\s*[Bb]|\d{1,2}\s*mm|盘螺|螺纹|電線|电线|电缆|電纜|\d+(?:\.\d+)?\s*mm²|芯/.test(spec);
    if (hasValidSpec && 10 < qty && qty < 5000) valid.push(p);
  }
  return valid;
}
export function parseProductsFallback(text, docType) {
  const products = [];
  text = text.replace(/(?<=[一-鿿])\s+(?=[一-鿿])/g, '');
  if (docType === 'contract') {
    for (const line0 of text.split('\n')) {
      const lineClean = line0.replace(/\s+/g, ' ').trim();
      const lineFixed = lineClean.replace(/[Tt]l(\d)/g, 'T1$1');
      const specM = lineFixed.match(/[Tt](\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:米|[mM])/);
      if (!specM) continue;
      const dia = specM[1], length = specM[2];
      const specStd = 'T' + dia + '-' + length + 'M';
      const nums = rawNumberTokens(lineFixed);
      if (nums.length < 2) continue;
      const diaInt = parseInt(dia, 10) || 0, lenInt = parseInt(length, 10) || 0;
      let qty = 0.0, price = 0.0, total = 0.0;
      for (const nStr of nums) {
        const v = safeFloat2(nStr);
        if ((diaInt > 0 && Math.abs(v - diaInt) < 0.1) || (lenInt > 0 && Math.abs(v - lenInt) < 0.1)) continue;
        if (isLikelyQuantity(v) && qty <= 0) qty = v;
        else if (isLikelyUnitPrice(v) && price <= 0) price = v;
        else if (v > UNIT_PRICE_MAX && total <= 0) total = v;
      }
      if (qty <= 0) {
        for (const nStr of nums) {
          const v = safeFloat2(nStr);
          if ((diaInt > 0 && Math.abs(v - diaInt) < 0.1) || (lenInt > 0 && Math.abs(v - lenInt) < 0.1)) continue;
          if (10 < v && v < 500 && !isLikelyUnitPrice(v)) { qty = v; break; }
        }
      }
      if (qty <= 0) continue;
      products.push({ '货物名称': '热轧带肋钢筋', '规格': specStd, '单位': '吨', '数量': qty, '单价': price, '总价': total });
    }
  } else if (docType === 'delivery' || docType === 'pi') {
    for (const line0 of text.split('\n')) {
      const line = line0;
      const fullSpecMatch = line.match(/[Tt]\d{1,2}\s*mm\s*[×xX]\s*\d{1,2}\s*[mM]/);
      const basicSpecMatch = line.match(/[YT]\d{1,2}/);
      const specText = fullSpecMatch ? fullSpecMatch[0] : (basicSpecMatch ? basicSpecMatch[0] : null);
      if (!specText) continue;
      const allNums = rawNumberTokens(line);
      const numValues = allNums.map((n) => normalizeQuantity(n));
      let qty = 0.0;
      for (const v of numValues) { if (isLikelyQuantity(v)) { qty = v; break; } }
      if (qty <= 0) {
        for (let k = 0; k < allNums.length; k++) {
          const v = normalizeQuantity(allNums[k]);
          if (allNums[k].includes('.') && !isLikelyUnitPrice(v) && 10 < v && v < 5000) { qty = v; break; }
        }
      }
      let price = 0.0;
      for (const v of numValues) { if (isLikelyUnitPrice(v)) { price = v; break; } }
      let total = 0.0;
      if (docType === 'pi') {
        for (const v of numValues) { if (v > UNIT_PRICE_MAX && v !== qty) { total = v; break; } }
        if (total <= 0) { const others = numValues.filter((v) => v !== qty); if (others.length) total = Math.max(...others); }
      }
      const unitStr = correctUnit(inferUnitFromLine(line) || '吨')[0];
      if (qty > 0) {
        const isWire = line.includes('电线') || line.includes('電線');
        const name = matchProductName(isWire ? '电线' : '热轧带肋钢筋')[0];
        products.push({ '货物名称': name, '规格': fuzzyMatchSpec(specText), '单位': unitStr, '数量': qty, '单价': price });
      }
    }
  }
  return products.filter((p) => (p['数量'] || 0) > 0);
}
export function parseProductsFromText(text, docType) {
  text = text.replace(/(?<=[一-鿿])[ \t]+(?=[一-鿿])/g, '');
  if (docType === 'contract') return parseProductsFallback(text, docType);
  if (docType === 'delivery' || docType === 'pi') {
    // ✅ 优先检测灯具特征词：有"灯具/照明装置/电池/应急电源"则直接走 parseLampRows，跳过 parseRebarRows
    // （否则 LED 规格里的 1205/1200mm 等数字会被 parseRebarRows 当钢筋直径误判为盘螺）
    const LAMP_KW = /灯具|燈具|電池|电池|照明装置|照明裝置|应急电源|應急電源|LED/;
    if (LAMP_KW.test(text)) {
      const lamp = parseLampRows(text, docType);
      if (lamp.length) return lamp;
    }
    // ✅ 优先检测电线特征词：有"电线/电缆/英标"则直接走 parseCableRows，跳过 parseRebarRows
    // （否则 mm² 中的数字 6/10 等会被 parseRebarRows 当钢筋直径误判为盘螺）
    const CABLE_KW = /電線|电线|電纜|电缆|英標|英标/;
    if (CABLE_KW.test(text)) {
      const cable = parseCableRows(text, docType);
      if (cable.length) return cable;
    }
    // ✅ 型材/板材（方矩管/槽钢/角钢/钢板等）：字段逐行、规格为 * 尺寸串
    // （必须在 parseRebarRows 之前，避免 20*2000*6000 里的数字被钢筋规则误吞）
    if (STEEL_KW.test(text)) {
      const steel = parseSteelRows(text, docType);
      if (steel.length) return steel;
    }
    const rebar = parseRebarRows(text, docType);
    if (rebar.length) return rebar;
    const cable2 = parseCableRows(text, docType);
    if (cable2.length) return cable2;
  }
  const table = parseTableRows(text);
  if (table.length) return table;
  return parseProductsFallback(text, docType);
}
