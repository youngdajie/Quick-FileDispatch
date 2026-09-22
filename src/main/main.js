'use strict';

/**
 * 快捷文件分发服务@JIE —— 主进程
 * 作者：小杰 · https://www.yangjie.site
 * 致敬 PicX（https://github.com/XPoet/picx）
 */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store, migrateLegacyUserData } = require('./store');
const { startServer, allowRoot } = require('./server');
const { CloudClient, fileLimitBytes } = require('./platform');
const git = require('./git');
const cnb = require('./cnb');
const local = require('./local');
const fonts = require('./fonts');
const CPLinks = require('../renderer/js/lib/links.js');

const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;
const SELFTEST = process.argv.includes('--selftest');

/**
 * 项目根目录（源码态）。打包后 __dirname 在 app.asar 里，往上数两级会拼出
 * 「app.asar\.demo\...」这种假路径（asar 是只读虚拟目录，往里写必然失败）。
 * 打包态改用 process.cwd()：自检永远从项目根启动，和 --profile=<相对路径>
 * 按 cwd 解析是同一份约定，测试产物（.shots / .demo）统一落在项目里。
 * 只给自检设施用（测试产物 / 截图 / mock 本地仓库），与运行时资源无关。
 */
function projectRoot() {
  return __dirname.includes('app.asar') ? process.cwd() : path.join(__dirname, '..', '..');
}

// 自动化测试时可以指定独立 profile，避免污染真实配置：--profile=<dir>
const PROFILE_ARG = process.argv.find((a) => a.startsWith('--profile='));
if (PROFILE_ARG) {
  try {
    app.setPath('userData', path.resolve(PROFILE_ARG.slice('--profile='.length)));
  } catch (e) {
    console.error('[profile] 无法切换 userData：' + e.message);
  }
}

// 包名改过一回（local-file-upload-management-tool → Quick-FileDispatch），userData 跟着变，
// 老配置要搬过来。自检 / 指定 profile 用的是独立目录，不参与搬家。
if (!PROFILE_ARG) migrateLegacyUserData();

const store = new Store();
let mainWindow = null;
let httpServer = null;
let serverPort = 0;

// Windows 下多开一个实例会抢配置文件，这里强制单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------- 工具

function cfgRaw() {
  return store.getRaw();
}

function buildClient() {
  const cfg = cfgRaw();
  if (!cfg.owner || !cfg.repo) {
    throw new Error('尚未配置仓库：请先在「设置」页填写用户名（owner）与仓库名（repo）');
  }
  const token = store.getToken();
  if (!token) {
    throw new Error('尚未配置访问令牌：请先在「设置」页填写 Token');
  }
  return new CloudClient({
    platform: cfg.platform,
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch || 'main',
    token,
    apiBase: cfg.apiBase || undefined
  });
}

function friendlyError(e) {
  if (!e) return '未知错误';
  if (e.name === 'ApiError' || e.message) return e.message;
  return String(e);
}

/** 当前配置是不是 CNB（CNB 的写操作全部走 git 通道，见 main/cnb.js） */
function cnbMode(cfg) {
  return ((cfg && cfg.platform) || 'github') === 'cnb';
}

/**
 * CNB 的写入通道要的信息。
 * CNB 公开接口造不了提交，写操作统一走 git（见 main/cnb.js），
 * 所以这里比 CloudClient 多带一个 localDir —— 有绑定就就地改，没有就临时克隆。
 */
function cnbConn() {
  const cfg = cfgRaw();
  return {
    platform: 'cnb',
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch || 'main',
    token: store.getToken(),
    localDir: cfg.localDir || ''
  };
}

/** 文件上限提示文案，跟着平台走 */
function fileTooBigMsg(platform, size) {
  return platform === 'cnb'
    ? `文件 ${CPLinks.formatBytes(size)} 超过 CNB 单文件 200MB 限制`
    : `文件 ${CPLinks.formatBytes(size)} 超过 GitHub 单文件 100MB 限制`;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon'
};

function mimeOf(name) {
  return MIME_BY_EXT[CPLinks.extOf(name)] || 'application/octet-stream';
}

/** 上传后把云端变更同步回本地仓库 */
async function syncLocal(reason) {
  const cfg = cfgRaw();
  const dir = cfg.localDir;
  if (!dir || !cfg.sync || cfg.sync.autoPull === false) return { skipped: true, message: '未启用自动同步' };
  if (!local.exists(dir)) return { skipped: true, message: '本地目录不存在' };
  const ok = await git.isRepo(dir);
  if (!ok) return { skipped: true, message: '本地目录不是 Git 仓库，跳过同步' };
  try {
    const r = await git.pull({
      platform: cfg.platform,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch || 'main',
      token: store.getToken(),
      dir,
      strategy: (cfg.sync && cfg.sync.strategy) || 'pull'
    });
    return Object.assign({ reason }, r);
  } catch (e) {
    return { skipped: false, ok: false, message: friendlyError(e) };
  }
}

// ---------------------------------------------------------------- 窗口

