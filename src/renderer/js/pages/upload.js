/** 上传页 */

import { $, $$, toast, err, ok, warn, modal, previewImage, escapeHtml, debounce, pulse, friendlyError } from '../lib/dom.js';
import state from '../lib/state.js';
import { CompressPool, defaultThreads, fileToArrayBuffer, buildFileName } from '../lib/compress.js';
import { openColorPicker, closeColorPicker, normalizeHex } from '../lib/colorpicker.js';
// 前后对比（含 OUT_MIME / canCompare / openCompare）已提到共享模块，
// 主上传页与「上传到此文件夹」mini 弹窗共用一份
import { canCompare, openCompare } from '../lib/compare.js';
// 上传流程与 mini 弹窗共用一份（进度、base64、结果映射、同步提示都在里面）
import { runUpload, uploadResultMessage } from '../lib/upload-run.js';
// LFS 开关的共享逻辑（与 mini 上传弹窗共用同一套判断和记忆）
import * as LFS from '../lib/lfs.js';
// 水印字体下拉要列本机真装了的字体，和设置页的「界面字体」用的是同一份枚举
import { installedFontGroups } from '../lib/appearance.js';

const CPLinks = window.CPLinks;
const CPWm = window.CPWatermark;

/** 水印配色快捷项（#1296db 是默认）——原设置页的色板跟着水印一起迁了过来 */
const WM_PRESETS = ['#1296db', '#ffffff', '#101722', '#ff4d4f', '#20c997', '#f5a623'];

let pool = null;
let seq = 0;
const queue = [];
const nodes = new Map();
let running = false;
let processTimer = null;

/* ---------------------------------------------------------------- 队列数据结构 */

function newItem(file) {
  const name = file.name || `file-${Date.now()}`;
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
    path: '',
    url: ''
  };
}

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|jfif)$/i;

function looksLikeImage(name, mime) {
  if (mime && mime.indexOf('image/') === 0) return true;
  return IMG_RE.test(name || '');
}

/* ---------------------------------------------------------------- 列表渲染 */

const STATUS_TEXT = {
  pending: '等待',
  compressing: '压缩中',
  ready: '就绪',
  uploading: '上传中',
  done: '已上传',
  error: '失败'
};

function statusClass(it) {
  if (it.status === 'done') return 'ok';
  if (it.status === 'error') return 'err';
  if (it.status === 'compressing' || it.status === 'uploading') return 'run';
  return '';
}

const REMOVE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function ensureNode(it) {
  let el = nodes.get(it.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'q-item';
  el.dataset.id = String(it.id);
  el.style.setProperty('--i', String(Math.min(nodes.size, 18)));
  el.innerHTML =
    '<div class="q-thumb"></div>' +
    '<div class="q-info"><div class="q-name"></div><div class="q-meta"></div></div>' +
    '<div class="q-status"></div>' +
    '<button class="icon-btn sm" data-act="remove" title="移出队列">' + REMOVE_SVG + '</button>';
  el.querySelector('[data-act="remove"]').onclick = () => {
    if (running) return;
    removeItem(it.id);
  };
  $('#queueList').appendChild(el);
  nodes.set(it.id, el);
  return el;
}

function updateItem(it) {
  const el = ensureNode(it);
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
  // 不给文件名挂 title：任务项本身已经把大小 / 尺寸 / 质量全摆出来了，
  // 再弹一个云朵气泡只会重复同样的信息（杰哥点名去掉）

  const parts = [CPLinks.formatBytes(it.origSize)];
  if (it.outSize && it.outSize !== it.origSize) {
    const saved = it.origSize - it.outSize;
    const pct = Math.round((saved / it.origSize) * 100);
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
  const cls = statusClass(it);
  st.className = cls ? 'q-status ' + cls : 'q-status';
  st.textContent = STATUS_TEXT[it.status] || it.status;
  // title 只在真有错误时给 —— 空值会渲染成 title="" 这种没意义的属性
  if (it.error) st.title = it.error;
  else st.removeAttribute('title');
  return el;
}

function refreshTotals() {
  const orig = queue.reduce((a, b) => a + b.origSize, 0);
  const now = queue.reduce((a, b) => a + (b.outSize || b.origSize), 0);
  const prev = refreshTotals.__prev || { count: -1, new: '' };
  const cntEl = $('#queueCount');
  const newEl = $('#queueNew');
  const origEl = $('#queueOrig');
  const newTxt = CPLinks.formatBytes(now);

  cntEl.textContent = String(queue.length);
  origEl.textContent = CPLinks.formatBytes(orig);
  newEl.textContent = newTxt;
  if (String(prev.count) !== String(queue.length)) pulse(cntEl);
  if (prev.new && prev.new !== newTxt) pulse(newEl);
  refreshTotals.__prev = { count: queue.length, new: newTxt };

  const saved = orig - now;
  const tag = $('#queueSave');
  if (saved > 0 && queue.some((q) => q.outSize)) {
    tag.hidden = false;
    tag.textContent = '省下 ' + CPLinks.formatBytes(saved) + ' · ' + Math.round((saved / orig) * 100) + '%';
  } else {
    tag.hidden = true;
  }
  $('#queuePanel').hidden = queue.length === 0;
}

/* ---------------------------------------------------------------- 增删 */

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => !f.name || !/^\./.test(f.name));
  if (!files.length) {
    warn('没有拿到可用的文件');
    return [];
  }
  const added = [];
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
    added.push(it);
    updateItem(it);
  }
  refreshTotals();
  scheduleProcess();
  return added;
}

