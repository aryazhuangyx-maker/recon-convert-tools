// extract.js — 识别层（pdf.js 文字层 + Tesseract.js OCR + 双路合并）
import { applyGarbleFix, learnGarbleFixes } from './garble.js';
export const OCR_LABEL_ALLOWLIST = new Set([
  '數量', '数量', '單位', '单位', '單价', '单价', '總价', '总价', '金額', '金额',
  '合計', '合计', '客戶', '客户', '供方', '收貨', '收货', '送貨', '送货',
  '簽收', '签收', '備註', '备注', '電話', '电话', '傳真', '传真', '日期',
  '合約', '合约', '編號', '编号', '聯絡', '联络', '地址', '名稱', '名称',
  '規格', '规格', '型號', '型号', '產品', '产品', '貨物', '货物', '科技',
  '數', '量', '單', '價', '額', '號', '期', '噸', '吨', '支', '米', '件',
  '申請', '申请', '單位', '發票', '发票', '金額', '總計', '总计',
]);
export function tlWordsToLines(tlWords) {
  if (!tlWords || !tlWords.length) return '';
  const lines = [];
  let cur = [], curY = null;
  const sorted = [...tlWords].sort((a, b) => (Math.round(a[1]) - Math.round(b[1])) || (a[0] - b[0]));
  for (const w of sorted) {
    if (curY === null || Math.abs(w[1] - curY) <= 6) cur.push(w);
    else { lines.push(cur); cur = [w]; }
    curY = w[1];
  }
  if (cur.length) lines.push(cur);
  return lines.map((ln) => [...ln].sort((a, b) => a[0] - b[0]).map((x) => x[4]).join(' ')).join('\n');
}
export function ocrWordsToLines(ocrWords) {
  if (!ocrWords || !ocrWords.length) return '';
  const lines = [];
  let cur = [], curY = null;
  const sorted = [...ocrWords].sort((a, b) => (Math.round(a.bbox[1]) - Math.round(b.bbox[1])) || (a.bbox[0] - b.bbox[0]));
  for (const w of sorted) {
    const y = w.bbox[1];
    if (curY === null || Math.abs(y - curY) <= 6) cur.push(w);
    else { lines.push(cur); cur = [w]; }
    curY = y;
  }
  if (cur.length) lines.push(cur);
  return lines.map((ln) => [...ln].sort((a, b) => a.bbox[0] - b.bbox[0]).map((x) => x.text).join(' ')).join('\n');
}
export function iou(a, b) {
  const [ax0, ay0, ax1, ay1] = a, [bx0, by0, bx1, by1] = b;
  const ix0 = Math.max(ax0, bx0), iy0 = Math.max(ay0, by0);
  const ix1 = Math.min(ax1, bx1), iy1 = Math.min(ay1, by1);
  const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  if (inter <= 0) return 0.0;
  const aa = (ax1 - ax0) * (ay1 - ay0), ab = (bx1 - bx0) * (by1 - by0);
  return inter / (aa + ab - inter);
}
export function mergePageWords(tlWords, ocrWords, pageIdx, diffs, learned) {
  const tokens = [];
  const usedOcr = new Set();
  for (let i = 0; i < ocrWords.length; i++) {
    const ow = ocrWords[i];
    const [ox0, oy0, ox1, oy1] = ow.bbox;
    const cx = (ox0 + ox1) / 2.0, cy = (oy0 + oy1) / 2.0;
    let hit = false;
    for (const tw of tlWords) {
      const tb = [tw[0], tw[1], tw[2], tw[3]];
      if (tb[0] <= cx && cx <= tb[2] && tb[1] <= cy && cy <= tb[3]) { hit = true; break; }
    }
    if (!hit) { for (const tw of tlWords) { if (iou([tw[0], tw[1], tw[2], tw[3]], ow.bbox) > 0.15) { hit = true; break; } } }
    if (!hit) {
      const owW = Math.max(1e-6, ox1 - ox0), owH = Math.max(1e-6, oy1 - oy0);
      for (const tw of tlWords) {
        const tb = [tw[0], tw[1], tw[2], tw[3]];
        const xov = Math.min(tb[2], ox1) - Math.max(tb[0], ox0);
        const yov = Math.min(tb[3], oy1) - Math.max(tb[1], oy0);
        if (xov > 0 && yov > 0 && (xov / owW) > 0.6 && (yov / owH) > 0.5) { hit = true; break; }
      }
    }
    if (hit) usedOcr.add(i);
  }
  for (const tw of tlWords) {
    const bbox = [tw[0], tw[1], tw[2], tw[3]];
    const txt = tw[4];
    let bestI = -1, bestIou = 0.0;
    for (let i = 0; i < ocrWords.length; i++) {
      const v = iou(bbox, ocrWords[i].bbox);
      if (v > bestIou) { bestIou = v; bestI = i; }
    }
    let final = txt, src = 'tl';
    const hasAlnum = /[0-9A-Za-z]/.test(txt);
    if (bestI >= 0 && bestIou > 0.1) {
      const ow = ocrWords[bestI];
      if (ow.text !== txt) {
        if (!hasAlnum && txt.length <= 4 && ow.conf >= 75 && OCR_LABEL_ALLOWLIST.has(ow.text) && ow.text.length === txt.length) {
          final = ow.text; src = 'ocr';
          diffs.push({ page: pageIdx + 1, text_layer: txt, ocr: ow.text, conf: Math.round(ow.conf * 10) / 10 });
          learned.push([txt, ow.text]);
        } else if (txt.length <= 6) {
          diffs.push({ page: pageIdx + 1, text_layer: txt, ocr: ow.text, conf: Math.round(ow.conf * 10) / 10, kept: 'text_layer' });
        }
      }
    }
    tokens.push({ bbox, text: final, yc: (tw[1] + tw[3]) / 2.0, x0: tw[0], src });
  }
  for (let i = 0; i < ocrWords.length; i++) {
    if (usedOcr.has(i)) continue;
    const bbox = ocrWords[i].bbox;
    tokens.push({ bbox, text: ocrWords[i].text, yc: (bbox[1] + bbox[3]) / 2.0, x0: bbox[0], src: 'ocr_only' });
  }
  if (!tokens.length) return '';
  const heights = tokens.filter((t) => t.bbox[3] > t.bbox[1]).map((t) => t.bbox[3] - t.bbox[1]);
  const mid = heights.length ? [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 12.0;
  const lineThr = Math.max(8.0, mid * 0.9);
  tokens.sort((a, b) => (Math.round(a.yc / lineThr) - Math.round(b.yc / lineThr)) || (a.x0 - b.x0));
  const lines = [];
  let cur = [], curY = null;
  for (const t of tokens) {
    const y = t.yc;
    if (curY === null || Math.abs(y - curY) <= lineThr) cur.push(t);
    else { lines.push(cur); cur = [t]; }
    curY = y;
  }
  if (cur.length) lines.push(cur);
  return lines.map((ln) => [...ln].sort((a, b) => a.x0 - b.x0).map((x) => x.text).join(' ')).join('\n');
}
export async function extractTextLayer(pdf, pageIndex) {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const words = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    const x0 = tx[4], y0 = viewport.height - tx[5];
    const w = item.width || 0, h = item.height || 8;
    words.push([x0, y0, x0 + w, y0 + h, item.str]);
  }
  page.cleanup();
  return words;
}
export async function ocrPage(worker, canvas, dpiScale, psm) {
  const res = await worker.recognize(canvas);
  const words = [];
  for (const w of res.data.words || []) {
    const b = w.bbox;
    words.push({ bbox: [b.x0 / dpiScale, b.y0 / dpiScale, b.x1 / dpiScale, b.y1 / dpiScale], text: w.text, conf: w.confidence || 0 });
  }
  return words;
}
export async function extractHybrid(pdfData, opts = {}) {
  const { maxOcrPages, earlyStopFn, onProgress, tessOptions = {} } = opts;
  const res = { merged_text: '', text_layer: '', ocr_text: '', diffs: [] };
  const pdfjs = await import('../vendor/pdf.min.js');
  // ✅ pdf.js v6+ 必须在创建 PDFWorker 前设置 GlobalWorkerOptions.workerSrc
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.v2.min.js', import.meta.url).href;
  }
  const Tesseract = window.Tesseract;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfData) }).promise;
  const total = pdf.numPages;
  const tlPages = [];
  let tlTextLen = 0;
  for (let i = 0; i < total; i++) {
    const words = await extractTextLayer(pdf, i);
    tlPages.push(words);
    tlTextLen += words.map((w) => w[4]).join(' ').length;
  }
  let ocrPages = [];
  let worker = null;
  if (tlTextLen < 200) {
    const ocrTotal = maxOcrPages ? Math.min(total, maxOcrPages) : total;
    worker = await Tesseract.createWorker('chi_sim', 1, {
      langPath: tessOptions.langPath || 'vendor/tessdata',
      workerPath: tessOptions.workerPath || new URL('../vendor/worker.min.js', import.meta.url).href,
      corePath: tessOptions.corePath || new URL('../vendor/tesseract-core.wasm.js', import.meta.url).href,
    });
    const DPI = 400;
    const dpiScale = DPI / 72;
    const accText = [];
    let done = 0;
    for (let i = 0; i < ocrTotal; i++) {
      if (onProgress) onProgress({ stage: '渲染页面', page: i, total: ocrTotal });
      const page = await pdf.getPage(i + 1);
      const viewport = page.getViewport({ scale: dpiScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      if (onProgress) onProgress({ stage: 'OCR', page: done, total: ocrTotal });
      ocrPages[i] = await ocrPage(worker, canvas, dpiScale, 6);
      done++;
      if (onProgress) onProgress({ stage: 'OCR', page: done, total: ocrTotal });
      if (earlyStopFn) {
        accText.push(ocrWordsToLines(ocrPages[i]));
        if (earlyStopFn(accText.join('\n'))) break;
      }
    }
    for (let i = 0; i < tlPages.length; i++) { if (!ocrPages[i]) ocrPages[i] = []; }
    await worker.terminate();
  }
  const mergedPages = [];
  const learned = [];
  for (let i = 0; i < tlPages.length; i++) {
    mergedPages.push(applyGarbleFix(mergePageWords(tlPages[i], ocrPages[i] || [], i, res.diffs, learned)));
  }
  if (learned.length) learnGarbleFixes(learned);
  res.merged_text = mergedPages.join('\n').trim();
  res.text_layer = tlPages.map((w, i) => tlWordsToLines(w)).join('\n').trim();
  res.ocr_text = (ocrPages || []).map((w) => ocrWordsToLines(w)).join('\n').trim();
  await pdf.cleanup();
  return res;
}
