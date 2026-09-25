/**
 * 配置向导：一份配置（仓库信息 + 本地目录 + 文件链接）一步步填。
 *
 * 为什么做成弹窗向导，而不是一个长表单：
 *   1) 长表单把十几项摊在一屏里，用户得自己判断「哪些是必填、现在填到哪了」；
 *   2) 原来的表单常驻在「仓库设置」卡里，于是它必须有个「当前编辑的是哪一份」的状态，
 *      切换配置时表单内容跟着变，很容易让人误以为「切了配置 = 改了内容」；
 *   3) 向导天然是「临时的一次操作」：填完即走，卡片列表才是常驻视图。
 *
 * 向导复用新手指引那套观感（步骤条 + 一屏一屏 + 底部按钮），
 * 结构上刻意保持简单：一屏只问一件事，回车即下一步。
 */

import { $, escapeHtml, modal, ok, err, warn } from './dom.js';
import state from './state.js';
import { brandIcon } from './brandicons.js';
import { PLATFORMS, SYNC_STRATEGIES, FIELDS } from './config-fields.js';
import { enhanceAll } from './cselect.js';

const CPLinks = window.CPLinks;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const platOf = (v) => (v === 'cnb' ? 'cnb' : 'github');
const platName = (v) => (platOf(v) === 'cnb' ? 'CNB' : 'GitHub');

/** 该平台下已经归档的配置（按创建时间倒序，用于「刚建出来的那一份」） */
function newestProfile(platform) {
  return state.profiles
    .filter((p) => platOf(p.platform) === platform)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
}

/**
 * 打开配置向导。
 *
 * opts.profile 给了就是「修改这一份」，不给就是「新建一份」。
 * opts.onDone 在保存成功后调用（设置页用它重画列表）。
 */
