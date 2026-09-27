/**
 * 新手指引：首次启动时弹出来带着走一遍，但**不强制**。
 * 四步：选平台 → 填仓库与令牌（现场验证通过才放行）→ 映射本地目录 → 完成
 * 右上角的 ❌ 随时可以退（见 quit()），之后还能在设置页重新叫回来。
 */

import { $, escapeHtml, ok, err, warn } from './dom.js';
import state from './state.js';
import { brandIcon } from './brandicons.js';
import { enhanceAll } from './cselect.js';

const CPLinks = window.CPLinks;
import { FIELDS, linkPreviewHtml } from './config-fields.js';

const STEPS = ['选择平台', '仓库与令牌', '映射本地目录', '完成'];

/**
 * 步骤条 / 检查结果的勾叉一律用 SVG。
 * 原来直接写 ✓ ✗ 字符 —— 字体里的勾粗细、形状每台机器都不一样，
 * 有时候还会 fallback 成别的字形，看着就不像一套图标。
 */
const TICK =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const PLATFORMS = [
  {
    id: 'github',
    name: 'GitHub',
    desc: '全球最大代码托管平台，私有仓库免费。raw 域名国内访问偶有波动，可切 CDN',
    tip: '单文件 ≤ 100MB · 单仓库建议 ≤ 1GB'
  },
  {
    id: 'cnb',
    name: 'CNB',
    desc: '腾讯云原生构建的代码托管，国内直连快。写入通过 Git 完成，需要本机装了 Git',
    tip: '单文件 ≤ 200MB · 仓库存储免费 100GB'
  }
];

let step = 0;
let draft = null;
let verify = null; // { ok, steps: [] }
let testing = false;
let localMode = null; // repo | clone | skip
let testHandler = null;

/* ---------------------------------------------------------------- 数据 */

function resetDraft() {
  const c = state.cfg || {};
  draft = {
    platform: c.platform || 'github',
    owner: c.owner || '',
    repo: c.repo || '',
    branch: c.branch || 'main',
    apiBase: c.apiBase || '',
    token: '',
    // 已存过 Token 时留空表示沿用 —— 字段渲染（config-fields）要看这个标记
    tokenKept: !!c.hasToken,
    localDir: c.localDir || '',
    // 链接规则 / 默认复制格式：和配置向导问的是同一批字段
    linkRule: c.linkRule || 'auto',
    customDomain: c.customDomain || '',
    linkFormat: c.linkFormat || 'markdown'
  };
  verify = null;
  testing = false;
  localMode = null;
  testHandler = null;
  step = 0;
}

function cfgOk() {
  return !!(draft.owner && draft.repo && (draft.token || (state.cfg && state.cfg.hasToken)));
}

/* ---------------------------------------------------------------- 渲染 */

function stepRail() {
  return STEPS.map((s, i) => {
    const cls = i === step ? 'active' : i < step ? 'done' : '';
    const mark = i < step ? TICK : String(i + 1);
    return (
      '<div class="ob-step ' + cls + '">' +
      '<span class="no">' + mark + '</span>' +
      '<span class="lb">' + escapeHtml(s) + '</span>' +
      (i < STEPS.length - 1 ? '<span class="bar"></span>' : '') +
      '</div>'
    );
  }).join('');
}

function panePlatform() {
  const cards = PLATFORMS.map(
    (p) =>
      '<button class="plat-card' + (draft.platform === p.id ? ' active' : '') + '" data-platform="' + p.id + '">' +
      '<span class="pn"><span class="plat-mark plat-mark-' + p.id + '">' + brandIcon(p.id, 15) + '</span>' +
      escapeHtml(p.name) + '</span>' +
      '<span class="pd">' + escapeHtml(p.desc) + '</span>' +
      '<span class="pt">' + escapeHtml(p.tip) + '</span>' +
      '</button>'
  ).join('');

  return (
    '<div class="ob-pane">' +
    '<p style="margin:0 0 12px;color:var(--text-dim);font-size:12.5px;line-height:1.9">' +
    '把免费的代码托管仓库当成文件仓库来用 —— 仓库装得下的东西，这里都能分发。先选一个平台，后面随时能换</p>' +
    '<div class="plat-cards">' + cards + '</div>' +
    '<div class="ob-note" style="margin-top:14px">程序不会限制你能传什么，真正的边界在平台那边：' +
    '<b>' + escapeHtml(CPLinks.FILE_LIMITS.github.note) + '</b>（GitHub） / ' +
    '<b>' + escapeHtml(CPLinks.FILE_LIMITS.cnb.note) + '</b>（CNB）</div>' +
    '</div>'
  );
}