function removeItem(id) {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return;
  const it = queue.splice(idx, 1)[0];
  if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  const el = nodes.get(id);
  if (el) el.remove();
  nodes.delete(id);
  refreshTotals();
}

function clearQueue() {
  while (queue.length) removeItem(queue[0].id);
  $('#resultPanel').hidden = true;
  $('#resultList').innerHTML = '';
}

/* ---------------------------------------------------------------- 压缩 */

function poolSize() {
  // 并行线程数现在跟压缩参数一起摆在上传页（原设置页的「图片压缩」卡迁来的）；
  // 输入框还没挂上（理论不会）时退回配置值
  const el = $('#upConcurrency');
  const c = Number(el && el.value);
  if (c > 0) return Math.min(32, c);
  const cfg = Number(state.cfg && state.cfg.concurrency) || 0;
  return cfg > 0 ? Math.min(32, cfg) : defaultThreads();
}

function compressOptions() {
  const v = (sel) => {
    const el = $(sel);
    return el ? Number(el.value) || 0 : 0;
  };
  const on = (sel, def) => {
    const el = $(sel);
    return el ? el.checked : def;
  };
  return {
    quality: Number($('#upQuality').value) || 80,
    maxWidth: v('#upMaxWidth'),
    maxHeight: v('#upMaxHeight'),
    format: $('#upFormat').value || 'auto',
    targetSizeKB: v('#upTargetSize'),
    skipIfSmaller: on('#upSkipSmaller', true),
    skipBelowKB: v('#upSkipBelow'),
    // 水印参数从「图片设置」的水印块里现读 —— 以前是从 cfg 直接带过去的，
    // 迁到上传页之后这里就是唯一数据源
    watermark: {
      enabled: on('#upWmEnabled', false),
      text: ($('#upWmText').value || '').trim(),
      position: $('#upWmPosition').value || 'bottom-right',
      opacity: (Number($('#upWmOpacity').value) || 35) / 100,
      fontSize: Number($('#upWmFontSize').value) || 22,
      color: $('#upWmColor').value || '#1296db',
      // 精确边距（距图边缘的像素）与字体 —— 以前这三项一个写死、两个靠字号推导
      marginX: wmMargin('#upWmMarginX', 24),
      marginY: wmMargin('#upWmMarginY', 24),
      fontFamily: $('#upWmFont').value || '',
      fontWeight: Number($('#upWmWeight').value) || 600
    }
  };
}

/** 边距输入：空着或写了非法值就退回默认，夹在 0~999 */
function wmMargin(sel, dflt) {
  const raw = String($(sel).value || '').trim();
  if (raw === '') return dflt;
  const n = Number(raw);
  if (!isFinite(n)) return dflt;
  return Math.max(0, Math.min(999, Math.round(n)));
}

function ensurePool() {
  const size = poolSize();
  if (!pool || pool.size !== size) {
    if (pool) pool.terminate();
    pool = new CompressPool(size);
  }
  return pool;
}

/** 设置变化时把「就绪」的文件退回待处理，让它们按新参数重算 */
function invalidate() {
  queue.forEach((it) => {
    if (it.status === 'done') return;
    it.outBuffer = null;
    it.outSize = 0;
    it.outW = 0;
    it.outH = 0;
    it.quality = 0;
    it.note = '';
    it.status = 'pending';
    updateItem(it);
  });
  refreshTotals();
}

function scheduleProcess(delay) {
  clearTimeout(processTimer);
  processTimer = setTimeout(() => {
    processPending().catch((e) => err('压缩失败：' + friendlyError(e && e.message)));
  }, delay == null ? 160 : delay);
}

