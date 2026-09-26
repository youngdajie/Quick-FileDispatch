'use strict';

/**
 * 毛玻璃智能功能专项验证脚本（一次性，不进仓库）
 *
 * 验证内容：
 *   1. 页面能正常启动（无控制台报错 / 无未捕获异常）
 *   2. 设置页的「分析背景图」按钮存在且可点
 *   3. 点击后算法分析出结果，推荐值正确显示
 *   4. 点「应用推荐 blur」后，滑块 + 配置真的被改了
 *   5. 截一张设置页的图（人工可看）
 *
 * 用法：node _verify-glass.js http://127.0.0.1:PORT
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pageURL = process.argv[2];
const CDP_PORT = 9444;
const WIDTH = 1440;
const HEIGHT = 900;

if (!pageURL) {
  console.error('用法：node _verify-glass.js <页面地址>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const list = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  for (const p of list) {
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
    ws.addEventListener('error', (e) => rej(new Error('CDP 连接失败')));
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
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('等不到可调试页面');
}

async function main() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge / Chrome');
  console.log('浏览器: ' + exe);

  const userDataDir = path.join(os.tmpdir(), 'qfd-glass-verify-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    pageURL
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  const results = [];
  const ok = (name, detail) => { results.push({ pass: true, name, detail }); console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); };
  const fail = (name, detail) => { results.push({ pass: false, name, detail }); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); };

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
        consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || a.type).join(' ').split('\n')[0]);
      }
    });

    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const evalJS = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('JS 执行异常：' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result && r.result.value;
    };

    console.log('\n=== 阶段 1：等界面启动 ===');
    const deadline = Date.now() + 20000;
    let booted = false;
    while (Date.now() < deadline) {
      const s = await evalJS(`(() => ({
        theme: document.documentElement.dataset.theme || '',
        hasState: !!(window.__state && window.__state.cfg),
        hasUniverse: typeof window.__universe === 'function',
        errored: /启动失败/.test(document.body.textContent || '')
      }))()`);
      if (s && s.errored) { fail('界面启动', '页面显示「启动失败」'); break; }
      if (s && s.hasState && s.theme) { booted = true; ok('界面启动完成', '主题=' + s.theme); break; }
      await sleep(300);
    }
    if (!booted) fail('界面启动', '15 秒内未完成');

    await sleep(1200);

    console.log('\n=== 阶段 2：检查浅色 + 背景图已生效 ===');
    const themeInfo = await evalJS(`(() => {
      const root = document.documentElement;
      const bg = document.getElementById('customBg');
      const cs = bg ? getComputedStyle(bg) : null;
      return {
        theme: root.dataset.theme || '',
        glassReady: root.classList.contains('glass-ready'),
        bgOn: !!(bg && bg.classList.contains('on')),
        bgImg: cs ? cs.backgroundImage.slice(0, 60) : '',
        blurVar: getComputedStyle(root).getPropertyValue('--glass-blur').trim(),
        alphaVar: getComputedStyle(root).getPropertyValue('--glass-alpha').trim(),
        washVar: getComputedStyle(root).getPropertyValue('--glass-wash').trim(),
        layers: document.querySelectorAll('.glass-layer').length
      };
    })()`);
    console.log('   ', JSON.stringify(themeInfo));
    themeInfo.theme === 'light' ? ok('浅色主题', themeInfo.theme) : fail('浅色主题', themeInfo.theme);
    themeInfo.bgOn ? ok('背景图已渲染', themeInfo.bgImg) : fail('背景图', '未渲染');
    themeInfo.glassReady ? ok('玻璃就绪') : fail('玻璃就绪', 'glass-ready 类缺失');
    themeInfo.layers > 0 ? ok('玻璃层已注入', themeInfo.layers + ' 层') : fail('玻璃层', '0 层');
    ok('已有玻璃变量', `blur=${themeInfo.blurVar} alpha=${themeInfo.alphaVar} wash=${themeInfo.washVar}`);

    console.log('\n=== 阶段 3：切到设置页 ===');
    // 测试配置没填 owner/repo，新手指引会自动弹出并拦截切页（原有逻辑）。
    // 点它右上角的 ❌ 关掉，再切页 —— 这是在测「设置页功能」，不是测引导。
    const obClosed = await evalJS(`(() => {
      const btn = document.querySelector('.ob-close');
      if (btn) { btn.click(); return 'closed'; }
      return 'no-onboard';
    })()`);
    console.log('    引导弹窗：' + obClosed);
    await sleep(400);

    const sw = await evalJS(`(() => {
      const nav = document.querySelector('.nav-item[data-page="settings"]');
      if (!nav) return '没有设置导航';
      nav.click();
      const active = document.querySelector('.page.active');
      return active ? active.id : '?';
    })()`);
    sw === 'page-settings' ? ok('切到设置页', sw) : fail('切到设置页', String(sw));
    await sleep(700);

    console.log('\n=== 阶段 4：检查「分析背景图」按钮 ===');
    const btnInfo = await evalJS(`(() => {
      const b = document.querySelector('#btnBgAdaptive');
      const r = document.querySelector('#adaptiveResult');
      const num = document.querySelector('#arBlur');
      if (!b) return { found: false };
      const rect = b.getBoundingClientRect();
      return {
        found: true,
        visible: rect.width > 0 && rect.height > 0,
        text: b.textContent.trim(),
        resultHidden: r ? r.hidden : null,
        hint: (document.querySelector('#cfgAdaptiveHint') || {}).textContent || ''
      };
    })()`);
    console.log('   ', JSON.stringify(btnInfo));
    if (btnInfo.found) ok('按钮存在', btnInfo.text); else fail('按钮存在', '未找到');
    if (btnInfo.visible) ok('按钮可见', '可点击尺寸'); else fail('按钮可见', '尺寸为 0');

    console.log('\n=== 阶段 5：点击按钮，验证算法出结果 ===');
    if (btnInfo.found) {
      await evalJS(`(() => { document.querySelector('#btnBgAdaptive').click(); return true; })()`);
      // 等算法跑完（图片加载 + 分析）
      let res = null;
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        res = await evalJS(`(() => {
          const r = document.querySelector('#adaptiveResult');
          return {
            hidden: r ? r.hidden : true,
            lum: (document.querySelector('#arLum') || {}).textContent || '',
            sat: (document.querySelector('#arSat') || {}).textContent || '',
            contrast: (document.querySelector('#arContrast') || {}).textContent || '',
            bias: (document.querySelector('#arBias') || {}).textContent || '',
            blur: (document.querySelector('#arBlur') || {}).textContent || '',
            weight: (document.querySelector('#arWeight') || {}).textContent || '',
            hint: (document.querySelector('#cfgAdaptiveHint') || {}).textContent || '',
            recBlur: r ? (r.dataset.recommendedBlur || '') : ''
          };
        })()`);
        if (res && !res.hidden && res.recBlur) break;
      }
      console.log('   ', JSON.stringify(res));
      if (res && !res.hidden) {
        ok('分析完成，结果面板已显示');
        ok('亮度采样', 'lum=' + res.lum);
        ok('饱和度采样', 'sat=' + res.sat);
        ok('对比度采样', 'contrast=' + res.contrast);
        ok('色彩倾向', res.bias);
        ok('算法推荐 blur', res.blur + '（数值 ' + res.recBlur + '）');
        ok('算法推荐字重', res.weight);
        const rec = parseFloat(res.recBlur);
        if (rec >= 0 && rec <= 24) ok('推荐值在合法区间', rec + ' ∈ [0,24]');
        else fail('推荐值区间', rec + ' 越界');

        console.log('\n=== 阶段 6：点击「应用推荐 blur」，验证真的改了配置 ===');
        const before = await evalJS(`(() => {
          const s = document.querySelector('#cfgBgBlur');
          return s ? s.value : null;
        })()`);
        await evalJS(`(() => { document.querySelector('#btnApplyBlur').click(); return true; })()`);
        await sleep(1000);
        const after = await evalJS(`(() => {
          const root = document.documentElement;
          const s = document.querySelector('#cfgBgBlur');
          return {
            slider: s ? s.value : null,
            blurVar: getComputedStyle(root).getPropertyValue('--glass-blur').trim(),
            valEl: (document.querySelector('#cfgBgBlurVal') || {}).textContent || '',
            okMsg: (document.querySelector('#adaptiveOk') || {}).textContent || ''
          };
        })()`);
        console.log('   ', JSON.stringify(after));
        if (after.slider !== before) ok('滑块已更新', before + ' → ' + after.slider);
        else fail('滑块未变', before + ' → ' + after.slider);
        if (after.blurVar.indexOf(after.slider) >= 0) ok('玻璃 CSS 变量已同步', after.blurVar);
        else fail('玻璃变量未同步', 'blurVar=' + after.blurVar + ' slider=' + after.slider);
        ok('提示文案', after.okMsg || '(空)');
      } else {
        fail('分析完成', '结果面板未显示，hint=' + (res && res.hint));
      }
    }

    console.log('\n=== 阶段 7：截图 ===');
    await sleep(500);
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    const outFile = path.join(process.env.TEMP || os.tmpdir(), 'qfd-glass-verify.png');
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
    ok('截图已保存', outFile);

    console.log('\n=== 阶段 8：错误收集 ===');
    const realErrs = consoleErrors.filter((e) => !/favicon/i.test(e));
    if (pageErrors.length === 0) ok('无未捕获异常'); else fail('有未捕获异常', pageErrors.slice(0, 3).join(' | '));
    if (realErrs.length === 0) ok('无控制台报错'); else fail('有控制台报错', realErrs.slice(0, 3).join(' | '));

    client.close();
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('\n================================');
  console.log(`结果：${passed}/${total} 通过`);
  if (passed < total) {
    console.log('失败项：');
    results.filter((r) => !r.pass).forEach((r) => console.log('  - ' + r.name + ': ' + (r.detail || '')));
    process.exit(1);
  }
  console.log('ALL_PASS');
}

main().catch((e) => {
  console.error('验证脚本出错：' + (e && e.stack || e));
  process.exit(2);
});