export function openConfigWizard(opts) {
  const o = opts || {};
  let editing = o.profile || null;

  const draft = {
    platform: platOf((editing && editing.platform) || o.platform || (state.cfg || {}).platform),
    owner: (editing && editing.owner) || '',
    repo: (editing && editing.repo) || '',
    branch: (editing && editing.branch) || 'main',
    apiBase: (editing && editing.apiBase) || '',
    token: '',
    tokenKept: !!(editing && editing.hasToken),
    localDir: (editing && editing.localDir) || '',
    linkRule: (editing && editing.linkRule) || 'auto',
    customDomain: (editing && editing.customDomain) || '',
    linkFormat: (editing && editing.linkFormat) || (state.cfg && state.cfg.linkFormat) || 'markdown'
  };
  const sync = Object.assign({ autoPull: true, strategy: 'pull' }, (state.cfg && state.cfg.sync) || {});

  let step = 0;
  let busy = false;
  let animating = false;
  let result = null; // 验证结果（最后一屏用）

  /**
   * 换页：当前这一屏往左滑出去，下一屏从右边登场（回退时方向反过来）。
   * 先等「滑出」跑完再重画 —— 直接重画的话两屏会叠在一起闪一下。
   */
  async function goTo(next) {
    if (animating || next < 0 || next >= STEPS || next === step) return;
    animating = true;
    const dir = next > step ? 'forward' : 'back';
    const pane = m.body.querySelector('[data-pane]');
    if (pane) {
      pane.classList.remove('wz-in-right', 'wz-in-left');
      pane.classList.add(dir === 'forward' ? 'wz-out-left' : 'wz-out-right');
      await wait(165);
    }
    step = next;
    draw(dir);
    animating = false;
  }

  /* ------------------------------------------------------------ 一屏一屏 */

  /** 宿主能力：本地目录要选文件夹 / 克隆，这些只有宿主（向导/引导）自己知道怎么做 */
  const host = {
    editing: editing,
    onPickDir: async () => {
      const pick = document.querySelector('#wzPickDir');
      if (pick) {
        pick.disabled = true;
        try {
          const dir = await window.cloudpic.dialog.chooseDir({
            title: '选择这份配置的本地目录',
            defaultPath: draft.localDir || undefined
          });
          if (dir) {
            draft.localDir = dir;
            draw();
          }
        } catch (e) {
          err(e.message || String(e));
        } finally {
          pick.disabled = false;
        }
      }
    },
    onClone: async (btn) => {
      if (!draft.localDir.trim()) {
        warn('先选一个本地目录，再克隆');
        return;
      }
      btn.disabled = true;
      btn.textContent = '克隆中…';
      try {
        // 克隆读的是「已落盘」的配置，所以先把这份配置存下来
        await persist();
        const r = await window.cloudpic.git.clone({ dir: draft.localDir.trim() });
        if (r && r.ok) ok('克隆完成');
      } catch (e) {
        err(e.message || String(e));
      } finally {
        btn.disabled = false;
        btn.textContent = '克隆到该目录';
      }
    }
  };

  /** 本地目录那屏还多一组全局同步选项（不属于单份配置，所以不在 FIELDS 里） */
  function syncHtml() {
    return (
      '<div class="wz-sync">' +
      '<label class="wz-check"><input type="checkbox" id="wzAutoPull"' + (sync.autoPull !== false ? ' checked' : '') + ' />' +
      '<span>打开管理页时自动拉取云端（全局设置）</span></label>' +
      '<label class="field" style="margin-top:8px">' +
      '<span class="field-label">本地有改动时 <span class="hint">全局设置</span></span>' +
      '<select id="wzSyncStrategy">' +
      SYNC_STRATEGIES.map((x) => '<option value="' + x.id + '"' + (sync.strategy === x.id ? ' selected' : '') + '>' + escapeHtml(x.name) + '</option>').join('') +
      '</select></label>' +
      '</div>'
    );
  }

  function bindSync() {
    const ap = document.querySelector('#wzAutoPull');
    if (ap) ap.onchange = () => (sync.autoPull = ap.checked);
    const st = document.querySelector('#wzSyncStrategy');
    if (st) st.onchange = () => (sync.strategy = st.value);
  }

  /* 七屏：平台、以及 config-fields 里的六个字段（一屏一项） */
  const panes = [
    {
      key: 'platform',
      label: '平台',
      title: '这份配置放在哪个平台',
      pane: () =>
        '<div class="plat-cards">' +
        PLATFORMS.map(
          (p) =>
            '<button type="button" class="plat-card' + (draft.platform === p.id ? ' active' : '') +
            '" data-plat="' + p.id + '">' +
            '<span class="pn"><span class="plat-mark plat-mark-' + p.id + '">' + brandIcon(p.id, 15) + '</span>' +
            escapeHtml(p.name) + '</span>' +
            '<span class="pd">' + escapeHtml(p.note) + '</span>' +
            '</button>'
        ).join('') +
        '</div>',
      bind: () => {
        document.querySelectorAll('.plat-card[data-plat]').forEach((b) => {
          b.onclick = () => {
            draft.platform = b.dataset.plat;
            draw();
          };
        });
      },
      valid: () => true
    }
  ].concat(
    ['owner', 'repo', 'branch', 'token', 'local', 'link'].map((key) => {
      const f = FIELDS[key];
      return {
        key: key,
        label: f.label,
        title: f.title,
        pane: () => f.html(draft, host) + (key === 'local' ? syncHtml() : ''),
        bind: () => {
          f.bind(draft, host);
          if (key === 'local') bindSync();
        },
        valid: () => f.valid(draft),
        hint: () => (f.hint ? f.hint(draft) : '')
      };
    })
  );

  const STEPS = panes.length + 1; // 最后一屏是「保存 / 验证结果」

  /* ------------------------------------------------------------ 渲染 */

  const m = modal({
    title: (editing ? '修改配置' : '新建配置'),
    className: 'wz-modal',
    buttons: false,
    onClose: () => {
      if (busy) return;
    }
  });

  /** 头部：只显示当前在填哪一项 + 进度。七项标签挤一行等于没有信息 */
  function headHtml() {
    const total = STEPS;
    const no = Math.min(step + 1, total);
    const pct = Math.round((no / total) * 100);
    const label = step < panes.length ? panes[step].label : '完成';
    return (
      '<div class="wz-head">' +
      '<div class="wz-head-row">' +
      '<span class="wz-head-label">' + escapeHtml(label) + '</span>' +
      '<span class="wz-head-count">' + no + ' / ' + total + '</span>' +
      '</div>' +
      '<div class="wz-progress"><i style="width:' + pct + '%"></i></div>' +
      '</div>'
    );
  }

  function paneBody() {
    if (step < panes.length) {
      const p = panes[step];
      return '<h3 class="wz-title">' + escapeHtml(p.title) + '</h3>' + p.pane();
    }
    return resultHtml();
  }

  function resultHtml() {
    if (!result) {
      return (
        '<div class="wz-final">' +
        '<h3 class="wz-title">' + (editing ? '保存修改' : '保存这份配置') + '</h3>' +
        summaryHtml() +
        (editing && draft.tokenKept && !draft.token ? '<p class="wz-note">Token 保持原样</p>' : '') +
        '</div>'
      );
    }
    const line = (title, part) =>
      '<div class="wz-check ' + (part && part.ok ? 'ok' : 'bad') + '">' +
      '<span class="mk">' + (part && part.ok ? '✓' : '✕') + '</span>' +
      '<div class="tx"><b>' + escapeHtml(title) + '</b>：' + escapeHtml((part && part.message) || '未检查') +
      (part && !part.ok && part.fix ? '<em>→ ' + escapeHtml(part.fix) + '</em>' : '') +
      '</div></div>';
    const rule = CPLinks.LINK_RULES.find((r) => r.id === draft.linkRule);
    return (
      '<div class="wz-final">' +
      '<h3 class="wz-title">' + (result.ok ? '全部通过，已归档' : '还有没通过的') + '</h3>' +
      (result.ok
        ? '<p class="wz-note">这份配置现在可以用了 —— 上传、管理页都会跟着它走</p>'
        : '<p class="wz-note">配置已经存下来了（状态是「待验证」），把下面的问题修好再验证一次即可</p>') +
      '<div class="wz-checks">' +
      line('仓库信息', result.cloud) +
      line('本地目录', result.local) +
      '<div class="wz-check ok"><span class="mk">✓</span><div class="tx"><b>文件链接</b>：规则「' +
      escapeHtml(rule ? rule.name : draft.linkRule) + '」</div></div>' +
      '</div>' +
      '</div>'
    );
  }

  function summaryHtml() {
    const rows = [
      ['平台', platName(draft.platform)],
      ['仓库', (draft.owner || '?') + '/' + (draft.repo || '?')],
      ['分支', draft.branch || 'main'],
      ['Token', draft.token ? '本次填了新的' : draft.tokenKept ? '沿用已保存的' : '还没填'],
      ['本地目录', draft.localDir || '未绑定'],
      ['链接规则', (CPLinks.LINK_RULES.find((r) => r.id === draft.linkRule) || {}).name || draft.linkRule],
      ['复制格式', (CPLinks.LINK_FORMATS.find((f) => f.id === draft.linkFormat) || {}).name || draft.linkFormat]
    ];
    return (
      '<dl class="wz-sum">' +
      rows.map((r) => '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(String(r[1])) + '</dd>').join('') +
      '</dl>'
    );
  }

  function footHtml() {
    if (result) {
      return (
        '<div class="wz-foot">' +
        '<div class="grow">' + (result.ok ? '归档完成' : '配置已保存，状态为待验证') + '</div>' +
        (result.ok
          ? '<button class="btn btn-primary" id="wzDone">完成</button>'
          : '<button class="btn btn-ghost" id="wzFix">返回修改</button><button class="btn btn-primary" id="wzDone">完成</button>') +
        '</div>'
      );
    }
    const last = step === panes.length - 1;
    const isFinal = step === panes.length;
    const v = panes[step] ? panes[step].valid() : true;
    return (
      '<div class="wz-foot">' +
      '<div class="grow' + (v ? '' : ' bad') + '">' +
      (step < panes.length
        ? '第 ' + (step + 1) + ' / ' + STEPS + ' 步' + (v ? '' : ' · ' + escapeHtml((panes[step].hint && panes[step].hint()) || '这一项还没填好'))
        : '') +
      '</div>' +
      (step > 0 ? '<button class="btn btn-ghost" id="wzBack">上一步</button>' : '') +
      (isFinal
        ? '<button class="btn btn-primary" id="wzSave">' + (editing ? '保存并验证' : '保存并验证') + '</button>'
        : '<button class="btn btn-primary" id="wzNext"' + (v ? '' : ' disabled') + '>' + (last ? '下一步' : '下一步') + '</button>') +
      '</div>'
    );
  }

  function draw(anim) {
    const paneCls = 'wz-pane' + (anim === 'forward' ? ' wz-in-right' : anim === 'back' ? ' wz-in-left' : '');
    m.body.innerHTML =
      headHtml() +
      '<div class="wz-body"><div class="' + paneCls + '" data-pane>' + paneBody() + '</div></div>' +
      footHtml();
    const p = panes[step];
    if (p && p.bind) p.bind(m.body);

    /**
     * 输入一变就重算「下一步」能不能点。
     * 字段的读写交给 config-fields，但它不认识这个底部按钮 —— 那层判断得宿主来做，
     * 少了它就会出现「填了用户名，下一步还是灰的」。
     */
    function refreshFoot() {
      if (step >= panes.length) return;
      const okNow = panes[step].valid();
      const n = $('#wzNext', m.body);
      if (n) n.disabled = !okNow;
      const g = $('.wz-foot .grow', m.body);
      if (g) {
        g.className = 'grow' + (okNow ? '' : ' bad');
        const base = '第 ' + (step + 1) + ' / ' + STEPS + ' 步';
        g.textContent = okNow
          ? base
          : base + ' · ' + ((panes[step].hint && panes[step].hint()) || '这一项还没填好');
      }
    }

    const paneEl = m.body.querySelector('[data-pane]');
    if (paneEl) {
      paneEl.addEventListener('input', refreshFoot);
      paneEl.addEventListener('change', refreshFoot);
    }

    const next = $('#wzNext', m.body);
    if (next) {
      next.onclick = () => {
        if (!p.valid()) return;
        goTo(step + 1);
      };
    }
    const back = $('#wzBack', m.body);
    if (back) {
      back.onclick = () => goTo(step - 1);
    }
    const save = $('#wzSave', m.body);
    if (save) save.onclick = () => commit();
    const done = $('#wzDone', m.body);
    if (done) {
      done.onclick = () => {
        if (o.onDone) o.onDone();
        m.close();
      };
    }
    const fix = $('#wzFix', m.body);
    if (fix) {
      fix.onclick = () => {
        const target = resultWhichStep();
        result = null;
        goTo(target);
      };
    }
    // 下拉统一升级成自绘面板（和设置页其他地方一致，原生 select 太「网页」）
    try {
      enhanceAll(m.body);
    } catch (e) {
      /* 升级失败不影响使用，原生下拉照常 */
    }

    // 回车 = 下一步（最后一屏 = 提交）
    const firstInput = m.body.querySelector('.wz-body input[type="text"], .wz-body input[type="password"]');
    if (firstInput) {
      firstInput.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const n = $('#wzNext', m.body);
        if (n && !n.disabled) n.click();
        else if (step === panes.length) {
          const s = $('#wzSave', m.body);
          if (s) s.click();
        }
      };
      setTimeout(() => firstInput.focus(), 60);
    }
  }

  /** 验证没过时，回到哪一屏最合适 */
  function resultWhichStep() {
    if (result && result.cloud && !result.cloud.ok) return 1; // 用户名 / 仓库名
    if (result && result.local && !result.local.ok) return 5; // 本地目录
    return 1;
  }

  /* ------------------------------------------------------------ 保存 */

  function connOf() {
    const conn = {
      platform: draft.platform,
      owner: draft.owner.trim(),
      repo: draft.repo.trim(),
      branch: (draft.branch || 'main').trim(),
      localDir: draft.localDir.trim(),
      linkRule: draft.linkRule,
      customDomain: draft.customDomain.trim(),
      linkFormat: draft.linkFormat
    };
    if (draft.apiBase.trim()) conn.apiBase = draft.apiBase.trim();
    if (draft.token.trim()) conn.token = draft.token.trim();
    return conn;
  }

  /** 只落盘（克隆前要用到已保存的配置） */
  async function persist() {
    const conn = connOf();
    await state.patch({ sync: { autoPull: sync.autoPull !== false, strategy: sync.strategy } });
    if (editing) {
      await state.updateProfile(editing.id, conn);
    } else {
      await state.newProfile(Object.assign({ activate: false }, conn));
      const made = newestProfile(draft.platform);
      if (made) editing = made; // 建出来之后，后面再保存就走「更新」
    }
    return editing ? editing.id : '';
  }

  /** 保存 + 真实校验（仓库可达、Token 有效、本地目录是 git 仓库） */
  async function commit() {
    if (busy) return;
    busy = true;
    const btn = $('#wzSave', m.body);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '验证中…';
    }
    try {
      const id = await persist();
      if (!id) {
        err('没能建出配置，请再试一次');
        busy = false;
        draw();
        return;
      }
      const chk = await window.cloudpic.profile.check({ id: id });
      if (chk && chk.ok) {
        await state.verifyProfile(id, {
          userName: (chk.cloud && chk.cloud.userName) || '',
          repo: (chk.cloud && chk.cloud.repoInfo) || { fullName: draft.owner + '/' + draft.repo }
        });
        ok('已归档：' + draft.owner + '/' + draft.repo);
      }
      result = chk || { ok: false, cloud: { ok: false, message: '没有拿到验证结果' } };
      if (o.onDone) o.onDone();
    } catch (e) {
      err(e.message || String(e));
    } finally {
      busy = false;
      draw('forward');
    }
  }

  draw();
  return m;
}