async function createWindow() {
  const cfg = cfgRaw();
  if (cfg.localDir) allowRoot(cfg.localDir);

  httpServer = await startServer(path.join(__dirname, '..', 'renderer'), {
    remoteProvider: async (relPath) => {
      const client = buildClient();
      const buffer = await client.readRaw(relPath);
      return { buffer, contentType: mimeOf(relPath) };
    }
  });
  serverPort = httpServer.port;

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0a1018',
    title: '快捷文件分发服务@JIE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);

  if (SELFTEST) runSelfTest();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 自绘标题栏：最大化状态变化时通知渲染层切换「最大化/还原」图标
  mainWindow.on('maximize', () => {
    if (mainWindow) mainWindow.webContents.send('win:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow) mainWindow.webContents.send('win:maximized', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** --selftest：无头跑一遍渲染层，把控制台输出和探测结果打到 stdout 后退出 */
function runSelfTest() {
  const wc = mainWindow.webContents;
  const errors = [];

  // 环境告警：WorkBuddy/CodeBuddy 的 shell 会通过 NODE_OPTIONS 注入 fs shim
  // （node-language-shim.cjs，仅在 CODEBUDDY_SESSION_ID 存在时激活），
  // 它会接管 fs 的删除类调用，导致 fs:localDelete 在本进程内假失败（报"文件不存在"），
  // 而同一进程的目录列举又看得到文件 —— 会让 --fstest 出现无法解释的红色。
  // 跑自检请务必先清掉：env -u NODE_OPTIONS -u CODEBUDDY_SESSION_ID -u CODEBUDDY_SAFE_DELETE_BULK_GUARD
  if (/node-language-shim/.test(process.env.NODE_OPTIONS || '') || process.env.CODEBUDDY_SESSION_ID) {
    console.log('SELFTEST_WARN 环境注入了 fs shim（NODE_OPTIONS/CODEBUDDY_SESSION_ID），'
      + '删除类断言会假失败；请用干净环境重跑：'
      + 'env -u NODE_OPTIONS -u CODEBUDDY_SESSION_ID -u CODEBUDDY_SAFE_DELETE_BULK_GUARD');
  }

  wc.on('console-message', (...args) => {
    const d = args.length > 1 && typeof args[1] === 'object' && !(args[1] instanceof Error) ? args[1] : null;
    const level = d ? d.level : args[1];
    const message = d ? d.message : args[2];
    const line = d ? d.lineNumber : args[3];
    const src = d ? d.sourceId : args[4];
    const tag = String(level);
    if (!/^[0-9]+$/.test(tag) && tag !== 'info' && tag !== 'log' && tag !== 'debug') {
      errors.push(tag + ': ' + message + ' @ ' + src + ':' + line);
    }
    console.log('[renderer:' + tag + '] ' + message + (src ? ' @ ' + src + ':' + line : ''));
  });

  wc.on('did-fail-load', (e, code, desc, url) => {
    errors.push('did-fail-load ' + code + ' ' + desc + ' ' + url);
    console.log('[fail-load]', code, desc, url);
  });

  wc.on('render-process-gone', (e, details) => {
    errors.push('render-process-gone ' + JSON.stringify(details));
    console.log('[render-gone]', JSON.stringify(details));
  });

  setTimeout(async () => {
    try {
      const probe = await wc.executeJavaScript(`(function(){
        var ids = ['page-upload','page-manage','page-settings','page-about','queueList','mgGrid','mgEmpty','aboutWrap','cfgOwner','cfgLinkRule','upTarget','utRepo','utState','mgSide','mgRootNode','mgCurPath','mgGitState','onboardWrap','btnMgRename','btnMgReplace'];
        var missing = ids.filter(function(i){ return !document.getElementById(i); });
        return {
          title: document.title,
          brand: (document.querySelector('.brand-name')||{}).textContent || '',
          brandSub: !!document.querySelector('.brand-sub'),
          cplinks: typeof window.CPLinks === 'object' && !!window.CPLinks.buildUrl,
          bridge: !!window.cloudpic && !!window.cloudpic.config,
          bridgeNew: !!(window.cloudpic.fs && window.cloudpic.fs.localRename && window.cloudpic.cloud.move && window.cloudpic.cloud.replace && window.cloudpic.git.commit),
          themeAccent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          navItems: document.querySelectorAll('.nav-item').length,
          activePage: (document.querySelector('.page.active')||{}).id || '',
          missingIds: missing,
          aboutRendered: (document.getElementById('aboutWrap')||{innerHTML:''}).innerHTML.length,
          linkRuleOptions: (document.getElementById('cfgLinkRule')||{options:[]}).options.length,
          repoChip: (document.getElementById('repoChipText')||{}).textContent || '',
          cpuChip: (document.getElementById('cpuBadge')||{}).textContent || '',
          targetRepo: (document.getElementById('utRepo')||{}).textContent || '',
          targetState: (document.getElementById('utState')||{}).textContent || '',
          sidebarW: (document.getElementById('sidebar')||{clientWidth:0}).clientWidth,
          footW: (document.querySelector('.sidebar-foot')||{clientWidth:0}).clientWidth,
          badges: (function(){
            var out = {};
            ['cpuBadge','verBadge'].forEach(function(id){
              var el = document.getElementById(id);
              if (!el) { out[id] = null; return; }
              var cs = getComputedStyle(el);
              var r = el.getBoundingClientRect();
              out[id] = { text: el.textContent, ws: cs.whiteSpace, w: Math.round(r.width), h: Math.round(r.height), lh: cs.lineHeight };
            });
            return out;
          })(),
          onboardOpen: (function(){ var w = document.getElementById('onboardWrap'); return !!w && !w.hidden; })(),
          onboardSteps: document.querySelectorAll('#onboardWrap .ob-step').length,
          pageAnim: getComputedStyle(document.querySelector('.page.active')||document.body).animationName,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,

          /* ---- 本轮新增：图标 / 列表 / 下拉 / 滑块 / AVIF / 代理 ---- */
          avifOption: (function(){
            var up = document.getElementById('upFormat');
            var cf = document.getElementById('cfgFormat');
            return {
              up: up ? !!up.querySelector('option[value="avif"]') : false,
              cfg: cf ? !!cf.querySelector('option[value="avif"]') : false,
              upValue: up ? up.value : ''
            };
          })(),
          cselect: (function(){
            var all = document.querySelectorAll('.csel').length;
            var nativeLeft = document.querySelectorAll('select:not(.csel-native)').length;
            var upRename = document.querySelector('#upRenameMode');
            var w = upRename && upRename.parentElement && upRename.parentElement.classList.contains('csel');
            var lbl = upRename ? (upRename.parentElement.querySelector('.csel-label')||{}).textContent : '';
            return { total: all, nativeLeft: nativeLeft, renameEnhanced: !!w, renameLabel: lbl };
          })(),
          rangeFill: (function(){
            var out = {};
            ['upQuality','cfgQuality','cfgWmOpacity'].forEach(function(id){
              var el = document.getElementById(id);
              out[id] = el ? el.style.getPropertyValue('--fill') : null;
            });
            return out;
          })(),
          fileIcons: (function(){
            var mod = window.__fi;
            if (!mod) return null;
            var names = ['a.png','b.mp4','c.mp3','d.zip','e.js','.editorconfig','f.pdf','g.docx','h.xlsx','i.pptx','j.woff2','k.epub','l.exe','m.sqlite','noext','.gitignore','x.avif'];
            var out = {};
            names.forEach(function(n){ out[n] = mod.categoryOf(n, false); });
            out.__dir = mod.categoryOf('folder', true);
            return out;
          })(),
          proxyResolve: (function(){
            var L = window.CPLinks;
            return {
              bare: L.buildProxyUrl({ proxyUrl: 'cdn.yangjie.site' }, '111.avif'),
              full: L.buildProxyUrl({ proxyUrl: 'https://cdn.yangjie.site/' }, 'images/2026/09/a b.png'),
              placeholder: L.buildProxyUrl({ proxyUrl: 'https://x.com/gh/o/r@main/{path}' }, 'a/b.png'),
              empty: L.buildProxyUrl({}, 'a.png')
            };
          })(),
          // 数字输入框：原生角标是否已干掉、有几个被自绘步进接管
          numfield: (function(){
            var nums = document.querySelectorAll('input[type="number"]');
            var wrapped = document.querySelectorAll('.numfield');
            var btn = document.querySelector('.numfield .nf-btn');
            return {
              inputs: nums.length,
              wrapped: wrapped.length,
              steppers: document.querySelectorAll('.numfield .nf-btn').length,
              ids: Array.prototype.map.call(wrapped, function(w){
                var i = w.querySelector('input'); return i ? i.id : '?';
              }),
              stepSize: btn ? getComputedStyle(btn).width : null
            };
          })(),
          // 水印颜色：色块 / 原生 color / hex 文本框三处是否同步
          wmColor: (function(){
            var c = document.getElementById('cfgWmColor');
            var t = document.getElementById('wmColorText');
            var sw = document.getElementById('wmSwatch');
            return {
              colorValue: c ? c.value : null,
              hexValue: t ? t.value : null,
              hexRender: t ? getComputedStyle(t).width : null,
              swatchBg: sw ? getComputedStyle(sw).getPropertyValue('--sw').trim() : null,
              presets: document.querySelectorAll('#wmPresets .wm-pre').length,
              presetOn: (document.querySelector('#wmPresets .wm-pre.on') || {}).dataset
                ? document.querySelector('#wmPresets .wm-pre.on').dataset.color : null
            };
          })(),
          // 界面字体：清单是不是「本机真装了哪些」枚举出来的，而不是那张写死的候选表
          fontList: (function(){
            var ap = window.__appearance;
            var sel = document.getElementById('cfgFont');
            var opts = sel
              ? Array.prototype.filter.call(sel.options, function(o){ return !o.disabled && o.value; })
              : [];
            return {
              real: ap ? ap.hasRealFontList() : false,
              count: ap ? ap.installFontCount() : 0,
              options: opts.length,
              groups: ap ? ap.installedFontGroups().map(function(g){ return g.group + ':' + g.fonts.length; }) : [],
              first: sel && sel.options[0] ? sel.options[0].textContent : '',
              // 本机装了霞鹜文楷才为真 —— 自检不假设任何机器装了它
              primary: opts.some(function(o){ return /霞鹜文楷|LXGW WenKai/i.test(o.value); }),
              stack: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()
            };
          })(),
          // 归档配置 UI + 数据
          profiles: (function(){
            var rows = document.querySelectorAll('#profileList .pf-row');
            var cfg = window.__state ? window.__state.cfg : null;
            var ps = (cfg && cfg.profiles) || [];
            return {
              uiRows: rows.length,
              newBtn: !!document.getElementById('btnProfNew'),
              archiveBtn: !!document.getElementById('btnProfArchive'),
              emptyHidden: !!(document.getElementById('profileEmpty') || {}).hidden,
              countText: (document.getElementById('profCount') || {}).textContent || '',
              total: ps.length,
              verified: ps.filter(function(p){ return p.verified; }).length,
              activeId: (cfg && cfg.activeProfileId) || '',
              activeRow: document.querySelectorAll('#profileList .pf-row.active').length,
              labels: ps.map(function(p){ return p.label + '@' + p.platform + (p.verified ? '✓' : '·'); })
            };
          })(),
          // 无边框窗口：自绘窗口控制按钮是否就位
          winControls: (function(){
            var drag = document.querySelector('.topbar');
            return {
              min: !!document.getElementById('btnWinMin'),
              max: !!document.getElementById('btnWinMax'),
              close: !!document.getElementById('btnWinClose'),
              group: !!document.getElementById('winControls'),
              topbarDrag: drag ? getComputedStyle(drag).webkitAppRegion || getComputedStyle(drag).appRegion : null
            };
          })()
        };
      })()`);
      console.log('SELFTEST_PROBE ' + JSON.stringify(probe, null, 2));
    } catch (e) {
      errors.push('probe failed: ' + e.message);
      console.log('SELFTEST_PROBE_FAILED ' + e.message);
    }

    if (process.argv.includes('--fstest')) {
      try {
        const out = await wc.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const waitFor = async (fn, ms) => {
            const t0 = Date.now();
            while (Date.now() - t0 < (ms || 10000)) {
              try { if (fn()) return true; } catch (e) { /* ignore */ }
              await sleep(150);
            }
            return false;
          };
          const log = [];
          const failed = [];
          // 假 API 地址（mock-server.js）；CNB / GitHub 探测都指向它
          const MOCK_API = 'http://127.0.0.1:8799';

          // —— 夹具自愈：先扫掉上一轮可能残留的测试文件。
          // 不清的话 renamed/after-rename.txt 会留在原地，UI 改名被"目标已存在"守卫正确拦下，
          // 断言却会读到旧残留而假失败（源文件保留其实是对的）。
          const FIXTURES = ['probe-a.txt', 'fstest-src.txt', 'renamed/probe-b.txt', 'renamed/after-rename.txt'];
          const before = await window.cloudpic.cloud.list({ dir: '', source: 'local' });
          const sweepCfg = await window.cloudpic.config.get();
          const swept = await window.cloudpic.fs.localDelete({ paths: FIXTURES });
          const after = await window.cloudpic.cloud.list({ dir: '', source: 'local' });
          log.push({
            step: 'sweep',
            localDir: (sweepCfg && sweepCfg.localDir) || '',
            before: before.items.map((i) => i.path),
            results: swept.results.map((r) => (r.ok ? 'rm:' : 'skip:') + r.path),
            after: after.items.map((i) => i.path)
          });

          document.querySelector('.nav-item[data-page="manage"]').click();
          await waitFor(() => document.querySelectorAll('#mgGrid .tile').length > 0, 12000);

          const diag = {
            tiles: document.querySelectorAll('#mgGrid .tile').length,
            skeleton: document.querySelectorAll('#mgGrid .skl-tile').length,
            emptyHidden: document.getElementById('mgEmpty').hidden,
            breadcrumb: document.getElementById('breadcrumb').innerText,
            sidebarSource: document.querySelector('#sourceSeg button.active').dataset.source
          };

          const rootList = await window.cloudpic.cloud.list({ dir: '', source: 'local' });
          log.push({ step: 'root', source: rootList.source, items: rootList.items.map((i) => i.type + ':' + i.path) });

          // —— 先做一次纯 IPC 的改名：确认 fs:localRename 真的把源文件移走了（不走 UI）
          await window.cloudpic.fs.localWrite({ path: 'probe-a.txt', data: new TextEncoder().encode('AAAAAAAAAA') });
          let probeErr = null;
          try {
            await window.cloudpic.fs.localRename({ from: 'probe-a.txt', to: 'renamed/probe-b.txt' });
          } catch (e) {
            probeErr = String(e.message || e);
          }
          const rootAfterProbe = await window.cloudpic.cloud.list({ dir: '', source: 'local' });
          const renamedAfterProbe = await window.cloudpic.cloud.list({ dir: 'renamed', source: 'local' });
          log.push({
            step: 'ipc-rename-probe',
            probeErr,
            srcStillThere: rootAfterProbe.items.some((i) => i.path === 'probe-a.txt'),
            target: renamedAfterProbe.items.map((i) => i.path + '(' + i.size + ')')
          });
          await window.cloudpic.fs.localDelete({ paths: ['renamed/probe-b.txt', 'probe-a.txt'] });

          // —— 本地改名：完整走 UI（选中 → 重命名 → 填表 → 确定）
          // 夹具文件可能被上一轮跑测改名/删除消耗掉，这里保证根目录一定存在一个文件，
          // 让 --fstest 可以反复跑而不用手工恢复 fixture。
          let gotFile = await waitFor(() => !!document.querySelector('#mgGrid .tile[data-type="file"]'), 2500);
          if (!gotFile) {
            await window.cloudpic.fs.localWrite({ path: 'fstest-src.txt', data: new TextEncoder().encode('fstest fixture') });
            if (!document.getElementById('btnMgRefresh')) return { error: '缺少刷新按钮，无法重建夹具', diag, log };
            document.getElementById('btnMgRefresh').click();
            gotFile = await waitFor(() => !!document.querySelector('#mgGrid .tile[data-type="file"]'), 8000);
            log.push({ step: 'seed', created: 'fstest-src.txt', visible: gotFile });
          }
          if (!gotFile) return { error: '根目录没有文件可改名', diag, log };
          diag.tiles = document.querySelectorAll('#mgGrid .tile').length;
          const fileTile = document.querySelector('#mgGrid .tile[data-type="file"]');
          const oldPath = fileTile.dataset.path;
          // 选中方式已经改掉了：单击条目不再选中，得点复选框（右键 / 空白拖框是另外两条路）
          fileTile.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const afterPlainClick = document.querySelectorAll('#mgGrid .tile.selected').length;
          const checkbox = fileTile.querySelector('.tile-check');
          if (checkbox) checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const afterCheck = document.querySelectorAll('#mgGrid .tile.selected').length;
          log.push({ step: 'select', afterPlainClick: afterPlainClick, afterCheckbox: afterCheck });
          if (afterPlainClick !== 0) failed.push('单击条目不该直接选中：选中了 ' + afterPlainClick + ' 项');
          if (afterCheck !== 1) failed.push('勾复选框没有选中该条目：选中 ' + afterCheck + ' 项');
          document.getElementById('btnMgRename').click();
          await sleep(400);
          const dirInput = document.getElementById('mgEditDir');
          const nameInput = document.getElementById('mgEditName');
          if (!dirInput || !nameInput) return { error: '重命名弹层没出现', diag, log, oldPath };
          log.push({ step: 'dialog', prefillDir: dirInput.value, prefillName: nameInput.value, buttons: document.querySelectorAll('.modal-foot .btn').length });

          // —— 目录选择器：本地与云端一致时，应该能点着本地目录树把路径挑出来，
          // 而不是让人默写一串相对路径。此时刚好有一个文件被选中，弹层已经开着。
          {
            const hint = document.getElementById('mgDirLocalTxt');
            const pickBtn = document.getElementById('mgDirPickBtn');
            const pick = {
              step: 'dirpick',
              hint: hint ? hint.innerText.trim() : null,
              hasPicker: !!pickBtn,
              localDir: (sweepCfg && sweepCfg.localDir) || ''
            };
            if (!hint || !hint.innerText.trim()) {
              failed.push('目录输入框下面那行「本地路径」提示是空的');
            }
            if (pickBtn) {
              pickBtn.click();
              await waitFor(() => document.querySelector('.dirpick-list'), 4000);
              const crumb = document.querySelector('.dirpick-crumb');
              pick.panel = !!document.querySelector('.dirpick');
              pick.crumb = crumb ? crumb.innerText.replace(/\s+/g, ' ').trim() : '';
              pick.rows = document.querySelectorAll('.dirpick-row').length;
              if (!pick.panel) failed.push('点了「浏览…」却没展开目录面板');
              const here = document.getElementById('mgDirPickHere');
              if (!here) {
                failed.push('目录面板里没有「选当前文件夹」按钮');
              } else {
                here.click();
                await sleep(80);
                pick.picked = dirInput.value;
                pick.closed = !document.querySelector('.dirpick');
                pick.hintAfter = hint.innerText.trim();
                if (document.querySelector('.dirpick')) failed.push('选了目录后面板没收起来');
                const root = ((sweepCfg && sweepCfg.localDir) || '').replace(/[\\/]+$/, '');
                if (root && pick.hintAfter.indexOf(root) !== 0) {
                  failed.push('采纳目录后本地路径没指到本地仓库里：' + pick.hintAfter);
                }
              }
            } else {
              // 这条用例跑在配好本地目录 + 本地是 Git 仓库的环境里，
              // 选择器没有理由不出现 —— 例如又把它绑回「必须 relation === 'same'」
              pick.reason = hint ? hint.innerText.trim() : '';
              failed.push('本地目录就绪却没出现「浏览…」按钮，路径选择器没启用：' + pick.reason);
            }
            log.push(pick);
          }
          dirInput.value = 'renamed';
          nameInput.value = 'after-rename.txt';
          document.querySelectorAll('.modal-foot .btn')[1].click();
          await sleep(1800);

          const afterRename = await window.cloudpic.cloud.list({ dir: 'renamed', source: 'local' });
          const rootAfter = await window.cloudpic.cloud.list({ dir: '', source: 'local' });
          const oldGone = !rootAfter.items.some((i) => i.path === oldPath);
          const renamedThere = afterRename.items.some((i) => i.path === 'renamed/after-rename.txt');
          if (!oldGone) failed.push('本地改名后源文件未移除：' + oldPath);
          if (!renamedThere) failed.push('本地改名后目标文件缺失：renamed/after-rename.txt');
          log.push({
            step: 'rename',
            from: oldPath,
            targets: fileTile ? 1 : 0,
            got: afterRename.items.map((i) => i.path),
            oldRemoved: oldGone,
            targetCreated: renamedThere,
            rootNow: rootAfter.items.map((i) => i.type + ':' + i.path)
          });

          // —— 条目上也能拉框：以前只有空白区能框选，一片夹着文件的区域没法一次框住
          {
            const marq = { step: 'marquee-from-tile' };
            const tile = document.querySelector('#mgGrid .tile');
            if (!tile) {
              failed.push('框选用例：网格里没有条目可框');
              log.push(marq);
            } else {
              const r = tile.getBoundingClientRect();
              const x0 = r.left + 3;
              const y0 = r.top + 3;
              tile.dispatchEvent(
                new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x0, clientY: y0 })
              );
              // 只按住、不动：长按判定应当自己把框拉起来
              await sleep(260);
              marq.afterHold = !!document.querySelector('.mg-marquee');
              document.dispatchEvent(
                new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x0 + 6, clientY: y0 + 6 })
              );
              await sleep(30);
              marq.boxDrawn = !!document.querySelector('.mg-marquee');
              marq.selected = document.querySelectorAll('#mgGrid .tile.selected').length;
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              await sleep(30);
              marq.boxGone = !document.querySelector('.mg-marquee');
              log.push(marq);
              if (!marq.afterHold) failed.push('在条目上长按没拉出选框：框选仍然只认空白区');
              if (!marq.selected) failed.push('在条目上拉框没选中任何条目');
              if (!marq.boxGone) failed.push('松手后选框没被移除');
              // 这条用例把选区改掉了，刷一次让它归零，免得干扰后面的断言
              const rf = document.getElementById('btnMgRefresh');
              if (rf) rf.click();
              await sleep(600);
            }
          }

          // —— 本地替换内容：与「替换内容」按钮同一条 IPC
          await window.cloudpic.fs.localWrite({ path: 'renamed/after-rename.txt', data: new Uint8Array([72, 73, 74, 73, 69]) });
          const readBack = await window.cloudpic.cloud.list({ dir: 'renamed', source: 'local' });
          const replaced = readBack.items.find((i) => i.path === 'renamed/after-rename.txt') || readBack.items[0] || {};
          log.push({ step: 'replace', size: replaced.size, expect: 5 });

          // —— 目标已存在时必须报错而不是静默覆盖
          let dup = 'no-throw';
          try { await window.cloudpic.fs.localRename({ from: 'renamed/after-rename.txt', to: 'renamed/after-rename.txt' }); }
          catch (e) { dup = e.message; }
          log.push({ step: 'same-path-guard', result: dup });
          if (!/一致/.test(dup)) failed.push('同源同目标未被拦截：' + dup);

          // —— 本地删除
          await window.cloudpic.fs.localDelete({ paths: ['renamed/after-rename.txt'] });
          const afterDel = await window.cloudpic.cloud.list({ dir: 'renamed', source: 'local' });
          log.push({ step: 'delete', remaining: afterDel.items.map((i) => i.path) });
          if (afterDel.items.some((i) => i.path === 'renamed/after-rename.txt')) failed.push('本地删除未生效');

          // —— 越界路径必须被拦住
          let guard = 'no-throw';
          try { await window.cloudpic.fs.localRename({ from: '../../escape.txt', to: 'x.txt' }); }
          catch (e) { guard = e.message; }
          log.push({ step: 'path-guard', result: guard });
          if (!/越界/.test(guard)) failed.push('越界路径未被拦截：' + guard);

          // —— 本地动过文件后，Git 应当变脏
          const st = await window.cloudpic.git.status();
          log.push({ step: 'git', isRepo: st.isRepo, dirty: st.dirty, changes: st.changes, branch: st.branch, head: st.head });

          // —— 提交并推送：测试环境没有真实远端，要求「优雅失败」而不是崩
          const push = await window.cloudpic.git.commit({});
          log.push({ step: 'push', ok: push.ok, message: String(push.message || '').slice(0, 100) });

          // —— 切到云端模式，验证远端浏览 + 云端改名入口（依赖假 API，失败不阻断本地断言）
          try {
            document.querySelectorAll('#sourceSeg button')[1].click();
            await sleep(2600);
            const remote = await window.cloudpic.cloud.list({ dir: '', source: 'remote' });
            log.push({ step: 'remote', files: (remote.items || []).map((i) => i.path) });

            const mvRemote = await window.cloudpic.cloud.move({ items: [{ from: 'docs/readme.md', to: 'docs/readme-renamed.md' }] });
            log.push({ step: 'cloud-move', ok: mvRemote.ok, results: (mvRemote.results || []).map((r) => (r.ok ? 'ok:' : 'fail:') + r.path) });
            const afterMove = await window.cloudpic.cloud.list({ dir: 'docs', source: 'remote' });
            log.push({ step: 'cloud-move-verify', items: afterMove.items.map((i) => i.path) });

            const repRes = await window.cloudpic.cloud.replace({ path: 'notes.txt', data: new Uint8Array([78, 69, 87]) });
            log.push({ step: 'cloud-replace', ok: repRes.ok, size: repRes.size });
          } catch (e) {
            log.push({ step: 'remote-skipped', reason: String(e && e.message ? e.message : e) });
          }

          // —— 云端检测器：结构必须齐（本地/云端两条 SHA + 结论字段）
          try {
            const det = await window.cloudpic.cloud.detect();
            const box = document.getElementById('mgCloudState');
            log.push({
              step: 'cloud-detect',
              ok: det.ok,
              relation: det.relation,
              localShort: det.local && det.local.short,
              cloudShort: det.cloud && det.cloud.short,
              boxText: box ? box.innerText.replace(/\s+/g, ' ').trim().slice(0, 120) : null
            });
            if (!det || typeof det.relation !== 'string') failed.push('云端检测器没有返回 relation');
            if (!box) failed.push('文件管理页左侧没有云端检测器（#mgCloudState）');
          } catch (e) {
            failed.push('云端检测器调用失败：' + (e.message || e));
          }

          // —— CNB 平台：走假 API 验证 CNB 客户端（whoami / repoInfo / listDir）
          try {
            const keepId = window.__state.cfg.activeProfileId;
            await window.__state.newProfile({ platform: 'cnb' });
            await window.__state.patch({
              platform: 'cnb',
              owner: 'youngdajie',
              repo: 'cnb-files',
              branch: 'main',
              apiBase: MOCK_API,
              token: 'cnb_fake_token_0001'
            });
            const tmpId = window.__state.cfg.activeProfileId;
            const chk = await window.cloudpic.profile.check({ id: tmpId });
            const list = await window.cloudpic.cloud.list({ dir: 'docs', source: 'remote' });
            log.push({
              step: 'cnb-check',
              cloudOk: chk.cloud && chk.cloud.ok,
              fullName: chk.cloud && chk.cloud.repoInfo && chk.cloud.repoInfo.fullName,
              userName: chk.cloud && chk.cloud.userName,
              message: chk.cloud && chk.cloud.message,
              docs: (list.items || []).map((i) => i.path)
            });
            if (!(chk.cloud && chk.cloud.ok)) failed.push('CNB 平台读接口没跑通：' + ((chk.cloud && chk.cloud.message) || '?'));
            if (!(list.items || []).some((i) => i.path === 'docs/readme.md')) {
              failed.push('CNB 平台列目录没拿到 docs/readme.md');
            }
            await window.__state.activateProfile(keepId);
            await window.__state.removeProfile(tmpId);
          } catch (e) {
            failed.push('CNB 平台探测失败：' + (e.message || e));
          }

          return { log, diag, failed };
        })()`);
        console.log('FSTEST ' + JSON.stringify(out, null, 2));
        if (out && out.error) errors.push('fstest: ' + out.error);
        for (const f of (out && out.failed) || []) errors.push('fstest assert: ' + f);
      } catch (e) {
        errors.push('fstest failed: ' + e.message);
        console.log('FSTEST_FAILED ' + (e.stack || e.message));
      }
    }

    /**
     * --uitest：驱动设置页做真实交互断言。
     * 覆盖：平台切换是否整表刷新、归档配置的切换/验证、
     *       数字步进器、水印颜色色板。
     * 沿用 --fstest 的 failed[] 约定，断言失败进 errors。
     */
    if (process.argv.includes('--uitest')) {
      try {
        const mockLocalDir = path.join(projectRoot(), '.demo', 'local-repo');
        const out = await wc.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const log = [];
          const failed = [];
          // 假 API 的约定值（mock-server.js 里 owner/repo 是写死的）
          const MOCK_PLATFORM = 'github';
          const MOCK_OWNER = 'youngdajie';
          const MOCK_REPO = 'my-images';
          const MOCK_API = 'http://127.0.0.1:8799';
          const MOCK_DIR = ${JSON.stringify(mockLocalDir)};
          const eq = (a, b, msg) => { if (a !== b) failed.push(msg + '：期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); };
          const val = (id) => (document.getElementById(id) || {}).value;
          const form = () => ({
            platform: (document.querySelector('#cfgPlatform button.active') || {}).dataset
              ? document.querySelector('#cfgPlatform button.active').dataset.platform : '',
            owner: val('cfgOwner'), repo: val('cfgRepo'), localDir: val('cfgLocalDir'), apiBase: val('cfgApiBase')
          });

          document.querySelector('.nav-item[data-page="settings"]').click();
          await sleep(1400);

          // —— 0. 前置：清空全部配置，重建一份指向假 API 的 GitHub 配置。
          //    完全自建，不依赖任何遗留状态，保证反复跑结果一致。
          // 删光（store 会保留一个占位，正好拿来当基准）
          let removed = 0;
          for (const p of (window.__state.cfg.profiles || []).slice()) {
            await window.__state.removeProfile(p.id);
            removed += 1;
          }
          await sleep(900);
          await window.__state.patch({
            platform: MOCK_PLATFORM,
            owner: MOCK_OWNER,
            repo: MOCK_REPO,
            branch: 'main',
            apiBase: MOCK_API,
            localDir: MOCK_DIR,
            token: 'ghp_fake_token_for_test_0001',
            watermark: { color: '#1296db' }
          });
          await sleep(900);
          const baseProf = (window.__state.cfg.profiles || []).find(
            (p) => p.id === window.__state.cfg.activeProfileId
          );
          if (!baseProf) {
            failed.push('测试前置失败：没能建出基准配置');
            return { log, failed };
          }
          log.push({
            step: 'reset',
            removed: removed,
            base: baseProf.label + '@' + baseProf.platform,
            localDir: baseProf.localDir,
            profiles: (window.__state.cfg.profiles || []).map((p) => p.label + '@' + p.platform)
          });

          // —— 1. 平台按钮：只切「正在编辑的配置」，不许碰全局生效的那份
          const before = form();
          const actIdBefore = window.__state.cfg.activeProfileId;
          const countBefore = (window.__state.cfg.profiles || []).length;
          log.push({ step: 'form-before', form: before });

          // CNB 下没有任何配置 → 表单清空，但「当前使用」仍然是那份 GitHub 配置
          document.querySelector('#cfgPlatform button[data-platform="cnb"]').click();
          await sleep(1500);
          const onCnb = form();
          log.push({
            step: 'switch-cnb',
            form: onCnb,
            profiles: (window.__state.cfg.profiles || []).length,
            active: window.__state.cfg.activeProfileId,
            platform: window.__state.cfg.platform,
            flag: (document.getElementById('platState') || {}).textContent,
            setActiveHidden: (document.getElementById('btnSetActive') || {}).hidden
          });
          eq(onCnb.platform, 'cnb', '切到 CNB 后平台按钮没跟上');
          eq(onCnb.owner, '', '切到 CNB 后 owner 没有刷新（还是 GitHub 的）');
          eq(onCnb.localDir, '', '切到 CNB 后本地目录没有刷新（还是 GitHub 的）');
          // 平台按钮不再是「切生效配置」：不能新建、不能改 activeProfileId、不能改全局平台
          if ((window.__state.cfg.profiles || []).length !== countBefore) {
            failed.push('点平台按钮不该新建配置：' + countBefore + ' -> ' + (window.__state.cfg.profiles || []).length);
          }
          if (window.__state.cfg.activeProfileId !== actIdBefore) failed.push('点平台按钮把「当前使用」的配置也换了');
          if (window.__state.cfg.platform !== MOCK_PLATFORM) {
            failed.push('点平台按钮把全局生效的平台也改了：' + window.__state.cfg.platform);
          }
          if ((document.getElementById('platState') || {}).textContent !== '新建') {
            failed.push('平台状态没显示「新建」：' + (document.getElementById('platState') || {}).textContent);
          }
          // 还没建出来的落点，归档列表 / 下拉里都不该多出条目
          {
            const rows = document.querySelectorAll('#profileList .pf-row').length;
            const opts = Array.from((document.getElementById('profilePick') || { options: [] }).options).filter(
              (o) => o.value && !o.disabled && o.value.indexOf('__') !== 0
            );
            log.push({ step: 'no-draft', rows: rows, pickOpts: opts.length, profiles: (window.__state.cfg.profiles || []).length });
            if (rows !== 1) failed.push('切平台后归档列表里多出了条目：' + rows + ' 行');
            if (opts.length !== 1) failed.push('切平台后归档下拉里多出了条目：' + opts.length + ' 项');
          }

          // 给 CNB 填一套完整信息 + 点「保存」→ 应该落成一份 CNB 配置，但不抢「当前使用」
          document.getElementById('cfgOwner').value = 'cnb-user';
          document.getElementById('cfgRepo').value = 'cnb-repo';
          document.getElementById('cfgLocalDir').value = 'D:/cnb-repo';
          await sleep(400);
          document.getElementById('btnSave').click();
          await sleep(1800);
          const cnbProf = (window.__state.cfg.profiles || []).find((p) => p.platform === 'cnb');
          log.push({
            step: 'cnb-filled',
            form: form(),
            created: !!cnbProf,
            createdActive: !!(cnbProf && window.__state.cfg.activeProfileId === cnbProf.id),
            activeStillBase: window.__state.cfg.activeProfileId === actIdBefore,
            flag: (document.getElementById('platState') || {}).textContent,
            setActiveHidden: (document.getElementById('btnSetActive') || {}).hidden
          });
          if (!cnbProf) failed.push('保存后没有新建出一份 CNB 配置');
          if (window.__state.cfg.activeProfileId !== actIdBefore) failed.push('保存 CNB 配置时把「当前使用」也换掉了');
          if ((document.getElementById('btnSetActive') || {}).hidden !== false) {
            failed.push('编辑一份「非当前使用」的配置时，应该给出「设为当前使用」入口');
          }

          // 切回 GitHub：应当整份还原
          document.querySelector('#cfgPlatform button[data-platform="github"]').click();
          await sleep(1500);
          const back = form();
          log.push({ step: 'switch-back-github', form: back });
          eq(back.platform, 'github', '切回 GitHub 后平台按钮没跟上');
          eq(back.owner, before.owner, '切回 GitHub 后 owner 没还原');
          eq(back.localDir, before.localDir, '切回 GitHub 后本地目录没还原');

          // —— 2. 归档列表：点某一行能整份切过去（这才是真正换生效配置的入口）
          if (!cnbProf) {
            failed.push('找不到刚建的 CNB 配置');
          } else {
            const row = document.querySelector('#profileList .pf-row[data-id="' + cnbProf.id + '"]');
            if (!row) failed.push('归档列表里没有渲染出 CNB 配置行');
            else {
              const useBtn = row.querySelector('button[data-act="use"]');
              (useBtn || row).click();
              await sleep(1500);
              log.push({ step: 'use-cnb-profile', form: form(), active: window.__state.cfg.activeProfileId });
              eq(form().owner, 'cnb-user', '点归档项没有切到该配置');
              if (window.__state.cfg.activeProfileId !== cnbProf.id) {
                failed.push('点归档项后「当前使用」的配置没换过去');
              }
            }
          }

          // —— 3. 验证并归档：用指向假 API 的基准配置跑真实连接校验
          {
            const row = document.querySelector('#profileList .pf-row[data-id="' + baseProf.id + '"]');
            if (row && !row.classList.contains('active')) {
              const useBtn = row.querySelector('button[data-act="use"]');
              (useBtn || row).click();
              await sleep(1500);
            }
            document.getElementById('btnProfArchive').click();
            await sleep(3200);
            const after = (window.__state.cfg.profiles || []).find((p) => p.id === baseProf.id);
            log.push({
              step: 'archive',
              verified: !!(after && after.verified),
              userName: after && after.userName,
              repoFull: after && after.repoInfo && after.repoInfo.fullName,
              hasToken: after && after.hasToken,
              countText: (document.getElementById('profCount') || {}).textContent,
              activeRow: document.querySelectorAll('#profileList .pf-row.active').length
            });
            if (!(after && after.verified)) failed.push('验证并归档后 profile 没被标记为已验证');
            if (!document.querySelector('#profileList .pf-row.active')) failed.push('归档列表里没有高亮当前生效项');
          }

          // —— 4. 强制绑定：本地目录为空时不允许归档
          document.getElementById('btnProfNew').click();
          await sleep(1400);
          document.getElementById('cfgOwner').value = 'some-user';
          document.getElementById('cfgRepo').value = 'some-repo';
          document.getElementById('cfgLocalDir').value = '';
          await sleep(1600);
          const nBefore = (window.__state.cfg.profiles || []).filter((p) => p.verified).length;
          document.getElementById('btnProfArchive').click();
          await sleep(1200);
          const nAfter = (window.__state.cfg.profiles || []).filter((p) => p.verified).length;
          log.push({ step: 'bind-guard', verifiedBefore: nBefore, verifiedAfter: nAfter });
          eq(nAfter, nBefore, '没有绑定本地目录却仍然归档成功了');

          // 切回指向假 API 的那份已验证配置，别把测试状态留在空配置上
          const good = (window.__state.cfg.profiles || []).find((p) => p.verified);
          if (good) {
            await window.__state.activateProfile(good.id);
            await sleep(1200);
          }

          // —— 5. 数字步进器：点 + 应当按 step 递增
          const mw = document.getElementById('cfgMaxWidth');
          const beforeW = Number(mw.value) || 0;
          const nfWrap = mw.closest('.numfield');
          if (!nfWrap) failed.push('最大宽度没有套上 .numfield');
          const upBtn = nfWrap.querySelector('.nf-btn[data-step="up"]');
          upBtn.click();
          await sleep(200);
          log.push({ step: 'numfield', before: beforeW, after: Number(mw.value), steppers: nfWrap.querySelectorAll('.nf-btn').length });
          eq(Number(mw.value), beforeW + 100, '最大宽度 + 按钮没有按 step=100 递增');
          const dnBtn = nfWrap.querySelector('.nf-btn[data-step="down"]');
          dnBtn.click();
          await sleep(200);
          eq(Number(mw.value), beforeW, '最大宽度 − 按钮没有还原');

          // 到下限时减号应当禁用
          mw.value = '0';
          mw.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(150);
          const dis = dnBtn.disabled;
          log.push({ step: 'numfield-min', minDisabled: dis });
          if (!dis) failed.push('数值到 min 时减号没被禁用');

          // —— 6. 水印颜色：色板点选要写回
          const pre = document.querySelectorAll('#wmPresets .wm-pre')[1];
          pre.click();
          await sleep(250);
          const picked = pre.dataset.color;
          log.push({ step: 'wm-color', picked: picked, color: val('cfgWmColor'), text: val('wmColorText') });
          eq(val('cfgWmColor'), picked, '点色板没有写回 color 输入');
          eq(val('wmColorText'), picked, '点色板没有同步 hex 文本框');
          // 手输一个 3 位缩写也要能归一化
          const hex = document.getElementById('wmColorText');
          hex.value = '#0af';
          hex.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(250);
          log.push({ step: 'wm-hex-short', value: val('cfgWmColor') });
          eq(val('cfgWmColor'), '#00aaff', '三位 hex 缩写没有归一化成 #00aaff');
          // 非法值不应污染
          hex.value = '#zz';
          hex.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(200);
          eq(val('cfgWmColor'), '#00aaff', '非法 hex 把颜色污染了');

          // —— 6b. 自绘取色器：开合、拖色、常用色、内部滚动不误关
          {
            const sw = document.getElementById('wmSwatch');
            if (!sw) failed.push('颜色那行没有自绘色块按钮 #wmSwatch');
            else {
              sw.click();
              await sleep(250);
              let pop = document.querySelector('.cp-pop');
              log.push({ step: 'cp-open', opened: !!pop });
              if (!pop) failed.push('点色块没有弹出取色面板');
              else {
                const sv = pop.querySelector('.cp-sv');
                const hueBar = pop.querySelector('.cp-hue');
                const presetsBox = pop.querySelectorAll('.cp-presets .cp-pre');
                const hexRead = pop.querySelector('.cp-hex');
                log.push({
                  step: 'cp-parts',
                  sv: !!sv,
                  hue: !!hueBar,
                  presets: presetsBox.length,
                  h: sv ? sv.style.getPropertyValue('--h') : '',
                  hex: hexRead ? hexRead.textContent : '',
                  swatchOn: sw.classList.contains('is-open')
                });
                if (!sv || !hueBar) failed.push('取色面板缺 SV 方块 / 色相条');
                if (presetsBox.length < 4) failed.push('取色面板常用色太少：' + presetsBox.length);
                if (sv && !sv.style.getPropertyValue('--h')) failed.push('SV 方块没有 --h，渐变不会跟着色相走');
                if (!sw.classList.contains('is-open')) failed.push('面板开着时色块没进 is-open 态');

                // 拖 SV 方块：中心点应当落到约 s=50% / v=50%，颜色随之改变
                if (sv) {
                  const before = val('cfgWmColor');
                  const r = sv.getBoundingClientRect();
                  const at = (fx, fy) => ({
                    bubbles: true, cancelable: true, button: 0, pointerId: 7, isPrimary: true,
                    clientX: r.left + r.width * fx, clientY: r.top + r.height * fy
                  });
                  sv.dispatchEvent(new PointerEvent('pointerdown', at(0.5, 0.5)));
                  await sleep(120);
                  const mid = val('cfgWmColor');
                  const knob = pop.querySelector('.cp-sv .cp-knob');
                  document.dispatchEvent(new PointerEvent('pointermove', at(0.75, 0.25)));
                  await sleep(80);
                  document.dispatchEvent(new PointerEvent('pointerup', at(0.75, 0.25)));
                  await sleep(120);
                  const afterDrag = val('cfgWmColor');
                  log.push({
                    step: 'cp-drag',
                    before: before, mid: mid, after: afterDrag,
                    knobLeft: knob ? knob.style.left : '', knobTop: knob ? knob.style.top : ''
                  });
                  if (mid === before) failed.push('在 SV 方块上按下没有取到颜色');
                  if (afterDrag === mid) failed.push('拖动 SV 方块的圆点没有连续改色');
                  if (knob && !knob.style.left) failed.push('SV 圆点没有跟着指针移动');

                  // 拖完再点常用色，必须精确回到那个色
                  const red = Array.from(presetsBox).find((b) => b.dataset.color === '#ff4d4f');
                  if (!red) failed.push('取色面板里没有 #ff4d4f 这个常用色');
                  else {
                    red.click();
                    await sleep(150);
                    log.push({ step: 'cp-preset', color: val('cfgWmColor'), hex: (pop.querySelector('.cp-hex') || {}).textContent });
                    eq(val('cfgWmColor'), '#ff4d4f', '取色面板点常用色没有写回颜色');
                  }
                }

                // 面板内部滚动（长列表 / 触摸板）绝不能把自己关掉
                pop.dispatchEvent(new Event('scroll', { bubbles: true }));
                await sleep(150);
                if (!document.querySelector('.cp-pop')) failed.push('取色面板内部滚动把面板误关了');

                // Escape 收起
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(150);
                if (document.querySelector('.cp-pop')) failed.push('Escape 没能收起取色面板');
                if (sw.classList.contains('is-open')) failed.push('收起后色块还留着 is-open 态');

                // 再开一次，点面板外面要收起
                sw.click();
                await sleep(200);
                document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                await sleep(150);
                log.push({ step: 'cp-dismiss', outsideClosed: !document.querySelector('.cp-pop') });
                if (document.querySelector('.cp-pop')) failed.push('点面板外面没有收起取色面板');
              }
            }
          }

          // —— 7. 换配置后管理页要回到根目录重载（不然会继续显示旧仓库的文件）
          document.querySelector('.nav-item[data-page="manage"]').click();
          await sleep(2800);
          const divedPath = await (async () => {
            for (let i = 0; i < 30; i++) {
              const t = document.querySelector('#mgGrid .tile[data-path="demo-files"]');
              if (t) {
                t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                return 'demo-files';
              }
              await sleep(150);
            }
            return null;
          })();
          await sleep(2200);
          const crumbBefore = (document.getElementById('breadcrumb') || {}).innerText || '';
          // 造一份同仓库但本地目录不同的配置，切换后身份串必然变化
          await window.__state.newProfile({ platform: MOCK_PLATFORM });
          await window.__state.patch({
            platform: MOCK_PLATFORM, owner: MOCK_OWNER, repo: MOCK_REPO,
            apiBase: MOCK_API, localDir: '', token: 'ghp_fake_token_for_test_0001'
          });
          await sleep(1600);
          const tmpProf = (window.__state.cfg.profiles || []).find(
            (p) => p.id === window.__state.cfg.activeProfileId
          );
          document.querySelector('.nav-item[data-page="manage"]').click();
          await sleep(3000);
          const crumbAfter = (document.getElementById('breadcrumb') || {}).innerText || '';
          log.push({
            step: 'manage-reload',
            dived: divedPath,
            crumbBefore: crumbBefore,
            crumbAfter: crumbAfter,
            tiles: document.querySelectorAll('#mgGrid .tile').length
          });
          if (divedPath && /demo-files/.test(crumbBefore)) {
            if (/demo-files/.test(crumbAfter)) failed.push('换了配置之后管理页还停在旧仓库的子目录里');
          }
          // 把这份临时配置删掉，切回基准
          if (tmpProf) await window.__state.removeProfile(tmpProf.id);
          await window.__state.activateProfile(baseProf.id);
          await sleep(1200);

          // —— 8. 外观：主题（白天/黑夜）+ 界面字体
          document.querySelector('.nav-item[data-page="settings"]').click();
          await sleep(900);

          const themeCards = document.querySelectorAll('#themeCards .theme-card');
          if (themeCards.length !== 2) failed.push('主题卡片不是两张：' + themeCards.length);
          document.querySelector('#themeCards .theme-card[data-theme="light"]').click();
          await sleep(700);
          const themeNow = document.documentElement.dataset.theme;
          const cfgTheme = (window.__state.cfg.ui || {}).theme;
          const themeOn = Array.from(document.querySelectorAll('#themeCards .theme-card.on')).map((c) => c.dataset.theme);
          const lightBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
          const lightText = getComputedStyle(document.body).color;
          log.push({ step: 'theme-light', themeNow, cfgTheme, on: themeOn, bg: lightBg, color: lightText });
          eq(themeNow, 'light', '点浅色主题后 <html data-theme> 没变成 light');
          eq(cfgTheme, 'light', '点浅色主题后配置里 ui.theme 没落盘');
          eq(themeOn.join(','), 'light', '主题卡片高亮没跟着走');
          // 浅色主题必须是浅底 + 深字，不然「白天」主题等于没做
          const lum = (c) => {
            const s = String(c || '');
            let r = 255, g = 255, b = 255;
            const hex = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s);
            const rgb = /rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/i.exec(s);
            if (hex) {
              r = parseInt(hex[1], 16); g = parseInt(hex[2], 16); b = parseInt(hex[3], 16);
            } else if (rgb) {
              r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
            } else {
              return 1;
            }
            return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
          };
          if (lum(lightBg) < 0.5) failed.push('浅色主题的 --bg 还是深色：' + lightBg);
          if (lum(lightText) > 0.6) failed.push('浅色主题的文字还是浅色（会看不清）：' + lightText);
          document.querySelector('#themeCards .theme-card[data-theme="dark"]').click();
          await sleep(700);
          eq(document.documentElement.dataset.theme, 'dark', '切回深色主题失败');

          // 顶栏的昼夜按钮：跟设置页那两张卡片共用同一个配置字段，
          // 两边都点一遍，确认图标、配置、卡片高亮、粒子背景是同一套状态
          const btnTheme = document.getElementById('btnTheme');
          if (!btnTheme) failed.push('顶栏没有昼夜切换按钮 #btnTheme');
          else {
            const iconDark = btnTheme.innerHTML.length;
            btnTheme.click();
            // 涟漪是「点下去那一刻」挂的类，动画归 CSS 播，等 900ms 再看就没了
            const rippleCls = btnTheme.classList.contains('ripple');
            const rippleAnim = getComputedStyle(btnTheme, '::before').animationName;
            await sleep(900);
            const uLight = window.__universe ? window.__universe() : null;
            const cv = document.getElementById('universe');
            log.push({
              step: 'topbar-theme',
              theme: document.documentElement.dataset.theme,
              cfg: (window.__state.cfg.ui || {}).theme,
              cardOn: Array.from(document.querySelectorAll('#themeCards .theme-card.on')).map((c) => c.dataset.theme).join(','),
              iconChanged: btnTheme.innerHTML.length !== iconDark,
              canvasHidden: cv ? cv.hidden : null,
              ripple: rippleCls,
              rippleAnim: rippleAnim,
              universe: uLight
            });
            eq(document.documentElement.dataset.theme, 'light', '顶栏按钮没把主题切成浅色');
            eq((window.__state.cfg.ui || {}).theme, 'light', '顶栏按钮切换后没把 ui.theme 落盘');
            if (btnTheme.innerHTML.length === iconDark) failed.push('顶栏按钮的图标没跟着换（太阳/月亮）');
            if (!rippleCls) failed.push('点昼夜按钮没挂上涟漪类');
            if (rippleAnim !== 'theme-breath-out') failed.push('涟漪扩散动画没生效：' + rippleAnim);
            if (!uLight || !uLight.mounted) failed.push('浅色下粒子背景没挂上');
            else {
              if (!uLight.light) failed.push('粒子背景没认出浅色主题');
              if (!uLight.running) failed.push('浅色下粒子动画没跑起来');
              if (uLight.dots < 10) failed.push('粒子数太少，背景等于没有：' + uLight.dots);
            }
            if (cv && cv.hidden) failed.push('浅色下粒子画布还挂着 hidden');

            // 光看 running 不算数 —— 画布尺寸、变换矩阵任何一处写错，
            // 动画照样「在跑」，但一个像素都落不下去。直接数一遍画布上真着了色的像素。
            if (cv) {
              const c2d = cv.getContext('2d');
              const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
              let painted = 0;
              for (let i = 3; i < data.length; i += 16) if (data[i] > 8) painted++;
              log.push({ step: 'universe-paint', canvas: [cv.width, cv.height], painted: painted });
              if (painted < 200) failed.push('粒子背景在跑，但画布上几乎没着色：' + painted);
            }

            // 再点一次切回深色：深色换的是星野形态，动画要继续跑
            btnTheme.click();
            await sleep(900);
            const uDark = window.__universe ? window.__universe() : null;
            log.push({
              step: 'topbar-theme-back',
              theme: document.documentElement.dataset.theme,
              canvasHidden: cv ? cv.hidden : null,
              universe: uDark
            });
            eq(document.documentElement.dataset.theme, 'dark', '顶栏按钮没切回深色');
            if (!uDark || uDark.mode !== 'dark') failed.push('深色下背景没切成星野形态：' + (uDark && uDark.mode));
            else {
              if (!uDark.running) failed.push('深色下星野动画没跑起来');
              if (uDark.stars < 40) failed.push('深色下星星太少，背景等于没有：' + uDark.stars);
              if (uDark.giants < 1) failed.push('深色下星星里没有巨星：' + uDark.giants);
            }
            if (cv && cv.hidden) failed.push('深色下背景画布被收起来了，星野画不出来');
            eq(btnTheme.classList.contains('ripple'), false, '涟漪类没在动画结束后摘掉（会一直占着，下次点不再播）');

            // 深色同样要数像素：星云和巨星都是离屏贴图，
            // 贴图没建出来时 running 照样是 true，画布上却是空的
            if (cv) {
              const c2d = cv.getContext('2d');
              const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
              let painted2 = 0;
              for (let i = 3; i < data.length; i += 16) if (data[i] > 8) painted2++;
              log.push({ step: 'universe-paint-dark', canvas: [cv.width, cv.height], painted: painted2 });
              if (painted2 < 200) failed.push('深色星野在跑，但画布上几乎没着色：' + painted2);
            }
          }

          // 压缩前后对比：自检跑不了真的压缩，就自己捏一份「压缩结果」喂进去，
          // 验弹层装不装得起来、中缝拖不拖得动
          if (!window.__cmp) failed.push('上传页没暴露前后对比的钩子');
          else {
            const probe = document.createElement('canvas');
            probe.width = 60; probe.height = 40;
            const pc = probe.getContext('2d');
            pc.fillStyle = '#4e9bea'; pc.fillRect(0, 0, 60, 40);
            pc.fillStyle = '#f76945'; pc.fillRect(20, 10, 20, 20);
            const srcBlob = await new Promise((r) => probe.toBlob(r, 'image/png'));
            const srcBuf = await srcBlob.arrayBuffer();
            const srcUrl = URL.createObjectURL(srcBlob);
            window.__cmp.open({
              id: 9001, isImage: true, previewUrl: srcUrl,
              outBuffer: srcBuf, outSize: srcBuf.byteLength, origSize: srcBuf.byteLength * 3,
              outName: 'cmp-probe.png', outW: 60, outH: 40, srcW: 60, srcH: 40,
              quality: 80, passthrough: false, note: ''
            });
            await sleep(700);
            const stage = document.querySelector('.modal .cmp-stage');
            const imgB = document.querySelector('.modal .cmp-b');
            log.push({
              step: 'compare-open',
              stage: !!stage,
              before: !!document.querySelector('.modal .cmp-a'),
              after: !!imgB,
              clip: imgB ? getComputedStyle(imgB).clipPath : '',
              tags: document.querySelectorAll('.modal .cmp-tag').length
            });
            if (!stage) failed.push('前后对比弹层没打开');
            if (!imgB) failed.push('对比弹层里没有压缩后那一层');
            else if (!getComputedStyle(imgB).clipPath || getComputedStyle(imgB).clipPath === 'none') {
              failed.push('对比层没有裁切，中缝不会出现');
            }
            if (document.querySelectorAll('.modal .cmp-tag').length !== 2) {
              failed.push('对比弹层两侧的标注不是两个');
            }
            // 拖一下中缝，看裁切位置真的会动
            const rect = stage.getBoundingClientRect();
            stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width * 0.25, pointerId: 1, button: 0 }));
            const dragged = stage.style.getPropertyValue('--split');
            stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.left, pointerId: 1 }));
            log.push({ step: 'compare-drag', split: dragged });
            if (!dragged) failed.push('拖动中缝没写进 --split');
            URL.revokeObjectURL(srcUrl);
            document.querySelector('.modal-foot .btn').click();
            await sleep(500);
            if (document.querySelector('.modal .cmp-stage')) failed.push('对比弹层点关闭后没关掉');
          }

          // 字体清单：探测本机已装字体，并验证选中后会落盘 + 改 --font-ui
          const fontSel = document.getElementById('cfgFont');
          if (!fontSel) failed.push('设置页没有字体下拉 #cfgFont');
          else {
            const fontOpts = Array.from(fontSel.options).filter((o) => o.value && !o.disabled);
            log.push({
              step: 'fonts',
              count: fontOpts.length,
              total: fontSel.options.length,
              sample: fontOpts.slice(0, 6).map((o) => o.value)
            });
            if (fontOpts.length < 3) failed.push('本机字体探测几乎没结果，字体清单只有 ' + fontOpts.length + ' 款');
            const pickFont = fontOpts[0] ? fontOpts[0].value : '';
            if (pickFont) {
              fontSel.value = pickFont;
              fontSel.dispatchEvent(new Event('change', { bubbles: true }));
              await sleep(900);
              const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-ui');
              log.push({ step: 'font-applied', pick: pickFont, cfg: (window.__state.cfg.ui || {}).font, stack: stack.trim() });
              eq((window.__state.cfg.ui || {}).font, pickFont, '选字体会后没写进配置');
              if (stack.indexOf(pickFont) < 0) failed.push('--font-ui 没有换成所选字体');
              // 字样本体也要跟着换
              const sampleFont = getComputedStyle(document.getElementById('fontSample')).fontFamily || '';
              if (sampleFont.indexOf(pickFont) < 0) failed.push('字体样本没有跟着换字体');
              fontSel.value = '';
              fontSel.dispatchEvent(new Event('change', { bubbles: true }));
              await sleep(800);
              eq((window.__state.cfg.ui || {}).font, '', '恢复「系统默认」字体失败');

              // —— 8b. 自绘下拉：真点得中、滚轮/内部滚动不误关、筛选能用
              //     （这几个正是「下拉选不中、点一下就消失」那次回归的核心）
              const wrap = fontSel.closest('.csel');
              const cbtn = wrap && wrap.querySelector('.csel-btn');
              log.push({ step: 'csel-wrap', hasWrap: !!wrap, hasBtn: !!cbtn });
              if (!wrap || !cbtn) failed.push('字体下拉没有被自绘下拉接管（缺 .csel / .csel-btn）');
              else {
                const isOpen = () => !!document.querySelector('.csel-panel');
                cbtn.click();
                await sleep(250);
                let panel = document.querySelector('.csel-panel');
                log.push({ step: 'csel-open', open: !!panel, btnOpen: cbtn.classList.contains('is-open') });
                if (!panel) failed.push('点字体下拉后面板没出来');
                else {
                  const opts = panel.querySelectorAll('.csel-opt');
                  const filter = panel.querySelector('.csel-filter');
                  log.push({ step: 'csel-parts', opts: opts.length, filter: !!filter });
                  if (opts.length < 3) failed.push('字体下拉面板里没有选项：' + opts.length);
                  if (fontSel.options.length > 20 && !filter) failed.push('字体这么多项却没有筛选框');

                  // 面板自己滚（滚轮/触摸板压在上面）绝不能把面板关掉
                  panel.dispatchEvent(new Event('scroll', { bubbles: true }));
                  await sleep(150);
                  log.push({ step: 'csel-scroll-inside', stillOpen: isOpen() });
                  if (!isOpen()) failed.push('在面板里滚动把下拉关掉了（这正是 bug 本身）');

                  // 焦点落在里面也不能触发滚动把自己关掉
                  if (!isOpen()) failed.push('面板丢了，后面没法继续');
                  else {
                    if (filter) {
                      // 用本机真实存在的某款字体名当关键字，保证一定筛得到
                      const probeFont = fontOpts[Math.min(5, fontOpts.length - 1)].value;
                      filter.value = probeFont;
                      filter.dispatchEvent(new Event('input', { bubbles: true }));
                      await sleep(200);
                      const shown = Array.from(panel.querySelectorAll('.csel-opt')).filter((o) => !o.hidden);
                      log.push({ step: 'csel-filter', q: probeFont, shown: shown.length, total: opts.length, stillOpen: isOpen() });
                      if (!shown.length) failed.push('筛选「' + probeFont + '」后一个字体都没剩下');
                      if (shown.length === opts.length) failed.push('筛选框没有真的过滤掉选项');
                      if (!isOpen()) failed.push('输入筛选词把下拉关掉了');
                    }
                    // 选一个真实存在的项：面板必须关掉、值必须写回、字体跟着换
                    const pick2 = Array.from(panel.querySelectorAll('.csel-opt:not([disabled]):not([hidden])'))
                      .find((o) => o.dataset.index != null && fontSel.options[Number(o.dataset.index)].value);
                    if (!pick2) failed.push('筛选后找不到可选项来点选');
                    else {
                      const wantVal = fontSel.options[Number(pick2.dataset.index)].value;
                      pick2.click();
                      await sleep(900);
                      log.push({
                        step: 'csel-pick',
                        want: wantVal, got: fontSel.value,
                        panelGone: !isOpen(),
                        cfg: (window.__state.cfg.ui || {}).font,
                        label: (wrap.querySelector('.csel-label') || {}).textContent
                      });
                      eq(fontSel.value, wantVal, '点下拉项没有写回原生 select');
                      if (isOpen()) failed.push('选中后下拉面板没有收起');
                      eq((window.__state.cfg.ui || {}).font, wantVal, '从下拉里选字体没有落盘');
                      const stack2 = getComputedStyle(document.documentElement).getPropertyValue('--font-ui');
                      if (stack2.indexOf(wantVal) < 0) failed.push('从下拉里选字体后 --font-ui 没生效');
                      const lbl = (wrap.querySelector('.csel-label') || {}).textContent || '';
                      if (lbl.indexOf(wantVal) < 0) failed.push('下拉按钮上的文字没有跟着换：' + lbl);
                      fontSel.value = '';
                      fontSel.dispatchEvent(new Event('change', { bubbles: true }));
                      await sleep(800);
                    }
                  }
                }
                // 点按钮开、再点一次应当收起（不要把面板点没又点不出来）
                cbtn.click();
                await sleep(200);
                const opened2 = isOpen();
                cbtn.click();
                await sleep(200);
                log.push({ step: 'csel-toggle', opened: opened2, closed: !isOpen() });
                if (!opened2) failed.push('第二次点字体下拉打不开了');
                if (isOpen()) failed.push('再点一次下拉没有收起');
              }
            }
          }

          // —— 9. 归档配置下拉：默认指向当前那份，条目数对得上
          const pick = document.getElementById('profilePick');
          if (!pick) failed.push('仓库标题右边没有归档配置下拉');
          else {
            const pickOpts = Array.from(pick.options).filter((o) => o.value && !o.disabled && o.value.indexOf('__') !== 0);
            const allProfiles = window.__state.cfg.profiles || [];
            const archived = allProfiles.filter((p) => !p.draft);
            log.push({
              step: 'profile-pick',
              value: pick.value,
              active: window.__state.cfg.activeProfileId,
              opts: pickOpts.map((o) => o.textContent)
            });
            const activeProf = allProfiles.find((p) => p.id === window.__state.cfg.activeProfileId) || {};
            eq(pick.value, activeProf.draft ? '__draft__' : window.__state.cfg.activeProfileId, '归档配置下拉没有默认选中当前生效的那份');
            eq(pickOpts.length, archived.length, '归档配置下拉的条目数和「已归档」配置数对不上');
            const draftIds = allProfiles.filter((p) => p.draft).map((p) => p.id);
            if (pickOpts.some((o) => draftIds.indexOf(o.value) >= 0)) {
              failed.push('归档配置下拉里混进了草稿（没填仓库的空落点）');
            }
            // 分隔线由样式画（.csel-opt.is-action），不再往列表里塞 ────── 假选项：
            // 那种假选项既丑、又多占一次键盘上下键
            const texts = Array.from(pick.options).map((o) => o.textContent);
            if (texts.some((t) => /─{3,}|—{3,}/.test(t))) {
              failed.push('归档配置下拉里还有「──────」式的假分隔项');
            }
            const newOpt = Array.from(pick.options).find((o) => o.value === '__new__');
            if (!newOpt) failed.push('归档配置下拉里没有「新建」入口');
            else if (newOpt.dataset.kind !== 'action') {
              failed.push('「新建」入口没有标成 action（样式画不出那条分隔线）：' + newOpt.dataset.kind);
            }
            // 面板里也得真的落成 is-action（分组/说明/动作三种身份各归各位）
            {
              const btn = pick.closest('.csel') && pick.closest('.csel').querySelector('.csel-btn');
              if (btn) {
                btn.click();
                await sleep(220);
                const panel = document.querySelector('.csel-panel');
                const act = panel && panel.querySelector('.csel-opt.is-action');
                const note = panel && panel.querySelector('.csel-opt.is-note');
                log.push({ step: 'pick-panel', action: !!act, note: !!note, opts: panel ? panel.querySelectorAll('.csel-opt').length : 0 });
                if (!act) failed.push('下拉面板里没把「新建」渲染成底部动作行');
                if (act && (act.textContent || '').indexOf('新建') < 0) failed.push('底部动作行不是「新建」那条：' + act.textContent);
                document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                await sleep(150);
                if (document.querySelector('.csel-panel')) failed.push('点面板外面没有收起归档配置下拉');
              }
            }
          }

          // —— 10. 平台图层：切平台时块上要挂滑动动画类，且左边色条跟着换
          {
            const pane = document.getElementById('repoPane');
            if (!pane) failed.push('仓库模块里没有平台图层 #repoPane');
            else {
              eq(pane.dataset.platform, 'github', '平台图层初始色条不是 GitHub');
              document.querySelector('#cfgPlatform button[data-platform="cnb"]').click();
              await sleep(120);
              const midCls = pane.className;
              await sleep(2000);
              log.push({ step: 'slide-cnb', midCls: midCls, endPlatform: pane.dataset.platform, badge: (document.getElementById('platBadgeText') || {}).textContent });
              if (!/slide-out-left|slide-in-right/.test(midCls)) failed.push('切到 CNB 时平台图层没有滑动动画');
              eq(pane.dataset.platform, 'cnb', '平台图层的色条没有跟着切到 CNB');
              // 平台胶囊必须是一颗完整的胶囊：被别的同名样式压成 22px 方块的话，内容会被裁掉
              const badgeEl = document.getElementById('platBadge');
              const badgeBox = badgeEl.getBoundingClientRect();
              log.push({ step: 'plat-badge', w: Math.round(badgeBox.width), h: Math.round(badgeBox.height), scrollW: badgeEl.scrollWidth, clientW: badgeEl.clientWidth });
              if (badgeEl.scrollWidth > badgeEl.clientWidth + 1) {
                failed.push('平台胶囊内容被裁掉了（' + badgeEl.scrollWidth + ' > ' + badgeEl.clientWidth + '），样式可能撞名');
              }
              // 左边那条主题色竖条也要跟着换成 CNB 色
              const bar = getComputedStyle(pane, '::before').backgroundColor;
              const cnbColor = getComputedStyle(pane).getPropertyValue('--plat-cnb').trim();
              log.push({ step: 'plat-bar', bar: bar, cnbColor: cnbColor });
              if (!bar || bar === 'rgba(0, 0, 0, 0)') failed.push('平台图层左侧色条没渲染出来');

              // —— 10b. 平台图标必须是品牌 SVG，不是字母方块
              const segIcons = Array.from(document.querySelectorAll('#cfgPlatform button .brand-ico'));
              const badgeIco = document.querySelector('#platBadgeIcon .brand-ico');
              const brandApi = window.CPBrand && window.CPBrand.brandIcon;
              log.push({
                step: 'brand-icons',
                segIcons: segIcons.length,
                badgeIco: !!badgeIco,
                badgePath: badgeIco ? (badgeIco.querySelector('path') ? badgeIco.querySelector('path').getAttribute('d').slice(0, 24) : '') : '',
                hasApi: typeof brandApi === 'function'
              });
              if (segIcons.length < 2) failed.push('平台切换按钮上没有品牌 SVG 图标：' + segIcons.length);
              if (!badgeIco) failed.push('仓库标题右边的平台胶囊里没有品牌 SVG 图标');
              if (!badgeIco || !badgeIco.querySelector('path')) failed.push('平台图标 SVG 里没有 path（图标是空的）');
              // 字母方块时代的遗留：图标位里不该再出现两三个大写字母
              const badgeTxt = (document.querySelector('#platBadgeIcon') || {}).textContent || '';
              if (/^[A-Z]{2}$/.test(badgeTxt.trim())) failed.push('平台图标还是字母方块：' + badgeTxt);
              if (typeof brandApi === 'function') {
                const gh = brandApi('github', 15);
                const ge = brandApi('cnb', 15);
                if (!/viewBox="0 0 24 24"/.test(gh) || !/<path d="M/.test(gh)) failed.push('品牌图标生成器没有吐出合法 SVG');
                if (gh === ge) failed.push('GitHub 与 CNB 的品牌图标一模一样');
              } else {
                failed.push('没有暴露 window.CPBrand.brandIcon');
              }
              // 新手向导里的平台卡片（用户最先看到的那两个图标）也必须是品牌 SVG
              const ob = window.CPOnboard;
              if (!ob || typeof ob.open !== 'function') failed.push('没有暴露 window.CPOnboard，无法验证向导图标');
              else {
                ob.open();
                await sleep(600);
                const cards = document.querySelectorAll('#onboardWrap .plat-card[data-platform]');
                const marks = document.querySelectorAll('#onboardWrap .plat-card .plat-mark .brand-ico');
                const legacyBadge = document.querySelectorAll('#onboardWrap .plat-card .plat-badge');
                const marksBox = document.querySelector('#onboardWrap .plat-card .plat-mark');
                const mb = marksBox ? marksBox.getBoundingClientRect() : null;
                log.push({
                  step: 'brand-onboard',
                  cards: cards.length,
                  marks: marks.length,
                  legacy: legacyBadge.length,
                  markSize: mb ? Math.round(mb.width) + 'x' + Math.round(mb.height) : ''
                });
                if (!cards.length) failed.push('新手向导第一步没有平台卡片');
                if (marks.length < 2) failed.push('向导平台卡片上的品牌 SVG 图标缺失：' + marks.length);
                if (legacyBadge.length) failed.push('向导里还留着字母方块 .plat-badge：' + legacyBadge.length);
                if (mb && Math.round(mb.width) < 20) failed.push('向导平台图标被压扁了：' + Math.round(mb.width) + 'px');
                ob.close();
                await sleep(300);
                if (ob.isOpen()) failed.push('向导关不掉，会挡住后面的步骤');
              }
              document.querySelector('#cfgPlatform button[data-platform="github"]').click();
              await sleep(2200);
              eq(pane.dataset.platform, 'github', '平台图层的色条没有切回 GitHub');
            }
          }

          // —— 11. 可用性体检（导入配置后的引导就靠它）
          {
            const chk = await window.cloudpic.profile.check({ id: baseProf.id });
            log.push({
              step: 'profile-check',
              ok: chk && chk.ok,
              local: chk && chk.local && { ok: chk.local.ok, code: chk.local.code, msg: chk.local.message },
              cloud: chk && chk.cloud && { ok: chk.cloud.ok, code: chk.cloud.code, msg: chk.cloud.message }
            });
            if (!chk || !chk.local || !chk.cloud) failed.push('可用性体检没有返回本地/云端两块结果');
            else {
              if (!chk.local.ok) failed.push('可用性体检误判本地目录不可用：' + chk.local.message);
              if (!chk.cloud.ok) failed.push('可用性体检误判云端仓库不可达：' + chk.cloud.message);
            }
            // 本地目录不存在时，必须说清楚「去哪儿改」
            await window.__state.newProfile({ platform: MOCK_PLATFORM });
            await window.__state.patch({
              owner: MOCK_OWNER, repo: MOCK_REPO, apiBase: MOCK_API,
              localDir: 'D:/__no_such_dir__/__nope__', token: 'ghp_fake_token_for_test_0001'
            });
            await sleep(700);
            const badId = window.__state.cfg.activeProfileId;
            const badChk = await window.cloudpic.profile.check({ id: badId });
            log.push({
              step: 'profile-check-bad',
              local: badChk && badChk.local && { ok: badChk.local.ok, code: badChk.local.code, fix: badChk.local.fix }
            });
            if (!badChk || !badChk.local || badChk.local.ok) failed.push('本地目录不存在时体检居然判为可用');
            else if (!badChk.local.fix) failed.push('本地目录不可用时没有给出修改引导文案');
            await window.__state.removeProfile(badId);
            await window.__state.activateProfile(baseProf.id);
            await sleep(900);
          }

          // —— 12. 上传页目标目录：能列出现有云端目录并写回
          document.querySelector('.nav-item[data-page="upload"]').click();
          await sleep(900);
          {
            const dirInput = document.getElementById('upDir');
            const pickBtn = document.getElementById('btnUpDirPick');
            if (!pickBtn) failed.push('上传页目标目录没有「浏览云端…」按钮');
            else {
              pickBtn.click();
              await sleep(2200);
              const crumbs = document.getElementById('dpCrumbs');
              const rows = document.querySelectorAll('#dpBody .dir-row');
              log.push({
                step: 'dir-picker',
                crumbs: crumbs ? crumbs.innerText : '',
                rows: rows.length,
                first: rows[0] ? rows[0].dataset.dir : '',
                msg: (document.getElementById('dpMsg') || {}).textContent
              });
              if (!crumbs) failed.push('目录选择器没有渲染面包屑');
              if (!rows.length) failed.push('目录选择器没有列出任何云端目录');
              else {
                const firstDir = rows[0].dataset.dir;
                rows[0].click();
                await sleep(1800);
                const use = document.getElementById('dpUse');
                if (use) use.click();
                await sleep(700);
                log.push({ step: 'dir-picker-pick', input: dirInput ? dirInput.value : '' });
                eq(dirInput ? dirInput.value : '', firstDir, '从目录选择器选中的路径没有写回目标目录');
              }
            }
          }
          document.querySelector('.nav-item[data-page="settings"]').click();
          await sleep(700);

          // —— 13. 压缩尺寸默认不设限 + 帮助文本；仓库设置的说明文字与右侧归档下拉的间距
          document.querySelector('.nav-item[data-page="settings"]').click();
          await sleep(900);
          {
            // 13.1 新建一份配置，看「最大宽/高」的默认值 —— 必须是不限制
            await window.__state.newProfile({ platform: MOCK_PLATFORM });
            await sleep(700);
            const freshId = window.__state.cfg.activeProfileId;
            const freshCmp = window.__state.cfg.compress || {};
            log.push({ step: 'compress-default', maxWidth: freshCmp.maxWidth, maxHeight: freshCmp.maxHeight });
            if (Number(freshCmp.maxWidth || 0) !== 0) {
              failed.push('新配置的「最大宽度」默认不是 0（依然在替用户预先限死尺寸）：' + freshCmp.maxWidth);
            }
            if (Number(freshCmp.maxHeight || 0) !== 0) {
              failed.push('新配置的「最大高度」默认不是 0（依然在替用户预先限死尺寸）：' + freshCmp.maxHeight);
            }
            await window.__state.removeProfile(freshId);
            await window.__state.activateProfile(baseProf.id);
            await sleep(900);

            // 13.2 输入框本身要允许 0，并且下面有帮助文本讲清楚
            const mw2 = document.getElementById('cfgMaxWidth');
            const mh2 = document.getElementById('cfgMaxHeight');
            if (!mw2 || !mh2) failed.push('压缩设置里没有最大宽度 / 最大高度输入框');
            else {
              log.push({ step: 'compress-ui', minW: mw2.min, phW: mw2.placeholder, minH: mh2.min, phH: mh2.placeholder });
              if (mw2.min !== '0' || mh2.min !== '0') failed.push('最大宽度 / 高度不允许填 0');
              if (mw2.placeholder !== '0' || mh2.placeholder !== '0') failed.push('最大宽度 / 高度的占位提示不是 0');
              const lblTxt = (mw2.closest('.field') || {}).textContent || '';
              if (!/0\\s*=\\s*不限制/.test(lblTxt)) failed.push('「最大宽度」标签没写「0 = 不限制」：' + lblTxt);
              const help = mw2.closest('.field').parentNode.querySelector('.field-help');
              const helpTxt = help ? help.textContent : '';
              log.push({ step: 'compress-help', has: !!help, txt: helpTxt.replace(/\\s+/g, ' ').trim().slice(0, 72) });
              if (!help) failed.push('压缩尺寸下面没有帮助文本');
              else if (!/不改动图片原始尺寸/.test(helpTxt)) failed.push('帮助文本没讲清「留 0 就不改动原始尺寸」');
              else if (!/4000×3000/.test(helpTxt)) failed.push('帮助文本没给具体的缩放例子');
              // 两个都填 0（也就是不限制）时，保存后配置里不该被塞回某个数字
              mw2.value = '0';
              mh2.value = '0';
              mw2.dispatchEvent(new Event('change', { bubbles: true }));
              mh2.dispatchEvent(new Event('change', { bubbles: true }));
              const saveBtn = document.getElementById('btnSave');
              if (saveBtn) saveBtn.click();
              await sleep(1600);
              const savedCmp = window.__state.cfg.compress || {};
              log.push({ step: 'compress-persist', maxWidth: savedCmp.maxWidth, maxHeight: savedCmp.maxHeight });
              if (Number(savedCmp.maxWidth || 0) !== 0 || Number(savedCmp.maxHeight || 0) !== 0) {
                failed.push('把宽高都填 0 之后配置里还是被塞了数字：' + savedCmp.maxWidth + '×' + savedCmp.maxHeight);
              }
            }

            // 13.3 仓库设置：左侧那段说明文字不能贴到右侧「归档配置」上
            const headMain = document.querySelector('.repo-module .card-head .head-main');
            const headTools = document.querySelector('.repo-module .card-head .head-tools');
            const headP = document.querySelector('.repo-module .card-head .head-main p');
            if (!headMain || !headTools) failed.push('仓库模块标题区缺 .head-main / .head-tools（说明文字和归档配置挤在一起了）');
            else {
              const a = (headP || headMain).getBoundingClientRect();
              const b = headTools.getBoundingClientRect();
              const sameRow = b.top < a.bottom && a.top < b.bottom;
              const gap = sameRow ? b.left - a.right : NaN;
              log.push({
                step: 'repo-spacing',
                sameRow: sameRow,
                gap: Number.isFinite(gap) ? Math.round(gap) : null,
                mainW: Math.round(headMain.getBoundingClientRect().width),
                maxW: getComputedStyle(headMain).maxWidth,
                toolsW: Math.round(b.width)
              });
              if (sameRow && gap < 16) failed.push('仓库设置的说明文字离右侧归档配置太近：' + Math.round(gap) + 'px');
              if (sameRow && Math.round(headMain.getBoundingClientRect().width) < 200) {
                failed.push('说明文字那一栏被压得太窄了：' + Math.round(headMain.getBoundingClientRect().width) + 'px');
              }
            }
          }

          // —— 14. 署名：关于页归小杰（品牌作者），上传提交归 youngdajie（GitHub 账号）
          //      应用提交文件时用的 user.name 绝不能是「JIE」，否则仓库贡献者列表会多出一个 JIE
          {
            const info = window.__state.info || {};
            log.push({
              step: 'attribution',
              aboutAuthor: info.author,
              gitAuthor: info.gitAuthor,
              gitAuthorEmail: info.gitAuthorEmail
            });
            if (info.author !== '小杰') failed.push('关于页作者应该是「小杰」，实际是：' + info.author);
            if (info.gitAuthor !== 'youngdajie') failed.push('应用提交身份不是 youngdajie：' + info.gitAuthor);
            if (/jie/i.test(String(info.gitAuthor)) && info.gitAuthor !== 'youngdajie') {
              failed.push('应用提交身份里还带着 JIE：' + info.gitAuthor);
            }
            document.querySelector('.nav-item[data-page="about"]').click();
            await sleep(700);
            const wrap = document.getElementById('aboutWrap');
            const heroTxt = wrap && wrap.querySelector('.author') ? wrap.querySelector('.author').innerText : '';
            log.push({ step: 'attribution-about', hero: heroTxt });
            if (heroTxt.indexOf('小杰') < 0) failed.push('关于页没有「小杰」署名：' + heroTxt);
            document.querySelector('.nav-item[data-page="settings"]').click();
            await sleep(500);
          }

          // —— 15. 界面字体：下拉里必须是「本机真装了的字体」，而不是程序内置的候选表
          //      用户装了霞鹜文楷却在下拉里找不到，就是因为以前只列候选表、从不问系统
          {
            const ap = window.__appearance;
            const sel = document.getElementById('cfgFont');
            const real = await window.cloudpic.app.fonts();
            const lower = new Set((real || []).map((x) => String(x).toLowerCase()));
            const values = sel
              ? Array.from(sel.options).filter((o) => !o.disabled && o.value).map((o) => o.value)
              : [];
            const stray = values.filter((v) => !lower.has(v.toLowerCase()));
            log.push({
              step: 'font-list',
              realCount: (real || []).length,
              options: values.length,
              groups: ap ? ap.installedFontGroups().map((g) => g.group + ':' + g.fonts.length) : [],
              first: sel && sel.options[0] ? sel.options[0].textContent : '',
              stack: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
              sample: values.slice(0, 6),
              lxgw: values.filter((v) => /霞鹜文楷|LXGW WenKai/i.test(v))
            });
            if (!(real || []).length) failed.push('app:fonts 没返回本机字体清单');
            if (ap && !ap.hasRealFontList()) failed.push('渲染层没拿到本机字体清单，下拉退回候选表了');
            if (values.length < 20) failed.push('字体下拉只有 ' + values.length + ' 项，不像本机字体清单');
            if (stray.length) failed.push('字体下拉里有本机并不存在的字体：' + stray.slice(0, 5).join('、'));
            // 主字体必须排在本机字栈最前（装了就用它，没装自然落到下一个）
            const top = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
            if (!/霞鹜文楷|LXGW WenKai/i.test(top.split(',')[0] || '')) {
              failed.push('本机字栈的第一顺位不是霞鹜文楷：' + top.slice(0, 60));
            }
          }

          // —— 收尾：删掉测试造出来的配置，只留指向假 API 的那份，保证下次跑还准
          await window.__state.activateProfile(baseProf.id);
          await sleep(1200);
          let cleaned = 0;
          for (const p of (window.__state.cfg.profiles || []).slice()) {
            if (p.id === baseProf.id) continue;
            await window.__state.removeProfile(p.id);
            cleaned += 1;
          }
          await window.__state.activateProfile(baseProf.id);
          // 水印色也还原成默认，别让测试值留在配置里
          await window.__state.patch({
            watermark: { color: '#1296db' },
            lastUploadDir: '',
            ui: { theme: 'dark', font: '' }
          });
          await sleep(800);
          log.push({
            step: 'teardown',
            cleaned: cleaned,
            left: (window.__state.cfg.profiles || []).map((p) => p.label + '@' + p.platform),
            wmColor: val('cfgWmColor'),
            theme: document.documentElement.dataset.theme,
            font: (window.__state.cfg.ui || {}).font
          });

          return { log, failed };
        })()`);
        console.log('UITEST ' + JSON.stringify(out, null, 2));
        if (out && out.error) errors.push('uitest: ' + out.error);
        for (const f of (out && out.failed) || []) errors.push('uitest assert: ' + f);
      } catch (e) {
        errors.push('uitest failed: ' + e.message);
        console.log('UITEST_FAILED ' + (e.stack || e.message));
      }
    }

    if (process.argv.includes('--shots')) {
      const dir = path.join(projectRoot(), '.shots');
      fs.mkdirSync(dir, { recursive: true });

      /**
       * 给某个元素拍一张「特写」：先放大页面渲染倍率，再滚到该元素居中，然后整面截图。
       * 不用 capturePage(rect) —— 这个 Chromium 版本裁出来的是一张空表面（全黑），
       * 而且不报错，很容易误以为成功了。整面捕获 + 缩放是可靠的。
       */
      const shotZoom = async (name, selector, zoom) => {
        const z = Number(zoom) || 2.5;
        try {
          wc.setZoomFactor(z);
          await new Promise((r) => setTimeout(r, 450));
          await wc.executeJavaScript(`(function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if (el) el.scrollIntoView({ block: 'center' });
          })()`);
          // 缩放过场 + 平滑滚动都要落定，否则框可能还在半路上
          await new Promise((r) => setTimeout(r, 700));
          const img = await wc.capturePage();
          fs.writeFileSync(path.join(dir, name), img.toPNG());
          console.log('SHOT ' + name + ' zoom=' + z);
          return true;
        } catch (e) {
          console.log('SHOT ' + name + ' skipped: ' + e.message);
          return false;
        } finally {
          try {
            wc.setZoomFactor(1);
          } catch (e2) {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 350));
        }
      };

      const pages = ['upload', 'manage', 'settings', 'about'];
      for (const p of pages) {
        try {
          await wc.executeJavaScript(
            `document.querySelector('.nav-item[data-page="${p}"]').click(); document.getElementById('content').scrollTop = 0;`
          );
          await new Promise((r) => setTimeout(r, p === 'manage' ? 2600 : 1000));
          const img = await wc.capturePage();
          fs.writeFileSync(path.join(dir, p + '.png'), img.toPNG());
          console.log('SHOT ' + p);
        } catch (e) {
          errors.push('shot ' + p + ' failed: ' + e.message);
        }
      }
      // 再钻三层到图片目录，验证缩略图与本地文件直出
      let dive; // 提到 try 外面：下面「图标总览 / 列表视图」的截图段也要用它
      try {
        dive = async (target, name) => {
          const went = await wc.executeJavaScript(
            `(async function(){
               var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
               var sel = ${JSON.stringify(target)};
               for (var i = 0; i < 40; i++) {
                 var t = document.querySelector(sel);
                 if (t) { t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return t.dataset.path; }
                 await sleep(150);
               }
               return null;
             })()`
          );
          await new Promise((r) => setTimeout(r, 2200));
          const img = await wc.capturePage();
          fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
          console.log('SHOT ' + name + ' -> ' + JSON.stringify(went));
        };
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="manage"]').click();`);
        await new Promise((r) => setTimeout(r, 2600));
        await dive('#mgGrid .tile[data-path="images"]', 'manage-images');
        await dive('#mgGrid .tile[data-type="dir"]', 'manage-2026');
        await dive('#mgGrid .tile[data-type="dir"]', 'manage-photos');
      } catch (e) {
        errors.push('shot manage dive failed: ' + e.message);
      }

      // 图标总览 + 列表视图：进 demo-files（每种类型一个文件）截图，验证新图标系统与列表布局
      try {
        await wc.reload();
        await new Promise((r) => setTimeout(r, 2600));
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="manage"]').click();`);
        await new Promise((r) => setTimeout(r, 2600));
        // 自己把浏览源切到「本地目录」。不能指望上一步（--fstest）留下的状态：
        // 单独跑 --shots 时源会停在云端，demo-files 根本不在云端列表里，dive 必然落空。
        const srcLocal = await wc.executeJavaScript(
          `(function(){
             var b = document.querySelector('#sourceSeg button[data-source="local"]');
             if (!b || b.classList.contains('active')) return false;
             b.click();
             return true;
           })()`
        );
        if (srcLocal) await new Promise((r) => setTimeout(r, 2200));
        await dive('#mgGrid .tile[data-path="demo-files"]', 'manage-icons');
        await wc.executeJavaScript(`document.getElementById('btnMgList').click();`);
        await new Promise((r) => setTimeout(r, 900));
        const imgList = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'manage-list.png'), imgList.toPNG());
        console.log('SHOT manage-list');
        // 表头点一下"修改时间"排序，再截一张，验证排序箭头
        await wc.executeJavaScript(`document.querySelector('#mgListHead [data-sort="mtime"]').click();`);
        await new Promise((r) => setTimeout(r, 900));
        const imgSort = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'manage-list-sort.png'), imgSort.toPNG());
        console.log('SHOT manage-list-sort');
        await wc.executeJavaScript(`document.getElementById('btnMgGrid').click();`);
      } catch (e) {
        errors.push('shot icons/list failed: ' + e.message);
      }

      // 打开「重命名 / 移动」弹层，验证云端改文件的入口
      try {
        const opened = await wc.executeJavaScript(
          `(async function(){
             var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
             for (var i = 0; i < 50; i++) {
               var t = document.querySelector('#mgGrid .tile[data-type="file"]');
               if (t) {
                 var cb = t.querySelector('.tile-check');
                 if (cb) cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                 document.getElementById('btnMgRename').click();
                 await sleep(500);
                 return document.querySelectorAll('.modal-foot .btn').length;
               }
               await sleep(150);
             }
             return -1;
           })()`
        );
        console.log('SHOT_RENAME_BUTTONS ' + opened);
        const img3 = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'manage-rename.png'), img3.toPNG());
        console.log('SHOT manage-rename');
        if (opened > 0) {
          // 顺手把路径选择器也拍下来：这是「重命名 / 移动」里最值得看的一屏
          const panel = await wc.executeJavaScript(
            `(async function(){
               var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
               var b = document.getElementById('mgDirPickBtn');
               if (!b) return { ok: false, why: (document.getElementById('mgDirLocalTxt') || {}).innerText || '' };
               b.click();
               for (var i = 0; i < 30; i++) {
                 if (document.querySelector('.dirpick-list')) break;
                 await sleep(120);
               }
               return {
                 ok: !!document.querySelector('.dirpick'),
                 rows: document.querySelectorAll('.dirpick-row').length,
                 crumb: (document.querySelector('.dirpick-crumb') || {}).innerText || ''
               };
             })()`
          );
          console.log('SHOT_DIRPICK ' + JSON.stringify(panel));
          const imgPick = await wc.capturePage();
          fs.writeFileSync(path.join(dir, 'manage-dirpick.png'), imgPick.toPNG());
          console.log('SHOT manage-dirpick');
          await wc.executeJavaScript(`document.querySelectorAll('.modal-foot .btn')[0].click();`);
        } else {
          errors.push('rename 弹层没打开，按钮数=' + opened);
        }
      } catch (e) {
        errors.push('shot manage-rename failed: ' + e.message);
      }

      // 设置页细节：代理 URL / 压缩格式（AVIF 默认）/ 质量滑块 / 自绘下拉展开
      try {
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="settings"]').click();`);
        await new Promise((r) => setTimeout(r, 1200));
        await wc.executeJavaScript(`document.getElementById('cfgProxyUrl').scrollIntoView({ block: 'center' });`);
        await new Promise((r) => setTimeout(r, 700));
        const imgProxy = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-proxy.png'), imgProxy.toPNG());
        console.log('SHOT settings-proxy');

        await wc.executeJavaScript(`document.getElementById('cfgFormat').scrollIntoView({ block: 'center' });`);
        await new Promise((r) => setTimeout(r, 700));
        const imgComp = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-compress.png'), imgComp.toPNG());
        console.log('SHOT settings-compress');

        // 展开自绘下拉：验证 AVIF 置顶、且原生 select 已被接管
        await wc.executeJavaScript(
          `document.getElementById('cfgFormat').closest('.csel').querySelector('.csel-btn').click();`
        );
        await new Promise((r) => setTimeout(r, 700));
        const imgFmt = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-format.png'), imgFmt.toPNG());
        console.log('SHOT settings-format');
        await wc.executeJavaScript(`document.body.click();`);
        await new Promise((r) => setTimeout(r, 400));
      } catch (e) {
        errors.push('shot settings detail failed: ' + e.message);
      }

      // 归档配置列表 / 数字步进器 / 水印颜色
      try {
        await wc.reload();
        await new Promise((r) => setTimeout(r, 2600));
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="settings"]').click();`);
        await new Promise((r) => setTimeout(r, 1400));

        // 临时造一份 CNB 配置，让归档列表同时有「已归档」和「待验证」两种状态可看
        const madeTmp = await wc.executeJavaScript(
          `(async function(){
             var before = (window.__state.cfg.profiles||[]).map(function(p){ return p.id; });
             await window.__state.newProfile({ platform: 'cnb' });
             await window.__state.patch({
               platform: 'cnb', owner: 'yangjie-site', repo: 'cdn-files',
               localDir: 'D:/web/cdn-files', token: 'cnb_fake_token_0001'
             });
             var after = (window.__state.cfg.profiles||[]);
             var add = after.filter(function(p){ return before.indexOf(p.id) < 0; })[0];
             return add ? add.id : '';
           })()`
        );
        await new Promise((r) => setTimeout(r, 1400));
        await wc.executeJavaScript(`document.getElementById('profileList').scrollIntoView({ block: 'center' });`);
        await new Promise((r) => setTimeout(r, 800));
        const imgProf = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-profiles.png'), imgProf.toPNG());
        console.log('SHOT settings-profiles -> ' + madeTmp);

        // 归档配置下拉展开的样子：看「新建」那条是不是被一条细线分出来的，
        // 而不是靠往列表里塞一行 ──────（那种假分隔线在配置名里很突兀）
        // 先把触发按钮滚进视野 —— 面板是 fixed 定位、按按钮位置摆放，
        // 按钮在视口外时面板会跟着画到屏幕外，截出来什么都没有
        await wc.executeJavaScript(
          `document.getElementById('profilePick').scrollIntoView({ block: 'center' });`
        );
        await new Promise((r) => setTimeout(r, 600));
        await wc.executeJavaScript(
          `document.querySelector('#profilePick').closest('.csel').querySelector('.csel-btn').click();`
        );
        await new Promise((r) => setTimeout(r, 800));
        const imgPick = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-profile-pick.png'), imgPick.toPNG());
        console.log('SHOT settings-profile-pick');
        await wc.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));`);
        await new Promise((r) => setTimeout(r, 400));

        // 数字步进器：聚焦数字框，让自绘的上下按钮淡入。
        // 宽/高默认都是 0（= 不限制），上/下按钮会双双贴到 min 变成禁用态，
        // 截出来灰扑扑看不出样式 —— 先点一下「+」把值抬起来再拍。
        await wc.executeJavaScript(
          `document.getElementById('cfgMaxHeight').scrollIntoView({ block: 'center' }); document.getElementById('cfgMaxHeight').focus();`
        );
        await new Promise((r) => setTimeout(r, 500));
        await wc.executeJavaScript(
          `(function(){ var n=document.getElementById('cfgMaxHeight').closest('.numfield');` +
            ` var b=n && n.querySelector('.nf-btn[data-step="up"]'); if(b) b.click(); })()`
        );
        await new Promise((r) => setTimeout(r, 800));
        const imgNum = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-numfield.png'), imgNum.toPNG());
        console.log('SHOT settings-numfield');

        // 再来一张特写：放大渲染倍率后只拍那个数字框附近
        await shotZoom('settings-numfield-zoom.png', '#cfgMaxHeight', 2.5);

        // 水印颜色
        await wc.executeJavaScript(`document.getElementById('wmSwatch').scrollIntoView({ block: 'center' });`);
        await new Promise((r) => setTimeout(r, 800));
        const imgWm = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-wmcolor.png'), imgWm.toPNG());
        console.log('SHOT settings-wmcolor');

        // 水印配色行特写
        await shotZoom('settings-wmcolor-zoom.png', '.wm-color', 2.5);

        // 自绘取色盘：先调好缩放再滚动 + 打开 —— 浮层是 fixed 定位，
        // 缩放会顺带改变滚动位置并触发 scroll，顺序反了浮层会被关掉/摆到屏幕外。
        const openWmPicker = async () => {
          await wc.executeJavaScript(`document.getElementById('wmSwatch').scrollIntoView({ block: 'center' });`);
          await new Promise((r) => setTimeout(r, 700));
          await wc.executeJavaScript(`document.getElementById('wmSwatch').click();`);
          await new Promise((r) => setTimeout(r, 700));
          return await wc.executeJavaScript(`!!document.querySelector('.cp-pop')`);
        };
        wc.setZoomFactor(2.2);
        await new Promise((r) => setTimeout(r, 900));
        let cpOpen = await openWmPicker();
        if (!cpOpen) cpOpen = await openWmPicker(); // 缩放后的余波滚动可能刚把面板收掉，再来一次
        const imgCpz = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-colorpicker-zoom.png'), imgCpz.toPNG());
        console.log('SHOT settings-colorpicker-zoom.png zoom=2.2 open=' + cpOpen);
        await wc.executeJavaScript(`document.getElementById('wmSwatch').click();`);
        await new Promise((r) => setTimeout(r, 400));
        wc.setZoomFactor(1);
        await new Promise((r) => setTimeout(r, 900));

        // 再拍一张正常倍率的（整块设置页 + 浮层）
        const cpOpen2 = await openWmPicker();
        const imgCp = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-colorpicker.png'), imgCp.toPNG());
        console.log('SHOT settings-colorpicker open=' + cpOpen2);
        await wc.executeJavaScript(`document.getElementById('wmSwatch').click();`);
        await new Promise((r) => setTimeout(r, 400));

        // 收尾：删掉临时配置并切回基准配置
        if (madeTmp) {
          await wc.executeJavaScript(`(async function(){
            await window.__state.removeProfile(${JSON.stringify(madeTmp)});
            var base = (window.__state.cfg.profiles||[]).filter(function(p){ return p.verified; })[0];
            if (base) await window.__state.activateProfile(base.id);
          })()`);
          await new Promise((r) => setTimeout(r, 1200));
        }
      } catch (e) {
        errors.push('shot settings profiles failed: ' + e.message);
      }

      // 新版块：仓库大模块（平台图层 + 归档下拉）/ 外观（主题 + 字体）/ 浅色主题 / 云端目录选择器
      try {
        await wc.reload();
        await new Promise((r) => setTimeout(r, 2600));
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="settings"]').click();`);
        await new Promise((r) => setTimeout(r, 1500));

        // 仓库大模块顶部：标题右边的归档下拉 + 三个子模块
        await wc.executeJavaScript(`document.querySelector('.repo-module').scrollIntoView({ block: 'start' });`);
        await new Promise((r) => setTimeout(r, 900));
        const imgRepo = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-repo-module.png'), imgRepo.toPNG());
        console.log('SHOT settings-repo-module');

        // 平台图层特写：左边那条平台主题色 + 平台徽标 + 当前编辑的平台
        await shotZoom('settings-platform-layer-zoom.png', '#platBadge', 2.2);

        // 外观：主题卡片 + 字体下拉 + 字体样本
        await wc.executeJavaScript(`document.getElementById('themeCards').scrollIntoView({ block: 'center' });`);
        await new Promise((r) => setTimeout(r, 900));
        const imgLook = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-appearance.png'), imgLook.toPNG());
        console.log('SHOT settings-appearance');

        // 字体下拉：选项多到 59 条，靠顶部的筛选框输关键字直接跳
        await wc.executeJavaScript(
          `document.getElementById('cfgFont').closest('.csel').querySelector('.csel-btn').click();`
        );
        await new Promise((r) => setTimeout(r, 700));
        await wc.executeJavaScript(
          `(function(){ var f=document.querySelector('.csel-panel .csel-filter');` +
            ` if(f){ f.value='Hei'; f.dispatchEvent(new Event('input',{bubbles:true})); } })()`
        );
        await new Promise((r) => setTimeout(r, 600));
        const imgFont = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-font-filter.png'), imgFont.toPNG());
        console.log('SHOT settings-font-filter');
        await wc.executeJavaScript(
          `(function(){ var b=document.querySelector('.csel-btn.is-open'); if(b) b.click(); })()`
        );
        await new Promise((r) => setTimeout(r, 500));

        // 浅色主题：整页
        await wc.executeJavaScript(`document.querySelector('#themeCards .theme-card[data-theme="light"]').click();`);
        await new Promise((r) => setTimeout(r, 1400));
        await wc.executeJavaScript(`document.getElementById('content').scrollTop = 0;`);
        await new Promise((r) => setTimeout(r, 700));
        const imgLight = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-light.png'), imgLight.toPNG());
        console.log('SHOT settings-light');

        // 浅色 + 仓库模块（平台图层在浅色下的样子）
        await wc.executeJavaScript(`document.querySelector('.repo-module').scrollIntoView({ block: 'start' });`);
        await new Promise((r) => setTimeout(r, 800));
        const imgLightRepo = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'settings-light-repo.png'), imgLightRepo.toPNG());
        console.log('SHOT settings-light-repo');

        // 浅色的上传页
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="upload"]').click();`);
        await new Promise((r) => setTimeout(r, 1100));
        const imgLightUp = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'upload-light.png'), imgLightUp.toPNG());
        console.log('SHOT upload-light');

        // 目标目录：输入框 + 浏览按钮
        await wc.executeJavaScript(`document.getElementById('upOptions').scrollIntoView({ block: 'center' });`);
        await new Promise((r) => setTimeout(r, 700));
        const imgUpDir = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'upload-target-dir.png'), imgUpDir.toPNG());
        console.log('SHOT upload-target-dir');

        // 云端目录选择器
        await wc.executeJavaScript(`document.getElementById('btnUpDirPick').click();`);
        await new Promise((r) => setTimeout(r, 2400));
        const imgPick = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'upload-dir-picker.png'), imgPick.toPNG());
        console.log('SHOT upload-dir-picker');
        await wc.executeJavaScript(`document.body.click();`);
        await new Promise((r) => setTimeout(r, 500));

        // 目录选择器是弹层，body 上点一下关不掉。收掉它，后面几张图才不会被遮罩压暗。
        // 优先点「取消」，走它自己的关闭流程；找不到按钮就直接摘掉弹层兜底。
        await wc.executeJavaScript(`(function(){
          var w = document.getElementById('modalWrap');
          if (!w || w.hidden) return;
          var btns = w.querySelectorAll('.modal-foot button');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].textContent.trim() === '取消') { btns[i].click(); return; }
          }
          w.hidden = true; w.innerHTML = '';
        })()`);
        await new Promise((r) => setTimeout(r, 600));

        // 回深色，别把后面的截图染成浅色
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="settings"]').click();`);
        await new Promise((r) => setTimeout(r, 900));
        await wc.executeJavaScript(`document.querySelector('#themeCards .theme-card[data-theme="dark"]').click();`);
        await new Promise((r) => setTimeout(r, 900));

        // 昼夜按钮的涟漪：正常只播 620ms，照常拍必然拍了个空 —— 临时把时长拉长，
        // 拍它扩散到半路上的样子，拍完把临时样式和类都撤掉
        await wc.executeJavaScript(`(function(){
          var s = document.createElement('style');
          s.id = 'slow-ripple';
          s.textContent = '#btnTheme.ripple::before,#btnTheme.ripple::after{animation-duration:3.2s !important}' +
                          '#btnTheme.ripple svg{animation-duration:2s !important}';
          document.head.appendChild(s);
          document.getElementById('btnTheme').classList.add('ripple');
        })()`);
        await new Promise((r) => setTimeout(r, 700));
        const imgRipple = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'theme-ripple.png'), imgRipple.toPNG());
        console.log('SHOT theme-ripple');
        await wc.executeJavaScript(`(function(){
          var s = document.getElementById('slow-ripple'); if (s) s.remove();
          var b = document.getElementById('btnTheme'); if (b) b.classList.remove('ripple');
        })()`);
      } catch (e) {
        errors.push('shot new-ui failed: ' + e.message);
      }

      // 新手指引（从设置页重新触发）
      try {
        await wc.reload();
        await new Promise((r) => setTimeout(r, 2600));
        await wc.executeJavaScript(
          `document.querySelector('.nav-item[data-page="settings"]').click(); document.getElementById('btnRerunGuide').click();`
        );
        await new Promise((r) => setTimeout(r, 1100));
        const img4 = await wc.capturePage();
        fs.writeFileSync(path.join(dir, 'onboard.png'), img4.toPNG());
        console.log('SHOT onboard');
        // 关掉引导，别让后面的截图被它挡住
        await wc.reload();
        await new Promise((r) => setTimeout(r, 2400));
      } catch (e) {
        errors.push('shot onboard failed: ' + e.message);
      }
    }

    if (process.argv.includes('--bench')) {
      try {
        const r = await wc.executeJavaScript(`(async () => {
          const mod = await import('/js/lib/compress.js');
          const N = 16, W = 2400, H = 1600;
          const blobs = [];
          for (let i = 0; i < N; i++) {
            const c = new OffscreenCanvas(W, H);
            const x = c.getContext('2d');
            const g = x.createLinearGradient(0, 0, W, H);
            g.addColorStop(0, 'hsl(' + (i * 23 % 360) + ',70%,55%)');
            g.addColorStop(1, 'hsl(' + ((i * 23 + 140) % 360) + ',65%,35%)');
            x.fillStyle = g; x.fillRect(0, 0, W, H);
            for (let k = 0; k < 26; k++) {
              x.beginPath();
              x.arc((k * 137 + i * 61) % W, (k * 211 + i * 97) % H, 40 + (k % 7) * 22, 0, Math.PI * 2);
              x.fillStyle = 'rgba(255,255,255,' + (0.06 + (k % 5) * 0.05) + ')';
              x.fill();
            }
            blobs.push(await c.convertToBlob({ type: 'image/png' }));
          }
          const bufs = [];
          let origBytes = 0;
          for (const b of blobs) { const ab = await b.arrayBuffer(); origBytes += ab.byteLength; bufs.push(ab); }
          const threads = mod.defaultThreads();
          const pool = new mod.CompressPool(threads);
          const opts = { quality: 80, maxWidth: 1920, maxHeight: 1920, format: 'auto', targetSizeKB: 0, skipIfSmaller: true, watermark: { enabled: false } };
          const t0 = performance.now();
          const res = await Promise.all(bufs.map((b, i) => pool.run('bench-' + i + '.png', b, opts)));
          const ms = performance.now() - t0;
          let outBytes = 0;
          res.forEach(r => { outBytes += r.buffer.byteLength; });
          return {
            threads, images: N, megapixels: +(N * W * H / 1e6).toFixed(1),
            totalMs: Math.round(ms),
            perImageMs: Math.round(ms / N),
            mpixPerSec: +((N * W * H / 1e6) / (ms / 1000)).toFixed(1),
            origBytes, outBytes,
            ratio: +(outBytes / origBytes).toFixed(3),
            sampleTypes: res.slice(0, 3).map(r => r.type + '@' + r.width + 'x' + r.height)
          };
        })()`);
        console.log('SELFTEST_BENCH ' + JSON.stringify(r, null, 2));
      } catch (e) {
        errors.push('bench failed: ' + e.message);
        console.log('SELFTEST_BENCH_FAILED ' + (e.stack || e.message));
      }
    }

    if (process.argv.includes('--aviftest')) {
      try {
        const r = await wc.executeJavaScript(`(async () => {
          const mod = await import('/js/lib/compress.js');
          async function src(w, h, alpha) {
            const c = new OffscreenCanvas(w, h);
            const x = c.getContext('2d');
            if (!alpha) { x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); }
            const g = x.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, '#3b7ddd');
            g.addColorStop(1, '#12b886');
            x.fillStyle = g; x.fillRect(0, 0, w, h);
            for (let k = 0; k < 18; k++) {
              x.beginPath();
              x.arc((k * 97) % w, (k * 151) % h, 12 + (k % 5) * 9, 0, Math.PI * 2);
              x.fillStyle = 'rgba(255,255,255,.22)'; x.fill();
            }
            if (alpha) {
              x.globalCompositeOperation = 'destination-out';
              x.beginPath();
              x.arc(w / 2, h / 2, Math.min(w, h) / 3.2, 0, Math.PI * 2);
              x.fill();
            }
            return await c.convertToBlob({ type: 'image/png' });
          }
          const A = await src(1200, 800, false);
          const B = await src(900, 900, true);
          const aBuf = await A.arrayBuffer();
          const bBuf = await B.arrayBuffer();
          const pool = new mod.CompressPool(2);
          const base = { quality: 80, maxWidth: 1920, maxHeight: 1920, targetSizeKB: 0, skipIfSmaller: true, watermark: { enabled: false } };
          async function decodeOk(res) {
            try {
              const bm = await createImageBitmap(new Blob([res.buffer], { type: res.type }));
              const o = { ok: bm.width === res.width && bm.height === res.height, w: bm.width, h: bm.height };
              if (bm.close) bm.close();
              return o;
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          }
          const t0 = performance.now();
          const ra = await pool.run('avif-opaque.png', aBuf.slice(0), Object.assign({}, base, { format: 'avif' }));
          const rb = await pool.run('avif-alpha.png', bBuf.slice(0), Object.assign({}, base, { format: 'avif' }));
          const rc = await pool.run('from-avif.avif', bBuf.slice(0), Object.assign({}, base, { format: 'keep' }));
          const ms = Math.round(performance.now() - t0);
          const out = {
            ms: ms,
            opaque: { type: ra.type, ext: ra.ext, size: ra.buffer.byteLength, src: aBuf.byteLength, w: ra.width, h: ra.height, q: ra.quality, decode: await decodeOk(ra) },
            alpha: { type: rb.type, ext: rb.ext, size: rb.buffer.byteLength, src: bBuf.byteLength, w: rb.width, h: rb.height, q: rb.quality, decode: await decodeOk(rb) },
            keepAvif: { type: rc.type, ext: rc.ext, size: rc.buffer.byteLength },
            header: Array.from(new Uint8Array(ra.buffer.slice(0, 16))).map(function (n) { return n.toString(16).padStart(2, '0'); }).join(' ')
          };
          pool.terminate();
          return out;
        })()`);
        console.log('AVIFTEST ' + JSON.stringify(r, null, 2));
      } catch (e) {
        errors.push('aviftest failed: ' + e.message);
        console.log('AVIFTEST_FAILED ' + (e.stack || e.message));
      }
    }

    if (process.argv.includes('--uploadtest')) {
      try {
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="upload"]').click();`);
        await new Promise((r) => setTimeout(r, 700));

        const dropped = await wc.executeJavaScript(`(async () => {
          async function mk(name, w, h, draw) {
            const c = new OffscreenCanvas(w, h);
            const x = c.getContext('2d');
            draw(x, w, h);
            const b = await c.convertToBlob({ type: 'image/png' });
            return new File([b], name, { type: 'image/png' });
          }
          const files = [];
          files.push(await mk('shot-gradient.png', 2400, 1600, (x, w, h) => {
            const g = x.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, '#ff8a3d'); g.addColorStop(1, '#7a2ff0');
            x.fillStyle = g; x.fillRect(0, 0, w, h);
          }));
          files.push(await mk('shot-dots.png', 1800, 1800, (x, w, h) => {
            x.fillStyle = '#12c07a'; x.fillRect(0, 0, w, h);
            for (let i = 0; i < 60; i++) {
              x.beginPath();
              x.arc((i * 97) % w, (i * 173) % h, 30 + (i % 6) * 16, 0, 7);
              x.fillStyle = 'rgba(255,255,255,.42)'; x.fill();
            }
          }));
          files.push(new File([new Blob(['hello from jie-dispatch\\n'])], 'notes.txt', { type: 'text/plain' }));
          const dt = new DataTransfer();
          files.forEach((f) => dt.items.add(f));
          document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          return files.map((f) => f.name + '(' + f.size + ')');
        })()`);
        console.log('UPLOADTEST_DROPPED ' + JSON.stringify(dropped));

        await new Promise((r) => setTimeout(r, 3000));
        const before = await wc.executeJavaScript(`document.getElementById('queueList').innerText.replace(/\\n+/g,' | ')`);
        console.log('UPLOADTEST_QUEUE_BEFORE ' + JSON.stringify(before));

        await wc.executeJavaScript(`document.getElementById('btnUpload').click()`);
        await new Promise((r) => setTimeout(r, 6000));

        const after = await wc.executeJavaScript(`(function(){
          var list = document.getElementById('resultList');
          var rows = [];
          list.querySelectorAll('.r-item').forEach(function(r){
            rows.push({ fail: r.className.indexOf('fail') >= 0, path: (r.querySelector('.r-path')||{}).textContent, link: (r.querySelector('.r-link')||{}).textContent, err: (r.querySelector('.r-err')||{}).textContent });
          });
          return { panelHidden: document.getElementById('resultPanel').hidden, rows: rows };
        })()`);
        console.log('UPLOADTEST_RESULT ' + JSON.stringify(after, null, 2));

        await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="manage"]').click()`);
        await new Promise((r) => setTimeout(r, 2500));
        if (process.argv.includes('--shots')) {
          const dir = path.join(projectRoot(), '.shots');
          fs.mkdirSync(dir, { recursive: true });
          const img3 = await wc.capturePage();
          fs.writeFileSync(path.join(dir, 'after-upload-manage.png'), img3.toPNG());
          await wc.executeJavaScript(`document.querySelector('.nav-item[data-page="upload"]').click();`);
          await new Promise((r) => setTimeout(r, 800));
          const img4 = await wc.capturePage();
          fs.writeFileSync(path.join(dir, 'after-upload-result.png'), img4.toPNG());
          console.log('SHOT after-upload');
        }
      } catch (e) {
        errors.push('uploadtest failed: ' + e.message);
        console.log('UPLOADTEST_FAILED ' + (e.stack || e.message));
      }
    }

    console.log('SELFTEST_ERRORS ' + JSON.stringify(errors, null, 2));
    console.log('SELFTEST_DONE errors=' + errors.length);
    app.exit(errors.length ? 1 : 0);
  }, 3500);
}