function paneRepo() {
  const checks =
    verify && verify.steps && verify.steps.length
      ? '<div class="ob-checks">' +
        verify.steps
          .map(
            (s) =>
              '<div class="ob-check ' + (s.ok ? 'ok' : 'bad') + '">' +
              '<span class="ic">' + (s.ok ? TICK : CROSS) + '</span>' +
              '<span><span class="nm">' + escapeHtml(s.name) + '</span>' +
              '<div class="ms">' + escapeHtml(s.message) + '</div></span></div>'
          )
          .join('') +
        '</div>'
      : '';

  // 仓库信息 + 令牌 + 文件链接：字段本身来自 config-fields（与配置向导同一份定义）
  return (
    '<div class="ob-pane">' +
    '<div class="grid-2">' +
    FIELDS.owner.html(draft) +
    FIELDS.repo.html(draft) +
    '</div>' +
    FIELDS.branch.html(draft) +
    FIELDS.token.html(draft) +
    FIELDS.link.html(draft) +
    checks +
    '</div>'
  );
}

function paneLocal() {
  const c = state.cfg || {};
  const dir = draft.localDir;
  let stateHtml = '<div class="mg-statusbar" style="padding:0">' +
    '<span class="pill">' + (dir ? escapeHtml(dir) : '尚未选择目录') + '</span>' +
    '<span class="pill" id="obLocalState">检测中…</span></div>';

  return (
    '<div class="ob-pane">' +
    '<p style="margin:0 0 12px;color:var(--text-dim);font-size:12.5px;line-height:1.9">' +
    '把仓库拉到本地，文件管理界面就读本地磁盘（打开即见、翻页零延迟），' +
    '而且本地改了文件也能直接推回云端。<b>建议映射</b>；实在不想也可以先只用云端浏览</p>' +
    '<div class="input-row" style="margin-bottom:10px">' +
    '<input type="text" id="obLocalDir" placeholder="例如 D:\\my-files" value="' + escapeHtml(draft.localDir) + '" />' +
    '<button class="btn btn-ghost btn-sm" id="obPickDir">选择…</button>' +
    '<button class="btn btn-primary btn-sm" id="obClone">克隆到此处</button>' +
    '</div>' +
    stateHtml +
    '<div class="ob-choice">' +
    '<button class="plat-card' + (localMode === 'repo' ? ' active' : '') + '" data-choice="repo">' +
    '<span class="pn">使用已有的本地仓库</span><span class="pd">目录里已经有 .git，直接用，不做任何下载</span></button>' +
    '<button class="plat-card' + (localMode === 'clone' ? ' active' : '') + '" data-choice="clone">' +
    '<span class="pn">从云端克隆下来</span><span class="pd">选一个空目录，把仓库完整拉一份到本地</span></button>' +
    '<button class="plat-card' + (localMode === 'skip' ? ' active' : '') + '" data-choice="skip">' +
    '<span class="pn">暂不映射</span><span class="pd">只用云端浏览，速度慢一些，之后再设置也行</span></button>' +
    '</div>' +
    '<div class="ob-note" id="obLocalNote" style="margin-top:12px">' +
    '选好目录后会立刻检测它是不是 Git 仓库' +
    (c.localDir ? '　当前已配置：<span class="mono">' + escapeHtml(c.localDir) + '</span>' : '') +
    '</div>' +
    '</div>'
  );
}

function paneDone() {
  const c = state.cfg || {};
  const rows = [
    ['平台', draft.platform === 'cnb' ? 'CNB' : 'GitHub'],
    ['仓库', (draft.owner || '?') + '/' + (draft.repo || '?') + ' @ ' + (draft.branch || 'main')],
    ['令牌', state.cfg && state.cfg.hasToken ? '已加密保存（' + (state.cfg.tokenMask || '') + '）' : '未配置'],
    ['本地目录', localMode === 'skip' || !c.localDir ? '未映射（仅云端浏览）' : c.localDir],
    ['链接规则', CPLinks.buildUrl(Object.assign({}, draft, { linkRule: c.linkRule || 'auto', customDomain: c.customDomain }), 'images/2026/09/example.jpg')]
  ];
  return (
    '<div class="ob-done">' +
    '<div class="big-ic"><svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="m7.6 12.3 3 3 5.8-6"/></svg></div>' +
    '<h3>配置完成，可以开始用了</h3>' +
    '<p>把文件拖进上传区就会自动压缩并推送到仓库；想改这里的任何一项，随时去「设置」页</p>' +
    '<div class="ob-summary"><dl class="kv">' +
    rows.map((r) => '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd>').join('') +
    '</dl></div>' +
    '</div>'
  );
}

