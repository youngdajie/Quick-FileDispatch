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

function go(name) {
  if (!PAGES[name]) return;
  const first = current !== name;
  current = name;

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $('#content').scrollTop = 0;

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
  const cfg = state.cfg || {};
  const okRepo = !!(cfg.owner && cfg.repo);
  $('#repoChipText').textContent = state.repoLabel;
  const dot = $('#statusDot');
  dot.className = 'dot ' + (okRepo && cfg.hasToken ? 'ok' : okRepo || cfg.hasToken ? 'bad' : '');
  dot.parentElement.title = okRepo && cfg.hasToken ? '配置就绪' : '尚未完成配置，点击前往设置';

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
  $('#repoChip').onclick = () => go('settings');

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

  $('#btnOpenLocalDir').onclick = async () => {
    const cfg = state.cfg || {};
    if (!cfg.localDir) {
      toast('还没配置本地目录，先到设置里选一个', 'warn');
      go('settings');
      return;
    }
    await window.cloudpic.shell.openLocalDir();
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

  // 没走完引导就不让用：配置齐全只是「能连上」，走完引导才算「会用了」
  if (!state.cfg.onboarded || !state.configured) {
    onboard.open();
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    '<div style="padding:40px;color:#ff8f97;font-family:monospace">启动失败：' + (e && e.message) + '</div>';
});
