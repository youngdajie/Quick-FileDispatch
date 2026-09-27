/**
 * 「上传到此文件夹」mini 上传弹窗。
 *
 * 从文件管理页空白处右键叫出来，目标目录固定 = 当前 view.dir（仓库内相对路径）。
 * 用模态弹窗的形态，但**没有走 dom.js 的 modal()** —— 全项目只有 #modalWrap 一个
 * 弹层容器，modal() 会 wrap.innerHTML='' 把正在开着的弹层整个换掉（见 dir-picker
 * 那段注释）。而这个弹窗里要能再叠一层「压缩前后对比」（openCompare 走的就是
 * modal()），两者必须同时存在，所以这里自建一个覆盖层，复用 .modal /
 * .modal-head / .modal-body / .modal-foot 的视觉类，只是 z-index 比 .modal-wrap
 * 低一档（对比层要盖在它上面）。
 *
 * 状态机与主上传页对齐（STATUS_TEXT 的键完全相同）：
 *   pending 等待 → compressing 压缩中 → ready 就绪 → uploading 上传中 → done 完成
 *   任一步出错 → error 失败
 *
 * 文件分流：非图片直接就绪、原样上传；图片先弹「是否压缩」，选压缩后再问
 * 「沿用上传页参数 / 自定义（一次性）」。
 *
 * 文件名与主上传页走**同一套改名规则**（cfg.rename 的 mode / prefix / hashLength，
 * 复用 compress.js 的 buildFileName）—— 同一产品两个上传入口，行为必须一致。
 *
 * **上传流程本身也共用**：本文件只负责「弹窗这一份界面怎么显示」，
 * 转 base64 / 开进度 / 调 cloud.upload / 结果映射 / 同步提示 / 广播事件
 * 全部走 lib/upload-run.js —— 与主上传页是同一份代码。
 * （2026-09-26 抽出去的：之前两处各写一份，很快就出现了
 *  「主页面有进度条、弹窗没有」这类偏差。）
 *
 * LFS 开关的显隐与记忆走 lib/lfs.js，同样与主上传页共用 ——
 * 连 localStorage 的键都是同一个，在哪边勾的另一个入口都认。
 */

import { $, err, ok, warn, escapeHtml, friendlyError, previewImage, paintRange } from './dom.js';
import state from './state.js';
import { CompressPool, defaultThreads, fileToArrayBuffer, buildFileName } from './compress.js';
import { canCompare, openCompare } from './compare.js';
// 与主上传页**共用一份**上传流程与 LFS 开关逻辑。
// 两个入口对用户来说是同一件事，行为必须一致 —— 各写一份的话
// 「主页面有进度条、右键弹窗没有」这类偏差迟早出现。
import { runUpload, uploadResultMessage } from './upload-run.js';
import * as LFS from './lfs.js';

const CPLinks = window.CPLinks;

/* ---------------------------------------------------------------- 常量 */

const STATUS_TEXT = {
  pending: '等待',
  compressing: '压缩中',
  ready: '就绪',
  uploading: '上传中',
  done: '完成',
  error: '失败'
};

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|jfif)$/i;

function looksLikeImage(name, mime) {
  if (mime && mime.indexOf('image/') === 0) return true;
  return IMG_RE.test(name || '');
}

/** 输出格式下拉的选项（与上传页 / 设置页同一套） */
const FORMATS = [
  ['avif', 'AVIF（推荐，体积最小）'],
  ['auto', '智能（按内容自动选）'],
  ['keep', '保持原格式'],
  ['webp', 'WebP'],
  ['jpeg', 'JPEG'],
  ['png', 'PNG']
];

function formatLabel(id) {
  const f = FORMATS.find((x) => x[0] === id);
  return f ? f[1].replace(/（.*?）/, '') : String(id || '');
}

const REMOVE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const CMP_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/><path d="M6.5 12h2.5M15 12h2.5"/></svg>';

/* ---------------------------------------------------------------- 弹窗状态 */

