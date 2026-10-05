/**
 * 图片查看器 —— 带水印实时编辑。
 *
 * 为什么值得单独做一个：水印的效果（字号占比、离边多少像素、换个字体好不好看）
 * 全是「看一眼才知道」的事，隔着设置表单调，改一次要等压缩跑完才能看到结果。
 * 这里把参数面板和画布并排放，改哪个立刻重画，调顺眼了再「保存为默认」。
 *
 * 两个关键设计：
 *
 * 1. **画布按原图分辨率开**（只对超大图等比缩小）。水印的边距语义是
 *    「输出图上的绝对像素」，画布要是随窗口大小走，预览就没法跟输出对上。
 * 2. 缩小的情况下，字号和边距都**按原图算完再整体乘比例**
 *    （CPWatermark.draw 的 originW），而不是拿缩略图的宽度去套公式 ——
 *    那个公式带 clamp，宽度一落到区间外，预览里的字号占比就跟实际输出不一样了。
 *
 * 参数面板是共享组件（lib/wm-panel.js），上传页那个「压缩前后对比」窗口用的是
 * 同一份 —— 同一个参数在两处出现两种行为，是最容易让人怀疑「哪个才算数」的。
 *
 * 这里的编辑是「试试看」：要点「保存为默认」才写进配置。
 * 对比窗那边不一样（它是从压缩流程进来的，改了就该立刻重压），所以那边是即时的。
 */

import { modal, escapeHtml, toast, err } from './dom.js';
import state from './state.js';
import { createWmPanel } from './wm-panel.js';

const CPWm = window.CPWatermark;

/** 预览画布上限：任一边不超过 4096，总面积不超过 2600 万像素 */
const MAX_SIDE = 4096;
const MAX_PIXELS = 26e6;

const ICON_OPEN =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4H20v6.5"/><path d="M20 4l-8.6 8.6"/>' +
  '<path d="M18.5 14v5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

/**
 * 打开图片查看器。
 * 签名保持和以前一致（src, name, link），调用方不用改。
 */
export function previewImage(src, name, link) {
  if (!CPWm) {
    // 水印脚本没加载上也不该挡住看图 —— 退化成纯图片预览
    modal({ title: name || '预览', wide: true, html: '<img src="' + escapeHtml(src) + '" alt="" />' });
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'iv-wrap';
  wrap.innerHTML =
    '<div class="iv-stage" id="ivStage">' +
    '<canvas class="iv-canvas" id="ivCanvas"></canvas>' +
    '<div class="iv-tip" id="ivTip" hidden></div>' +
    '</div>';

  const side = document.createElement('aside');
  side.className = 'iv-side';

  const cur = { wm: CPWm.normalize((state.cfg && state.cfg.watermark) || {}) };
  let tick = 0;
  let ro = null;

  const panel = createWmPanel({
    prefix: 'ivWm',
    initial: cur.wm,
    onChange: (wm) => {
      cur.wm = wm;
      scheduleRepaint();
    }
  });
  side.appendChild(panel.el);

  const actions = document.createElement('div');
  actions.className = 'iv-actions';
  actions.innerHTML =
    '<button type="button" class="btn btn-ghost btn-sm" id="ivWmReset" ' +
    'title="丢弃这里的改动，回到配置里存着的那份">恢复已保存</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="ivWmSave" ' +
    'title="把当前这套水印参数写进配置，上传页也会用">保存为默认</button>';
  side.appendChild(actions);

  wrap.appendChild(side);

  const m = modal({
    title: name || '预览',
    className: 'imgview',
    node: wrap,
    buttons: false,
    closeX: true,
    actions: link
      ? [
          {
            icon: ICON_OPEN,
            label: '浏览器打开',
            title: '用系统默认浏览器打开这个文件',
            onClick: () => window.cloudpic.shell.openExternal(link)
          }
        ]
      : [],
    onClose: () => {
      panel.dispose();
      if (ro) ro.disconnect();
      ro = null;
    }
  });

  const q = (s) => wrap.querySelector(s);
  const canvas = q('#ivCanvas');
  const stage = q('#ivStage');
  const ctx = canvas.getContext('2d');
  const img = new Image();

  let ow = 0;
  let oh = 0;

  function repaint() {
    if (!ow || !oh) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    CPWm.draw(ctx, canvas.width, canvas.height, cur.wm, { originW: ow, originH: oh });
  }

  // 用 setTimeout 而不是 rAF 合并重绘：拖滑块时这里是高频调用，
  // rAF 在无头环境会被节流（验证脚本里就是），定时器到点就跑，两边表现一致
  function scheduleRepaint() {
    if (tick) return;
    tick = setTimeout(() => {
      tick = 0;
      repaint();
    }, 16);
  }

  /** 画布按容器可用空间等比摆放（不写死 CSS 尺寸，免得宽图被拉变形） */
  function fit() {
    if (!canvas.width || !canvas.height) return;
    const availW = Math.max(60, stage.clientWidth - 28);
    const availH = Math.max(60, stage.clientHeight - 28);
    const k = Math.min(availW / canvas.width, availH / canvas.height, 1);
    canvas.style.width = Math.round(canvas.width * k) + 'px';
    canvas.style.height = Math.round(canvas.height * k) + 'px';
  }

  img.onload = () => {
    ow = img.naturalWidth;
    oh = img.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(ow, oh), Math.sqrt(MAX_PIXELS / (ow * oh)));
    canvas.width = Math.max(1, Math.round(ow * k));
    canvas.height = Math.max(1, Math.round(oh * k));
    const tip = q('#ivTip');
    if (k < 0.999) {
      tip.hidden = false;
      tip.textContent =
        '预览按 ' + Math.round(k * 100) + '% 渲染 · 水印的字号与边距已按原图换算，与实际输出一致';
    }
    repaint();
    fit();
  };
  img.onerror = () => {
    stage.innerHTML = '<div class="iv-fail">这张图没能加载出来</div>';
  };
  img.src = src;

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => fit());
    ro.observe(stage);
  }

  q('#ivWmReset').onclick = () => {
    panel.setValue((state.cfg && state.cfg.watermark) || {});
    cur.wm = panel.value;
    repaint();
    toast('已回到配置里存着的那份', 'ok', 1400);
  };

  q('#ivWmSave').onclick = async () => {
    try {
      await state.patch({ watermark: panel.value });
      toast('水印设置已保存为默认，上传页也会用这套', 'ok');
    } catch (e) {
      err(e.message || String(e));
    }
  };

  return m;
}