function buildMenu() {  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开配置目录', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'PicX 原项目',
          click: () => shell.openExternal('https://github.com/XPoet/picx')
        },
        {
          label: 'GitHub Token 申请',
          click: () => shell.openExternal('https://github.com/settings/tokens/new?scopes=repo&description=JIE-Dispatch')
        },
        {
          label: 'CNB 访问令牌',
          click: () => shell.openExternal('https://cnb.cool/profile/token')
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: '快捷文件分发服务@JIE',
    version: app.getVersion(),
    author: '小杰',
    // 应用往 GitHub / CNB 提交文件时用的署名（见 main/git.js），
    // 必须是账号本人 youngdajie，别让上传的提交挂在「JIE」名下
    gitAuthor: git.COMMIT_IDENTITY.name,
    gitAuthorEmail: git.COMMIT_IDENTITY.email,
    site: 'https://www.yangjie.site',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    configFile: path.join(app.getPath('userData'), 'config.json'),
    serverPort,
    isDev: IS_DEV,
    cpuCount: require('os').cpus().length
  }));

  /**
   * 本机已安装字体的家族名清单（给设置页的「界面字体」下拉用）。
   *
   * 渲染层是 contextBridge 沙箱，碰不到 fs，所以由主进程扫字体目录再回传。
   * fonts.js 内部带缓存，第一次约 200ms，之后是一次数组返回。
   */
  ipcMain.handle('app:fonts', () => fonts.listFamilies());

  ipcMain.handle('config:get', () => store.get());
  ipcMain.handle('config:set', (e, patch) => {
    const next = store.patch(patch || {});
    if (next.localDir) allowRoot(next.localDir);
    return next;
  });
  ipcMain.handle('config:reset', () => store.reset());

  // ---- 归档的仓库配置：新建 / 切换 / 改名 / 删除 / 标记已验证
  ipcMain.handle('profile:new', (e, payload) => store.newProfile(payload || {}));
  ipcMain.handle('profile:activate', (e, payload) => {
    const next = store.activateProfile(String((payload && payload.id) || ''));
    if (next.localDir) allowRoot(next.localDir);
    return next;
  });
  ipcMain.handle('profile:update', (e, payload) => {
    const p = payload || {};
    return store.updateProfile(String(p.id || ''), p.patch || {});
  });
  ipcMain.handle('profile:delete', (e, payload) => {
    const next = store.deleteProfile(String((payload && payload.id) || ''));
    if (next.localDir) allowRoot(next.localDir);
    return next;
  });
  ipcMain.handle('profile:verify', (e, payload) => {
    const p = payload || {};
    return store.verifyProfile(String(p.id || ''), p.info || {});
  });
  // 导出归档配置（含 Token —— 明文写进 JSON，渲染层会先弹确认框；不含本地路径）
  ipcMain.handle('profile:export', async () => {
    const data = store.exportProfiles();
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出归档配置',
      defaultPath: 'Quick-FileDispatch-' + stamp + '.json',
      filters: [{ name: 'JSON 配置', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return {
      ok: true,
      filePath: r.filePath,
      count: data.profiles.length,
      withToken: data.profiles.filter((p) => p.token).length
    };
  });
  // 导入归档配置：读文件 → 合并 → 交给渲染层做可用性体检
  ipcMain.handle('profile:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入归档配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON 配置', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error('不是有效的配置文件：' + e.message);
    }
    // 兼容两种写法：带信封的 {profiles:[...]} 和裸数组
    const payload = Array.isArray(parsed) ? { profiles: parsed } : parsed;
    if (!payload || !Array.isArray(payload.profiles)) {
      throw new Error('配置文件里没有 profiles 列表');
    }
    // 老版本的 kind 是 jie-dispatch-profiles，一并认，免得以前导出的文件导不回来
    const KINDS = ['Quick-FileDispatch', 'jie-dispatch-profiles'];
    if (payload.kind && KINDS.indexOf(payload.kind) < 0) {
      throw new Error('这不像本程序导出的配置（kind=' + payload.kind + '）');
    }
    const res = store.importProfiles(payload);
    return Object.assign({ ok: true, filePath: file }, res);
  });

  /**
   * 单份配置的可用性体检：本地目录 + 云端仓库各查一遍。
   * 导入之后靠它告诉用户「哪一块不可用、该去哪里改」，而不是丢一句「导入失败」。
   */
  ipcMain.handle('profile:check', async (e, payload) => {
    const id = String((payload && payload.id) || '');
    const p = store.profileById(id);
    if (!p) return { ok: false, missing: true, error: '配置不存在，可能已被删除' };

    const out = {
      ok: true,
      id: id,
      label: p.name || [p.owner, p.repo].filter(Boolean).join('/') || '未命名配置',
      platform: p.platform || 'github',
      local: { ok: false, code: 'missing', message: '没有填写本地目录', fix: '到「本地目录」选一个文件夹' },
      cloud: { ok: false, code: 'missing', message: '没有填写仓库信息', fix: '到「仓库信息」填写用户名与仓库名' }
    };

    /* ---- 本地目录 ---- */
    const dir = String(p.localDir || '').trim();
    if (dir) {
      if (!local.exists(dir)) {
        out.local = {
          ok: false,
          code: 'not-exist',
          dir: dir,
          message: '目录不存在：' + dir,
          fix: '点「选择…」重新指到本机的仓库目录，或点「克隆到此处」把仓库拉下来'
        };
      } else if (!(await git.isRepo(dir))) {
        out.local = {
          ok: false,
          code: 'not-repo',
          dir: dir,
          message: '目录存在，但不是 Git 仓库（没有 .git）',
          fix: '点「克隆到此处」把仓库克隆到这个目录'
        };
      } else {
        const sum = (await git.repoSummary(dir)) || {};
        const st = (await git.status(dir)) || {};
        out.local = {
          ok: true,
          code: 'ready',
          dir: dir,
          branch: sum.branch || '',
          dirty: !!st.dirty,
          message: '本地仓库就绪' + (sum.branch ? '（分支 ' + sum.branch + '）' : '')
        };
      }
    }

    /* ---- 云端仓库 ---- */
    if (p.owner && p.repo) {
      const token = store.getProfileToken(id);
      if (!token) {
        out.cloud = {
          ok: false,
          code: 'no-token',
          owner: p.owner,
          repo: p.repo,
          message: p.owner + '/' + p.repo + '：本机没有可用 Token',
          fix:
            '把「归档配置」切到这一份，在「仓库信息 → 访问令牌」补上 Token 后点「验证并归档」。' +
            '（若这份是从配置文件导入的，说明导出时那份配置本身就没带 Token）'
        };
      } else {
        try {
          const client = new CloudClient({
            platform: p.platform || 'github',
            owner: p.owner,
            repo: p.repo,
            branch: p.branch || 'main',
            token: token,
            apiBase: p.apiBase || undefined
          });
          const user = await client.whoami();
          const info = await client.repoInfo();
          await client.listDir('');
          out.cloud = {
            ok: true,
            code: 'ready',
            owner: p.owner,
            repo: p.repo,
            userName: user.name || user.login,
            repoInfo: info,
            message: '云端可达：' + info.fullName + ' · ' + (info.private ? '私有' : '公开')
          };
        } catch (err2) {
          out.cloud = {
            ok: false,
            code: 'unreachable',
            owner: p.owner,
            repo: p.repo,
            message: friendlyError(err2),
            fix:
              '检查「仓库信息」里的 owner / 仓库名 / 分支是否写对，平台（GitHub / CNB）是否选错；' +
              '私有仓库还要确认 Token 有仓库读写权限'
          };
        }
      }
    }

    out.ok = out.local.ok && out.cloud.ok;
    return out;
  });

  // 无边框窗口的底色跟着主题走，免得调整窗口大小时闪一下另一种颜色
  ipcMain.handle('ui:setBackground', (e, color) => {
    if (!mainWindow) return false;
    try {
      mainWindow.setBackgroundColor(/^#[0-9a-fA-F]{6}$/.test(String(color)) ? String(color) : '#070b12');
      return true;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle('dialog:chooseDir', async (e, opts) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || '选择文件夹',
      defaultPath: (opts && opts.defaultPath) || undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('cloud:verify', async () => {
    const cfg = cfgRaw();
    const out = { ok: false, steps: [] };
    try {
      const client = buildClient();
      const user = await client.whoami();
      out.steps.push({ name: '账号鉴权', ok: true, message: `已登录：${user.name || user.login}` });
      out.user = user;
      try {
        const repo = await client.repoInfo();
        out.repo = repo;
        out.steps.push({
          name: '仓库访问',
          ok: true,
          message: `${repo.fullName} · ${repo.private ? '私有' : '公开'} · 已用 ${CPLinks.formatBytes(repo.sizeKB * 1024)}`
        });
        const branches = await client.listDir('');
        out.steps.push({ name: '分支读取', ok: true, message: `分支 ${cfg.branch} 可读，根目录 ${branches.length} 项` });
      } catch (e2) {
        out.steps.push({ name: '仓库访问', ok: false, message: friendlyError(e2) });
      }
      out.ok = out.steps.every((s) => s.ok);
      return out;
    } catch (e) {
      out.steps.push({ name: '账号鉴权', ok: false, message: friendlyError(e) });
      return out;
    }
  });

  ipcMain.handle('cloud:list', async (e, payload) => {
    const p = payload || {};
    const dirRel = CPLinks.normalizePath(p.dir || '');
    const cfg = cfgRaw();
    const localReady = !!(cfg.localDir && local.exists(cfg.localDir) && (await git.isRepo(cfg.localDir)));

    if (p.source === 'local' && localReady) {
      const items = local.listDir(cfg.localDir, dirRel);
      return { source: 'local', dir: dirRel, items, localReady };
    }
    const client = buildClient();
    const items = await client.listDir(dirRel);
    return { source: 'remote', dir: dirRel, items, localReady };
  });

  ipcMain.handle('cloud:tree', async (e, payload) => {
    const p = payload || {};
    const cfg = cfgRaw();
    const localReady = !!(cfg.localDir && local.exists(cfg.localDir) && (await git.isRepo(cfg.localDir)));
    if (p.source === 'local' && localReady) {
      return { source: 'local', tree: local.tree(cfg.localDir, '', 0, 2) };
    }
    // 远程模式：只列出一级目录（逐层点开时再请求），避免一次拉爆接口
    const client = buildClient();
    const items = await client.listDir('');
    return {
      source: 'remote',
      tree: items.filter((i) => i.type === 'dir').map((i) => ({ name: i.name, path: i.path, children: [] }))
    };
  });

  ipcMain.handle('cloud:stats', async (e, payload) => {
    const p = payload || {};
    const cfg = cfgRaw();
    if (p.source === 'local' && cfg.localDir && local.exists(cfg.localDir)) {
      return Object.assign({ source: 'local' }, local.countDir(cfg.localDir));
    }
    const client = buildClient();
    const r = await client.countFiles('');
    return Object.assign({ source: 'remote' }, r);
  });

  ipcMain.handle('cloud:upload', async (e, payload) => {
    const p = payload || {};
    const files = Array.isArray(p.files) ? p.files : [];
    if (!files.length) return { ok: false, message: '没有待上传的文件' };

    const cfg = cfgRaw();
    const limit = fileLimitBytes(cfg.platform);
    const subDir = CPLinks.normalizePath(p.dir || '');
    const results = [];
    const accepted = [];

    for (const f of files) {
      const buf = Buffer.from(f.data);
      const safeName = CPLinks.sanitizeName(f.name);
      // 路径模板已取消：上传到哪里完全由上传页选的「目标目录」决定，
      // 不再叠加一层隐式的日期 / 仓库占位符目录。
      const rel = CPLinks.joinPath(subDir, safeName);

      if (buf.length > limit) {
        results.push({ name: safeName, path: rel, ok: false, error: fileTooBigMsg(cfg.platform, buf.length) });
        continue;
      }
      accepted.push({ path: rel, buff: buf, name: safeName, size: buf.length });
    }

    if (accepted.length) {
      const message = (cfg.commitMessage || 'chore: 通过 JIE 分发服务上传') + ` (${accepted.length} file${accepted.length > 1 ? 's' : ''})`;
      try {
        // GitHub 走 Git Data API 一次提交；CNB 没有提交接口，走本地 Git 工作区
        const batchResults = cnbMode(cfg)
          ? await cnb.uploadBatch(cnbConn(), accepted, message)
          : await buildClient().uploadBatch(accepted, message);
        batchResults.forEach((r, idx) => {
          const src = accepted[idx] || {};
          results.push(Object.assign({ name: src.name, size: src.size }, r));
        });
      } catch (err) {
        accepted.forEach((src) => {
          if (!results.find((r) => r.path === src.path)) {
            results.push({ name: src.name, size: src.size, path: src.path, ok: false, error: friendlyError(err) });
          }
        });
      }
    }

    const uploaded = results.filter((r) => r.ok);
    let sync = null;
    if (uploaded.length) sync = await syncLocal('upload');

    return { ok: uploaded.length > 0, results, sync, uploaded: uploaded.length, failed: results.length - uploaded.length };
  });

  ipcMain.handle('cloud:delete', async (e, payload) => {
    const p = payload || {};
    const paths = (Array.isArray(p.paths) ? p.paths : []).map(CPLinks.normalizePath).filter(Boolean);
    if (!paths.length) return { ok: false, message: '没有选中任何文件' };
    const cfg = cfgRaw();
    const message = p.message || 'chore: delete files via JIE Dispatch';
    const results = cnbMode(cfg)
      ? await cnb.deleteBatch(cnbConn(), paths, message)
      : await buildClient().deleteBatch(paths, message);
    const ok = results.some((r) => r.ok);
    const sync = ok ? await syncLocal('delete') : null;
    return { ok, results, sync };
  });

  // ---- 云端改名 / 移动（GitHub 单次原子提交；CNB 走本地 Git 工作区一次提交）
  ipcMain.handle('cloud:move', async (e, payload) => {
    const p = payload || {};
    const items = (Array.isArray(p.items) ? p.items : [])
      .map((it) => ({
        from: CPLinks.normalizePath((it && it.from) || ''),
        to: CPLinks.normalizePath((it && it.to) || '')
      }))
      .filter((it) => it.from && it.to && it.from !== it.to);
    if (!items.length) return { ok: false, message: '没有需要移动的文件（源路径与目标路径一致）' };
    const cfg = cfgRaw();
    const message = p.message || `chore: 移动 ${items.length} 个文件`;
    const results = cnbMode(cfg)
      ? await cnb.moveBatch(cnbConn(), items, message)
      : await buildClient().moveBatch(items, message);
    const ok = results.some((r) => r.ok);
    const sync = ok ? await syncLocal('move') : null;
    return { ok, results, sync };
  });

  // ---- 云端替换：把某个已存在的路径换成一份新内容（保持路径不变）
  ipcMain.handle('cloud:replace', async (e, payload) => {
    const p = payload || {};
    const rel = CPLinks.normalizePath(p.path || '');
    if (!rel) throw new Error('缺少目标路径');
    const buf = Buffer.from(p.data || []);
    if (!buf.length) throw new Error('替换的内容为空');
    const cfg = cfgRaw();
    const limit = fileLimitBytes(cfg.platform);
    if (buf.length > limit) {
      throw new Error(`文件 ${CPLinks.formatBytes(buf.length)} 超过平台单文件上限（${CPLinks.formatBytes(limit)}）`);
    }
    const name = rel.split('/').pop();
    if (cnbMode(cfg)) {
      await cnb.replaceFile(cnbConn(), rel, buf, `chore: 替换 ${rel}`);
    } else {
      const results = await buildClient().uploadBatch([{ path: rel, buff: buf, name }], `chore: 替换 ${rel}`);
      const r = results[0];
      if (!r || !r.ok) throw new Error((r && r.error) || '替换失败');
    }
    const sync = await syncLocal('replace');
    return { ok: true, path: rel, size: buf.length, sync };
  });

  // ---- 本地目录：改名 / 移动
  ipcMain.handle('fs:localRename', (e, payload) => {
    const cfg = cfgRaw();
    if (!cfg.localDir || !local.exists(cfg.localDir)) throw new Error('尚未配置本地目录');
    const from = CPLinks.normalizePath((payload && payload.from) || '');
    const to = CPLinks.normalizePath((payload && payload.to) || '');
    if (!from || !to) throw new Error('路径不能为空');
    if (from === to) throw new Error('源路径与目标路径一致');
    const absFrom = local.safeJoin(cfg.localDir, from);
    const absTo = local.safeJoin(cfg.localDir, to);
    if (!fs.existsSync(absFrom)) throw new Error('源文件不存在：' + from);
    if (fs.existsSync(absTo) && !(payload && payload.overwrite)) throw new Error('目标位置已存在同名文件：' + to);
    local.ensureDir(path.dirname(absTo));
    fs.renameSync(absFrom, absTo);
    return { ok: true, from, to };
  });

  // ---- 本地目录：用新文件覆盖已有文件的内容
  ipcMain.handle('fs:localWrite', (e, payload) => {
    const cfg = cfgRaw();
    if (!cfg.localDir || !local.exists(cfg.localDir)) throw new Error('尚未配置本地目录');
    const rel = CPLinks.normalizePath((payload && payload.path) || '');
    if (!rel) throw new Error('缺少目标路径');
    const abs = local.safeJoin(cfg.localDir, rel);
    const buf = Buffer.from((payload && payload.data) || []);
    if (!buf.length) throw new Error('替换的内容为空');
    local.ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, buf);
    return { ok: true, path: rel, size: buf.length };
  });

  // ---- 本地目录：删除文件
  ipcMain.handle('fs:localDelete', (e, payload) => {
    const cfg = cfgRaw();
    if (!cfg.localDir || !local.exists(cfg.localDir)) throw new Error('尚未配置本地目录');
    const paths = (Array.isArray(payload && payload.paths) ? payload.paths : []).map(CPLinks.normalizePath).filter(Boolean);
    const results = paths.map((rel) => {
      try {
        const abs = local.safeJoin(cfg.localDir, rel);
        if (!fs.existsSync(abs)) return { path: rel, ok: false, error: '文件不存在' };
        const st = fs.statSync(abs);
        if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
        else fs.unlinkSync(abs);
        return { path: rel, ok: true, error: null };
      } catch (err) {
        return { path: rel, ok: false, error: err.message };
      }
    });
    return { ok: results.some((r) => r.ok), results };
  });

  // ---- 本地目录：把改动提交并推回云端
  ipcMain.handle('git:commit', async (e, payload) => {
    const cfg = cfgRaw();
    const dir = cfg.localDir;
    if (!dir || !local.exists(dir)) throw new Error('尚未配置本地目录');
    if (!(await git.isRepo(dir))) throw new Error('本地目录不是 Git 仓库，无法推送');
    if (!cfg.owner || !cfg.repo) throw new Error('请先配置仓库信息');
    return git.commitAndPush({
      platform: cfg.platform,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch || 'main',
      token: store.getToken(),
      dir,
      message: (payload && payload.message) || cfg.commitMessage || 'chore: 通过 JIE 分发服务更新'
    });
  });

  ipcMain.handle('git:version', async () => ({ version: await git.version() }));

  ipcMain.handle('git:status', async () => {
    const cfg = cfgRaw();
    const dir = cfg.localDir;
    if (!dir || !local.exists(dir)) return { configured: false, isRepo: false };
    const isRepo = await git.isRepo(dir);
    if (!isRepo) return { configured: true, isRepo: false, dir };
    const st = await git.status(dir);
    const sum = await git.repoSummary(dir);
    return Object.assign({ configured: true, isRepo: true, dir }, st, sum || {});
  });

  ipcMain.handle('git:clone', async (e, payload) => {
    const cfg = cfgRaw();
    if (!cfg.owner || !cfg.repo) throw new Error('请先配置用户名与仓库名');
    const dir = (payload && payload.dir) || cfg.localDir;
    if (!dir) throw new Error('请先选择本地目录');
    const r = await git.clone({
      platform: cfg.platform,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch || 'main',
      token: store.getToken(),
      dir
    });
    if (r.ok) {
      store.patch({ localDir: dir });
      allowRoot(dir);
    }
    return r;
  });

  ipcMain.handle('git:pull', async () => syncLocal('manual'));

  /**
   * 云端检测器 —— 回答「云端更新了、本地怎么没跟上」。
   *
   * 拿本地 HEAD 的完整 SHA 和云端分支 HEAD 的完整 SHA 比：
   *   完全一致            → same
   *   不一致就 fetch 一次，数 ahead / behind：
   *     ahead>0 behind=0 → local-ahead（本地新，该推到云端）
   *     ahead=0 behind>0 → local-behind（云端新，该拉下来）
   *     两边都>0         → diverged（分叉，得人来定）
   *
   * 只读不写：任何「拉/推」都由渲染层拿到结论后再显式触发，
   * 免得进个页面就悄悄改了仓库。
   */
  ipcMain.handle('cloud:detect', async () => {
    const cfg = cfgRaw();
    const branch = cfg.branch || 'main';
    const out = {
      ok: false,
      platform: cfg.platform || 'github',
      branch: branch,
      repoLabel: cfg.owner && cfg.repo ? cfg.owner + '/' + cfg.repo : '',
      gitAvailable: !!(await git.version()),
      local: { isRepo: false, dir: cfg.localDir || '', sha: '', short: '', dirty: false, changes: 0, branch: '' },
      cloud: { ok: false, sha: '', short: '', message: '' },
      ahead: 0,
      behind: 0,
      relation: 'unknown' // same | local-ahead | local-behind | diverged | no-local | no-cloud | unconfigured | unknown
    };

    if (!cfg.owner || !cfg.repo) {
      out.relation = 'unconfigured';
      return out;
    }

    /* ---- 本地 HEAD ---- */
    const dir = String(cfg.localDir || '').trim();
    if (dir && local.exists(dir) && (await git.isRepo(dir))) {
      const st = (await git.status(dir)) || {};
      const sum = (await git.repoSummary(dir)) || {};
      out.local = {
        isRepo: true,
        dir: dir,
        sha: await git.headShaFull(dir),
        short: sum.head || '',
        branch: sum.branch || '',
        dirty: !!st.dirty,
        changes: st.changes || 0
      };
    } else if (dir) {
      out.local.dir = dir;
      out.local.reason = '目录不存在或不是 Git 仓库';
    }

    /* ---- 云端 HEAD ---- */
    const token = store.getToken();
    if (!token) {
      out.cloud.message = '本机没有可用 Token，无法读取云端提交';
      out.relation = out.local.isRepo ? 'unknown' : 'no-local';
      return out;
    }
    try {
      const client = buildClient();
      const sha = await client.headSha(branch);
      out.cloud.sha = sha || '';
      out.cloud.short = sha ? sha.slice(0, 7) : '';
      out.cloud.ok = !!sha;
      if (!sha) out.cloud.message = '云端分支「' + branch + '」为空或不存在';
    } catch (err) {
      out.cloud.message = friendlyError(err);
      out.relation = out.local.isRepo ? 'unknown' : 'no-local';
      return out;
    }

    if (!out.local.isRepo) {
      out.relation = 'no-local';
      out.ok = true;
      return out;
    }

    // SHA 完全一致：连 fetch 都省了
    if (out.local.sha && out.cloud.sha && out.local.sha === out.cloud.sha) {
      out.relation = 'same';
      out.ok = true;
      return out;
    }

    /* ---- 不一致：fetch 云端，数领先 / 落后几条 ---- */
    if (!out.cloud.ok) {
      // 云端 HEAD 都没读到（空分支 / 接口不通），别再去 fetch —— 比不出结论，
      // 白跑一次网络还可能把真实远端的凭据试探一遍
      out.relation = 'unknown';
      out.ok = true;
      return out;
    }
    // 接口地址被改成自定义的（GitHub Enterprise / 自建网关 / 离线自测）时，
    // 没法从接口地址反推 Git 远端主机，就别硬比提交了 —— 老实说不比得出。
    const officialApi = cfg.platform === 'cnb' ? 'https://api.cnb.cool' : 'https://api.github.com';
    const customApi = String(cfg.apiBase || '').replace(/\/+$/, '');
    if (customApi && customApi !== officialApi) {
      out.cloud.message = '接口地址是自定义的（' + customApi + '），无法据此推断 Git 远端，跳过提交比对';
      out.relation = 'unknown';
      out.ok = true;
      return out;
    }
    if (!out.gitAvailable) {
      out.cloud.message = '未检测到 Git，无法比较提交历史';
      out.relation = 'unknown';
      out.ok = true;
      return out;
    }
    const f = await git.fetchRef({
      platform: cfg.platform,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: branch,
      token: token,
      dir: dir
    });
    if (!f.ok) {
      out.cloud.message = f.message;
      out.relation = 'unknown';
      out.ok = true;
      return out;
    }
    out.cloud.short = (await git.fetchHeadSha(dir)) || out.cloud.short;
    const cmp = await git.compareRefs(dir);
    if (!cmp) {
      out.relation = 'unknown';
      out.ok = true;
      return out;
    }
    out.ahead = cmp.ahead;
    out.behind = cmp.behind;
    out.relation = cmp.ahead && cmp.behind ? 'diverged' : cmp.ahead ? 'local-ahead' : cmp.behind ? 'local-behind' : 'same';
    out.ok = true;
    return out;
  });

  /** 检测器给出「云端旧、本地新」结论后，用户点「推送到云端」走这里 */
  ipcMain.handle('cloud:pushLocal', async () => {
    const cfg = cfgRaw();
    const dir = cfg.localDir;
    if (!dir || !local.exists(dir)) throw new Error('未绑定本地目录，无法推送');
    if (!(await git.isRepo(dir))) throw new Error('本地目录不是 Git 仓库，无法推送');
    if (!cfg.owner || !cfg.repo) throw new Error('请先配置仓库信息');
    return git.commitAndPush({
      platform: cfg.platform,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch || 'main',
      token: store.getToken(),
      dir: dir,
      message: cfg.commitMessage || 'chore: 通过 JIE 分发服务更新'
    });
  });

  ipcMain.handle('clipboard:write', (e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });

  ipcMain.handle('shell:openExternal', (e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('shell:showItem', (e, target) => {
    const cfg = cfgRaw();
    if (!cfg.localDir) return false;
    try {
      shell.showItemInFolder(local.safeJoin(cfg.localDir, target));
      return true;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle('shell:openLocalDir', () => {
    const cfg = cfgRaw();
    if (cfg.localDir && local.exists(cfg.localDir)) shell.openPath(cfg.localDir);
    return true;
  });

  ipcMain.handle('fs:exportText', async (e, payload) => {
    const p = payload || {};
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出',
      defaultPath: p.defaultName || 'jie-export.txt',
      filters: [{ name: '文本文件', extensions: ['txt', 'md'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, String(p.content || ''), 'utf8');
    return { ok: true, filePath: r.filePath };
  });

  ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('win:close', () => mainWindow && mainWindow.close());
  ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));
}

// ---------------------------------------------------------------- 生命周期

app.whenReady().then(async () => {
  buildMenu();
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
