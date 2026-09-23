/**
 * 垫片：把 window.cloudpic 从「Electron IPC」接到「本地 HTTP 的 /ipc」上。
 *
 * 存在的唯一理由：渲染层那 9,587 行代码里到处在调 window.cloudpic.xxx，
 * 而 WebView2 里没有 ipcRenderer / contextBridge。垫片在页面最前面注入（见
 * internal/webui），把同一个对象按同样的形状铺出来，渲染层一个字都不用改。
 *
 * 对应关系：Electron 的 ipcRenderer.invoke(channel, payload)
 *          → POST /ipc {channel, payload} → {ok, data} / {ok, error}
 * 语义刻意做成一致的：
 *   - 返回 Promise；
 *   - 通道抛错就是 Promise reject，message 与后端给的字符串一致
 *     （渲染层的 catch 里读的就是 e.message）；
 *   - payload 原样 JSON 化，null / 不给都是 null。
 *
 * 通道名逐字对照 src/main/preload.js，两边必须同步改 —— 名字差一个字母，
 * 界面上表现成「点了没反应」，而且不报错，很难查。
 *
 * 这版还补了两件 WebView2 壳需要的事（渲染层不用知道）：
 *   - 标题栏拖动：见文件末尾的 mousedown 监听（Electron 靠 -webkit-app-region）；
 *   - win:maximized 事件：onMaximized 用 400ms 轮询模拟主进程推送。
 *
 * 还没有的东西：
 *   - getPathForFile：拖拽进来的文件拿不到真实路径（那是 Electron 的 webUtils）。
 */