let wrap = null; // 覆盖层元素
let queue = [];
let nodes = new Map();
let seq = 0;
let pendingImages = []; // 等待「是否压缩」决定的图片
let decisionStep = ''; // '' | 'ask' | 'params' | 'custom'
let running = false;
let uploaded = false;
let pool = null;
let onDoneCb = null;
let escHandler = null;

/* ---------------------------------------------------------------- 小工具 */

function limitOf() {
  return CPLinks.limitOf((state.cfg || {}).platform);
}

function checkLimit(bytes) {
  const lim = limitOf();
  if (bytes > lim.maxFile) {
    throw new Error(
      CPLinks.formatBytes(bytes) + ' 超过 ' + lim.name + ' 单文件上限（' + CPLinks.formatBytes(lim.maxFile) + '）'
    );
  }
}

/**
 * 主上传页那套改名规则的取值来源（与 upload.js 的 processPending 一致）：
 * mode / prefix 由 upload 页的「文件名 / 前缀」持久化进 cfg.rename，
 * hashLength 也来自 cfg.rename。mini 这里直接读同一份配置，行为不漂移。
 */
function renameOpts() {
  const ren = (state.cfg || {}).rename || {};
  return {
    mode: ren.mode || 'keep',
    prefix: ren.prefix || '',
    hashLen: ren.hashLength || 8
  };
}

function poolSize() {
  const c = Number((state.cfg || {}).concurrency) || 0;
  return c > 0 ? Math.min(32, c) : defaultThreads();
}

function ensurePool() {
  const size = poolSize();
  if (!pool || pool.size !== size) {
    if (pool) pool.terminate();
    pool = new CompressPool(size);
  }
  return pool;
}

/* ---------------------------------------------------------------- 队列项 */

function newItem(file) {
  const name = file.name || 'file-' + Date.now();
  return {
    id: ++seq,
    file: file,
    origName: name,
    origSize: file.size || 0,
    isImage: looksLikeImage(name, file.type),
    previewUrl: '',
    status: 'pending',
    outName: '',
    outBuffer: null,
    outSize: 0,
    passthrough: false,
    outW: 0,
    outH: 0,
    srcW: 0,
    srcH: 0,
    quality: 0,
    note: '',
    error: '',
    path: ''
  };
}

function statusClass(it) {
  if (it.status === 'done') return 'ok';
  if (it.status === 'error') return 'err';
  if (it.status === 'compressing' || it.status === 'uploading') return 'run';
  return '';
}