async function processPending() {
  const targets = queue.filter((it) => it.status !== 'done' && !it.outBuffer);
  if (!targets.length) return;

  const useCompress = $('#upCompress').checked;
  const mode = $('#upRenameMode').value || 'keep';
  const prefix = $('#upPrefix').value || '';
  const hashLen = (state.cfg && state.cfg.rename && state.cfg.rename.hashLength) || 8;
  const opts = compressOptions();
  const lim = CPLinks.limitOf((state.cfg || {}).platform);
  const cpool = ensurePool();

  const prog = $('#upProgress');
  const bar = $('#upProgressBar');
  const label = $('#upProgressLabel');
  const detail = $('#upProgressDetail');
  const pctEl = $('#upProgressPct');
  prog.hidden = false;
  // 进度条得说清当前在干什么：这里是**本地压缩**，不是上传。
  // 之前只动宽度、不设文案，条上留着上一次上传的「上传中」——
  // 明明在压图却写着上传中（杰哥点名的）。上传阶段由 describeProgress 负责。
  if (label) label.textContent = '压缩中';
  if (detail) detail.textContent = '';
  let done = 0;
  const paintProg = () => {
    const p = Math.round((done / targets.length) * 100);
    bar.style.width = p + '%';
    if (pctEl) pctEl.textContent = p + '%';
  };
  paintProg();
  const tick = () => {
    done += 1;
    paintProg();
    if (done >= targets.length) setTimeout(() => { prog.hidden = true; }, 420);
  };

  await Promise.all(
    targets.map(async (it) => {
      it.status = 'compressing';
      updateItem(it);
      try {
        const buf = await fileToArrayBuffer(it.file);
        const origExt = CPLinks.extOf(it.origName);

        if (buf.byteLength > lim.maxFile) {
          throw new Error(
            CPLinks.formatBytes(buf.byteLength) + ' 超过 ' + lim.name + ' 单文件上限（' + CPLinks.formatBytes(lim.maxFile) + '）'
          );
        }

        if (!useCompress || !it.isImage) {
          it.outBuffer = buf;
          it.outSize = buf.byteLength;
          it.passthrough = true;
          it.note = it.isImage ? '未压缩' : '非图片，原样上传';
          it.outName = await buildFileName(it.origName, mode, prefix, buf, origExt, hashLen);
        } else {
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
          const outExt = res.passthrough ? origExt : res.ext || origExt;
          it.outName = await buildFileName(it.origName, mode, prefix, res.buffer, outExt, hashLen);
        }
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
      refreshTotals();
      tick();
    })
  );
}

/* ---------------------------------------------------------------- 前后对比 */
// OUT_MIME / canCompare / openCompare 已提到 ../lib/compare.js（见文件顶部 import）。

/**
 * 点缩略图：能对比就拉对比，否则退回普通放大预览。
 * 队列和结果两处共用 —— 两边的判断条件本来就是一回事。
 */
function openThumbFor(id) {
  const it = queue.find((q) => String(q.id) === String(id));
  if (!it || !it.previewUrl) return false;
  if (canCompare(it)) openCompare(it);
  else previewImage(it.previewUrl);
  return true;
}

/* ---------------------------------------------------------------- 上传 */

function resultUrl(it) {
  return CPLinks.buildUrl(state.cfg, it.path);
}

/** 当前平台是不是 CNB（只有它支持把文件放进对象存储）。 */
function isCNBPlatform() {
  return LFS.isCNBPlatform(state.cfg);
}

/**
 * LFS 开关只在 CNB 下出现，并且恢复上次的勾选。
 *
 * GitHub 走 Git Data API 直接建 blob，没有「对象存储」这个独立计费项，
 * 显示出来只会让用户困惑（勾了也没用）。
 */
function syncLfsRow() {
  LFS.syncLfsUI(state.cfg, { row: $('#upLfsRow'), box: $('#upLfs') });
  syncLfsHint();
}

/** 首次使用会下载 git-lfs，勾上时才提醒（不勾就别吓人）。 */
function syncLfsHint() {
  const hint = $('#upLfsHint');
  if (!hint) return;
  const box = $('#upLfs');
  hint.hidden = !isCNBPlatform() || !(box && box.checked);
}

/** 读 LFS 开关；非 CNB 恒 false。 */
function lfsEnabled() {
  return LFS.lfsEnabled(state.cfg, $('#upLfs'));
}

/**
 * 进度条的元素 id。共享模块按 id 找元素，所以这里只是「这份界面把进度条
 * 放在了哪几个节点上」的声明 —— 结构本身在 index.html 里。
 */
const UPLOAD_PROGRESS_IDS = {
  prog: 'upProgress',
  bar: 'upProgressBar',
  label: 'upProgressLabel',
  detail: 'upProgressDetail',
  pct: 'upProgressPct'
};

async function doUpload() {
  if (!state.configured) {
    err('请先在「设置」里完成仓库与 Token 配置');
    return;
  }
  const ready = queue.filter((q) => q.outBuffer && q.status !== 'error' && q.status !== 'done');
  if (!ready.length) {
    err('队列里没有待上传的图片');
    return;
  }
  running = true;
  $('#btnUpload').disabled = true;
  // 全部先标「等待」而不是「上传中」—— 分批上传时同一时刻只有一批在传，
  // 一次性全标「上传中」会让用户以为十个文件同时在跑。
  ready.forEach((it) => {
    it.status = 'pending';
    updateItem(it);
  });

  const dir = CPLinks.normalizePath($('#upDir').value || '');

  try {
    // 上传流程与 mini 弹窗**共用一份**（lib/upload-run.js）：
    // 分批、转 base64、开进度、调接口、结果映射、同步提示、广播事件都在那边。
    // 这里只负责「上传页该怎么显示」—— 条目状态、总计、结果面板。
    const res = await runUpload({
      ready: ready,
      dir: dir,
      useLFS: lfsEnabled(),
      progressIds: UPLOAD_PROGRESS_IDS,
      // 一批开始前，把这一批标成「上传中」（其余仍是「等待」）
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
          it.url = resultUrl(it);
          it.error = '';
        } else {
          it.status = 'error';
          it.error = r.error;
        }
        updateItem(it);
      },
      onSummary: () => {
        refreshTotals();
        renderResults();
      }
    });

    const m = uploadResultMessage(res, '张');
    if (m.ok) ok(m.text);
    else err(m.text);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    running = false;
    $('#btnUpload').disabled = false;
  }
}

/* ---------------------------------------------------------------- 结果面板 */

function fmtLabel(fmt) {
  if (fmt === 'url') return '链接';
  if (fmt === 'markdown') return 'Markdown';
  if (fmt === 'html') return 'HTML';
  return 'BBCode';
}

