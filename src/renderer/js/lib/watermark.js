/**
 * 文字水印 —— 唯一的绘制实现（经典脚本，挂到 window / self 上）。
 *
 * 为什么不做成 ES module：
 *   压缩 worker 是 **classic worker**，它得用 importScripts 加载 AVIF 的
 *   emscripten glue，而 module worker 不支持 importScripts。所以这里沿用本项目
 *   既有的 window.CPxxx 老办法（CPLinks / CPHighlight 都是这么挂的）：
 *   worker 用 importScripts 引、页面用 <script> 引，**同一份代码**。
 *   预览要「所见即所得」就不能有两份绘制实现，不然迟早漂移。
 *
 * 位置语义（这一版的重点）：
 *   文字块的**外边缘**到图片边缘的距离 = marginX / marginY，单位是输出图上的像素。
 *   以前这个边距是算出来的（固定按字号 × 0.9），用户既没法调、也没法回答
 *   「右下角那个水印到底距边多少 px」。
 *
 * 字号仍按图宽缩放（基准 1000px 宽，0.6~2.4 倍），边距不缩放 ——
 * 边距就是输出图上实打实的像素，这样「距右边 24px」说出口就是 24px。
 */
(function (root) {
  'use strict';

  var DEFAULT_STACK = '"Microsoft YaHei UI", "PingFang SC", sans-serif';
  var POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'tile'];
  var WEIGHTS = [400, 500, 600, 700, 800];

  var DEFAULTS = {
    enabled: false,
    text: '',
    position: 'bottom-right',
    opacity: 0.35,
    fontSize: 22,
    color: '#1296db',
    marginX: 24,
    marginY: 24,
    fontFamily: '',
    fontWeight: 600
  };

  /**
   * 边距那两个输入框的标签随「位置」走：右下角时该读作「距右 / 距底」，
   * 换到左上角就是「距左 / 距上」。首页设置和预览面板共用这一套口径，
   * 免得两个地方说法不一致。
   */
  var AXIS = {
    'bottom-right': ['距右边缘（px）', '距底边缘（px）'],
    'bottom-left': ['距左边缘（px）', '距底边缘（px）'],
    'top-right': ['距右边缘（px）', '距上边缘（px）'],
    'top-left': ['距左边缘（px）', '距上边缘（px）'],
    center: ['居中时无效', '居中时无效'],
    tile: ['平铺时无效', '平铺时无效']
  };

  function axisLabels(pos) {
    return AXIS[pos] || AXIS['bottom-right'];
  }

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function normColor(v) {
    var s = String(v == null ? '' : v).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    }
    return '';
  }

  /** 参数归一化：所有入口（配置读回来的、界面输入的、预览拖出来的）都先过这一遍 */
  function normalize(raw) {
    var o = raw || {};
    return {
      enabled: !!o.enabled,
      text: String(o.text == null ? '' : o.text).trim(),
      position: POSITIONS.indexOf(o.position) >= 0 ? o.position : DEFAULTS.position,
      opacity: clamp(num(o.opacity, DEFAULTS.opacity), 0.03, 1),
      fontSize: clamp(Math.round(num(o.fontSize, DEFAULTS.fontSize)), 8, 200),
      color: normColor(o.color) || DEFAULTS.color,
      // 边距允许到 999：想贴到很里面去也行，别把人卡住
      marginX: clamp(Math.round(num(o.marginX, DEFAULTS.marginX)), 0, 999),
      marginY: clamp(Math.round(num(o.marginY, DEFAULTS.marginY)), 0, 999),
      fontFamily: typeof o.fontFamily === 'string' ? o.fontFamily.trim().replace(/["']/g, '') : '',
      fontWeight: WEIGHTS.indexOf(Number(o.fontWeight)) >= 0 ? Number(o.fontWeight) : DEFAULTS.fontWeight
    };
  }

  /**
   * 字体名可能带空格或中文，进 CSS font 简写必须加引号；
   * 后面永远垫一层默认栈，用户选了个本机没有的字体也不会突然变成衬线。
   */
  function fontStack(family) {
    var f = String(family || '').trim().replace(/["']/g, '');
    if (!f) return DEFAULT_STACK;
    return '"' + f + '", ' + DEFAULT_STACK;
  }

  /** 字号随图宽缩放：基准 1000px，夹在 0.6~2.4 倍之间（沿用旧公式） */
  function scaleOf(w) {
    return clamp(w / 1000, 0.6, 2.4);
  }

  function fontSizePx(base, w) {
    return Math.max(10, Math.round(num(base, DEFAULTS.fontSize) * scaleOf(w)));
  }

  /**
   * 把水印画到 ctx 上（w / h 是这张图的像素尺寸）。
   * opts.originW / originH：画布是原图的缩略版时传原图尺寸 —— 字号和边距都按
   * **原图**算完再整体乘比例，这样预览和正式输出所见即所得。
   * （不能只依赖 draw 内部按 w 缩放：字号那个公式带 0.6~2.4 的 clamp，
   *   缩略图的宽度一旦落到 clamp 区间外，字号占比就会跟实际输出对不上。）
   *
   * 返回是否真的画了东西 —— 调用方偶尔要据此判断。
   */
  function draw(ctx, w, h, raw, opts) {
    var wm = normalize(raw);
    // enabled 也在这里判：调用方（worker / 预览）虽然都先判过一道，
    // 但「关掉就不该画」是 draw 自己的契约，不该指望每个调用方都记得
    if (!wm.enabled || !wm.text || !(w > 0) || !(h > 0)) return false;

    var o = opts || {};
    var ow = o.originW > 0 ? o.originW : w;
    var k = w / ow;                       // 画布相对原图的比例（原图直出时正好 = 1）
    var size = Math.max(10, Math.round(fontSizePx(wm.fontSize, ow) * k));
    var mx = Math.max(0, Math.round(wm.marginX * k));
    var my = Math.max(0, Math.round(wm.marginY * k));

    ctx.save();
    ctx.globalAlpha = wm.opacity;
    ctx.fillStyle = wm.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.lineWidth = Math.max(1, size / 12);
    ctx.font = wm.fontWeight + ' ' + size + 'px ' + fontStack(wm.fontFamily);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    var text = wm.text;

    if (wm.position === 'tile') {
      var tileW = ctx.measureText(text).width;
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-Math.PI / 7);
      ctx.translate(-w / 2, -h / 2);
      var stepX = tileW + size * 5;
      var stepY = size * 6;
      for (var y0 = -h; y0 < h * 2; y0 += stepY) {
        for (var x0 = -w; x0 < w * 2; x0 += stepX) {
          ctx.strokeText(text, x0, y0);
          ctx.fillText(text, x0, y0);
        }
      }
      ctx.restore();
      return true;
    }

    // textBaseline 是 middle，所以 y 指向的是文字垂直中心，要减掉半个字高
    var tw = ctx.measureText(text).width;
    var half = size / 2;
    var x, y;

    if (wm.position === 'bottom-left') {
      x = mx;                 // 左边缘距左边 mx
      y = h - my - half;      // 底边缘距底边 my
    } else if (wm.position === 'top-right') {
      x = w - mx - tw;
      y = my + half;
    } else if (wm.position === 'top-left') {
      x = mx;
      y = my + half;
    } else if (wm.position === 'center') {
      x = (w - tw) / 2;
      y = h / 2;
    } else {
      x = w - mx - tw;        // bottom-right（默认）
      y = h - my - half;
    }

    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
    return true;
  }

  /**
   * 水印占的矩形（预览里画定位参考框、口算边距用）。
   * 平铺 / 居中返回 null —— 它们没有「距某个角多少 px」这回事。
   */
  function rectOf(ctx, w, h, raw) {
    var wm = normalize(raw);
    if (!wm.text || wm.position === 'tile' || wm.position === 'center') return null;
    var size = fontSizePx(wm.fontSize, w);
    var prev = ctx.font;
    ctx.font = wm.fontWeight + ' ' + size + 'px ' + fontStack(wm.fontFamily);
    var tw = ctx.measureText(wm.text).width;
    ctx.font = prev;
    var mx = wm.marginX;
    var my = wm.marginY;
    var left = wm.position === 'bottom-left' || wm.position === 'top-left' ? mx : w - mx - tw;
    var top = wm.position === 'top-left' || wm.position === 'top-right' ? my : h - my - size;
    return { x: left, y: top, w: tw, h: size };
  }

  root.CPWatermark = {
    DEFAULTS: DEFAULTS,
    POSITIONS: POSITIONS,
    WEIGHTS: WEIGHTS,
    AXIS: AXIS,
    axisLabels: axisLabels,
    DEFAULT_STACK: DEFAULT_STACK,
    normalize: normalize,
    fontStack: fontStack,
    scaleOf: scaleOf,
    fontSizePx: fontSizePx,
    draw: draw,
    rectOf: rectOf
  };
})(typeof window !== 'undefined' ? window : self);