function ensureNode(it) {
  let el = nodes.get(it.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'q-item';
  el.dataset.id = String(it.id);
  el.innerHTML =
    '<div class="q-thumb"></div>' +
    '<div class="q-info"><div class="q-name"></div><div class="q-meta"></div></div>' +
    '<div class="q-status"></div>' +
    '<button type="button" class="icon-btn sm" data-act="cmp" title="压缩前后对比" hidden>' + CMP_SVG + '</button>' +
    '<button type="button" class="icon-btn sm" data-act="remove" title="移出队列">' + REMOVE_SVG + '</button>';
  el.querySelector('[data-act="remove"]').onclick = () => {
    if (running) return;
    removeItem(it.id);
  };
  el.querySelector('[data-act="cmp"]').onclick = () => {
    if (canCompare(it)) openCompare(it);
  };
  el.querySelector('.q-thumb').onclick = () => {
    if (canCompare(it)) openCompare(it);
    else if (it.previewUrl) previewImage(it.previewUrl);
  };
  $('#miniList', wrap).appendChild(el);
  nodes.set(it.id, el);
  return el;
}

function updateItem(it) {
  const el = nodes.get(it.id);
  if (!el) return;
  const thumb = el.querySelector('.q-thumb');
  if (it.previewUrl) {
    thumb.style.backgroundImage = 'url("' + it.previewUrl + '")';
    thumb.textContent = '';
  } else if (!thumb.textContent) {
    thumb.textContent = (CPLinks.extOf(it.origName) || 'file').toUpperCase().slice(0, 4);
    thumb.classList.add('ext');
  }
  const nameEl = el.querySelector('.q-name');
  nameEl.textContent = it.outName || it.origName;
  nameEl.title = it.outName || it.origName;

  // 与主上传页 updateItem 的 meta 行保持一致：原始体积 → 压缩后体积 · 省下百分比 · 尺寸 · 质量
  const parts = [CPLinks.formatBytes(it.origSize)];
  if (it.outSize && it.outSize !== it.origSize) {
    const saved = it.origSize - it.outSize;
    const pct = it.origSize ? Math.round((saved / it.origSize) * 100) : 0;
    parts.push('→');
    parts.push('<span class="' + (saved > 0 ? 'good' : 'bad') + '">' + CPLinks.formatBytes(it.outSize) + '</span>');
    parts.push('<span class="' + (pct > 0 ? 'good' : 'bad') + '">' + (pct > 0 ? '-' + pct : '+' + Math.abs(pct)) + '%</span>');
  }
  if (it.outW) {
    if (it.srcW && (it.outW !== it.srcW || it.outH !== it.srcH)) parts.push(it.srcW + '×' + it.srcH + ' → ' + it.outW + '×' + it.outH);
    else parts.push(it.outW + '×' + it.outH);
  }
  if (it.quality && !it.passthrough) parts.push('q' + it.quality);
  if (it.note) parts.push(escapeHtml(it.note));
  el.querySelector('.q-meta').innerHTML = parts.join(' ');

  const st = el.querySelector('.q-status');
  st.className = 'q-status ' + statusClass(it);
  st.textContent = STATUS_TEXT[it.status] || it.status;
  st.title = it.error || '';

  const cmp = el.querySelector('[data-act="cmp"]');
  if (cmp) cmp.hidden = !canCompare(it);
}

function removeItem(id) {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return;
  const it = queue.splice(idx, 1)[0];
  if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  const el = nodes.get(id);
  if (el) el.remove();
  nodes.delete(id);
  const pi = pendingImages.indexOf(it);
  if (pi >= 0) {
    pendingImages.splice(pi, 1);
    if (!pendingImages.length) decisionStep = '';
    renderDecision();
  }
  updateSummary();
}

function updateSummary() {
  const el = $('#miniSum', wrap);
  if (!el) return;
  const ready = queue.filter((q) => q.status === 'ready').length;
  const done = queue.filter((q) => q.status === 'done').length;
  const busy = queue.filter((q) => q.status === 'compressing' || q.status === 'uploading').length;
  const bad = queue.filter((q) => q.status === 'error').length;
  const bits = [queue.length + ' 个文件'];
  if (ready) bits.push(ready + ' 个就绪');
  if (busy) bits.push(busy + ' 个处理中');
  if (done) bits.push(done + ' 个已上传');
  if (bad) bits.push(bad + ' 个失败');
  el.textContent = bits.join(' · ');
  const start = $('#miniStart', wrap);
  if (start) start.disabled = running || !ready;
}

/* ---------------------------------------------------------------- 压缩参数 */

/** 沿用主上传页那一套（值就存在 state.cfg.compress / watermark 里） */
function reuseOptions() {
  const c = state.cfg || {};
  const cmp = c.compress || {};
  return {
    quality: Number(cmp.quality) || 80,
    maxWidth: Number(cmp.maxWidth) || 0,
    maxHeight: Number(cmp.maxHeight) || 0,
    format: cmp.format || 'auto',
    targetSizeKB: Number(cmp.targetSizeKB) || 0,
    skipIfSmaller: cmp.skipIfSmaller !== false,
    watermark: c.watermark || { enabled: false }
  };
}

/** 自定义表单的初值（一次性，不写回配置） */
function defaultCustom() {
  const cmp = (state.cfg || {}).compress || {};
  return { quality: Number(cmp.quality) || 80, format: cmp.format || 'auto' };
}

function readCustomOptions() {
  const q = Number($('#mcQ', wrap).value) || 80;
  const fmt = $('#mcFmt', wrap).value || 'auto';
  const mw = Number($('#mcW', wrap).value) || 0;
  const mh = Number($('#mcH', wrap).value) || 0;
  return {
    quality: q,
    maxWidth: mw,
    maxHeight: mh,
    format: fmt,
    targetSizeKB: 0,
    skipIfSmaller: true,
    watermark: { enabled: false }
  };
}

/* ---------------------------------------------------------------- 决策面板 */

function enqueueImages(images) {
  pendingImages = pendingImages.concat(images);
  if (!decisionStep) decisionStep = 'ask';
  renderDecision();
}

function renderDecision() {
  const box = $('#miniDecision', wrap);
  if (!box) return;
  const n = pendingImages.length;
  if (!n) {
    box.innerHTML = '';
    return;
  }

  if (decisionStep === 'ask') {
    box.innerHTML =
      '<div class="mini-ask">' +
      '<div class="mini-ask-title">这 ' + n + ' 张图片要压缩吗？</div>' +
      '<div class="mini-ask-sub">选「不压缩」就按原图上传；做出选择前这些图片停在「等待」</div>' +
      '<div class="mini-ask-btns">' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="ask-compress">压缩</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="ask-skip">不压缩，直接上传</button>' +
      '</div>' +
      '</div>';
  } else if (decisionStep === 'params') {
    const op = reuseOptions();
    box.innerHTML =
      '<div class="mini-ask">' +
      '<div class="mini-ask-title">用哪套压缩参数？（只对这一批 ' + n + ' 张生效）</div>' +
      '<div class="mini-ask-btns">' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="use-reuse">沿用上传页参数（q' +
      escapeHtml(String(op.quality)) + ' · ' + escapeHtml(formatLabel(op.format)) + '）</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="use-custom">自定义参数…</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="back-ask">返回</button>' +
      '</div>' +
      '</div>';
  } else if (decisionStep === 'custom') {
    const d = defaultCustom();
    box.innerHTML =
      '<div class="mini-ask">' +
      '<div class="mini-ask-title">自定义压缩参数（只对当前这批生效，不改配置）</div>' +
      '<div class="mini-custom">' +
      '<label class="field"><span class="field-label">质量 <b id="mcQVal">' + d.quality + '</b></span>' +
      '<input type="range" id="mcQ" min="10" max="100" value="' + d.quality + '" /></label>' +
      '<label class="field"><span class="field-label">输出格式</span>' +
      '<select id="mcFmt">' +
      FORMATS.map((f) => '<option value="' + f[0] + '"' + (f[0] === d.format ? ' selected' : '') + '>' + escapeHtml(f[1]) + '</option>').join('') +
      '</select></label>' +
      '<div class="grid-2">' +
      '<label class="field"><span class="field-label">最大宽度 <span class="hint">px · 0 = 不限</span></span>' +
      '<input type="number" id="mcW" min="0" step="100" value="0" /></label>' +
      '<label class="field"><span class="field-label">最大高度 <span class="hint">px · 0 = 不限</span></span>' +
      '<input type="number" id="mcH" min="0" step="100" value="0" /></label>' +
      '</div>' +
      '</div>' +
      '<div class="mini-ask-btns">' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="apply-custom">开始压缩</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="back-params">返回</button>' +
      '</div>' +
      '</div>';
    const q = $('#mcQ', box);
    if (q) {
      paintRange(q);
      q.oninput = () => {
        const v = $('#mcQVal', box);
        if (v) v.textContent = q.value;
      };
    }
  }
}

function finishDecision() {
  pendingImages = [];
  decisionStep = '';
  renderDecision();
}

/* ---------------------------------------------------------------- 处理 */

/** 非图片：直接就绪、原样上传（文件名走与主上传页同一套改名规则） */
async function processPassthrough(it, note) {
  try {
    const buf = await fileToArrayBuffer(it.file);
    checkLimit(buf.byteLength);
    const ro = renameOpts();
    it.outBuffer = buf;
    it.outSize = buf.byteLength;
    it.passthrough = true;
    it.note = note || '原样上传';
    it.outName = await buildFileName(it.origName, ro.mode, ro.prefix, buf, CPLinks.extOf(it.origName), ro.hashLen);
    it.status = 'ready';
  } catch (e) {
    it.status = 'error';
    it.error = friendlyError(e.message || String(e));
  }
  updateItem(it);
  updateSummary();
}

/** 图片选「不压缩」：走原图，但补上体积与状态 */
async function skipCompress(items) {
  await Promise.all(items.map((it) => processPassthrough(it, '未压缩')));
}

/** 图片选「压缩」：交给压缩池，与主上传页同一套结果字段 + 改名规则 */
async function runCompress(items, opts) {
  const cpool = ensurePool();
  const lim = limitOf();
  const ro = renameOpts();
  await Promise.all(
    items.map(async (it) => {
      it.status = 'compressing';
      updateItem(it);
      try {
        const buf = await fileToArrayBuffer(it.file);
        checkLimit(buf.byteLength);
        const res = await cpool.run(it.origName, buf, opts);
        it.outBuffer = res.buffer;
        it.outSize = res.buffer.byteLength;
        it.passthrough = !!res.passthrough;
        it.outW = res.width || 0;
        it.outH = res.height || 0;
        it.srcW = res.srcWidth || res.width || 0;
        it.srcH = res.srcHeight || res.height || 0;
        it.quality = res.quality || 0;
        it.note = res.reason || '';
        const origExt = CPLinks.extOf(it.origName);
        const outExt = res.passthrough ? origExt : res.ext || origExt;
        it.outName = await buildFileName(it.origName, ro.mode, ro.prefix, res.buffer, outExt, ro.hashLen);
        if (it.outSize > lim.maxFile) {
          throw new Error('处理后仍有 ' + CPLinks.formatBytes(it.outSize) + '，超过平台单文件上限');
        }
        it.status = 'ready';
      } catch (e) {
        it.status = 'error';
        it.error = friendlyError(e.message || String(e));
        it.outSize = 0;
      }
      updateItem(it);
    })
  );
  updateSummary();
}

function addFiles(fileList) {
  if (running) {
    warn('正在上传，稍等一下');
    return;
  }
  const files = Array.from(fileList || []).filter((f) => !f.name || !/^\./.test(f.name));
  if (!files.length) {
    warn('没有拿到可用的文件');
    return;
  }
  const images = [];
  for (const f of files) {
    const it = newItem(f);
    if (it.isImage) {
      try {
        it.previewUrl = URL.createObjectURL(f);
      } catch (e) {
        it.previewUrl = '';
      }
    }
    queue.push(it);
    ensureNode(it);
    updateItem(it);
    if (it.isImage) images.push(it);
    else processPassthrough(it);
  }
  if (images.length) enqueueImages(images);
  updateSummary();
}

/* ---------------------------------------------------------------- 上传 */

/**
 * 进度条的元素 id（与 build() 生成的结构一一对应）。
 *
 * 共享的 startProgressBar 按 id 找元素 —— 这里只声明「本弹窗把进度条
 * 放在哪几个节点上」，DOM 结构本身在 build() 里。这样两个上传入口
 * 共用同一套进度渲染逻辑，只是挂在不同节点上。
 */
const MINI_PROGRESS_IDS = {
  prog: 'miniProgress',
  bar: 'miniProgressBar',
  label: 'miniProgressLabel',
  detail: 'miniProgressDetail',
  pct: 'miniProgressPct'
};

async function doUpload() {
  if (running) return;
  if (!state.configured) {
    err('请先在「设置」里完成仓库与 Token 配置');
    return;
  }
  const ready = queue.filter((q) => q.outBuffer && q.status !== 'error' && q.status !== 'done');
  if (!ready.length) {
    err('没有待上传的文件');
    return;
  }
  running = true;
  const start = $('#miniStart', wrap);
  if (start) start.disabled = true;
  // 全部先标「等待」：分批上传时同一时刻只有一批在传
  ready.forEach((it) => {
    it.status = 'pending';
    updateItem(it);
  });
  updateSummary();

  const dir = CPLinks.normalizePath(($('#miniDir', wrap) && $('#miniDir', wrap).dataset.dir) || '');

  try {
    // 与主上传页**共用一份**上传流程（lib/upload-run.js）：
    // 分批、转 base64、开进度、调接口、结果映射、同步提示、广播事件都在那边。
    // 这里只负责本弹窗的显示差异（列表项 + 汇总行）。
    const res = await runUpload({
      ready: ready,
      dir: dir,
      useLFS: LFS.lfsEnabled(state.cfg, $('#miniLfs', wrap)),
      progressIds: MINI_PROGRESS_IDS,
      // 一批开始前标成「上传中」（其余仍是「等待」）
      onBatch: (items) => {
        items.forEach((it) => {
          it.status = 'uploading';
          updateItem(it);
        });
      },
      onItem: (it, r) => {
        if (r.ok) {
          it.status = 'done';
          it.path = r.path;
          it.error = '';
        } else {
          it.status = 'error';
          it.error = r.error;
        }
        updateItem(it);
      },
      onSummary: updateSummary
    });

    // 有文件成功 → 通知调用方（文件管理页据此刷新列表）
    if (ready.some((it) => it.status === 'done')) uploaded = true;

    const m = uploadResultMessage(res, '个');
    if (m.ok) ok(m.text);
    else err(m.text);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    running = false;
    updateSummary();
  }
}

/* ---------------------------------------------------------------- 组装与关闭 */

function build() {
  const el = document.createElement('div');
  el.className = 'mini-up-wrap';
  el.id = 'miniUpWrap';
  el.innerHTML =
    '<div class="modal mini-up">' +
    '<div class="modal-head"><span class="mh-title">上传到此文件夹</span></div>' +
    '<div class="modal-body">' +
    '<div class="mini-target">目标目录：<b id="miniDir"></b></div>' +
    '<div class="mini-drop" id="miniDrop">' +
    '<div class="md-title">把文件拖到这里</div>' +
    '<div class="md-sub">图片可先压缩再上传，其它文件原样上传</div>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="miniPick">选择文件</button>' +
    '<input type="file" id="miniInput" multiple hidden />' +
    '</div>' +
    '<div id="miniDecision"></div>' +
    // LFS 开关。复用主上传页的 .up-lfs 样式 —— 两个入口长得一样，
    // 用户才认得出「这是同一个功能」。
    '<label class="up-lfs" id="miniLfsRow" hidden>' +
    '<input type="checkbox" id="miniLfs" />' +
    '<span class="up-lfs-text">' +
    '<b>用 LFS 对象存储</b>' +
    '<span class="hint">文件内容存进 CNB 对象存储（独立额度），仓库里只留一个指针。首次使用会自动下载 git-lfs。</span>' +
    '</span>' +
    '</label>' +
    // 实时进度。与主上传页同一套结构和样式（.up-progress）。
    '<div class="up-progress" id="miniProgress" hidden>' +
    '<div class="up-progress-head">' +
    '<span class="up-progress-label" id="miniProgressLabel">上传中</span>' +
    '<span class="up-progress-detail" id="miniProgressDetail"></span>' +
    '<span class="up-progress-pct" id="miniProgressPct"></span>' +
    '</div>' +
    '<div class="progress"><div class="progress-bar" id="miniProgressBar"></div></div>' +
    '</div>' +
    '<div class="mini-list" id="miniList"></div>' +
    '</div>' +
    '<div class="modal-foot">' +
    '<span class="mini-foot-sum" id="miniSum"></span>' +
    '<button type="button" class="btn btn-ghost" id="miniClose">关闭</button>' +
    '<button type="button" class="btn btn-primary" id="miniStart" disabled>开始上传</button>' +
    '</div>' +
    '</div>';
  return el;
}

function wire(target) {
  const dirEl = $('#miniDir', wrap);
  dirEl.textContent = target || '仓库根目录';
  dirEl.dataset.dir = target || '';

  // LFS 开关：与主上传页共用同一套「按平台显隐 + 记住选择」的逻辑，
  // 连 localStorage 的键都是同一个 —— 在主页面勾了，这里打开也是勾上的。
  const lfsBox = $('#miniLfs', wrap);
  LFS.syncLfsUI(state.cfg, { row: $('#miniLfsRow', wrap), box: lfsBox });
  if (lfsBox) {
    // 勾上先弹确认（对象存储无法 jsdmirror 加速），取消就回退不勾
    lfsBox.addEventListener('change', async () => {
      if (lfsBox.checked) {
        const ok = await LFS.confirmLfsEnable();
        if (!ok) lfsBox.checked = false;
      }
    });
  }

  const drop = $('#miniDrop', wrap);
  const input = $('#miniInput', wrap);

  $('#miniPick', wrap).onclick = () => input.click();
  input.onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  // 拖放：整个覆盖层都收，落到哪都算数。stopPropagation 挡住上传页挂在
  // document 上的全局拖放（否则文件会同时进主上传队列）。
  ['dragenter', 'dragover'].forEach((t) => {
    wrap.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!running) drop.classList.add('over');
    });
  });
  wrap.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target === wrap) drop.classList.remove('over');
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('over');
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });

  // 决策面板按钮
  $('#miniDecision', wrap).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const batch = pendingImages.slice();
    if (act === 'ask-compress') {
      decisionStep = 'params';
      renderDecision();
    } else if (act === 'ask-skip') {
      finishDecision();
      skipCompress(batch);
    } else if (act === 'back-ask') {
      decisionStep = 'ask';
      renderDecision();
    } else if (act === 'use-reuse') {
      const op = reuseOptions();
      finishDecision();
      runCompress(batch, op);
    } else if (act === 'use-custom') {
      decisionStep = 'custom';
      renderDecision();
    } else if (act === 'back-params') {
      decisionStep = 'params';
      renderDecision();
    } else if (act === 'apply-custom') {
      const op = readCustomOptions(); // 必须在清空 DOM 之前读
      finishDecision();
      runCompress(batch, op);
    }
  });

  $('#miniStart', wrap).onclick = () => doUpload();
  $('#miniClose', wrap).onclick = () => close();

  // 点遮罩关闭（点弹窗本体不关）
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });

  escHandler = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', escHandler, true);
}

