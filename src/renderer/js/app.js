/** 应用入口：路由 + 顶栏状态 + 首次启动引导 */

import { $, err, toast, paintRanges, paintRange } from './lib/dom.js';
import { enhanceAll } from './lib/cselect.js';
import { enhanceNumbers } from './lib/numfield.js';
import { installTooltips } from './lib/tooltip.js';
import * as fileIcons from './lib/fileicons.js';
import state from './lib/state.js';
import * as appearance from './lib/appearance.js';
import { initUniverse, universeState } from './lib/universe.js';
import onboard from './lib/onboard.js';
import uploadPage from './pages/upload.js';
import managePage from './pages/manage.js';
import settingsPage from './pages/settings.js';
import aboutPage from './pages/about.js';

/**
 * 顶栏那个昼夜按钮的图标：露出来的永远是「点了会变成什么」。
 * 深色主题下显示太阳（点击转亮），浅色主题下显示月亮（点击转暗）。
 */
const ICON_SUN =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="4"/>' +
  '<path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/></svg>';
const ICON_MOON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20.6 14.7A8.6 8.6 0 0 1 9.3 3.4a8.6 8.6 0 1 0 11.3 11.3z"/></svg>';

/** 当前是不是浅色主题（配置为准，不是看 DOM） */
function themeIsLight() {
  return !!(state.cfg && state.cfg.ui && state.cfg.ui.theme === 'light');
}

const PAGES = {
  upload: uploadPage,
  manage: managePage,
  settings: settingsPage,
  about: aboutPage
};

let current = 'upload';

/**
 * 内容区的滚动分流：短页面铺满、不滚；真长起来的内容照常滚。
 *
 * 为什么不靠纯 CSS：短页面在内容区底下总会多算 5px 上下的 scrollHeight ——
 * 遍历内容区所有后代都没元素越界（offenders 为空），说明那几像素不属于任何元素，
 * 是滚动容器自己的计算。min-height / height / flex / grid / overflow / 负 margin /
 * 收 padding 全试过，按不住。所以按「溢出量」分流：十几像素以内的一律当
 * 「本该铺满」，把滚动关掉 —— 就多那几像素，裁掉也看不见。
 *
 * ⚠️ 内容**变化时也要重算**：上传页的「图片设置」是可以展开的，展开后页面长高，
 * 这里要跟着把滚动放开，否则鼠标滚不动、设置项够不着（就是漏了这一点出的问题）。
 */
/**
 * 量一次并决定要不要滚。
 *
 * ⚠️ 只在**值真的变化**时才写 style —— 这是必须的：
 * 写 overflowY 会让滚动条出现/消失，进而改变 clientHeight，
 * 而 ResizeObserver 正盯着这块；每次无条件改写就形成
 * 「改 → 触发 RO → 再改」的自激循环，浏览器直接报
 *   ResizeObserver loop completed with undelivered notifications
 * （2026-10-10 实测，就是这个原因）。
 */
function applyFit() {
  const content = $('#content');
  if (!content) return;
  if (content.style.overflowY !== '') content.style.overflowY = '';
  const slack = content.scrollHeight - content.clientHeight;
  const want = (slack > 0 && slack < 20) ? 'hidden' : '';
  if (content.style.overflowY !== want) {
    content.style.overflowY = want;
  }
  if (want === 'hidden') content.scrollTop = 0;
}

/**
 * 量一次不够 —— 切页后布局往往还在动（字体、缩略图、折叠动画 0.34s），
 * 当下量到的还没到最终高度。所以要等一下按「稳定后」的高度再量一次，
 * 否则会出现「明明该滚却滚不动」或者相反的情况。
 */
function fitContentScroll() {
  applyFit();
  setTimeout(applyFit, 450);
}

/** 页面里任何一次点击之后也复核一遍：展开 / 收起这类动作都会改变高度 */
document.addEventListener('click', () => setTimeout(applyFit, 500), true);

/** 盯住当前页面：长高/变矮（展开、收起、列表加载完）都重新分流一次 */
let contentRO = null;
function watchActivePage() {
  const content = $('#content');
  const page = content && content.querySelector('.page.active');
  if (!page || typeof ResizeObserver === 'undefined') return;
  if (contentRO) contentRO.disconnect();
  // 回调里用 rAF 挪到下一帧再处理：RO 回调中同步改布局同样容易触发上面那个循环
  contentRO = new ResizeObserver(() => requestAnimationFrame(applyFit));
  contentRO.observe(page);
}