function renderResults() {
  const list = $('#resultList');
  const panel = $('#resultPanel');
  const done = queue.filter((q) => q.status === 'done' || q.status === 'error');
  if (!done.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const fmt = $('#resultFormat').value || (state.cfg && state.cfg.linkFormat) || 'markdown';
  list.innerHTML = done
    .map((it, idx) => {
      if (it.status === 'error') {
        return (
          '<div class="r-item fail" style="--i:' + Math.min(idx, 18) + '">' +
          '<div class="r-thumb"></div>' +
          '<div class="r-info"><div class="r-path">' + escapeHtml(it.outName || it.origName) + '</div>' +
          '<div class="r-err">' + escapeHtml(it.error) + '</div></div></div>'
        );
      }
      const link = CPLinks.formatLink(it.url, fmt, it.outName, it.isImage);
      const thumb = it.previewUrl
        ? '<div class="r-thumb" style="background-image:url(\'' + it.previewUrl + '\')"></div>'
        : '<div class="r-thumb ext">' + escapeHtml((CPLinks.extOf(it.outName) || 'file').toUpperCase().slice(0, 4)) + '</div>';
      return (
        '<div class="r-item" data-id="' + it.id + '" style="--i:' + Math.min(idx, 18) + '">' + thumb +
        '<div class="r-info"><div class="r-path">' + escapeHtml(it.path) + '</div>' +
        '<div class="r-link" title="' + escapeHtml(link) + '">' + escapeHtml(link) + '</div></div>' +
        '<div class="queue-actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="copy-url" data-id="' + it.id + '">复制链接</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="copy-fmt" data-id="' + it.id + '">复制 ' + fmtLabel(fmt) + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="view" data-id="' + it.id + '">打开</button>' +
        '</div></div>'
      );
    })
    .join('');
}

function bindResultActions() {
  $('#resultList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const it = queue.find((q) => String(q.id) === btn.dataset.id);
      if (!it) return;
      const fmt = $('#resultFormat').value || 'markdown';
      if (btn.dataset.act === 'view') {
        window.cloudpic.shell.openExternal(it.url);
        return;
      }
      const text = btn.dataset.act === 'copy-url' ? it.url : CPLinks.formatLink(it.url, fmt, it.outName, it.isImage);
      await window.cloudpic.clipboard.write(text);
      ok('已复制');
      return;
    }
    const t = e.target.closest('.r-thumb');
    if (t && t.style.backgroundImage) {
      const item = e.target.closest('.r-item');
      if (item && item.dataset.id) openThumbFor(item.dataset.id);
    }
  });
}

function allResultLinks() {
  const fmt = $('#resultFormat').value || 'markdown';
  return queue
    .filter((q) => q.status === 'done')
    .map((q) => CPLinks.formatLink(resultUrl(q), fmt, q.outName, q.isImage))
    .join('\n');
}

/* ---------------------------------------------------------------- 配置联动 */

/** 上传页顶部必须写清楚：这批文件到底会被推到哪里 */
function fillTarget() {
  const c = state.cfg || {};
  const okRepo = !!(c.owner && c.repo);
  const lim = CPLinks.limitOf(c.platform);

  $('#utPlatform').textContent = c.platform === 'cnb' ? 'CNB' : 'GITHUB';
  $('#utRepo').textContent = okRepo ? c.owner + '/' + c.repo + ' @ ' + (c.branch || 'main') : '未配置仓库';

  const box = $('#upTarget');
  // 左侧竖条与平台的 pill 都跟着平台主色走（GitHub 蓝 / CNB 橙红，见 app.css 的 [data-platform]）
  box.dataset.platform = c.platform === 'cnb' ? 'cnb' : 'github';
  const st = $('#utState');
  if (!okRepo) {
    box.classList.add('warn');
    st.className = 'ut-state bad';
    st.textContent = '尚未选择仓库';
  } else if (!c.hasToken) {
    box.classList.add('warn');
    st.className = 'ut-state bad';
    st.textContent = '缺少访问令牌';
  } else {
    box.classList.remove('warn');
    st.className = 'ut-state ok';
    st.textContent = '已就绪 · 单文件上限 ' + CPLinks.formatBytes(lim.maxFile);
  }
}

