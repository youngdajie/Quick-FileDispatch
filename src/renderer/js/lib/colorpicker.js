/**
 * 自绘颜色选择器。
 *
 * 原来直接盖一个原生 `<input type="color">`，弹出来的是系统那套灰扑扑的面板，
 * 和界面完全不搭。这里改成自己画：
 *   - 上半块是「饱和度 × 明度」方块，拖圆点取色
 *   - 下面一条色相条
 *   - 底部一行显示当前色块 + HEX / RGB
 *   - 常用色直接摆在下面，一点就走
 *
 * 面板挂在 document.body 上（fixed 定位），因为 .card 是 overflow:hidden，挂原地会被裁掉。
 */

const PRESET_DEFAULT = ['#1296db', '#ffffff', '#101722', '#ff4d4f', '#20c997', '#f5a623'];

let openCtx = null;

/* ---------------------------------------------------------------- 色彩换算 */

export function normalizeHex(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  if (t[0] !== '#') t = '#' + t;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    return ('#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3]).toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
  return '';
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16)
  };
}

export function rgbToHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return ('#' + c(r) + c(g) + c(b)).toLowerCase();
}

export function rgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/* ---------------------------------------------------------------- 面板 */

function buildPanel(opts) {
  const pop = document.createElement('div');
  pop.className = 'cp-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '选择颜色');
  pop.innerHTML =
    '<div class="cp-sv"><span class="cp-knob"></span></div>' +
    '<div class="cp-hue"><span class="cp-knob cp-knob-hue"></span></div>' +
    '<div class="cp-meta">' +
    '<span class="cp-chip"></span>' +
    '<span class="cp-read"><b class="cp-hex"></b><span class="cp-rgb"></span></span>' +
    '</div>' +
    '<div class="cp-presets"></div>';
  return pop;
}

function place(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.style.left = '0px';
  pop.style.top = '0px';
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const gap = 8;
  const below = window.innerHeight - r.bottom - gap;
  const up = below < h && r.top > h + gap;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = up ? Math.max(8, r.top - h - gap) : Math.min(window.innerHeight - h - 8, r.bottom + gap);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(Math.max(8, top)) + 'px';
  pop.style.visibility = '';
}

/**
 * 打开一个颜色选择器。
 * @param {{anchor:HTMLElement, color:string, presets?:string[], onChange:(hex:string)=>void, onClose?:()=>void}} opts
 */
export function openColorPicker(opts) {
  const o = opts || {};
  closeColorPicker();
  const anchor = o.anchor;
  if (!anchor) return null;

  const start = normalizeHex(o.color) || '#1296db';
  const rgb0 = hexToRgb(start);
  let hsv = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);

  const pop = buildPanel(o);
  const sv = pop.querySelector('.cp-sv');
  const svKnob = sv.querySelector('.cp-knob');
  const hue = pop.querySelector('.cp-hue');
  const hueKnob = hue.querySelector('.cp-knob-hue');
  const chip = pop.querySelector('.cp-chip');
  const hexEl = pop.querySelector('.cp-hex');
  const rgbEl = pop.querySelector('.cp-rgb');
  const presetBox = pop.querySelector('.cp-presets');

  function paint(silent) {
    const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    sv.style.setProperty('--h', String(Math.round(hsv.h)));
    svKnob.style.left = (hsv.s * 100).toFixed(2) + '%';
    svKnob.style.top = ((1 - hsv.v) * 100).toFixed(2) + '%';
    svKnob.style.setProperty('--knob-color', hex);
    hueKnob.style.left = ((hsv.h / 360) * 100).toFixed(2) + '%';
    chip.style.setProperty('--sw', hex);
    hexEl.textContent = hex.toUpperCase();
    rgbEl.textContent = 'rgb(' + Math.round(rgb.r) + ', ' + Math.round(rgb.g) + ', ' + Math.round(rgb.b) + ')';
    Array.from(presetBox.children).forEach((b) => b.classList.toggle('on', b.dataset.color === hex));
    if (!silent && o.onChange) o.onChange(hex);
  }

  /** 从指针位置换算 s / v */
  function pickSv(e) {
    const r = sv.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    hsv.s = x;
    hsv.v = 1 - y;
    paint();
  }

  function pickHue(e) {
    const r = hue.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    hsv.h = x * 360;
    paint();
  }

  /** 按下 → 拖动 → 松开，全程监听 document，指针滑出面板也不断 */
  function bindDrag(el, handler) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // setPointerCapture 对「非活跃 pointerId」会抛 NotFoundError，
      // 不能让它把整个按下流程带崩 —— 拿不到捕获也一样能靠 document 上的
      // pointermove 继续跟手。
      try {
        if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      handler(e);
      const move = (ev) => handler(ev);
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        try {
          if (el.releasePointerCapture) el.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  bindDrag(sv, pickSv);
  bindDrag(hue, pickHue);

  // 常用色
  const presets = (o.presets || PRESET_DEFAULT).slice();
  presetBox.innerHTML = presets
    .map((c) => '<button type="button" class="cp-pre" data-color="' + c + '" title="' + c + '" style="--sw:' + c + '"></button>')
    .join('');
  presetBox.addEventListener('click', (e) => {
    const b = e.target.closest('.cp-pre');
    if (!b) return;
    const rgb = hexToRgb(b.dataset.color);
    if (!rgb) return;
    hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    paint();
  });

  document.body.appendChild(pop);
  place(pop, anchor);
  paint(true);
  anchor.classList.add('is-open');
  anchor.setAttribute('aria-expanded', 'true');

  const onDocDown = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    closeColorPicker();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeColorPicker();
    }
  };
  const onScroll = (e) => {
    // 面板自身不滚动，所以照旧：外部滚动就收起来
    if (e && e.target && e.target.nodeType === 1 && pop.contains(e.target)) return;
    closeColorPicker();
  };
  const onResize = () => closeColorPicker();

  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize, true);

  openCtx = {
    pop: pop,
    anchor: anchor,
    onDocDown: onDocDown,
    onKey: onKey,
    onScroll: onScroll,
    onResize: onResize,
    onClose: o.onClose,
    setColor(hex) {
      const rgb = hexToRgb(hex);
      if (!rgb) return;
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      paint(true);
    }
  };
  return openCtx;
}

export function closeColorPicker() {
  if (!openCtx) return;
  const c = openCtx;
  openCtx = null;
  c.pop.remove();
  c.anchor.classList.remove('is-open');
  c.anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', c.onDocDown, true);
  document.removeEventListener('keydown', c.onKey, true);
  window.removeEventListener('scroll', c.onScroll, true);
  window.removeEventListener('resize', c.onResize, true);
  if (c.onClose) c.onClose();
}

export function colorPickerOpen() {
  return !!openCtx;
}

export default { openColorPicker, closeColorPicker, colorPickerOpen, normalizeHex };
