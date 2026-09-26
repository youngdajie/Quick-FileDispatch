'use strict';

/**
 * 多页面回归检查（一次性，不进仓库）
 *
 * 逐个切到 4 个页面，检查：
 *   - 页面真的渲染出来（不是白屏）
 *   - 无控制台报错 / 无未捕获异常
 *   - 深色模式下星野画布正常绘制
 *
 * 用法：node _regress.js http://127.0.0.1:PORT
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pageURL = process.argv[2];
const CDP_PORT = 9445;
const WIDTH = 1440;
const HEIGHT = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  for (const p of [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ]) {
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
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
    try { m = JSON.parse(ev.data); } catch (e) { return; }
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
    send: (method, params) => new Promise((res, rej) => {
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
    } catch (e) { /* waiting */ }
    await sleep(250);
  }
  throw new Error('等不到可调试页面');
}

async function main() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge');

  const userDataDir = path.join(os.tmpdir(), 'qfd-regress-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    pageURL
  ], { stdio: 'ignore' });

  const errors = [];
  let pass = 0, fail = 0;
  const check = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
  };

  try {
    const target = await waitForTarget();
    const client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    client.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        errors.push('EXC: ' + String((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push('ERR: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' ').split('\n')[0]);
      }
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const js = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result && r.result.value;
    };

    console.log('=== 等启动 ===');
    for (let i = 0; i < 60; i++) {
      const s = await js(`!!(window.__state && window.__state.cfg) && !!document.documentElement.dataset.theme`);
      if (s) break;
      await sleep(300);
    }
    await sleep(1000);

    console.log('=== 关掉新手指引（测试配置未填仓库，属原有逻辑）===');
    await js(`(() => { const b = document.querySelector('.ob-close'); if (b) b.click(); return 1; })()`);
    await sleep(500);

    console.log('\n=== 逐页检查 ===');
    for (const page of ['upload', 'manage', 'settings', 'about']) {
      const r = await js(`(async () => {
        const nav = document.querySelector('.nav-item[data-page=${JSON.stringify(page)}]');
        if (!nav) return { ok: false, why: '没有导航项' };
        nav.click();
        await new Promise(r => setTimeout(r, 600));
        const active = document.querySelector('.page.active');
        const el = active;
        const text = el ? (el.textContent || '').trim() : '';
        return {
          ok: !!el && el.id === 'page-' + ${JSON.stringify(page)} && text.length > 20,
          id: el ? el.id : '',
          textLen: text.length,
          children: el ? el.children.length : 0
        };
      })()`);
      check(r && r.ok, '页面 ' + page, r ? `${r.id} · ${r.textLen} 字 · ${r.children} 个子元素` : '无返回');
    }

    console.log('\n=== 深色星野画布 ===');
    await sleep(1500);
    const cv = await js(`(() => {
      const c = document.querySelector('#universe');
      if (!c) return { ok: false, why: '无 #universe' };
      const ctx = c.getContext('2d');
      if (!ctx) return { ok: false, why: '无 2d 上下文' };
      const cs = getComputedStyle(c);
      const w = c.width, h = c.height;
      if (!w || !h) return { ok: false, why: '画布 ' + w + 'x' + h };
      const d = ctx.getImageData(0, 0, w, h).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) painted++;
      return { ok: painted > 0, painted, size: w + 'x' + h, display: cs.display, theme: document.documentElement.dataset.theme };
    })()`);
    console.log('   ', JSON.stringify(cv));
    check(cv && cv.theme === 'dark', '当前是深色主题', cv && cv.theme);
    check(cv && cv.display !== 'none', '画布可见', cv && cv.display);
    check(cv && cv.ok, '星野已绘制', cv ? `${cv.painted} 个着色像素 · ${cv.size}` : '');

    console.log('\n=== 毛玻璃在深色下应关闭（设计：深色永远星野）===');
    const g = await js(`(() => ({
      ready: document.documentElement.classList.contains('glass-ready'),
      layers: document.querySelectorAll('.glass-layer').length
    }))()`);
    check(!g.ready, '深色下玻璃未启用（符合设计）', JSON.stringify(g));

    client.close();
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }

  console.log('\n=== 错误收集 ===');
  const real = errors.filter((e) => !/favicon/i.test(e));
  check(real.length === 0, '无控制台报错 / 未捕获异常', real.slice(0, 3).join(' | ') || '');
  if (real.length) real.slice(0, 5).forEach((e) => console.log('     ' + e));

  console.log('\n================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? 'ALL_PASS' : 'HAS_FAILURE');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本出错：' + (e && e.stack || e)); process.exit(2); });
