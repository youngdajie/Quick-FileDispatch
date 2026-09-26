'use strict';

/**
 * 上传功能（LFS 开关 + 进度条）的浏览器验证。
 *
 * 检查项：
 *   1. 进度条结构齐全（标签 / 明细 / 百分比 / 条）
 *   2. LFS 开关在 CNB 平台可见、在 GitHub 隐藏
 *   3. 勾选 LFS 时「首次会下载」的提醒才出现
 *   4. SSE 端点可用（EventSource 能连上）
 *   5. 无控制台报错 / 未捕获异常
 *
 * 用法：node tools/verify-upload.js http://127.0.0.1:PORT/
 *
 * 与 browser-check.js 的关系：那个只管「页面有没有白屏」，
 * 这个管「新加的上传功能在真实浏览器里是不是真的能用」。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pageURL = process.argv[2];
const CDP_PORT = Number(process.env.CDP_PORT || 9446);
const WIDTH = 1440;
const HEIGHT = 900;

if (!pageURL) {
  console.error('用法：node tools/verify-upload.js <页面地址>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  for (const p of [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (e) {
      /* 下一个 */
    }
  }
  return '';
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
      return;
    }
    if (m.method) listeners.forEach((fn) => fn(m));
  });
  return {
    ready,
    on: (fn) => listeners.push(fn),
    send: (method, params) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      }),
    close: () => ws.close()
  };
}

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('等不到可调试页面');
}