(function () {
  'use strict';

  const ENDPOINT = '/ipc';

  /** 上一次请求失败的原因，供状态栏排查用（不影响主流程） */
  let lastError = '';

  async function invoke(channel, payload) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel, payload: payload === undefined ? null : payload })
      });
    } catch (e) {
      // 连不上本地服务：这不是「通道没实现」，得说清楚，否则会被当成业务报错
      lastError = '本地服务连不上（' + (e && e.message) + '）';
      throw new Error(lastError);
    }
    if (!res.ok) {
      lastError = '本地服务返回 HTTP ' + res.status;
      throw new Error(lastError);
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      lastError = '本地服务返回的不是 JSON';
      throw new Error(lastError);
    }
    if (!body || body.ok !== true) {
      const msg = (body && body.error) || '未知错误';
      lastError = msg;
      throw new Error(msg);
    }
    return body.data;
  }

  const call = (channel) => (payload) => invoke(channel, payload);

  /* ---------------------------------------------------------------- 剪贴板 */

  /**
   * Electron 版走主进程的 clipboard 模块。WebView 里 127.0.0.1 算安全上下文，
   * navigator.clipboard 可用，于是直接在前端做，少一次往返回。
   * 仍然留了 execCommand 的兜底：某些环境下剪贴板写入会被权限策略挡掉。
   */
  async function writeClipboard(text) {
    const str = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(str);
        return true;
      } catch (e) {
        /* 落到下面的兜底 */
      }
    }
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (!ok) throw new Error('写入剪贴板失败');
    return true;
  }

  /* ---------------------------------------------------------------- 装配 */

  window.cloudpic = {
    app: {
      info: call('app:info'),
      /** 本机已安装字体的家族名清单（设置页的「界面字体」下拉靠它列出真装了的字体） */
      fonts: call('app:fonts'),
      setBackground: call('ui:setBackground')
    },
    config: {
      get: call('config:get'),
      set: call('config:set'),
      reset: call('config:reset')
    },
    /** 归档的仓库配置（远端仓库 + 本地目录绑定在一起） */
    profile: {
      create: call('profile:new'),
      activate: call('profile:activate'),
      update: call('profile:update'),
      remove: call('profile:delete'),
      verify: call('profile:verify'),
      /** 单份配置的可用性体检（本地目录 + 云端仓库） */
      check: call('profile:check'),
      exportFile: call('profile:export'),
      importFile: call('profile:import')
    },
    dialog: {
      chooseDir: call('dialog:chooseDir')
    },
    cloud: {
      verify: call('cloud:verify'),
      list: call('cloud:list'),
      tree: call('cloud:tree'),
      stats: call('cloud:stats'),
      upload: call('cloud:upload'),
      remove: call('cloud:delete'),
      move: call('cloud:move'),
      replace: call('cloud:replace'),
      detect: call('cloud:detect'),
      readText: call('cloud:readText'),
      pushLocal: call('cloud:pushLocal'),
      pullCloud: call('git:pull')
    },
    git: {
      version: call('git:version'),
      status: call('git:status'),
      clone: call('git:clone'),
      pull: call('git:pull'),
      commit: call('git:commit')
    },
    clipboard: {
      write: writeClipboard
    },
    shell: {
      openExternal: call('shell:openExternal'),
      showItem: call('shell:showItem'),
      openLocalDir: call('shell:openLocalDir')
    },
    fs: {
      exportText: call('fs:exportText'),
      /** 本地目录内的改名 / 移动 */
      localRename: call('fs:localRename'),
      /** 用新文件覆盖本地已有文件的内容 */
      localWrite: call('fs:localWrite'),
      /** 删除本地文件 */
      localDelete: call('fs:localDelete')
    },
    win: {
      minimize: call('win:minimize'),
      maximize: call('win:maximize'),
      close: closeWindow,
      isMaximized: call('win:isMaximized'),
      /**
       * Electron 版订阅的是主进程推过来的 win:maximized 事件。
       * HTTP 这条路上没有事件通道，改用轮询：每 400ms 问一次状态，
       * 变了才回调 —— 渲染层的用法（onMaximized(applyMax)）不变。
       */
      onMaximized: function (listener) {
        let last = null;
        const timer = setInterval(function () {
          invoke('win:isMaximized').then(function (v) {
            if (last !== null && v !== last) listener(!!v);
            last = !!v;
          }).catch(function () { /* 服务没了就安静等着 */ });
        }, 400);
        return function () { clearInterval(timer); };
      }
    },
    /**
     * Electron 32+ 已移除 File.path，那边用 webUtils.getPathForFile。
     * 浏览器 / WebView2 这条路上拿不到真实路径（安全限制），先返回空串，
     * 拖拽上传里的「按路径去重」等功能会退化。
     * 待办：WebView2 宿主可以用 WebResourceRequested 或注入脚本拿路径。
     */
    getPathForFile: function () {
      return '';
    },
    /** 本地图片预览地址（走本机 127.0.0.1 服务，由 Go 侧直出文件） */
    localUrl: (absPath) => '/__local?p=' + encodeURIComponent(absPath),
    remoteUrl: (relPath) => '/__remote?p=' + encodeURIComponent(relPath),

    /** 排障用：最后一次后端调用的失败原因 */
    __lastError: () => lastError
  };

  /**
   * 关窗口。
   *
   * 宿主（wvhost）监听 WM_CLOSE 走正常销毁流程；window.close() 只是顺手一试，
   * 在 WebView2 里会失败（窗口不是脚本开的），失败是常态，别报错吓人。
   */
  function closeWindow() {
    invoke('win:close').catch(function () {});
    try {
      window.close();
    } catch (e) {
      /* 允许失败 */
    }
    return Promise.resolve(true);
  }

  /**
   * 无边框窗口的标题栏拖动。
   *
   * Electron 靠 CSS 的 -webkit-app-region: drag，浏览器引擎里只有 Chromium
   * 的 app 模式认它，WebView2 不认。这里在标题栏按下鼠标时通知宿主
   * （宿主用 WM_NCLBUTTONDOWN(HTCAPTION) 触发系统原生拖动）。
   * 选择器对着 app.css 抄：标题栏是 .topbar，里面的按钮 / 仓库徽章不拖。
   * 双击标题栏 = 最大化/还原，系统拖动循环自己处理。
   */
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (!t.closest('.topbar')) return;
    if (t.closest('button, .repo-chip, .win-controls, input, select, textarea, a, [contenteditable]')) return;
    invoke('win:drag').catch(function () { /* 拖不动就算了 */ });
  }, true);
})();
