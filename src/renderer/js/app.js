/** 应用入口：路由 + 顶栏状态 + 首次启动引导 */

import { $, err, toast, modal, paintRanges, paintRange } from './lib/dom.js';
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
let themeIconMotionId = 0;
let themeIconTimer = 0;
let themeIconSwitchTimer = 0;

function setThemeButtonIcon(light) {
  const button = $('#btnTheme');
  if (!button) return;
  button.querySelector('.theme-icon-sun')?.classList.toggle('is-current', !light);
  button.querySelector('.theme-icon-moon')?.classList.toggle('is-current', light);
  const label = light ? '切换到深色模式' : '切换到浅色模式';
  button.title = label;
  button.setAttribute('aria-label', label);
}

function syncThemeButtonIcon(light) {
  const button = $('#btnTheme');
  if (!button) return;
  if (button.classList.contains('theme-spinning')) {
    button.dataset.themeTarget = light ? 'light' : 'dark';
    return;
  }
  setThemeButtonIcon(light);
}

function spinThemeButtonIcon(light) {
  const button = $('#btnTheme');
  if (!button) return;
  const motionId = ++themeIconMotionId;
  button.dataset.themeTarget = light ? 'light' : 'dark';
  button.classList.remove('theme-spinning');
  void button.offsetWidth;
  button.classList.add('theme-spinning');
  if (themeIconSwitchTimer) clearTimeout(themeIconSwitchTimer);
  if (themeIconTimer) clearTimeout(themeIconTimer);

  const switchIcon = () => {
    if (motionId !== themeIconMotionId) return;
    setThemeButtonIcon(button.dataset.themeTarget === 'light');
    themeIconSwitchTimer = 0;
  };
  const finish = () => {
    if (motionId !== themeIconMotionId) return;
    if (themeIconTimer) clearTimeout(themeIconTimer);
    if (themeIconSwitchTimer) clearTimeout(themeIconSwitchTimer);
    switchIcon();
    button.classList.remove('theme-spinning');
    themeIconTimer = 0;
  };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  themeIconSwitchTimer = setTimeout(switchIcon, reducedMotion ? 1 : 245);
  themeIconTimer = setTimeout(finish, reducedMotion ? 150 : 590);
}

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
let updateActionRunning = false;

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
  if (!updateActionRunning) $('#verBadgeText').textContent = 'v' + (info.version || '1.2');

  // 顶栏的昼夜按钮跟着配置走。state 每次变更都会回到这儿，
  // 所以在设置页里点主题卡片，顶栏图标也会跟着换，不会两边对不上。
  const btnTheme = $('#btnTheme');
  if (btnTheme) {
    syncThemeButtonIcon(themeIsLight());
  }
}

const formatUpdateSize = (bytes) => (bytes > 0 ? (bytes / 1048576).toFixed(1) + ' MB' : '—');
const RELEASES_URL = 'https://cnb.cool/youngdajie/Quick-FileDispatch/-/releases';

function confirmUpdate(result) {
  return new Promise((resolve) => {
    let decided = false;
    const finish = (yes) => {
      if (decided) return;
      decided = true;
      resolve(yes);
    };
    modal({
      title: '发现新版本 ' + result.latest,
      text: '当前 ' + result.current + ' → 最新 ' + result.latest + '\n' +
        '确认后会下载安装包并自动安装，程序会退出再重新启动。\n\n' +
        '安装期间程序暂时无法使用。',
      actions: [{
        label: '版本说明',
        title: '打开 CNB 版本发布页',
        onClick: () => window.cloudpic.shell.openExternal(RELEASES_URL)
      }],
      buttons: [
        { label: '稍后', onClick: () => finish(false) },
        { label: '下载并重启', primary: true, onClick: () => finish(true) }
      ],
      onClose: () => finish(false)
    });
  });
}

async function waitForUpdateDownload() {
  const label = $('#verBadgeText');
  await new Promise((resolve, reject) => {
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const progress = await window.cloudpic.update.progress();
        if (progress.status === 'downloading') {
          const pct = progress.total > 0 ? Math.round((progress.got / progress.total) * 100) + '%' : '';
          label.textContent = '下载 ' + pct;
          $('#verBadge').title = '正在下载：' + formatUpdateSize(progress.got) + ' / ' + formatUpdateSize(progress.total);
        } else if (progress.status === 'ready') {
          clearInterval(timer);
          label.textContent = '安装中…';
          $('#verBadge').title = '下载完成，正在安装更新';
          await window.cloudpic.update.install();
          resolve();
        } else if (progress.status === 'error') {
          clearInterval(timer);
          reject(new Error(progress.error || '下载失败'));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      } finally {
        polling = false;
      }
    }, 400);
  });
}