async function main() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge / Chrome');

  const userDataDir = path.join(os.tmpdir(), 'qfd-upload-verify-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(
    exe,
    [
      '--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      pageURL
    ],
    { stdio: 'ignore' }
  );

  const consoleErrors = [];
  const pageErrors = [];
  let pass = 0;
  let fail = 0;
  const check = (cond, name, detail) => {
    if (cond) {
      pass++;
      console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
    } else {
      fail++;
      console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    }
  };

  try {
    const target = await waitForTarget();
    const client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    client.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        pageErrors.push(String((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(
          (m.params.args || []).map((a) => a.value || a.description || '').join(' ').split('\n')[0]
        );
      }
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const js = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result && r.result.value;
    };

    console.log('=== 等界面启动 ===');
    for (let i = 0; i < 60; i++) {
      const ok = await js(`!!(window.__state && window.__state.cfg) && !!document.documentElement.dataset.theme`);
      if (ok) break;
      await sleep(300);
    }
    await sleep(1000);
    // 测试配置没填仓库，新手指引会弹出并挡住导航（原有逻辑）——关掉它
    await js(`(() => { const b = document.querySelector('.ob-close'); if (b) b.click(); return 1; })()`);
    await sleep(400);
    await js(`(() => { const n = document.querySelector('.nav-item[data-page="upload"]'); if (n) n.click(); return 1; })()`);
    await sleep(600);

    console.log('\n=== 1. 进度条结构 ===');
    const dom = await js(`(() => {
      const ids = ['upProgress', 'upProgressLabel', 'upProgressDetail', 'upProgressPct', 'upProgressBar'];
      const out = {};
      ids.forEach((id) => { out[id] = !!document.getElementById(id); });
      const bar = document.getElementById('upProgressBar');
      out.progressContainerHidden = (document.getElementById('upProgress') || {}).hidden;
      out.indeterminateClass = bar ? bar.classList.contains('indeterminate') : null;
      return out;
    })()`);
    console.log('   ', JSON.stringify(dom));
    ['upProgress', 'upProgressLabel', 'upProgressDetail', 'upProgressPct', 'upProgressBar'].forEach((id) => {
      check(dom[id], '存在 #' + id);
    });
    check(dom.progressContainerHidden === true, '进度条默认隐藏（未上传时不占位）');

    console.log('\n=== 2. LFS 开关（按平台显隐）===');
    // 注意必须走 window.__state.patch 而不是 window.cloudpic.config.set：
    // 后者只改后端配置，不会 emit → 各页的 onConfigChanged 不触发 →
    // 界面看着「改了没反应」。这是踩过的一个坑，写下来免得下次又用错。
    await js(`(async () => {
      await window.__state.patch({ platform: 'cnb' });
      return 1;
    })()`);
    await sleep(800);
    const cnb = await js(`(() => {
      const row = document.getElementById('upLfsRow');
      const box = document.getElementById('upLfs');
      const hint = document.getElementById('upLfsHint');
      return {
        rowHidden: row ? row.hidden : null,
        hasBox: !!box,
        hintHidden: hint ? hint.hidden : null,
        platform: (window.__state && window.__state.cfg && window.__state.cfg.platform) || ''
      };
    })()`);
    console.log('   ', JSON.stringify(cnb));
    check(cnb.platform === 'cnb', '已切到 CNB 平台', cnb.platform);
    check(cnb.rowHidden === false, 'CNB 下 LFS 开关可见');
    check(cnb.hasBox, 'LFS 复选框存在');
    check(cnb.hintHidden === true, '未勾选时不显示「首次会下载」提醒');

    // 勾上它，应该弹确认窗；点「继续」后保持勾选，且提醒出现
    await js(`(() => {
      const b = document.getElementById('upLfs');
      if (b) { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }
      return 1;
    })()`);
    await sleep(300);
    const modalAppeared = await js(`(() => {
      const t = document.querySelector('.modal .mh-title');
      return { title: t ? t.textContent : '', hasFoot: !!document.querySelector('.modal-foot') };
    })()`);
    check((modalAppeared.title || '').indexOf('LFS') >= 0, '勾选弹出「用 LFS 对象存储」确认窗', modalAppeared.title);
    // 点最后一个按钮（继续）
    await js(`(() => {
      const btns = document.querySelectorAll('.modal-foot .btn');
      const last = btns[btns.length - 1];
      if (last) last.click();
      return 1;
    })()`);
    await sleep(300);
    const afterCheck = await js(`(() => ({
      hintHidden: (document.getElementById('upLfsHint') || {}).hidden,
      checked: (document.getElementById('upLfs') || {}).checked
    }))()`);
    check(afterCheck.hintHidden === false, '确认后出现「首次会下载 git-lfs」提醒');
    check(afterCheck.checked === true, '确认后保持勾选');

    // 切回 GitHub，开关应隐藏
    await js(`(async () => {
      await window.__state.patch({ platform: 'github' });
      return 1;
    })()`);
    await sleep(800);
    const gh = await js(`(() => {
      const row = document.getElementById('upLfsRow');
      return {
        rowHidden: row ? row.hidden : null,
        platform: (window.__state && window.__state.cfg && window.__state.cfg.platform) || ''
      };
    })()`);
    console.log('   ', JSON.stringify(gh));
    check(gh.platform === 'github', '已切回 GitHub', gh.platform);
    check(gh.rowHidden === true, 'GitHub 下 LFS 开关隐藏（GitHub 没有对象存储）');

    console.log('\n=== 3. SSE 端点（EventSource 能连上）===');
    const sse = await js(`(async () => {
      return await new Promise((resolve) => {
        let done = false;
        const es = new EventSource('/ipc/events');
        const finish = (r) => { if (!done) { done = true; try { es.close(); } catch (e) {} resolve(r); } };
        es.onopen = () => finish({ connected: true });
        // 打开失败（503 等）也会走 onerror
        es.onerror = () => finish({ connected: false });
        setTimeout(() => finish({ connected: false, why: '超时' }), 4000);
      });
    })()`);
    console.log('   ', JSON.stringify(sse));
    check(sse && sse.connected === true, 'EventSource 成功连上 /ipc/events');

    console.log('\n=== 4. 分批逻辑（在真实浏览器环境里）===');
    const batch = await js(`(async () => {
      try {
        const m = await import('/js/lib/upload-batch.js');
        const mb = 1024 * 1024;
        const f = (n, name) => ({ outSize: n * mb, outName: name });
        return {
          ok: true,
          safeBody: m.SAFE_BODY,
          ipcLimit: m.IPC_LIMIT,
          one200: m.planBatches([f(200, 'a.bin')]).length,
          two200: m.planBatches([f(200, 'a'), f(200, 'b')]).length,
          ten100: m.planBatches(Array.from({ length: 10 }, (_, i) => f(100, 'f' + i))).length,
          empty: m.planBatches([]).length
        };
      } catch (e) {
        return { ok: false, err: String((e && e.message) || e) };
      }
    })()`);
    console.log('   ', JSON.stringify(batch));
    check(batch.ok, '分批模块能在浏览器里加载', batch.err || '');
    if (batch.ok) {
      check(batch.one200 === 1, '单个 200MB → 1 批', String(batch.one200));
      check(batch.two200 === 2, '2×200MB → 2 批', String(batch.two200));
      check(batch.ten100 === 5, '10×100MB → 5 批', String(batch.ten100));
      check(batch.empty === 1, '空队列 → 1 个空批', String(batch.empty));
      check(
        batch.safeBody < batch.ipcLimit,
        '安全上限低于 IPC 硬上限',
        (batch.safeBody / 1024 / 1024).toFixed(0) + ' < ' + (batch.ipcLimit / 1024 / 1024).toFixed(0) + ' MB'
      );
    }

    console.log('\n=== 5. 设置页 git-lfs 状态 ===');
    await js(`(() => { const n = document.querySelector('.nav-item[data-page="settings"]'); if (n) n.click(); return 1; })()`);
    await sleep(800);
    const lfsCard = await js(`(() => {
      const dot = document.getElementById('lfsDot');
      const text = document.getElementById('lfsText');
      const btn = document.getElementById('btnLfsInstall');
      return {
        hasDot: !!dot,
        dotClass: dot ? dot.className : '',
        text: text ? (text.textContent || '').trim() : '',
        hasBtn: !!btn,
        btnHidden: btn ? btn.hidden : null
      };
    })()`);
    console.log('   ', JSON.stringify(lfsCard));
    check(lfsCard.hasDot, '状态圆点存在');
    check(lfsCard.text.length > 0 && lfsCard.text !== '检查中…', '状态已加载（不是一直「检查中」）', lfsCard.text);
    check(lfsCard.hasBtn, '安装按钮存在');
    // 未装 → 按钮可见；已装 → 隐藏。两种都算正常，只要求自洽。
    const consistent = (lfsCard.text.indexOf('已就绪') >= 0) === (lfsCard.btnHidden === true);
    check(consistent, '「已就绪」与按钮显隐自洽', 'btnHidden=' + lfsCard.btnHidden);

    console.log('\n=== 6. mini 上传弹窗（文件管理页右键那个）===');
    const opened = await js(`(async () => {
      try {
        const m = await import('/js/lib/upload-mini.js');
        m.openMiniUpload('test-dir', function () {});
        return 'ok';
      } catch (e) {
        return 'err: ' + (e && e.message);
      }
    })()`);
    check(opened === 'ok', '打开 mini 弹窗', String(opened));
    await sleep(500);

    const mini = await js(`(() => {
      const row = document.getElementById('miniLfsRow');
      const box = document.getElementById('miniLfs');
      const prog = document.getElementById('miniProgress');
      const bar = document.getElementById('miniProgressBar');
      const label = document.getElementById('miniProgressLabel');
      return {
        hasRow: !!row,
        rowHidden: row ? row.hidden : null,
        hasBox: !!box,
        hasProg: !!prog,
        progHidden: prog ? prog.hidden : null,
        hasBar: !!bar,
        hasLabel: !!label
      };
    })()`);
    console.log('   ', JSON.stringify(mini));
    check(mini.hasRow, 'mini 有 LFS 开关行');
    check(mini.hasBox, 'mini 有 LFS 复选框');
    check(mini.hasProg, 'mini 有进度条容器');
    check(mini.hasBar, 'mini 有进度条');
    check(mini.hasLabel, 'mini 有进度文案');
    check(mini.progHidden === true, 'mini 进度条默认隐藏');
    // 当前平台是 github，所以 mini 的 LFS 行也该是隐藏的
    check(mini.rowHidden === true, 'GitHub 下 mini 的 LFS 开关也隐藏（与主页面一致）');

    console.log('\n=== 7. LFS 默认不勾 + 取消回退 ===');
    // 切到 CNB，这样 LFS 开关才可见
    await js(`(async () => { await window.__state.patch({ platform: 'cnb' }); return 1; })()`);
    await sleep(800);
    await js(`(() => { const n = document.querySelector('.nav-item[data-page="upload"]'); if (n) n.click(); return 1; })()`);
    await sleep(600);

    // 主页面 LFS 应默认不勾（不再记住上次的选择）
    const defaultUnchecked = await js(`(() => {
      const b = document.getElementById('upLfs');
      return b ? !b.checked : false;
    })()`);
    check(defaultUnchecked, 'LFS 默认不勾');

    // 勾选 → 弹窗 → 点「取消」→ 回退为不勾
    await js(`(() => {
      const b = document.getElementById('upLfs');
      if (b) { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }
      return 1;
    })()`);
    await sleep(300);
    await js(`(() => {
      const btns = document.querySelectorAll('.modal-foot .btn');
      const first = btns[0]; // 取消
      if (first) first.click();
      return 1;
    })()`);
    await sleep(300);
    const afterCancel = await js(`(() => {
      const b = document.getElementById('upLfs');
      return b ? !b.checked : false;
    })()`);
    check(afterCancel, '取消后 LFS 回退为不勾');

    // 重开 mini：应该也默认不勾
    await js(`(async () => {
      const m = await import('/js/lib/upload-mini.js');
      m.openMiniUpload('', function () {});
      return 1;
    })()`);
    await sleep(500);
    const miniAfter = await js(`(() => {
      const row = document.getElementById('miniLfsRow');
      const box = document.getElementById('miniLfs');
      return {
        rowHidden: row ? row.hidden : null,
        boxChecked: box ? box.checked : null
      };
    })()`);
    console.log('   ', JSON.stringify(miniAfter));
    check(miniAfter.rowHidden === false, 'CNB 下 mini 的 LFS 开关可见');
    check(miniAfter.boxChecked === false, 'mini 打开时 LFS 也默认不勾');

    // 清掉弹窗，别影响后面的检查
    await js(`(() => { const w = document.getElementById('miniUpWrap'); if (w) w.remove(); return 1; })()`);

    console.log('\n=== 8. 错误收集 ===');
    const realErrs = consoleErrors.filter((e) => !/favicon/i.test(e));
    check(pageErrors.length === 0, '无未捕获异常', pageErrors.slice(0, 2).join(' | ') || '');
    check(realErrs.length === 0, '无控制台报错', realErrs.slice(0, 2).join(' | ') || '');

    client.close();
  } finally {
    try {
      child.kill();
    } catch (e) {
      /* ignore */
    }
  }

  console.log('\n================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? 'ALL_PASS' : 'HAS_FAILURE');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本出错：' + ((e && e.stack) || e));
  process.exit(2);
});