function go(name) {
  if (!PAGES[name]) return;
  const first = current !== name;
  current = name;

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $('#content').scrollTop = 0;
  // 短页面在内容区底下总会多算 5px 上下的 scrollHeight —— 遍历内容区里所有后代，
  // 没有任何元素越界（offenders 为空），说明这几像素不属于任何元素，是滚动容器
  // 自己的计算。CSS 那边试过 min-height / height / flex / grid / overflow /
  // 负 margin / 收 padding，全都按不住它。
  //
  // 所以这里按「溢出量」分流：十几像素以内的一律当「本该铺满」，直接把滚动关掉
  // （内容只多出那几像素，裁掉也看不见）；真需要滚的长页面（溢出成百上千）不碰。
  // 用 rAF 等一帧再量，这时布局已经稳定。
  requestAnimationFrame(() => { fitContentScroll(); watchActivePage(); });

  if (first && PAGES[name].onEnter) {
    try {
      PAGES[name].onEnter();
    } catch (e) {
      err(e.message || String(e));
    }
  }
  // 页面里的滑块可能刚被 onConfigChanged 改过值，切页时顺手重画填充进度
  paintRanges($('#page-' + name));
}

function updateChrome() {
  const info = state.info || {};
  $('#cpuBadge').textContent = (info.cpuCount || navigator.hardwareConcurrency || '-') + ' 核';
  $('#cpuBadge').title = '压缩线程池按 CPU 核心数并行';
  $('#verBadge').textContent = 'v' + (info.version || '1.2');

  // 顶栏的昼夜按钮跟着配置走。state 每次变更都会回到这儿，
  // 所以在设置页里点主题卡片，顶栏图标也会跟着换，不会两边对不上。
  const btnTheme = $('#btnTheme');
  if (btnTheme) {
    const light = themeIsLight();
    btnTheme.innerHTML = light ? ICON_MOON : ICON_SUN;
    btnTheme.title = light ? '切换到深色模式' : '切换到浅色模式';
  }
}

function bindChrome() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => {
      if (onboard.isOpen() && b.dataset.page !== 'upload') {
        toast('先把新手指引走完，就可以自由切换了', 'warn');
        return;
      }
      go(b.dataset.page);
    };
  });

  // 昼夜切换：这里只改配置，界面颜色交给 state.on → applyAppearance 去落。
  // 顺带的好处是设置页里那两张主题卡片也会跟着亮（它走 onConfigChanged）。
  // 图标外面那圈涟漪是纯装饰：先摘类再强制重排一次，连点也能重新播。
  const btnTheme = $('#btnTheme');
  let rippleTimer = 0;
  btnTheme.onclick = () => {
    btnTheme.classList.remove('ripple');
    void btnTheme.offsetWidth;
    btnTheme.classList.add('ripple');
    clearTimeout(rippleTimer);
    rippleTimer = setTimeout(() => btnTheme.classList.remove('ripple'), 700);
    state.patch({ ui: { theme: themeIsLight() ? 'dark' : 'light' } }).catch((e) => err(e.message || String(e)));
  };

  $('#btnRefreshAll').onclick = async () => {
    await state.refresh();
    // 本地改动可能来自外部编辑器，刷新时顺手重算 Git 状态
    if (PAGES[current].refresh) PAGES[current].refresh();
    else if (PAGES[current].onEnter) PAGES[current].onEnter();
    toast('已刷新', 'ok', 1400);
  };

  const rerun = $('#btnRerunGuide');
  if (rerun) rerun.onclick = () => onboard.open();

  bindWindowControls();
}

/** 无边框窗口的自绘「最小化 / 最大化 / 关闭」按钮 */
function bindWindowControls() {
  const win = window.cloudpic && window.cloudpic.win;
  if (!win) return;

  $('#btnWinMin').onclick = () => win.minimize();
  $('#btnWinClose').onclick = () => win.close();
  $('#btnWinMax').onclick = async () => {
    await win.maximize();
  };

  const applyMax = (v) => document.body.classList.toggle('is-maximized', !!v);

  win.isMaximized().then(applyMax).catch(() => {});
  if (typeof win.onMaximized === 'function') win.onMaximized(applyMax);
}

/**
 * 关掉浏览器的表单自动填充。
 *
 * 「桌面程序」里最露馅的一刻：点进一个之前填过的输入框，Edge 弹一个
 * 「已保存的内容」下拉，或者自动补一坨黄底蓝字 —— 一秒回到网页。
 *
 * 两层都堵上：
 *   1. 给所有 input/textarea 打 autocomplete="off"（拦下拉保存框）
 *   2. 用 MutationObserver 盯着动态插进来的输入框（重命名弹层、向导），
 *      插一个补一个
 *
 * 黄底蓝字那一层在 app.css 里用 -webkit-autofill 的 box-shadow 盖掉。
 */
