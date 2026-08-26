# 出口单证工作台（纯前端版）

> 完全离线 · 数据不出本地 · 无后端 · 无网络依赖

统一门户，把两个外贸单证工具整合为一个纯前端工作台，可直接托管到 GitHub Pages 或任意静态服务器使用。

## 包含工具

| 入口 | 功能 | 技术 |
|---|---|---|
| **三流合一核对**（`slhy-web/`）| 销售合同 / 送货单 / 形式发票 OCR 识别 + 三流核对 | pdf.js 文字层 + Tesseract.js OCR（本地 chi_sim 中文模型）+ 白名单约束式提取 + 核对引擎 |
| **报关单转换**（`customs/`）| 海关单一窗口 xlsx → 整理底稿，汇率换算、sheet 汇总 | SheetJS（本地）|

两个工具均为纯前端实现：所有 OCR、Excel 解析、数据计算都在浏览器本地完成，**不调用后端接口、不上传任何数据**。

## 外壳功能

- 左侧深蓝渐变侧边栏（`#1a365d → #2b6cb0`），可点击「◀」收起为 64px 图标栏
- 两个菜单项：**三流合一核对** / **报关单转换**，iframe 懒加载（切换后保留各自状态）
- 当前工具记忆在 localStorage，刷新后恢复
- 底部按钮：**在新窗口打开** / **刷新当前工具**（静态页带时间戳防缓存）
- 窄屏自动变为抽屉式侧边栏（汉堡遮罩打开）

## 本地使用

任选一种：

1. **直接打开**：浏览器打开 `index.html`（三流合一需通过 http 服务访问，见下）
2. **本地静态服务**（推荐）：
   ```bash
   cd 三流合一工作台
   python -m http.server 5010
   # 浏览器访问 http://localhost:5010/
   ```

> 注：三流合一工具依赖 ES Module 加载，建议通过 http 服务访问（`file://` 直接打开可能受限）。

## 部署到 GitHub Pages

1. **创建公开仓库**：GitHub → New repository → 仓库名如 `export-doc-workbench` → Public
2. **推送代码**：
   ```bash
   git init
   git add .
   git commit -m "出口单证工作台（纯前端）"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
3. **启用 Pages**：仓库 Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save
4. 等待 1-2 分钟，访问 `https://<你的用户名>.github.io/<仓库名>/`

## 部署后验证

- [ ] 打开首页，侧边栏两个 tab 可切换
- [ ] 三流合一：上传台账 xlsx → 上传单据 PDF → 开始识别（首次加载 chi_sim 中文模型约 5-10 秒）→ 核对结果
- [ ] 报关单：上传报关单 xlsx → 预览 → 导出整理底稿
- [ ] 断网后刷新仍可完整使用

## 目录结构

```
├── index.html            # 外壳：侧边栏 + iframe 门户
├── slhy-web/             # 三流合一核对（纯前端）
│   ├── index.html
│   ├── js/               # 13 个业务模块（识别/解析/核对引擎）
│   ├── vendor/           # pdf.js / tesseract.js v5 / chi_sim 模型 / SheetJS / Bootstrap
│   └── data/             # 白名单 / 错字词典
└── customs/              # 报关单转换（纯前端）
    ├── index.html
    └── xlsx.full.min.js
```

## 注意事项

- 首次识别送货单/发票会从本地加载 20MB 中文 OCR 模型（`slhy-web/vendor/tessdata/`），后续走浏览器缓存
- 台账/错字词典等用户数据保存在浏览器 localStorage，不会上传
- 浏览器版本建议：Chrome / Edge 100+（需要 ES Module + WebAssembly 支持）