function fillOptions() {
  const c = state.cfg || {};
  const cmp = c.compress || {};
  const wm = c.watermark || {};
  const ren = c.rename || {};
  const lim = CPLinks.limitOf(c.platform);

  fillTarget();

  $('#upCompress').checked = cmp.enabled !== false;
  $('#upQuality').value = cmp.quality || 80;
  $('#upQualityVal').textContent = String(cmp.quality || 80);
  $('#upFormat').value = cmp.format || 'auto';
  $('#upMaxWidth').value = cmp.maxWidth || 0;
  $('#upMaxHeight').value = cmp.maxHeight || 0;
  $('#upTargetSize').value = cmp.targetSizeKB || 0;
  $('#upSkipSmaller').checked = cmp.skipIfSmaller !== false;
  $('#upSkipBelow').value = cmp.skipBelowKB || 0;
  $('#upConcurrency').value = c.concurrency || 0;

  $('#upWmEnabled').checked = !!wm.enabled;
  $('#upWmText').value = wm.text || '';
  $('#upWmPosition').value = wm.position || 'bottom-right';
  $('#upWmOpacity').value = Math.round((wm.opacity == null ? 0.35 : wm.opacity) * 100);
  $('#upWmOpacityVal').textContent = (wm.opacity == null ? 0.35 : wm.opacity).toFixed(2);
  $('#upWmFontSize').value = wm.fontSize || 22;
  $('#upWmMarginX').value = wm.marginX == null ? 24 : wm.marginX;
  $('#upWmMarginY').value = wm.marginY == null ? 24 : wm.marginY;
  ensureWmFontOptions(wm.fontFamily || '');
  $('#upWmWeight').value = String(wm.fontWeight || 600);
  setWmColor(wm.color || '#1296db');
  syncWmMarginLabels();

  $('#upRenameMode').value = ren.mode || 'keep';
  $('#upPrefix').value = ren.prefix || '';
  if (document.activeElement !== $('#upDir')) $('#upDir').value = c.lastUploadDir || '';

  $('#dzHint').textContent =
    '图片会被本地压缩，其他文件原样上传 · 单次不限数量 · ' + lim.name + ' ' + lim.note;
  $('#quotaChip').innerHTML = '<b>' + escapeHtml(lim.name) + '</b>' + escapeHtml(lim.note);
  $('#quotaChip').title = '程序本身不设上限，这几条是平台官方红线';
}

const persistQuickOptions = debounce(() => {
  state.patch({
    lastUploadDir: CPLinks.normalizePath($('#upDir').value || ''),
    // 压缩与水印的全部字段都在上传页维护了，这里就是它们的唯一落盘出口；
    // patch 是深合并，只提交界面上有的键，别的全局设置不受影响
    concurrency: Number($('#upConcurrency').value) || 0,
    compress: {
      enabled: $('#upCompress').checked,
      quality: Number($('#upQuality').value),
      format: $('#upFormat').value,
      maxWidth: Number($('#upMaxWidth').value) || 0,
      maxHeight: Number($('#upMaxHeight').value) || 0,
      targetSizeKB: Number($('#upTargetSize').value) || 0,
      skipIfSmaller: $('#upSkipSmaller').checked,
      skipBelowKB: Number($('#upSkipBelow').value) || 0
    },
    watermark: {
      enabled: $('#upWmEnabled').checked,
      text: ($('#upWmText').value || '').trim(),
      position: $('#upWmPosition').value,
      opacity: (Number($('#upWmOpacity').value) || 35) / 100,
      fontSize: Number($('#upWmFontSize').value) || 22,
      color: $('#upWmColor').value || '#1296db',
      marginX: wmMargin('#upWmMarginX', 24),
      marginY: wmMargin('#upWmMarginY', 24),
      fontFamily: $('#upWmFont').value || '',
      fontWeight: Number($('#upWmWeight').value) || 600
    },
    rename: {
      mode: $('#upRenameMode').value,
      prefix: $('#upPrefix').value
    }
  });
}, 500);

/* ---------------------------------------------------------- 图片设置（折叠 + 水印色板） */

/**
 * 「图片设置」的折叠状态。
 *
 * 记在配置的 ui.imgSetOpen 里 —— 原来用 localStorage，那个依赖 WebView2 的
 * userDataFolder 是否持久，写在配置里更稳，也和 theme / manageView 那几项
 * 界面偏好保持了同一处。
 *
 * 默认**收起**：日常只改目录和文件名，压缩参数属于低频设置，摊开占地方。
 */
function setImgSetOpen(open, persist) {
  const box = $('#upImgSet');
  if (!box) return;
  box.classList.toggle('open', !!open);
  const head = $('#upImgSetHead');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  // persist=false 给初始化用：恢复上次的状态，但别反过来再写一次配置
  if (persist !== false) state.patch({ ui: { imgSetOpen: !!open } });
}

function imgSetOpen() {
  const ui = (state.cfg && state.cfg.ui) || {};
  return ui.imgSetOpen === true;
}

/** 色块 / 隐藏色值 / hex 文本框三处同步（自设置页原样迁来，#upWmColor 是数据源） */
let wmPicker = null;

/* ------------------------------------------------ 精确边距 / 字体 */

/**
 * 边距那两个标签随「位置」走：右下角时它们该读作「距右边缘 / 距底边缘」，
 * 换到左上角就成了「距左 / 距上」—— 标签不动的话，用户填 24 根本不知道
 * 这 24 是贴着哪条边，还得自己脑补。
 * （标签口径由 lib/watermark.js 定义，预览面板用的是同一份）
 */
function syncWmMarginLabels() {
  const pos = $('#upWmPosition').value || 'bottom-right';
  const pair = CPWm.axisLabels(pos);
  const mxLabel = $('#upWmMxLabel');
  const myLabel = $('#upWmMyLabel');
  if (!mxLabel || !myLabel) return;
  mxLabel.textContent = pair[0];
  myLabel.textContent = pair[1];
  // 居中 / 平铺时边距没有意义，灰掉而不是藏起来 —— 藏了会让整个栅格跳一下
  const off = pos === 'center' || pos === 'tile';
  ['#upWmMarginX', '#upWmMarginY'].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = off;
  });
  mxLabel.classList.toggle('is-off', off);
  myLabel.classList.toggle('is-off', off);
}

/** 水印字体下拉：和设置页的「界面字体」共用同一份本机字体枚举，只枚举一次 */
let wmFontsBuilt = false;

