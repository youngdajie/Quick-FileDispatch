/**
 * 水印参数面板（可复用组件）。
 *
 * 两个地方要用它：图片查看器（lib/imgview.js）和上传页的「压缩前后对比」
 * （lib/compare.js）。**必须是同一份** —— 同一个参数在两处出现两种行为/两种
 * 文案，是最容易让人怀疑「这软件到底哪个是对的」的那类问题。
 *
 * 面板只管「编辑参数」和「把参数报出去」（onChange），不决定保存语义：
 * 查看器那边是「试试看，点保存才写配置」，对比窗那边是「改了立刻重压缩」，
 * 这两种意图由调用方决定，面板不掺和。
 *
 * 用法：
 *   const panel = createWmPanel({ initial, prefix: 'cp', onChange: (wm) => {...} });
 *   host.appendChild(panel.el);
 *   panel.read();              // 从 DOM 读回参数（一般不用手动调）
 *   panel.setValue(newWm);     // 外部改参数（比如「恢复已保存」）
 */

import { escapeHtml } from './dom.js';
import { openColorPicker, closeColorPicker, normalizeHex } from './colorpicker.js';
import { installedFontGroups } from './appearance.js';
import { enhanceAll } from './cselect.js';
import { enhanceNumbers } from './numfield.js';

const CPWm = window.CPWatermark;
const WM_PRESETS = ['#1296db', '#ffffff', '#101722', '#ff4d4f', '#20c997', '#f5a623'];

/** 取色器是全局单例，同一时刻只可能开一个面板 */
let picker = null;
/** 字体清单的 HTML 只拼一次（枚举本机字体不便宜），但每个 select 都要各自填 */
let fontHtml = null;

function html(prefix) {
  const p = prefix;
  return (
    // 开关并入标题行：它管的是整块面板有没有用，单独占一行既费高度又显得散
    '<div class="wm-p-head"><span>水印</span>' +
    '<label class="wm-p-check" title="勾上就会画到图上">' +
    '<input type="checkbox" id="' + p + 'On" /><span>启用</span></label></div>' +
    '<div class="wm-p-note" id="' + p + 'Note" hidden></div>' +

    '<label class="field"><span class="field-label">文字</span>' +
    '<input type="text" id="' + p + 'Text" placeholder="@your-name" /></label>' +

    '<div class="wm-p-row">' +
    '<label class="field"><span class="field-label">位置</span><select id="' + p + 'Pos">' +
    '<option value="bottom-right">右下角</option><option value="bottom-left">左下角</option>' +
    '<option value="top-right">右上角</option><option value="top-left">左上角</option>' +
    '<option value="center">居中</option><option value="tile">平铺</option></select></label>' +
    '<label class="field"><span class="field-label">字号基准</span>' +
    '<input type="number" id="' + p + 'Size" min="8" max="96" /></label>' +
    '</div>' +

    '<div class="wm-p-row">' +
    '<label class="field"><span class="field-label" id="' + p + 'MxLabel">距右边缘（px）</span>' +
    '<input type="number" id="' + p + 'Mx" min="0" max="999" step="1" /></label>' +
    '<label class="field"><span class="field-label" id="' + p + 'MyLabel">距底边缘（px）</span>' +
    '<input type="number" id="' + p + 'My" min="0" max="999" step="1" /></label>' +
    '</div>' +

    '<div class="wm-p-sep"></div>' +

    '<div class="wm-p-row">' +
    '<label class="field"><span class="field-label">字重</span><select id="' + p + 'Weight">' +
    '<option value="400">常规</option><option value="500">中等</option><option value="600">半粗</option>' +
    '<option value="700">加粗</option><option value="800">特粗</option></select></label>' +
    '<label class="field"><span class="field-label">字体</span>' +
    '<select id="' + p + 'Font"><option value="">默认</option></select></label>' +
    '</div>' +

    '<div class="wm-p-block">' +
    '<span class="field-label">不透明度 <b id="' + p + 'OpVal">0.35</b></span>' +
    '<input type="range" id="' + p + 'Op" min="5" max="100" step="1" /></div>' +

    '<div class="wm-p-block">' +
    '<span class="field-label">颜色</span>' +
    '<div class="wm-color">' +
    '<button type="button" class="wm-swatch" id="' + p + 'Swatch" title="选择颜色" aria-haspopup="dialog">' +
    '<span class="wm-swatch-fill"></span></button>' +
    '<input type="text" class="wm-hex" id="' + p + 'Hex" maxlength="7" spellcheck="false" placeholder="#1296db" />' +
    '</div>' +
    '<span class="wm-presets" id="' + p + 'Presets"></span>' +
    '</div>'
  );
}

