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

/**
 * 系统兜底字栈：没选自定义字体时用这套。
 *
 * 霞鹜文楷（LXGW WenKai）排在最前 —— 它就是本程序的界面主字体。
 * 装了就整个界面用它（中文比雅黑耐看，正文尤其明显），没装就往后落到
 * 微软雅黑 UI / Segoe UI，和以前一模一样，不会因为少了它变难看。
 *
 * 中英文两个家族名都写上：字体文件里中英文名是两条记录，
 * 而 CSS 匹配哪条得看系统语言，两条都排上才稳。
 */
const PRIMARY_FAMILIES = ['"霞鹜文楷 屏幕阅读版"', '"LXGW WenKai Screen"'];

/** 程序主字体的名字（界面文案里用；字体没装时字栈会自己往后落） */
export const PRIMARY_FONT_NAME = '霞鹜文楷';

const BASE_FAMILIES = PRIMARY_FAMILIES.concat([
  '"Microsoft YaHei UI"',
  '"PingFang SC"',
  '"Segoe UI"',
  'system-ui',
  '-apple-system',
  'sans-serif'
]);
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
 * 候选表：只用来**分组**（中文 / 西文 / 等宽），不再是「能列出什么」的白名单。
 *
 * 以前这里就是全部可选项，用户自己装的字体（霞鹜文楷、思源、鸿蒙…）永远不出现 ——
 * 因为程序从没问过系统装了啥。现在真正的清单由主进程扫字体目录给出
 * （见 main/fonts.js），这张表退化成「认识的字体归到哪一组」的标签，
 * 表外的字体统一落到最后一组「本机其他字体」，一款都不会漏。
 *
 * 所以往这里加条目只有两个作用：1) 同一款字体的中/英文名都认得；
 * 2) 把它从「其他」提到对应分组里。装了才出现，没装不会占位。
 */
export const FONT_CANDIDATES = {
  中文: [
    // 第三方中文字体（用户自己装的常见款，装了才出现）
    '霞鹜文楷 屏幕阅读版',
    '霞鹜文楷',
    '霞鹜文楷等宽 屏幕阅读版',
    'LXGW WenKai Screen',
    'LXGW WenKai',
    'LXGW WenKai Mono',
    '思源黑体',
    'Source Han Sans SC',
    'Noto Sans SC',
    'HarmonyOS Sans SC',
    'MiSans',
    '阿里巴巴普惠体',
    'Alibaba PuHuiTi',
    'OPPO Sans',
    '得意黑',
    'Smiley Sans',
    '仓耳今楷',
    '文泉驿微米黑',
    'WenQuanYi Micro Hei',
    // Windows 自带
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

/* ------------------------------------------------ 本机字体清单（主进程提供） */

/**
 * 主进程扫出来的真实字体家族名。null = 还没拿到（非 Windows、或 IPC 失败），
 * 这时退回下面的「量宽度」探测，功能不至于挂掉。
 */
let realFamilies = null;
/** 小写化索引，用来做大小写无关的匹配（'Segoe UI' vs 'segoe ui'） */
let realIndex = null;

/** 本机清单是否已经拿到（设置页想给用户一句准确的话时可以问一下） */
export function hasRealFontList() {
  return !!realFamilies;
}

/**
 * 主动去主进程要一次本机字体清单。
 * 在 app.js 的 boot() 里、渲染首页之前 await 一次，设置页建下拉时就是现成的数据，
 * 不用「先画一版候选、再补一版真实清单」那样闪一下。
 */
export async function loadInstalledFonts() {
  try {
    const api = window.cloudpic && window.cloudpic.app;
    if (api && typeof api.fonts === 'function') {
      const list = await api.fonts();
      setInstalledFamilies(list);
    }
  } catch (e) {
    /* 拿不到就算了，下面会退回宽度探测 */
  }
  return realFamilies || [];
}

/** 注入清单（也方便自检直接喂数据）；传空数组视为「没拿到」，保留探测兜底 */
export function setInstalledFamilies(list) {
  const arr = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
  realFamilies = arr.length ? arr : null;
  realIndex = realFamilies ? new Set(realFamilies.map((x) => x.toLowerCase())) : null;
  fontCountCache = -1;
}

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
 * 判断某个字体在本机是否真的装了。
 *
 * 优先查主进程给的真实清单（准、快、零副作用）；
 * 没有清单时退回老办法：拿「候选 + 通用族」和「纯通用族」各量一次宽度，
 * 宽度不一样说明候选生效了。三个通用族都对不上才算装。
 */
export function fontAvailable(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  if (realIndex) return realIndex.has(key);

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

/**
 * 分组遍历：先按候选表把认识的分到「中文 / 西文 / 等宽」，
 * 剩下本机装着的、表里没有的一律进「本机其他字体」。
 * 同一款字体只出现一次（跨组去重，大小写不敏感）。
 */
function walkGroups(visit) {
  const used = new Set();
  const claim = (name) => {
    const k = String(name).toLowerCase();
    if (used.has(k)) return false;
    used.add(k);
    return true;
  };
  Object.keys(FONT_CANDIDATES).forEach((g) => {
    const fonts = [];
    FONT_CANDIDATES[g].forEach((f) => {
      if (!fontAvailable(f) || !claim(f)) return;
      fonts.push(f);
    });
    if (fonts.length) visit(g, fonts);
  });

  // 表外的本机字体（用户自己装的都在这儿），保持主进程给的排序
  const others = [];
  (realFamilies || []).forEach((f) => {
    if (claim(f)) others.push(f);
  });
  if (others.length) visit('本机其他字体', others);
}

/** 本机已安装的字体，按分组返回 [{group, fonts:[name]}] */
export function installedFontGroups() {
  const groups = [];
  walkGroups((group, list) => groups.push({ group: group, fonts: list }));
  return groups;
}

/** 已安装字体的扁平清单（含当前配置里那个，哪怕没探测到也保留，免得选择被吃掉） */
export function installedFonts(current) {
  const list = [];
  walkGroups((group, fonts) => list.push(...fonts));
  const cur = String(current || '').trim();
  if (cur && !list.some((x) => x.toLowerCase() === cur.toLowerCase())) list.unshift(cur);
  return list;
}

/** 本机装了多少款（给设置页显示一句「检测到 N 款」） */
let fontCountCache = -1;
export function installFontCount() {
  if (fontCountCache < 0) {
    let n = 0;
    walkGroups((group, fonts) => {
      n += fonts.length;
    });
    fontCountCache = n;
  }
  return fontCountCache;
}