function paneHtml() {
  if (step === 0) return panePlatform();
  if (step === 1) return paneRepo();
  if (step === 2) return paneLocal();
  return paneDone();
}

function footHtml() {
  let grow = '';
  if (step === 1) {
    grow = verify && verify.ok ? '连接正常' : testing ? '正在测试…' : '必须测试连接通过才能继续';
    grow = '<div class="grow ' + (verify && verify.ok ? 'ok' : verify ? 'bad' : '') + '">' + grow + '</div>';
  } else if (step === 2) {
    grow = localMode === 'repo' || localMode === 'clone'
      ? '<div class="grow ok">本地目录已就绪</div>'
      : localMode === 'skip'
        ? '<div class="grow">已选择仅云端浏览</div>'
        : '<div class="grow">请选择本地目录，或明确选择「暂不映射」</div>';
  } else {
    grow = '<div class="grow">第 ' + (step + 1) + ' / ' + STEPS.length + ' 步</div>';
  }

  const back = step > 0 && step < 3 ? '<button class="btn btn-ghost" id="obBack">上一步</button>' : '';
  let next;
  if (step === 0) next = '<button class="btn btn-primary" id="obNext">下一步</button>';
  else if (step === 1) next = '<button class="btn btn-primary" id="obNext" ' + (verify && verify.ok ? '' : 'disabled') + '>下一步</button>';
  else if (step === 2) next = '<button class="btn btn-primary" id="obNext" ' + (localMode ? '' : 'disabled') + '>下一步</button>';
  else next = '<button class="btn btn-primary" id="obNext">进入程序</button>';

  const testBtn =
    step === 1 ? '<button class="btn btn-ghost" id="obTest" ' + (testing ? 'disabled' : '') + '>' + (testing ? '测试中…' : '测试连接') + '</button>' : '';

  return back + '<div style="flex:1"></div>' + grow + testBtn + next;
}

function render() {
  const wrap = $('#onboardWrap');
  if (!wrap || wrap.hidden) return;

  wrap.innerHTML =
    '<div class="onboard">' +
    '<div class="ob-head">' +
    '<img src="/assets/logo.svg" alt="" />' +
    '<div><h2>欢迎使用 快捷文件分发服务@JIE</h2>' +
    '<p>第一次使用先花一分钟把仓库接上，之后打开就是干活</p></div>' +
    '<button type="button" class="ob-close" id="obClose" title="跳过引导（之后可在「设置」页重看）" aria-label="跳过引导">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
    '</button>' +
    '</div>' +
    '<div class="ob-steps">' + stepRail() + '</div>' +
    '<div class="ob-body">' + paneHtml() + '</div>' +
    '<div class="ob-foot">' + footHtml() + '</div>' +
    '</div>';

  bindPane();
  bindFoot();
  // 下拉统一升级成自绘面板（链接规则 / 默认复制格式那两个）——
  // 和设置页、配置向导向同一套，原生 select 太「网页」。
  // 必须放在 bindPane 之后：enhanceSelect 是「增强」不是「替换」，
  // 原 select 还在（被隐藏），onchange 照常触发，所以绑定不会丢。
  try {
    enhanceAll(wrap);
  } catch (e) {
    /* 升级失败不影响使用，原生下拉照常 */
  }
  const x = $('#obClose');
  if (x) x.onclick = quit;
}

/**
 * ❌ 退出引导 —— 不强制走完全程。
 *
 * 顺手把 onboarded 记成 true，免得每次开机都弹这个框；但这不影响使用，
 * 想接着配就去「设置」页，那里有「重看新手指引」能把这套流程再叫回来。
 */
async function quit() {
  try {
    await state.patch({ onboarded: true });
    state.refresh();
  } catch (e) {
    /* 存不上也照样关 —— 绝不能因为写配置失败就把人锁在引导里 */
  }
  close();
  warn('已跳过新手指引 —— 到「设置」页填好仓库信息就能开始用；想再走一遍点「重看新手指引」');
  window.dispatchEvent(new CustomEvent('cloudpic:changed'));
}

