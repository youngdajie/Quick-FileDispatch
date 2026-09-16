/**
 * 外观：主题（白天 / 黑夜）与界面字体。
 *
 * 两件事都只改 CSS 变量，不动 DOM 结构：
 *   - 主题：在 <html> 上打 data-theme，浅色那套变量在 app.css 里覆盖
 *   - 字体：改写 --font-ui
 * 同时把无边框窗口的底色一起换掉，否则拉伸窗口时会闪出另一种颜色的边。
 */

export const THEMES = ['dark', 'light'];

/** 无边框窗口的底色，和 CSS 里的 --bg 保持一致 */
const THEME_BG = { dark: '#070b12', light: '#eef1f6' };

/** 系统兜底字栈：没选自定义字体时用这套 */
const BASE_FAMILIES = [
  '"Microsoft YaHei UI"',
  '"PingFang SC"',
  '"Segoe UI"',
  'system-ui',
  '-apple-system',
  'sans-serif'
];
const DEFAULT_STACK = BASE_FAMILIES.join(', ');

/** 把「所选字体 + 系统兜底」拼成 font-family，并去掉重复项（选的就是默认字体时不出现两遍） */
export function stackFor(font) {
  const f = String(font || '').trim().replace(/"/g, '');
  const fams = f ? ['"' + f + '"'].concat(BASE_FAMILIES) : BASE_FAMILIES.slice();
  const seen = new Set();
  return fams
    .filter((x) => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(', ');
}

export function applyTheme(theme) {
  const t = THEMES.indexOf(theme) >= 0 ? theme : 'dark';
  const root = document.documentElement;
  root.dataset.theme = t;
  // 让原生控件（下拉、滚动条、range）也跟着换，不然浅色主题里会冒出黑条
  root.style.colorScheme = t;
  try {
    window.cloudpic.app.setBackground(THEME_BG[t]);
  } catch (e) {
    /* 主进程不在也无所谓，只是窗口底色不跟着走 */
  }
  return t;
}

export function applyFont(font) {
  const f = String(font || '').trim();
  document.documentElement.style.setProperty('--font-ui', stackFor(f));
  return f;
}

/** 按配置里 ui 这一段一次性应用 */
export function applyAppearance(cfg) {
  const ui = (cfg && cfg.ui) || {};
  const theme = applyTheme(ui.theme);
  const font = applyFont(ui.font);
  return { theme: theme, font: font };
}

/* ---------------------------------------------------------------- 字体探测 */

/**
 * Windows 自带字体候选表。分成三组方便下拉里分节展示；
 * 真正列出来的还要过一道「本机是否装了」的检测，没装的不会出现。
 */
export const FONT_CANDIDATES = {
  中文: [
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    'Microsoft YaHei Light',
    'SimSun',
    'NSimSun',
    'SimHei',
    'KaiTi',
    'FangSong',
    'DengXian',
    'DengXian Light',
    'YouYuan',
    'LiSu',
    'STXihei',
    'STSong',
    'STKaiti',
    'STZhongsong',
    'STXingkai',
    'STXinwei',
    'STHupo',
    'STCaiyun',
    'FZShuTi',
    'FZYaoTi',
    'Microsoft JhengHei',
    'MingLiU',
    'DFKai-SB'
  ],
  西文: [
    'Segoe UI',
    'Segoe UI Variable Text',
    'Segoe UI Semibold',
    'Segoe UI Semilight',
    'Arial',
    'Arial Black',
    'Arial Narrow',
    'Calibri',
    'Cambria',
    'Candara',
    'Constantia',
    'Corbel',
    'Comic Sans MS',
    'Courier New',
    'Ebrima',
    'Franklin Gothic Medium',
    'Gabriola',
    'Gadugi',
    'Georgia',
    'Impact',
    'Ink Free',
    'Palatino Linotype',
    'Segoe Print',
    'Segoe Script',
    'Sylfaen',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana'
  ],
  等宽: [
    'Cascadia Mono',
    'Cascadia Code',
    'Consolas',
    'Lucida Console',
    'Courier New',
    'Cascadia Mono PL',
    'Cascadia Code PL'
  ]
};

/** 去重后的完整候选（含分组信息） */
const ALL_CANDIDATES = (() => {
  const seen = new Set();
  const out = [];
  Object.keys(FONT_CANDIDATES).forEach((group) => {
    FONT_CANDIDATES[group].forEach((name) => {
      if (seen.has(name)) return;
      seen.add(name);
      out.push({ name: name, group: group });
    });
  });
  return out;
})();

const PROBE_TEXT = '中国智造 JIE 快捷分发 AaBbGg0123456789';

let probeEl = null;
function measure(stack) {
  if (!probeEl) {
    probeEl = document.createElement('span');
    probeEl.setAttribute('aria-hidden', 'true');
    probeEl.style.cssText =
      'position:absolute;left:-99999px;top:-99999px;white-space:nowrap;font-size:48px;' +
      'letter-spacing:0;visibility:hidden;pointer-events:none;';
    probeEl.textContent = PROBE_TEXT;
    (document.body || document.documentElement).appendChild(probeEl);
  }
  probeEl.style.fontFamily = stack;
  return probeEl.getBoundingClientRect().width;
}

/**
 * 判断某个字体在本机是否真的装了：
 * 拿「候选 + 通用族」和「纯通用族」各量一次宽度，宽度不一样说明候选生效了。
 * 两个通用族都对不上才算装（单个通用族可能刚好被系统映射到同一张字体）。
 */
export function fontAvailable(name) {
  const quoted = '"' + String(name).replace(/"/g, '') + '"';
  try {
    const wMono = measure(quoted + ', monospace');
    const baseMono = measure('monospace');
    if (Math.abs(wMono - baseMono) > 0.5) return true;
    const wSerif = measure(quoted + ', serif');
    const baseSerif = measure('serif');
    if (Math.abs(wSerif - baseSerif) > 0.5) return true;
    const wSans = measure(quoted + ', sans-serif');
    const baseSans = measure('sans-serif');
    return Math.abs(wSans - baseSans) > 0.5;
  } catch (e) {
    return false;
  }
}

/** 本机已安装的候选字体，按分组返回 [{group, fonts:[name]}]（跨组去重，同一款只出现一次） */
export function installedFontGroups() {
  const groups = [];
  const seen = new Set();
  Object.keys(FONT_CANDIDATES).forEach((g) => {
    const fonts = [];
    FONT_CANDIDATES[g].forEach((f) => {
      if (seen.has(f) || !fontAvailable(f)) return;
      seen.add(f);
      fonts.push(f);
    });
    if (fonts.length) groups.push({ group: g, fonts: fonts });
  });
  return groups;
}

/** 已安装字体的扁平清单（含当前配置里那个，哪怕没探测到也保留，免得选择被吃掉） */
export function installedFonts(current) {
  const list = [];
  const seen = new Set();
  Object.keys(FONT_CANDIDATES).forEach((g) => {
    FONT_CANDIDATES[g].forEach((f) => {
      if (seen.has(f) || !fontAvailable(f)) return;
      seen.add(f);
      list.push(f);
    });
  });
  const cur = String(current || '').trim();
  if (cur && !seen.has(cur)) list.unshift(cur);
  return list;
}

/** 本机装了候选表里的多少款（给设置页显示一句「检测到 N 款」） */
let fontCountCache = -1;
export function installFontCount() {
  if (fontCountCache < 0) {
    let n = 0;
    const seen = new Set();
    Object.keys(FONT_CANDIDATES).forEach((g) => {
      FONT_CANDIDATES[g].forEach((f) => {
        if (seen.has(f)) return;
        seen.add(f);
        if (fontAvailable(f)) n += 1;
      });
    });
    fontCountCache = n;
  }
  return fontCountCache;
}
