'use strict';

/**
 * 浏览器冒烟检查：用系统里的 Edge / Chrome 打开 Go 版起的页面，
 * 收集控制台报错、检查 DOM 是否真的渲染出来，并截一张图。
 *
 * 为什么需要它：`go run . --check` 只能证明「HTTP 打得通、通道回得对」，
 * 证明不了「界面渲染出来了」。页面是异步启动的（先 config.get / app:info，
 * 再初始化各页），启动链路上任何一环抛错都会表现成一块白屏，
 * 而 HTTP 状态码还是 200 —— 这种失败只有真的跑一遍浏览器才看得见。
 *
 * 用法：
 *   node tools/browser-check.js <页面地址> [输出图片] [浏览器exe路径] [切到哪一页] [滚到哪]
 * 例：
 *   node tools/browser-check.js http://127.0.0.1:8790/ .demo/go-demo.png
 *   node tools/browser-check.js http://127.0.0.1:8790/ .shots/about.png "" about 运行环境
 *   node tools/browser-check.js http://127.0.0.1:8790/ .shots/settings.png "" settings bottom
 *
 * 第 4 个参数是导航项的名字（upload / manage / settings / about），
 * 给了就先点一下再截图 —— 「关于」这种不在首屏的页面，光截首页是看不到的。
 * 第 5 个参数是滚动目标：`bottom` 滚到底，给 CSS 选择器或一段文字就滚到那个元素。
 * 内容区自己滚，不滚的话靠下的表格截不到。
 *
 * 依赖：只用到 Node 自带的 WebSocket（Node 22+ 全局可用）和 fetch，无第三方包。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pageURL = process.argv[2];
const outFile = process.argv[3] || path.join('.shots', 'go-demo.png');
const edgeArg = process.argv[4];
const wantPage = process.argv[5] || '';
const scrollTo = process.argv[6] || '';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const WIDTH = 1280;
const HEIGHT = 860;

if (!pageURL) {
  console.error('用法：node tools/browser-check.js <页面地址> [输出图片] [浏览器exe路径]');
  process.exit(2);
}

function findBrowser() {
  if (edgeArg) return edgeArg;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const list = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  for (const p of list) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (e) {
      /* 换下一个 */
    }
  }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：够用就行，不做重连和事件订阅框架 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('CDP 连接失败：' + (e.message || 'error'))));
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
      /* 还没起来，接着等 */
    }
    await sleep(250);
  }
  throw new Error('等不到可调试的页面（浏览器没起来？）');
}