function ensureWmFontOptions(cur) {
  const sel = $('#upWmFont');
  if (!sel) return;
  if (!wmFontsBuilt) {
    let html = '<option value="">默认（雅黑 / 苹方）</option>';
    installedFontGroups().forEach((g) => {
      if (!g.fonts.length) return;
      html += '<optgroup label="' + escapeHtml(g.group) + '">';
      g.fonts.forEach((f) => {
        html += '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>';
      });
      html += '</optgroup>';
    });
    sel.innerHTML = html;
    wmFontsBuilt = true;
  }
  // 配置里那个字体如果本机没探测到也要留住，否则一打开就被重置成默认
  const has = Array.from(sel.options).some((o) => o.value === cur);
  if (cur && !has) {
    const opt = document.createElement('option');
    opt.value = cur;
    opt.textContent = cur + '（未检测到）';
    sel.appendChild(opt);
  }
  sel.value = cur || '';
}

function setWmColor(hex) {
  const norm = normalizeHex(hex) || '#1296db';
  const valueEl = $('#upWmColor');
  if (valueEl) valueEl.value = norm;
  const textEl = $('#wmColorText');
  if (textEl) textEl.value = norm;
  const sw = $('#wmSwatch');
  if (sw) sw.style.setProperty('--sw', norm);
  $$('#wmPresets .wm-pre').forEach((b) => b.classList.toggle('on', b.dataset.color === norm));
  if (wmPicker) wmPicker.setColor(norm);
  return norm;
}

function openWmPicker() {
  const sw = $('#wmSwatch');
  if (!sw) return;
  if (wmPicker) {
    closeColorPicker();
    wmPicker = null;
    return;
  }
  wmPicker = openColorPicker({
    anchor: sw,
    color: $('#upWmColor').value || '#1296db',
    presets: WM_PRESETS,
    onChange: (hex) => {
      setWmColor(hex);
      invalidate();
      scheduleProcess(320);
      persistQuickOptions();
    },
    onClose: () => {
      wmPicker = null;
    }
  });
}

function renderWmPresets() {
  const box = $('#wmPresets');
  if (!box) return;
  box.innerHTML = WM_PRESETS.map(
    (c) =>
      '<button type="button" class="wm-pre" data-color="' + c + '" title="' + c + '" style="--sw:' + c + '"></button>'
  ).join('');
}

/* ---------------------------------------------------------------- 目标目录选择 */

/**
 * 目标目录不该靠手打。点「浏览目录...」直接列出本地现有目录，逐层点进去，
 * 选中的路径写回 #upDir —— 和手动输入完全等价（同一个 input）。
 */
let pickDir = '';

function dpCrumbs() {
  const box = $('#dpCrumbs');
  if (!box) return;
  const parts = pickDir ? pickDir.split('/').filter(Boolean) : [];
  const out = [
    '<button type="button" class="dir-crumb' + (parts.length ? '' : ' last') + '" data-dir="">仓库根目录</button>'
  ];
  let acc = '';
  parts.forEach((seg, i) => {
    acc = acc ? acc + '/' + seg : seg;
    out.push('<span class="dir-sep">/</span>');
    out.push(
      '<button type="button" class="dir-crumb' + (i === parts.length - 1 ? ' last' : '') +
        '" data-dir="' + escapeHtml(acc) + '">' + escapeHtml(seg) + '</button>'
    );
  });
  box.innerHTML = out.join('');
}

async function dpLoad(dir) {
  pickDir = CPLinks.normalizePath(dir || '');
  dpCrumbs();
  const body = $('#dpBody');
  const msg = $('#dpMsg');
  if (!body) return;
  body.innerHTML = '<div class="dir-pick-empty">读取中…</div>';
  if (msg) msg.textContent = '';
  try {
    // 只读本机这份目录 —— 不再去问远端。
    // 原来本地这一层为空时会再查一次云端兜底，结果「点浏览目录 = 发网络请求」，
    // 既慢（等一轮 REST）又让人以为这程序离不开网络；本地仓库本来就是同一份东西。
    const res = await window.cloudpic.cloud.list({ dir: pickDir, source: 'local' });
    const dirs = (res.items || []).filter((i) => i.type === 'dir');

    if (!dirs.length) {
      body.innerHTML =
        '<div class="dir-pick-empty">这个目录下没有子目录<br>直接点「选择此目录」就行，也可以先「新建子目录」</div>';
    } else {
      body.innerHTML = dirs
        .map((d) => {
          const rel = d.path || d.name;
          return (
            '<div class="dir-row" data-dir="' + escapeHtml(rel) + '">' +
            '<span class="dr-ico">📁</span>' +
            '<span class="dr-name">' + escapeHtml(d.name || rel) + '</span>' +
            '<span class="dr-go">进入 ›</span>' +
            '</div>'
          );
        })
        .join('');
    }
    if (msg) {
      msg.textContent =
        '本地目录 · ' + (pickDir || '根目录') + ' · ' + dirs.length + ' 个子目录';
    }
  } catch (e) {
    body.innerHTML = '<div class="dir-pick-empty">' + escapeHtml(friendlyError(e && e.message)) + '</div>';
  }
}