/* ---------------------------------------------------------------- 各步交互 */

function bindExternal(root) {
  root.querySelectorAll('a[data-ext]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      window.cloudpic.shell.openExternal(a.dataset.ext);
    };
  });
}

function bindPane() {
  const wrap = $('#onboardWrap');
  bindExternal(wrap);

  if (step === 0) {
    wrap.querySelectorAll('.plat-card[data-platform]').forEach((b) => {
      b.onclick = async () => {
        draft.platform = b.dataset.platform;
        if (draft.platform === 'cnb' && (!draft.branch || draft.branch === 'master')) draft.branch = 'main';
        await state.patch({ platform: draft.platform });
        render();
      };
    });
    return;
  }

  if (step === 1) {
    // 字段绑定由 config-fields 负责，输入直接落进 draft —— 不用再从 DOM 里 take
    FIELDS.owner.bind(draft);
    FIELDS.repo.bind(draft);
    FIELDS.branch.bind(draft);
    FIELDS.token.bind(draft);
    FIELDS.link.bind(draft);
    const take = () => draft;
    const invalidateVerify = () => {
      verify = null;
      const n = $('#obNext');
      if (n) n.disabled = true;
      const g = $('.ob-foot .grow');
      if (g) {
        g.className = 'grow';
        g.textContent = '必须测试连接通过才能继续';
      }
      const box = document.querySelector('.ob-checks');
      if (box) box.remove();
    };
    wrap.querySelectorAll('.ob-pane input, .ob-pane select').forEach((el) => {
      el.addEventListener('input', invalidateVerify);
      el.addEventListener('change', invalidateVerify);
    });

    testHandler = async () => {
      take();
      if (!draft.owner || !draft.repo) return err('先填用户名和仓库名');
      if (!draft.token && !(state.cfg && state.cfg.hasToken)) return err('还需要一个访问令牌');
      testing = true;
      const btn = $('#obTest');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '测试中…';
      }
      try {
        const patch = {
          platform: draft.platform,
          owner: draft.owner,
          repo: draft.repo,
          branch: draft.branch,
          apiBase: draft.apiBase,
          linkRule: draft.linkRule,
          customDomain: draft.customDomain,
          linkFormat: draft.linkFormat
        };
        if (draft.token) patch.token = draft.token;
        await state.patch(patch);
        draft.token = '';
        verify = await window.cloudpic.cloud.verify();
        if (verify.ok) ok('连接正常');
        else err('连接有问题，看下面的逐项结果');
      } catch (e) {
        verify = { ok: false, steps: [{ name: '测试', ok: false, message: e.message || String(e) }] };
        err(e.message || String(e));
      } finally {
        testing = false;
        render();
      }
    };
    $('#obTest').onclick = testHandler;
    return;
  }

  if (step === 2) {
    const setState = (text, cls) => {
      const el = $('#obLocalState');
      if (el) {
        el.textContent = text;
        el.className = 'pill' + (cls ? ' ' + cls : '');
      }
    };

    const detect = async () => {
      setState('检测中…', '');
      const dir = draft.localDir;
      if (!dir) {
        setState('未选择目录', '');
        localMode = null;
        refreshNext();
        return;
      }
      const [gv, st] = await Promise.all([window.cloudpic.git.version(), window.cloudpic.git.status()]);
      if (!gv || !gv.version) {
        setState('未检测到 Git', 'bad');
        return;
      }
      if (st && st.isRepo) {
        setState('已是 Git 仓库 · ' + (st.branch || '?') + ' @ ' + (st.head || '?'), 'ok');
        localMode = 'repo';
      } else {
        setState('不是 Git 仓库，可点「克隆到此处」', 'bad');
        if (localMode === 'repo') localMode = null;
      }
      refreshNext();
    };

    $('#obPickDir').onclick = async () => {
      const p = await window.cloudpic.dialog.chooseDir({ title: '选择本地仓库目录', defaultPath: draft.localDir || undefined });
      if (!p) return;
      draft.localDir = p;
      $('#obLocalDir').value = p;
      await state.patch({ localDir: p, sync: { autoPull: true } });
      await detect();
    };
    $('#obLocalDir').addEventListener('change', async () => {
      draft.localDir = $('#obLocalDir').value.trim();
      await state.patch({ localDir: draft.localDir });
      await detect();
    });

    $('#obClone').onclick = async () => {
      let dir = draft.localDir;
      if (!dir) {
        dir = await window.cloudpic.dialog.chooseDir({ title: '选择一个空目录用于克隆' });
        if (!dir) return;
        draft.localDir = dir;
        $('#obLocalDir').value = dir;
      }
      const btn = $('#obClone');
      btn.disabled = true;
      btn.textContent = '克隆中…';
      try {
        await state.patch({ localDir: dir, owner: draft.owner, repo: draft.repo, branch: draft.branch });
        const r = await window.cloudpic.git.clone({ dir: dir });
        if (r.ok) {
          ok(r.message || '克隆完成');
          localMode = 'clone';
        } else {
          err(r.message);
        }
      } catch (e) {
        err(e.message || String(e));
      } finally {
        btn.disabled = false;
        btn.textContent = '克隆到此处';
        await detect();
      }
    };

    wrap.querySelectorAll('.plat-card[data-choice]').forEach((b) => {
      b.onclick = async () => {
        localMode = b.dataset.choice;
        if (localMode === 'skip') {
          draft.localDir = '';
          wrap.querySelectorAll('.plat-card[data-choice]').forEach((x) => x.classList.toggle('active', x === b));
          const note = $('#obLocalNote');
          if (note) {
            note.innerHTML =
              '已选择仅云端浏览：文件管理会直接读云端接口，速度取决于网络。之后想映射本地目录，去「设置」页选一个目录即可';
          }
          refreshNext();
          return;
        }
        await detect();
        if (localMode === 'repo') {
          wrap.querySelectorAll('.plat-card[data-choice]').forEach((x) => x.classList.toggle('active', x === b));
          const note = $('#obLocalNote');
          if (note) note.innerHTML = '本地目录已经是 Git 仓库，将直接使用，不做任何下载';
        } else if (localMode === 'clone') {
          wrap.querySelectorAll('.plat-card[data-choice]').forEach((x) => x.classList.toggle('active', x === b));
          const note = $('#obLocalNote');
          if (note) note.innerHTML = '点上面的「克隆到此处」把仓库拉到本地，目录需要是空的';
        } else {
          localMode = null;
        }
        refreshNext();
      };
    });

    detect();
    return;
  }

  // step 3 无需额外绑定
}