async function main() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge / Chrome');

  const userDataDir = path.join(os.tmpdir(), 'qfd-go-browsercheck-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    exe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      pageURL
    ],
    { stdio: 'ignore' }
  );

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const target = await waitForTarget();
    const client = cdp(target.webSocketDebuggerUrl);
    await client.ready;

    client.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
        pageErrors.push(String(desc).split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(
          (m.params.args || [])
            .map((a) => a.value || a.description || a.type)
            .join(' ')
            .split('\n')[0]
        );
      }
    });

    await client.send('Runtime.enable');
    await client.send('Page.enable');

    // 等界面自己启动完。
    //
    // 判据不能用「有没有 .page.active」—— index.html 里就给 page-upload 写死了
    // class="page active"，那是静态骨架，第一帧就成立。上一版就是这么被骗的：
    // 循环第一轮立刻跳出，主题还没落下去、画布还没开始画，于是报了两条假失败。
    //
    // 真正的判据是启动链走完了没有：app.js 的 boot() 里 applyAppearance() 落在
    // initUniverse() 之前，所以「主题非空 + __universe 已挂上」这两条同时成立，
    // 就说明 state.init() 和字体那一步都过去了。
    const deadline = Date.now() + 15000;
    let state = null;
    let why = '';
    while (Date.now() < deadline) {
      const r = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const cp = window.cloudpic;
          const active = document.querySelector('.page.active');
          const wrap = document.querySelector('#onboardWrap');
          return {
            hasCloudpic: !!cp,
            hasBridgeMeta: !!(cp && cp.__lastError),
            activePage: active ? active.id : '',
            navCount: document.querySelectorAll('.nav-item').length,
            title: document.title,
            theme: document.documentElement.dataset.theme || '',
            hasUniverse: typeof window.__universe === 'function',
            booted: !!(window.__state && window.__state.cfg),
            onboardShown: !!(wrap && !wrap.hidden && wrap.children.length),
            bodyLen: document.body.innerHTML.length,
            errored: /启动失败/.test(document.body.textContent || '')
          };
        })()`,
        returnByValue: true
      });
      state = r.result && r.result.value;
      if (!state) break;
      if (state.errored) { why = '页面显示「启动失败」'; break; }
      if (state.hasUniverse && state.theme) break;
      why = '等不到启动完成（主题=' + (state.theme || '空') + '，__universe=' + state.hasUniverse + '）';
      await sleep(300);
    }

    // 再给背景动画（点阵 / 星野 canvas）和字体加载一点时间，截图才不是空的
    await sleep(1200);

    // 想截的不是首屏就先切过去。切页是纯前端路由，点一下导航项即可。
    let pageSwitch = '';
    if (wantPage) {
      const r = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const nav = document.querySelector('.nav-item[data-page=' + JSON.stringify(${JSON.stringify(wantPage)}) + ']');
          if (!nav) return '没有这个导航项';
          nav.click();
          const active = document.querySelector('.page.active');
          return '切到 ' + (active ? active.id : '?');
        })()`,
        returnByValue: true
      });
      pageSwitch = (r.result && r.result.value) || '';
      await sleep(700);
    }

    const shotArgs = { format: 'png' };
    if (scrollTo) {
      // 注意：本应用是「外壳固定高度 + 内容区自己滚」，所以整页截图（captureBeyondViewport）
      // 出来的还是视口那一屏 —— 想看靠下的表格只能滚内容区。
      const r = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const box = document.querySelector('.page.active') || document.scrollingElement;
          const want = ${JSON.stringify(scrollTo)};
          if (want === 'bottom') { box.scrollTop = box.scrollHeight; return '滚到底 ' + box.scrollTop; }
          let el = null;
          try { el = box.querySelector(want); } catch (e) { el = null; }
          if (!el) {
            el = Array.from(box.querySelectorAll('section, .card, dl, h2'))
              .find((x) => (x.textContent || '').indexOf(want) >= 0);
          }
          if (!el) return '没找到：' + want;
          el.scrollIntoView({ block: 'start' });
          return '滚到 ' + want;
        })()`,
        returnByValue: true
      });
      pageSwitch += (pageSwitch ? ' · ' : '') + ((r.result && r.result.value) || '');
      await sleep(500);
    }
    const shot = await client.send('Page.captureScreenshot', shotArgs);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

    // canvas 有没有真的在画：只看「rAF 在跑」不够 ——
    // 画布尺寸或变换写错时它照样在跑，却什么都画不出来。数着色像素才作数。
    const canvasStat = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const c = document.querySelector('#universe');
        if (!c) return { ok: false, why: '没有 #universe' };
        const ctx = c.getContext('2d');
        if (!ctx) return { ok: false, why: '拿不到 2d 上下文' };
        const w = c.width, h = c.height;
        if (!w || !h) return { ok: false, why: '画布尺寸是 ' + w + 'x' + h };
        const d = ctx.getImageData(0, 0, w, h).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) painted++;
        return { ok: painted > 0, painted, size: w + 'x' + h };
      })()`,
      returnByValue: true
    });

    client.close();

    const out = {
      page: state,
      switched: pageSwitch || undefined,
      canvas: canvasStat.result && canvasStat.result.value,
      pageErrors: pageErrors.slice(0, 20),
      consoleErrors: consoleErrors.slice(0, 20),
      screenshot: outFile
    };
    console.log('BROWSER_CHECK ' + JSON.stringify(out, null, 2));

    const bad = [];
    if (!state || !state.hasCloudpic) bad.push('window.cloudpic 不存在（垫片没生效）');
    if (state && !state.booted) bad.push('启动没走完：' + (why || '未知原因'));
    if (state && state.errored) bad.push('页面显示「启动失败」');
    if (state && !state.theme) bad.push('主题没落下去（data-theme 是空的）');
    if (pageErrors.length) bad.push('有未捕获异常：' + pageErrors[0]);
    if (!out.canvas || !out.canvas.ok) bad.push('背景 canvas 没画出东西：' + JSON.stringify(out.canvas));

    if (bad.length) {
      console.log('BROWSER_CHECK_FAILED ' + JSON.stringify(bad));
      process.exitCode = 1;
    } else {
      console.log('BROWSER_CHECK_OK');
    }
  } finally {
    try {
      child.kill();
    } catch (e) {
      /* ignore */
    }
    await sleep(300);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (e) {
      /* 临时目录删不掉不影响结论 */
    }
  }
}

main().catch((e) => {
  console.error('BROWSER_CHECK_ERROR ' + (e && e.message));
  process.exit(2);
});