function installAutofillKiller() {
  const kill = (root) => {
    (root || document).querySelectorAll('input, textarea').forEach((el) => {
      el.setAttribute('autocomplete', 'off');
    });
  };
  kill(document);
  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) {
          if (n.matches && n.matches('input, textarea')) n.setAttribute('autocomplete', 'off');
          if (n.querySelectorAll) kill(n);
        }
      });
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

async function boot() {
  await state.init();
  /**
   * 本机字体清单要在第一次画界面之前拿到：设置页的字体下拉、以及「系统默认」
   * 实际会落到哪款字体，都取决于它。晚一步拿就会先列一版旧候选再补一版真的，
   * 用户正好开着设置页就能看见下拉自己变一次。
   */
  await appearance.loadInstalledFonts();
  // 主题和字体必须在其它页面 init 之前落下去，否则会先按默认深色画一帧再跳色
  appearance.applyAppearance(state.cfg);
  updateChrome();

  // 粒子背景挂上就不用管了：它自己盯着 <html data-theme> 决定跑不跑
  initUniverse();

  // 接管原生 title 提示（黑框系统小窗太突兀），换成自绘的云朵气泡
  installTooltips();

  // 关掉浏览器的表单自动填充（保存的下拉框 / 黄底蓝字都是 Web 味）
  installAutofillKiller();

  bindChrome();
  Object.keys(PAGES).forEach((k) => {
    try {
      PAGES[k].init();
    } catch (e) {
      console.error('[init]', k, e);
    }
  });

  state.on((cfg) => {
    appearance.applyAppearance(cfg);
    updateChrome();
    Object.keys(PAGES).forEach((k) => {
      if (PAGES[k].onConfigChanged) {
        try {
          PAGES[k].onConfigChanged();
        } catch (e) {
          /* ignore */
        }
      }
    });
    paintRanges();
  });

  // 滑块拖动时实时更新已填充进度
  document.addEventListener('input', (e) => {
    if (e.target && e.target.type === 'range') paintRange(e.target);
  });

  // 原生 select 统一升级成自绘下拉（选项都是静态写在 index.html 里的，初始化一次就够）
  enhanceAll();
  // 数字输入框：干掉原生上下角标，换成自绘步进
  enhanceNumbers();
  paintRanges();

  // 无头自检用的调试钩子（--selftest 会在页面里读它）
  window.__fi = fileIcons;
  window.__nf = { enhanceNumbers };
  window.__state = state;
  window.__appearance = appearance;
  window.__universe = universeState;

  window.addEventListener('cloudpic:changed', () => {
    state.refresh();
  });

  go('upload');

  // 侧栏闲置自动收起（20 秒），鼠标碰到左边那条提示线再弹回来
  initSidebarAutoHide();

  // 没走完引导就不让用：配置齐全只是「能连上」，走完引导才算「会用了」
  if (!state.cfg.onboarded || !state.configured) {
    onboard.open();
  }
}

/**
 * 侧栏闲置自动收起。
 *
 * 收起状态挂在 body 的 .side-hidden 上，具体动作由 CSS 做（transform 平移出屏）——
 * 用 transform 而不是改宽度/display，是因为它不参与布局，右边的 .content
 * 不会跟着跳。
 */
function initSidebarAutoHide() {
  const bar = document.getElementById('sidebar');
  const dock = document.getElementById('sideDock');
  if (!bar || !dock) return;
  // 20 秒没碰就自动收起 —— 10 秒太急，看一眼文件回来侧栏就没了
  const IDLE_MS = 20000;
  let timer = null;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => document.body.classList.add('side-hidden'), IDLE_MS);
  };
  const expand = () => {
    document.body.classList.remove('side-hidden');
    schedule();
  };

  // 鼠标在侧栏里就一直展开着（暂停倒计时），移开之后才开始算 20 秒
  bar.addEventListener('mouseenter', () => clearTimeout(timer));
  bar.addEventListener('mouseleave', schedule);
  // 碰那条提示线 → 弹出来
  dock.addEventListener('mouseenter', expand);
  dock.addEventListener('click', expand);
  // Tab 键把焦点送进侧栏时也要展开，否则焦点跑进了一个看不见的东西里
  bar.addEventListener('focusin', expand);
  // 页面切换（点是导航）时重新计时，别让用户刚点完就被收走
  bar.addEventListener('click', schedule);

  schedule();
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    '<div style="padding:40px;color:#ff8f97;font-family:monospace">启动失败：' + (e && e.message) + '</div>';
});