function openDirPicker() {
  const input = $('#upDir');
  const start = CPLinks.normalizePath((input && input.value) || '');

  const wrap = document.createElement('div');
  wrap.className = 'dir-pick';
  wrap.innerHTML =
    '<div class="dir-pick-head">' +
    '<div class="dir-crumbs" id="dpCrumbs"></div>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="dpRefresh">刷新</button>' +
    '</div>' +
    '<div class="dir-pick-body" id="dpBody"></div>' +
    '<div class="dir-pick-foot">' +
    '<span class="dir-pick-msg" id="dpMsg"></span>' +
    '<span style="display:flex;gap:6px;flex:0 0 auto">' +
    '<button type="button" class="btn btn-ghost btn-sm" id="dpCancel">取消</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="dpNew">新建子目录</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="dpUse">选择此目录</button>' +
    '</span>' +
    '</div>';

  const dlg = modal({ title: '选择目标目录', node: wrap, buttons: false });

  const close = () => dlg.close();

  // 目录列表：点行进目录，点面包屑跳层
  $('#dpBody').addEventListener('click', (e) => {
    const row = e.target.closest('.dir-row');
    if (!row) return;
    dpLoad(row.dataset.dir);
  });
  $('#dpCrumbs').addEventListener('click', (e) => {
    const c = e.target.closest('.dir-crumb');
    if (!c) return;
    dpLoad(c.dataset.dir);
  });
  $('#dpRefresh').onclick = () => dpLoad(pickDir);
  $('#dpCancel').onclick = close;

  $('#dpUse').onclick = () => {
    if (input) {
      input.value = pickDir;
      persistQuickOptions();
    }
    close();
    ok(pickDir ? '目标目录：' + pickDir : '目标目录：仓库根目录');
  };

  // 新建子目录：在当前层下面建一个（其实就是把路径补全到 input，目录会随上传一起创建）
  $('#dpNew').onclick = () => {
    const body = $('#dpBody');
    if (!body || $('#dpNewName')) return;
    const box = document.createElement('div');
    box.style.cssText =
      'display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border-soft);background:var(--panel)';
    box.innerHTML =
      '<input type="text" id="dpNewName" placeholder="新目录名，如 2026/09" style="flex:1" />' +
      '<button type="button" class="btn btn-ghost btn-sm" id="dpCreateCancel">取消</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="dpCreate">创建</button>';
    wrap.insertBefore(box, body);
    const nameEl = box.querySelector('#dpNewName');
    nameEl.focus();
    const cancel = () => box.remove();
    const create = () => {
      const name = CPLinks.normalizePath(nameEl.value || '');
      if (!name) {
        warn('请填一个目录名');
        return;
      }
      box.remove();
      const next = CPLinks.normalizePath((pickDir ? pickDir + '/' : '') + name);
      if (input) {
        input.value = next;
        persistQuickOptions();
      }
      close();
      ok('目标目录：' + next);
    };
    box.querySelector('#dpCreate').onclick = create;
    box.querySelector('#dpCreateCancel').onclick = cancel;
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
      if (e.key === 'Escape') cancel();
    });
  };

  dpLoad(start);
}

/* ---------------------------------------------------------------- 拖拽与粘贴 */

function bindDrop() {
  const dz = $('#dropzone');
  /** 新手指引盖在上面时不要偷偷收文件 */
  const blocked = () => document.body.classList.contains('is-onboarding');
  let depth = 0;
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((t) => {
    document.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });
  document.addEventListener('dragenter', () => {
    if (blocked()) return;
    depth += 1;
    dz.classList.add('over');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dz.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    depth = 0;
    dz.classList.remove('over');
    if (blocked()) return;
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });

  dz.addEventListener('click', (e) => {
    if (blocked()) return;
    if (e.target.closest('button')) return;
    $('#fileInput').click();
  });
  $('#btnPick').onclick = (e) => {
    e.stopPropagation();
    if (blocked()) return;
    $('#fileInput').click();
  };
  $('#fileInput').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  document.addEventListener('paste', (e) => {
    if (blocked()) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (!f) continue;
      if (!f.name) {
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        Object.defineProperty(f, 'name', { value: 'paste-' + Date.now() + '.' + ext });
      }
      files.push(f);
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
      ok('已从剪贴板添加 ' + files.length + ' 张图片');
    }
  });
}

/* ---------------------------------------------------------------- 导出 */