async function checkForUpdates() {
  const badge = $('#verBadge');
  const label = $('#verBadgeText');
  if (!badge || updateActionRunning) return;
  updateActionRunning = true;
  badge.disabled = true;
  badge.classList.add('is-busy');
  badge.title = '正在检查更新';
  label.textContent = '检查中…';
  try {
    const result = await window.cloudpic.update.check();
    if (!result.hasUpdate) {
      toast('当前已是最新版（v' + (result.current || (state.info && state.info.version) || '-') + '）', 'ok');
      return;
    }
    const confirmed = await confirmUpdate(result);
    if (!confirmed) return;
    badge.title = '正在下载更新';
    label.textContent = '下载中…';
    await window.cloudpic.update.download({ url: result.url, name: result.assetName, ver: result.latest });
    await waitForUpdateDownload();
  } catch (error) {
    err(error.message || String(error));
  } finally {
    updateActionRunning = false;
    badge.disabled = false;
    badge.classList.remove('is-busy');
    label.textContent = 'v' + ((state.info && state.info.version) || '1.2');
    badge.title = '检查软件更新';
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

  $('#verBadge').onclick = checkForUpdates;

  /*
   * 昼夜切换：**即时响应优先**。
   *
   * 旧做法是「点一下 → 等 config.set 这个 IPC 回来 → emit → applyAppearance」，
   * 全程异步；而 themeIsLight() 又读异步才更新的 cfg，连点几下读到的全是同一个
   * 旧值，于是「点了没反应、过一会儿连着跳」，还每次都把 applyGlass、各页
   * onConfigChanged、paintRanges 整套重活跑一遍 —— 那就是卡顿的来源。
   *
   * 现在分两层：
   *   - 界面层：点击当场把 theme 乐观写进 state.cfg 并同步换色；换色那一下给
   *     <html> 挂 .theme-instant 掐掉全站 transition，颜色「啪」地切过去，
   *     不是几十处 background/color 一起慢慢爬（那种渐变正是塑料感）。
   *   - 配置层：合并连点，只把最终主题写一次盘；写完 emit 一次，顺带让设置页
   *     的主题卡片、毛玻璃层这些重活对齐。
   */
  const btnTheme = $('#btnTheme');
  let themeQueued = null; // 待落盘的主题
  let themeWriting = false;
  let themeSaved = themeIsLight() ? 'light' : 'dark';
  let instantTimer = 0;

  function paintThemeNow(t) {
    const light = t === 'light';
    syncThemeButtonIcon(light);
    const root = document.documentElement;
    root.classList.add('theme-instant');
    // 只换变量和窗口底色，不跑毛玻璃那套遍历 DOM 的重活（留给 emit 那一次）
    appearance.applyTheme(t);
    clearTimeout(instantTimer);
    instantTimer = setTimeout(() => root.classList.remove('theme-instant'), 90);
  }

  async function flushTheme() {
    if (themeWriting || themeQueued === null || themeQueued === themeSaved) return;
    themeWriting = true;
    const t = themeQueued;
    try {
      await state.patch({ ui: { theme: t } });
      themeSaved = t;
    } catch (e) {
      err(e.message || String(e));
    } finally {
      themeWriting = false;
      // 连点期间主题又变了 → 补写最后一次（中间的都会被合并掉）
      if (themeQueued !== themeSaved) flushTheme();
    }
  }

  btnTheme.onclick = () => {
    const next = themeIsLight() ? 'dark' : 'light';
    const cfg = state.cfg || {};
    // 乐观更新：让 themeIsLight() 当场反映新值，连点才会一下一变
    state.cfg = Object.assign({}, cfg, {
      ui: Object.assign({}, cfg.ui || {}, { theme: next })
    });
    spinThemeButtonIcon(next === 'light');
    paintThemeNow(next);
    themeQueued = next;
    flushTheme();
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

  // 导航侧栏常驻；桌面工作区不因空闲状态改变布局。

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
boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    '<div style="padding:40px;color:#ff8f97;font-family:monospace">启动失败：' + (e && e.message) + '</div>';
});
