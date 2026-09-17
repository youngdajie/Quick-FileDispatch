'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('cloudpic', {
  app: {
    info: () => invoke('app:info'),
    /** 本机已安装字体的家族名清单（设置页的「界面字体」下拉靠它列出真装了的字体） */
    fonts: () => invoke('app:fonts'),
    setBackground: (color) => invoke('ui:setBackground', color)
  },
  config: {
    get: () => invoke('config:get'),
    set: (patch) => invoke('config:set', patch),
    reset: () => invoke('config:reset')
  },
  /** 归档的仓库配置（远端仓库 + 本地目录绑定在一起） */
  profile: {
    create: (payload) => invoke('profile:new', payload),
    activate: (payload) => invoke('profile:activate', payload),
    update: (payload) => invoke('profile:update', payload),
    remove: (payload) => invoke('profile:delete', payload),
    verify: (payload) => invoke('profile:verify', payload),
    /** 单份配置的可用性体检（本地目录 + 云端仓库） */
    check: (payload) => invoke('profile:check', payload),
    exportFile: () => invoke('profile:export'),
    importFile: () => invoke('profile:import')
  },
  dialog: {
    chooseDir: (opts) => invoke('dialog:chooseDir', opts)
  },
  cloud: {
    verify: () => invoke('cloud:verify'),
    list: (payload) => invoke('cloud:list', payload),
    tree: (payload) => invoke('cloud:tree', payload),
    stats: (payload) => invoke('cloud:stats', payload),
    upload: (payload) => invoke('cloud:upload', payload),
    remove: (payload) => invoke('cloud:delete', payload),
    move: (payload) => invoke('cloud:move', payload),
    replace: (payload) => invoke('cloud:replace', payload),
    /** 云端检测器：比对本地 HEAD 与云端 HEAD，判断谁新谁旧 */
    detect: () => invoke('cloud:detect'),
    /** 检测结论为「云端旧、本地新」时，把本地提交推上去 */
    pushLocal: () => invoke('cloud:pushLocal'),
    /** 检测结论为「云端新、本地旧」时，把云端拉下来 */
    pullCloud: () => invoke('git:pull')
  },
  git: {
    version: () => invoke('git:version'),
    status: () => invoke('git:status'),
    clone: (payload) => invoke('git:clone', payload),
    pull: () => invoke('git:pull'),
    commit: (payload) => invoke('git:commit', payload)
  },
  clipboard: {
    write: (text) => invoke('clipboard:write', text)
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
    showItem: (p) => invoke('shell:showItem', p),
    openLocalDir: () => invoke('shell:openLocalDir')
  },
  fs: {
    exportText: (payload) => invoke('fs:exportText', payload),
    /** 本地目录内的改名 / 移动 */
    localRename: (payload) => invoke('fs:localRename', payload),
    /** 用新文件覆盖本地已有文件的内容 */
    localWrite: (payload) => invoke('fs:localWrite', payload),
    /** 删除本地文件 */
    localDelete: (payload) => invoke('fs:localDelete', payload)
  },
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
    isMaximized: () => invoke('win:isMaximized'),
    /** 订阅最大化状态变化，返回取消订阅函数 */
    onMaximized: (cb) => {
      const listener = (_e, v) => cb(!!v);
      ipcRenderer.on('win:maximized', listener);
      return () => ipcRenderer.removeListener('win:maximized', listener);
    }
  },
  /** Electron 32+ 已移除 File.path，拖拽进窗口的文件必须用这个拿真实路径 */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (e) {
      return '';
    }
  },
  /** 本地图片预览地址（走主进程起的 127.0.0.1 服务） */
  localUrl: (absPath) => `/__local?p=${encodeURIComponent(absPath)}`,
  remoteUrl: (relPath) => `/__remote?p=${encodeURIComponent(relPath)}`
});