function close() {
  if (running) {
    warn('正在上传，请稍候');
    return;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler, true);
    escHandler = null;
  }
  queue.forEach((it) => {
    if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  });
  if (pool) {
    pool.terminate();
    pool = null;
  }
  if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
  wrap = null;
  nodes = new Map();
  queue = [];
  pendingImages = [];
  decisionStep = '';
  const done = uploaded;
  uploaded = false;
  if (done && onDoneCb) {
    try {
      onDoneCb();
    } catch (e) {
      /* 刷新失败不该影响关窗 */
    }
  }
}

/**
 * 打开 mini 上传弹窗。
 * @param {string} dir 目标目录（仓库内相对路径，根目录为空串）
 * @param {Function} [onDone] 有文件成功上传时、弹窗关闭后调用（用来刷新文件管理页）
 */
export function openMiniUpload(dir, onDone) {
  const old = document.getElementById('miniUpWrap');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const target = CPLinks.normalizePath(dir || '');
  queue = [];
  nodes = new Map();
  seq = 0;
  pendingImages = [];
  decisionStep = '';
  running = false;
  uploaded = false;
  pool = null;
  onDoneCb = typeof onDone === 'function' ? onDone : null;

  wrap = build();
  document.body.appendChild(wrap);
  wire(target);
  updateSummary();
  return { close };
}