export function createWmPanel(opts) {
  const o = opts || {};
  const prefix = o.prefix || 'wm';
  const q = (n) => el.querySelector('#' + prefix + n);

  const el = document.createElement('div');
  el.className = 'wm-panel';
  el.innerHTML = html(prefix);

  let wm = CPWm.normalize(o.initial || {});
  let notify = false;   // fill() 期间压住 onChange，别把回填当成用户改动

  function syncLabels() {
    const pair = CPWm.axisLabels(wm.position);
    const mxLabel = q('MxLabel');
    const myLabel = q('MyLabel');
    mxLabel.textContent = pair[0];
    myLabel.textContent = pair[1];
    // 居中 / 平铺时边距没有意义，灰掉而不是藏起来 —— 藏了栅格会跳
    const off = wm.position === 'center' || wm.position === 'tile';
    q('Mx').disabled = off;
    q('My').disabled = off;
    mxLabel.classList.toggle('is-off', off);
    myLabel.classList.toggle('is-off', off);
  }

  /** 图上没水印时得说清为什么，不然用户会以为功能坏了 */
  function syncNote() {
    const n = q('Note');
    if (!wm.enabled) {
      n.hidden = false;
      n.textContent = '水印当前是关的，勾上上面那项才会画出来。';
    } else if (!wm.text) {
      n.hidden = false;
      n.textContent = '还没填水印文字，填一个就会出现在图上。';
    } else {
      n.hidden = true;
      n.textContent = '';
    }
  }

  function setSwatch(hex) {
    const norm = normalizeHex(hex) || CPWm.DEFAULTS.color;
    q('Hex').value = norm;
    q('Swatch').style.setProperty('--sw', norm);
    el.querySelectorAll('#' + prefix + 'Presets .wm-pre').forEach((b) =>
      b.classList.toggle('on', b.dataset.color === norm)
    );
    if (picker) picker.setColor(norm);
  }

  function fillFonts(cur) {
    const sel = q('Font');
    // 每个 select 各自填一次。**别用模块级布尔量**：那样第二个面板
    // （先开了看图、再开对比窗）就再也拿不到清单了，里面会只剩「默认」一项，
    // 于是配置里存过的字体一律显示成「（未检测到）」—— 表现得像字体没跟上。
    if (sel.dataset.fontsFilled !== '1') {
      if (fontHtml === null) {
        let h = '<option value="">默认（雅黑 / 苹方）</option>';
        installedFontGroups().forEach((g) => {
          if (!g.fonts.length) return;
          h += '<optgroup label="' + escapeHtml(g.group) + '">';
          g.fonts.forEach((f) => {
            h += '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>';
          });
          h += '</optgroup>';
        });
        fontHtml = h;
      }
      sel.innerHTML = fontHtml;
      sel.dataset.fontsFilled = '1';
    }
    // 配置里那个字体本机确实没探测到，也留住 —— 否则一打开就被重置成默认
    if (cur && !Array.from(sel.options).some((op) => op.value === cur)) {
      const op = document.createElement('option');
      op.value = cur;
      op.textContent = cur + '（未检测到）';
      sel.appendChild(op);
    }
    sel.value = cur || '';
  }

  function fill() {
    notify = false;
    q('On').checked = wm.enabled;
    q('Text').value = wm.text;
    q('Pos').value = wm.position;
    q('Mx').value = wm.marginX;
    q('My').value = wm.marginY;
    q('Size').value = wm.fontSize;
    q('Weight').value = String(wm.fontWeight);
    fillFonts(wm.fontFamily);
    q('Op').value = Math.round(wm.opacity * 100);
    q('OpVal').textContent = wm.opacity.toFixed(2);
    setSwatch(wm.color);
    syncLabels();
    syncNote();
    notify = true;
  }

  function num(n, dflt) {
    const raw = String(q(n).value || '').trim();
    if (raw === '') return dflt;
    const v = Number(raw);
    return isFinite(v) ? v : dflt;
  }

  /**
   * 从界面读回参数。
   * 越界/非法值交给 normalize 收口，但**不动用户正在敲的输入框** ——
   * 边打字边把输入框改掉，光标会跳，那是很难受的体验。
   */
  function read() {
    wm = CPWm.normalize({
      enabled: q('On').checked,
      text: q('Text').value,
      position: q('Pos').value,
      marginX: num('Mx', wm.marginX),
      marginY: num('My', wm.marginY),
      fontSize: num('Size', wm.fontSize),
      fontWeight: Number(q('Weight').value),
      fontFamily: q('Font').value,
      opacity: Number(q('Op').value) / 100,
      color: q('Hex').value
    });
    q('OpVal').textContent = wm.opacity.toFixed(2);
    syncLabels();
    syncNote();
    if (notify && o.onChange) o.onChange(wm);
  }

  WM_PRESETS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wm-pre';
    b.dataset.color = c;
    b.style.setProperty('--sw', c);
    b.title = c;
    b.onclick = () => {
      setSwatch(c);
      read();
    };
    q('Presets').appendChild(b);
  });

  q('Swatch').onclick = () => {
    if (picker) {
      closeColorPicker();
      picker = null;
      return;
    }
    picker = openColorPicker({
      anchor: q('Swatch'),
      color: q('Hex').value || CPWm.DEFAULTS.color,
      presets: WM_PRESETS,
      onChange: (hex) => {
        setSwatch(hex);
        read();
      },
      onClose: () => {
        picker = null;
      }
    });
  };

  q('Hex').addEventListener('change', () => {
    const norm = normalizeHex(q('Hex').value);
    setSwatch(norm || wm.color);
    read();
  });

  // 文字用 input（边打边看），下拉用 change，滑块两种都要
  ['On', 'Pos', 'Weight', 'Font'].forEach((n) => q(n).addEventListener('change', read));
  ['Text', 'Mx', 'My', 'Size'].forEach((n) => q(n).addEventListener('input', read));
  q('Op').addEventListener('input', read);
  q('Op').addEventListener('change', read);

  fill();
  // 把原生 select 换成界面自绘的那套下拉 —— 不调这一下就是系统原生长相，
  // 跟其它地方完全不是一回事。必须放在 fill() 之后：选项得先填好再接管。
  enhanceAll(el);
  // 数字框同理：启动时那一轮扫描扫不到运行时才建的节点，
  // 不补这一下，面板里的加减角标会一直是系统原生的灰方块
  enhanceNumbers(el);

  return {
    el,
    /** 当前参数（已归一化） */
    get value() {
      return wm;
    },
    read,
    fill,
    setValue(v) {
      wm = CPWm.normalize(v || {});
      fill();
    },
    /** 面板被移除时收掉可能还开着的取色器 */
    dispose() {
      if (picker) {
        closeColorPicker();
        picker = null;
      }
    }
  };
}