function refreshNext() {
  const foot = $('.ob-foot');
  if (!foot) return;
  foot.innerHTML = footHtml();
  bindFoot();
}

function bindFoot() {
  const next = $('#obNext');
  if (next) next.onclick = onNext;
  const back = $('#obBack');
  if (back) {
    back.onclick = () => {
      step = Math.max(0, step - 1);
      render();
    };
  }
  const test = $('#obTest');
  if (test && testHandler) test.onclick = testHandler;
}

async function onNext() {
  if (step === 0) {
    step = 1;
    render();
    return;
  }
  if (step === 1) {
    if (!verify || !verify.ok) return err('请先点「测试连接」并通过');
    step = 2;
    render();
    return;
  }
  if (step === 2) {
    if (!localMode) return err('请选择本地目录，或选择「暂不映射」');
    step = 3;
    render();
    return;
  }
  // 完成
  try {
    await state.patch({ onboarded: true });
    state.refresh();
    close();
    ok('配置已保存，开始使用吧');
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));
    const nav = document.querySelector('.nav-item[data-page="upload"]');
    if (nav) nav.click();
  } catch (e) {
    err(e.message || String(e));
  }
}

/* ---------------------------------------------------------------- 对外 */

export function open() {
  resetDraft();
  const wrap = $('#onboardWrap');
  if (!wrap) return;
  wrap.hidden = false;
  document.body.classList.add('is-onboarding');
  render();
}

export function close() {
  const wrap = $('#onboardWrap');
  if (!wrap) return;
  wrap.hidden = true;
  wrap.innerHTML = '';
  document.body.classList.remove('is-onboarding');
}

export function isOpen() {
  const wrap = $('#onboardWrap');
  return !!(wrap && !wrap.hidden);
}

const api = { open: open, close: close, isOpen: isOpen };
export default api;

// 自检（--uitest）要能开一次向导看看渲染结果，再关掉继续跑后面的用例
if (typeof window !== 'undefined') window.CPOnboard = api;
