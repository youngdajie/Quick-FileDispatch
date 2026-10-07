/**
 * 压缩前后对比（squoosh 那种中缝对比）。
 *
 * 从 upload.js 里提出来，主上传页和「上传到此文件夹」mini 弹窗共用一份 ——
 * 之前它俩都各自要用到，抄一份就会漂移（对比层只有一处能改，才好维护）。
 * 行为与原来完全一致：openCompare 仍是往 #modalWrap 上开一个 wide 弹层。
 */

import { modal, escapeHtml } from './dom.js';

const CPLinks = window.CPLinks;

/**
 * 压缩产物的扩展名 → MIME。
 * 给 Blob 标对类型再喂给 <img>：多数格式浏览器能自己嗅探出来，
 * 但 avif / svg 这类不标清楚会直接不显示。
 */
export const OUT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml'
};

/** 这一项凑不凑得出前后对比：得是图片、压缩完了、而且原图的预览地址还在 */
export function canCompare(it) {
  return !!(it && it.isImage && it.outBuffer && it.previewUrl);
}

/**
 * 压缩前后对比（squoosh 那种中缝对比）。
 *
 * 两张图叠在一起：底下那张是原图，上面那张是压缩产物，
 * 用 clip-path 从中间裁开，中缝拖到哪就裁到哪 —— 比左右并排更容易看出
 * 压缩到底吃掉了什么细节，因为同一个像素在切换前后落在屏幕上的位置完全没变。
 *
 * 有一点得注意：裁切是按**外层盒子**算的，所以外层必须收缩到图片本身的显示尺寸
 * （CSS 里用 width: fit-content 做到），否则 contain 留下的空白会让中缝和图片边界对不上。
 */
export function openCompare(it) {
  const afterUrl = URL.createObjectURL(
    new Blob([it.outBuffer], { type: OUT_MIME[CPLinks.extOf(it.outName)] || '' })
  );

  const dim =
    it.outW && it.srcW && (it.srcW !== it.outW || it.srcH !== it.outH)
      ? it.srcW + '×' + it.srcH + ' → ' + it.outW + '×' + it.outH
      : it.outW
        ? it.outW + '×' + it.outH
        : '';

  const meta = [dim, it.quality && !it.passthrough ? 'q' + it.quality : '', it.note]
    .filter(Boolean)
    .map((x) => '<span>' + escapeHtml(String(x)) + '</span>')
    .join('');

  const node = document.createElement('div');
  node.className = 'cmp';
  node.innerHTML =
    '<div class="cmp-stage">' +
    '<img class="cmp-a" src="' + escapeHtml(it.previewUrl) + '" alt="压缩前" draggable="false" />' +
    '<img class="cmp-b" src="' + escapeHtml(afterUrl) + '" alt="压缩后" draggable="false" />' +
    '<span class="cmp-tag l">压缩前 ' + escapeHtml(CPLinks.formatBytes(it.origSize)) + '</span>' +
    '<span class="cmp-tag r">压缩后 ' + escapeHtml(CPLinks.formatBytes(it.outSize)) + '</span>' +
    '<div class="cmp-bar"><span class="cmp-knob"></span></div>' +
    '</div>' +
    '<div class="cmp-meta">' +
    '<span class="cmp-name">' + escapeHtml(it.outName || it.origName) + '</span>' +
    meta +
    '<span class="cmp-hint">按住左右拖动中缝</span>' +
    '</div>';

  const stage = node.querySelector('.cmp-stage');
  let dragging = false;

  const setSplit = (clientX) => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const p = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
    stage.style.setProperty('--split', p.toFixed(2) + '%');
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 拿不到指针捕获也能用，只是拖出界会断 */
    }
    setSplit(e.clientX);
  });
  stage.addEventListener('pointermove', (e) => {
    if (dragging) setSplit(e.clientX);
  });
  const stop = (e) => {
    dragging = false;
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  modal({
    title: '压缩前后对比',
    wide: true,
    node: node,
    buttons: [{ label: '关闭', primary: true }],
    onClose: () => URL.revokeObjectURL(afterUrl)
  });
}