export default {
  init() {
    bindDrop();
    fillOptions();
    bindResultActions();

    // LFS 开关：勾选状态记进 localStorage（下次默认带上），
    // 并同步「首次会下载 git-lfs」那句提醒的显隐
    const lfsBox = $('#upLfs');
    if (lfsBox) {
      // 勾上先弹确认（对象存储无法 jsdmirror 加速），取消就回退不勾
      lfsBox.addEventListener('change', async () => {
        if (lfsBox.checked) {
          const ok = await LFS.confirmLfsEnable();
          if (!ok) lfsBox.checked = false;
        }
        syncLfsHint();
      });
    }
    syncLfsRow();

    $('#resultFormat').innerHTML = CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
    $('#resultFormat').value = (state.cfg && state.cfg.linkFormat) || 'markdown';
    $('#resultFormat').onchange = () => {
      renderResults();
      persistQuickOptions();
    };

    const toSettings = $('#btnUtSettings');
    if (toSettings) {
      toSettings.onclick = () => document.querySelector('.nav-item[data-page="settings"]').click();
    }

    $('#upQuality').oninput = () => {
      $('#upQualityVal').textContent = $('#upQuality').value;
    };
    $('#upWmOpacity').oninput = () => {
      $('#upWmOpacityVal').textContent = (Number($('#upWmOpacity').value) / 100).toFixed(2);
    };

    // 「图片设置」折叠：点头部开合，状态记 localStorage
    $('#upImgSetHead').onclick = () => setImgSetOpen(!imgSetOpen());
    // 初始化：按记住的状态摆好，但别回写配置
    setImgSetOpen(imgSetOpen(), false);

    // 压缩 / 水印参数变了：清掉「就绪」让队列按新参数重算 + 落盘
    // （水印也影响输出，所以同样要走 invalidate）
    [
      '#upMaxWidth', '#upMaxHeight', '#upTargetSize', '#upSkipBelow', '#upConcurrency'
    ].forEach((s) => {
      $(s).addEventListener('change', () => {
        invalidate();
        scheduleProcess(320);
        persistQuickOptions();
      });
    });
    $('#upSkipSmaller').addEventListener('change', () => {
      invalidate();
      scheduleProcess(60);
      persistQuickOptions();
    });
    [
      '#upWmEnabled', '#upWmText', '#upWmPosition', '#upWmFontSize',
      '#upWmMarginX', '#upWmMarginY', '#upWmFont', '#upWmWeight'
    ].forEach((s) => {
      $(s).addEventListener('change', () => {
        // 位置一换，「距右 / 距底」这组标签的口径得跟着变
        if (s === '#upWmPosition') syncWmMarginLabels();
        invalidate();
        scheduleProcess(320);
        persistQuickOptions();
      });
    });
    $('#upWmOpacity').addEventListener('change', () => {
      invalidate();
      scheduleProcess(320);
      persistQuickOptions();
    });
    // 色块点开自绘选择器（原生 type=color 的系统面板和界面完全不搭）
    $('#wmSwatch').onclick = (e) => {
      e.preventDefault();
      openWmPicker();
    };
    // hex 文本框：随时输入随时生效，非法值不写回（等用户补全）
    const applyHex = () => {
      const norm = normalizeHex($('#wmColorText').value);
      if (!norm) return;
      setWmColor(norm);
      invalidate();
      scheduleProcess(320);
      persistQuickOptions();
    };
    $('#wmColorText').addEventListener('input', applyHex);
    $('#wmColorText').addEventListener('blur', () => {
      const norm = normalizeHex($('#wmColorText').value);
      setWmColor(norm || $('#upWmColor').value);
    });
    $('#wmPresets').addEventListener('click', (e) => {
      const b = e.target.closest('.wm-pre');
      if (!b) return;
      setWmColor(b.dataset.color);
      invalidate();
      scheduleProcess(320);
      persistQuickOptions();
    });
    renderWmPresets();

    ['#upQuality', '#upFormat', '#upRenameMode'].forEach((s) => {
      $(s).addEventListener('change', () => {
        invalidate();
        scheduleProcess(60);
        persistQuickOptions();
      });
    });
    $('#upCompress').addEventListener('change', () => {
      invalidate();
      scheduleProcess(60);
      persistQuickOptions();
    });
    $('#upPrefix').addEventListener('input', () => {
      invalidate();
      scheduleProcess(320);
      persistQuickOptions();
    });
    $('#upDir').addEventListener('input', persistQuickOptions);
    $('#btnUpDirPick').onclick = () => {
      if (!state.configured) {
        warn('还没配好仓库，先去设置里走一遍配置才能列出本地目录');
        return;
      }
      openDirPicker();
    };

    $('#btnClearQueue').onclick = () => {
      if (running) return;
      clearQueue();
    };

    $('#btnUpload').onclick = async () => {
      if (running) return;
      await processPending();
      await doUpload();
    };

    $('#btnCopyAllResult').onclick = async () => {
      const txt = allResultLinks();
      if (!txt) {
        warn('还没有可复制的链接');
        return;
      }
      await window.cloudpic.clipboard.write(txt);
      ok('已复制 ' + queue.filter((q) => q.status === 'done').length + ' 条链接');
    };
    $('#btnExportResult').onclick = async () => {
      const txt = allResultLinks();
      if (!txt) {
        warn('还没有可导出的内容');
        return;
      }
      const r = await window.cloudpic.fs.exportText({ content: txt, defaultName: 'jie-links.txt' });
      if (r.ok) ok('已导出到 ' + r.filePath);
    };
    $('#btnCloseResult').onclick = () => {
      $('#resultPanel').hidden = true;
    };

    $('#queueList').addEventListener('click', (e) => {
      const thumb = e.target.closest('.q-thumb');
      if (!thumb) return;
      const item = e.target.closest('.q-item');
      if (item) openThumbFor(item.dataset.id);
    });

    // 无头自检的钩子：自检没法真跑一遍压缩，就自己捏一份「压缩结果」喂进来，
    // 验证对比弹层装不装得起来（见 main.js 的 ui 段）
    window.__cmp = { open: openCompare, can: canCompare };
  },

  onEnter() {
    fillOptions();
    syncLfsRow();
  },

  onConfigChanged() {
    fillOptions();
    // 换平台（GitHub ↔ CNB）时 LFS 开关要跟着显示 / 隐藏
    syncLfsRow();
  }
};
