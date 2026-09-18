'use strict';

/**
 * 配置持久化
 * - 存于 Electron userData/config.json
 * - Token 使用系统级加密（Windows DPAPI / safeStorage），落盘不明文
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/** 平台白名单：Gitee 已下线，现在只有 GitHub 和 CNB 两个 */
const PLATFORMS = ['github', 'cnb'];

function normalizePlatform(p) {
  const s = String(p || '');
  return PLATFORMS.indexOf(s) >= 0 ? s : 'github';
}

const DEFAULT_CONFIG = {
  version: 7,
  onboarded: false,
  platform: 'github', // github | cnb
  owner: '',
  repo: '',
  branch: 'main',
  apiBase: '',
  localDir: '',
  commitMessage: 'chore: 通过 JIE 分发服务上传',

  /**
   * 归档的仓库配置。
   *
   * 「云端仓库 + 本地目录」二者强制绑定在同一个 profile 上：
   * 切换 profile 时，远端仓库信息和本地目录一起换，不会出现
   * 「浏览器指着 A 仓库、本地却写着 B 仓库目录」的错位。
   *
   * 顶层那组 platform/owner/repo/branch/apiBase/localDir + _tokenEnc 是
   * 「当前生效」的镜像（整个 app 有上百处直接读 cfg.owner），
   * 由 activeProfileId 指向的 profile 同步过来。
   */
  profiles: [],
  activeProfileId: '',

  linkRule: 'auto', // auto|github_raw|jsdelivr|statically|githack|cnb_raw|ghpages|custom
  customDomain: '',
  linkFormat: 'markdown', // url | markdown | html | bbcode

  /**
   * 预览代理域名（可选）。
   * GitHub raw 在国内经常拉不动，填了自己的 CDN（如 https://cdn.yangjie.site）之后，
   * 文件管理页的预览 / 缩略图就会去请求 <proxyUrl>/<仓库内相对路径>，
   * 例：仓库 main 根目录的 111.avif -> https://cdn.yangjie.site/111.avif
   * 只是「读取时走代理」，不影响复制出去的链接（那由 linkRule 决定）。
   */
  proxyUrl: '',

  compress: {
    enabled: true,
    quality: 80,
    // 0 = 不限制：默认不动用户图片的尺寸，需要缩的时候自己填
    maxWidth: 0,
    maxHeight: 0,
    format: 'avif', // auto | keep | avif | webp | jpeg | png
    targetSizeKB: 0,
    skipIfSmaller: true,
    skipBelowKB: 100
  },

  watermark: {
    enabled: false,
    text: '',
    position: 'bottom-right',
    opacity: 0.35,
    fontSize: 22,
    color: '#1296db'
  },

  rename: {
    mode: 'keep', // keep | hash | timestamp
    prefix: '',
    hashLength: 8
  },

  concurrency: 0, // 0 = 自动按 CPU 核心数

  sync: {
    autoPull: true,
    strategy: 'pull' // pull | reset
  },

  ui: {
    theme: 'dark', // dark | light
    /**
     * 界面字体。留空 = 跟随系统默认（微软雅黑 UI / Segoe UI）。
     * 只影响界面，不参与渲染产物。
     */
    font: '',
    pageSize: 60
  }
};

/** profile 上「属于某个仓库」的字段：切 profile 时整组一起换 */
const PROFILE_FIELDS = ['platform', 'owner', 'repo', 'branch', 'apiBase', 'localDir'];

/**
 * 「草稿」= 还没有任何仓库信息、也从没验证过的空落点。
 *
 * 切平台、点「新建」都会开一个出来当落点，用户还没真正填过 ——
 * 这种半成品不该冒充成一份「归档配置」显示出来。早先它会原样出现在列表里，
 * 显示成「（未填写仓库）未绑定本地目录 · 待验证 · 无 Token」，看着像凭空多了一份。
 *
 * 它是**算出来的**、不落盘（见 get()）：只要填上仓库（owner + repo）或者验证通过，
 * 它立刻就是一份正经配置，不需要谁去记得把某个标记清掉 ——
 * 存标记的话，导入 / 迁移 / 手改配置都可能留下对不上的旧值。
 */
function isDraftProfile(p) {
  return !p.verified && !(p.owner && p.repo);
}

function newProfileId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 从当前顶层字段造一个 profile（迁移 / 兜底用） */
function profileFromTop(cfg, extra) {
  const p = { id: newProfileId(), name: '', verified: false, verifiedAt: 0, note: '', createdAt: Date.now() };
  for (const k of PROFILE_FIELDS) p[k] = cfg[k] || (k === 'branch' ? 'main' : '');
  if (cfg._tokenEnc) p._tokenEnc = cfg._tokenEnc;
  else if (cfg._tokenPlain) p._tokenPlain = cfg._tokenPlain;
  return Object.assign(p, extra || {});
}

/**
 * 老配置迁移。
 * v3：AVIF 编码器内置完成后，默认输出格式从「智能」改成 AVIF；
 *     之前一直没动过这个选项（还是 auto）的老配置跟着换一次，
 *     用户主动选过 webp/jpeg/png/keep 的则一律不动。
 * v4：引入「归档的仓库配置」。把现有的一组连接信息收成一个 profile，
 *     并保证 profiles/activeProfileId 始终有效（否则切换平台会没有落点）。
 */
function migrate(cfg) {
  const v = Number(cfg.version) || 0;
  if (v < 3) {
    if (cfg.compress && (!cfg.compress.format || cfg.compress.format === 'auto')) {
      cfg.compress.format = 'avif';
    }
    cfg.version = 3;
  }
  if (v < 4) {
    if (cfg._tokenEnc || cfg._tokenPlain || cfg.owner || cfg.repo) {
      cfg.profiles = [profileFromTop(cfg, { note: '原有配置' })];
    }
    // 水印默认色改成品牌蓝 #1296db（和界面主色一致）。
    // 跟 AVIF 那次的策略一样：只动「从没改过、还是旧默认白」的配置。
    if (cfg.watermark && (!cfg.watermark.color || cfg.watermark.color === '#ffffff')) {
      cfg.watermark.color = '#1296db';
    }
    cfg.version = 4;
  }
  if (v < 5) {
    // 路径模板取消：上传目标目录改到上传页自己选，占位符那套不再生效。
    // 这里把残留值删掉，免得老配置里留个看不见、却还会影响上传路径的字段。
    delete cfg.pathTemplate;
    cfg.version = 5;
  }
  if (v < 6) {
    // 之前预置了 1920 的最大宽高，等于偷偷替用户做了「缩图」的决定。
    // 改成默认不限制，只把「还停在旧默认值 1920」的配置还原成 0，
    // 用户自己填过的尺寸一律不动。
    if (cfg.compress) {
      if (Number(cfg.compress.maxWidth) === 1920) cfg.compress.maxWidth = 0;
      if (Number(cfg.compress.maxHeight) === 1920) cfg.compress.maxHeight = 0;
    }
    cfg.version = 6;
  }
  if (v < 7) {
    // Gitee 平台已下线（改用 CNB）。老配置里残留的 gitee 一律归到 github，
    // 否则设置页找不到对应的平台按钮、云端连不上还查不出原因。
    /**
     * 顺手清掉指向 Gitee 的自定义接口地址：平台已经改成 github，
     * 再留着 https://gitee.com/api/v5 只会让验证时报一个看不懂的错。
     * 并把这类「平台被换过」的配置标回未验证 —— 它原来的 Token 是 Gitee 的，
     * 不能继续冒充已验证。
     */
    const scrubApiBase = (obj) => {
      const api = String(obj.apiBase || '').toLowerCase();
      if (api.indexOf('gitee') >= 0) obj.apiBase = '';
    };
    const demote = (obj) => {
      if (!obj) return;
      if (obj.platform === 'gitee') {
        obj.platform = 'github';
        scrubApiBase(obj);
        obj.verified = false;
        obj.verifiedAt = 0;
        if (obj.repoInfo) delete obj.repoInfo;
        if (obj.userName) delete obj.userName;
      }
    };
    if (Array.isArray(cfg.profiles)) cfg.profiles.forEach(demote);
    if (cfg.platform === 'gitee') {
      cfg.platform = 'github';
      scrubApiBase(cfg);
    }
    cfg.platform = normalizePlatform(cfg.platform);
    cfg.version = 7;
  }
  if (!Array.isArray(cfg.profiles)) cfg.profiles = [];
  // 保证永远至少有一个 profile：切换平台 / 新建配置都要有落点
  if (!cfg.profiles.length) cfg.profiles = [profileFromTop(cfg)];
  if (!cfg.profiles.some((p) => p.id === cfg.activeProfileId)) {
    cfg.activeProfileId = cfg.profiles[0].id;
  }
  return cfg;
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    if (
      base &&
      typeof base[k] === 'object' &&
      base[k] !== null &&
      !Array.isArray(base[k]) &&
      typeof patch[k] === 'object' &&
      patch[k] !== null &&
      !Array.isArray(patch[k])
    ) {
      out[k] = deepMerge(base[k], patch[k]);
    } else {
      out[k] = patch[k];
    }
  }
  return out;
}

/** 把 from 上的 token（加密或明文）原样搬到 to，先清空 to 上的 */
function copyToken(from, to) {
  delete to._tokenEnc;
  delete to._tokenPlain;
  if (!from) return;
  if (from._tokenEnc) to._tokenEnc = from._tokenEnc;
  else if (from._tokenPlain) to._tokenPlain = from._tokenPlain;
}

/**
 * 配置目录一次性搬家。
 *
 * npm 包名从 local-file-upload-management-tool 改成了 Quick-FileDispatch，
 * 而 Electron 的 userData 目录就是「appData + 应用名」—— 改个名，老用户
 * 原本的 config.json（仓库信息 + Token + 归档配置）就凭空消失了，看起来
 * 像是「升级之后配置全没了」。
 *
 * 所以启动时先看一眼：新目录里还没有 config.json，就去旧目录把它拷过来。
 * 只在真的没有旧数据时拷一次，之后新目录里就有了，不会再动。
 */
function migrateLegacyUserData() {
  const dir = app.getPath('userData');
  const dest = path.join(dir, 'config.json');
  if (fs.existsSync(dest)) return;

  const appData = app.getPath('appData');
  for (const name of ['local-file-upload-management-tool']) {
    const oldDir = path.join(appData, name);
    if (path.resolve(oldDir) === path.resolve(dir)) continue;
    const src = path.join(oldDir, 'config.json');
    if (!fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, dest);
      console.log('[migrate] 已把旧配置搬到 ' + dest);
    } catch (e) {
      console.error('[migrate] 配置迁移失败：' + e.message);
    }
    return;
  }
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const merged = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), parsed);
      return migrate(merged);
    } catch (e) {
      return migrate(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    }
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 对外（渲染层）可见的配置：token 以掩码形式给出 */
  get() {
    const cfg = JSON.parse(JSON.stringify(this.data));
    const token = this.getToken();
    cfg.hasToken = !!token;
    cfg.tokenMask = token ? maskToken(token) : '';
    delete cfg._tokenEnc;
    delete cfg._tokenPlain;
    cfg.profiles = (this.data.profiles || []).map((p) => {
      const o = JSON.parse(JSON.stringify(p));
      const t = this._decryptToken(p);
      o.hasToken = !!t;
      o.tokenMask = t ? maskToken(t) : '';
      o.isActive = p.id === this.data.activeProfileId;
      o.label = p.name || [p.owner, p.repo].filter(Boolean).join('/') || '未命名配置';
      // 草稿是算出来的，不落盘 —— 渲染层只认这个字段决定要不要列出来
      o.draft = isDraftProfile(p);
      delete o._tokenEnc;
      delete o._tokenPlain;
      return o;
    });
    return cfg;
  }

  getRaw() {
    return this.data;
  }

  patch(patch) {
    // 单独处理 token
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'token')) {
      const t = patch.token;
      delete patch.token;
      if (t !== undefined && t !== null) {
        if (t === '') this.setToken('');
        else if (!/^\*+$/.test(String(t))) this.setToken(String(t));
      }
    }
    this.data = deepMerge(this.data, patch);
    this._syncActive();
    this._write();
    return this.get();
  }

  /* ------------------------------------------------------------ profile */

  activeProfile() {
    const list = this.data.profiles || [];
    return list.find((p) => p.id === this.data.activeProfileId) || null;
  }

  /** 把「当前生效」的连接字段 + token 写回 active profile */
  _syncActive() {
    const p = this.activeProfile();
    if (!p) return;
    for (const k of PROFILE_FIELDS) p[k] = this.data[k] || (k === 'branch' ? 'main' : '');
    copyToken(this.data, p);
  }

  /** 把 profile 的连接字段 + token 镜像到顶层（顶层才是全 app 读的那份） */
  _mirrorFrom(p) {
    for (const k of PROFILE_FIELDS) this.data[k] = p[k] || (k === 'branch' ? 'main' : '');
    copyToken(p, this.data);
    this.data.activeProfileId = p.id;
  }

  /**
   * 取某份配置的明文 Token（只给主进程内部用，不会经过 IPC 出去）。
   * 自己没存，就顺着「同平台 + 同 owner/repo/branch」找一份有 Token 的借用 ——
   * 导入进来的配置天生不带凭据，靠这条把可用性体检做得有意义。
   */
  getProfileToken(id) {
    const list = this.data.profiles || [];
    const p = list.find((x) => x.id === id);
    if (!p) return '';
    const own = this._decryptToken(p);
    if (own) return own;
    const same = list.find(
      (x) =>
        x.id !== p.id &&
        (x.platform || 'github') === (p.platform || 'github') &&
        (x.owner || '') === (p.owner || '') &&
        (x.repo || '') === (p.repo || '') &&
        (x.branch || 'main') === (p.branch || 'main')
    );
    return same ? this._decryptToken(same) : '';
  }

  profileById(id) {
    return (this.data.profiles || []).find((x) => x.id === id) || null;
  }

  _decryptToken(holder) {
    if (holder && holder._tokenEnc) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(holder._tokenEnc, 'base64'));
        }
      } catch (e) {
        /* fallthrough */
      }
    }
    return (holder && holder._tokenPlain) || '';
  }

  _encryptInto(holder, token) {
    delete holder._tokenEnc;
    delete holder._tokenPlain;
    if (!token) return;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        holder._tokenEnc = safeStorage.encryptString(token).toString('base64');
      } else {
        holder._tokenPlain = token;
      }
    } catch (e) {
      holder._tokenPlain = token;
    }
  }

  /**
   * 新建一个空白配置并切换过去。
   * 注意：patch() 是「改当前生效的那个」，新建必须走这里——
   * 否则用户点「新建配置」会变成把现有配置覆盖掉。
   *
   * 它是空的、没验证过，所以在渲染层看来就是「草稿」，不会出现在归档列表里
   * （见 isDraftProfile）；用户填上仓库、或点过「验证并归档」之后自然就露头了。
   */
  newProfile(patch) {
    const p = {
      id: newProfileId(),
      name: (patch && patch.name) || '',
      note: (patch && patch.note) || '',
      verified: false,
      verifiedAt: 0,
      createdAt: Date.now(),
      platform: normalizePlatform((patch && patch.platform) || this.data.platform),
      owner: '',
      repo: '',
      branch: 'main',
      apiBase: '',
      localDir: ''
    };
    // 允许把连接字段一起带进来建（设置页「配置某个平台 → 保存」走的就是这条）
    if (patch) for (const k of PROFILE_FIELDS) if (patch[k] !== undefined) p[k] = patch[k];
    if (!p.branch) p.branch = 'main';
    if (patch && patch.token) this._encryptInto(p, patch.token);
    this.data.profiles = this.data.profiles || [];
    this.data.profiles.push(p);
    /**
     * activate === false：只建，不抢「当前使用」这个位置。
     * 平台按钮现在只切「正在编辑的对象」，顺手把全局生效的配置也换掉是副作用。
     */
    if (!patch || patch.activate !== false) this._mirrorFrom(p);
    this._write();
    return this.get();
  }

  /** 按平台找落点：优先已验证的，其次最近创建的 */
  findByPlatform(platform) {
    const list = (this.data.profiles || []).filter((p) => (p.platform || 'github') === platform);
    if (!list.length) return null;
    const verified = list.filter((p) => p.verified);
    const pool = verified.length ? verified : list;
    return pool.sort((a, b) => (b.verifiedAt || b.createdAt || 0) - (a.verifiedAt || a.createdAt || 0))[0];
  }

  activateProfile(id) {
    const p = (this.data.profiles || []).find((x) => x.id === id);
    if (!p) throw new Error('配置不存在');
    this._mirrorFrom(p);
    this._write();
    return this.get();
  }

  /** 更新归档信息（名称 / 备注 / 验证结果）；允许顺带改连接字段 */
  updateProfile(id, patch) {
    const p = (this.data.profiles || []).find((x) => x.id === id);
    if (!p) throw new Error('配置不存在');
    // Token 也要能改到「非当前使用」的那份上（设置页可以编辑任意一份配置）
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'token')) {
      const t = patch.token;
      delete patch.token;
      if (t !== undefined && t !== null && !/^\*+$/.test(String(t))) {
        if (t === '') this._encryptInto(p, '');
        else this._encryptInto(p, String(t));
        if (p.id === this.data.activeProfileId) copyToken(p, this.data);
      }
    }
    const conn = {};
    for (const k of PROFILE_FIELDS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
        conn[k] = patch[k];
        delete patch[k];
      }
    }
    Object.assign(p, patch || {});
    if (Object.keys(conn).length) Object.assign(p, conn);
    // 改的是当前生效的那个：连接字段要立刻镜像回顶层
    if (p.id === this.data.activeProfileId && Object.keys(conn).length) {
      for (const k of PROFILE_FIELDS) this.data[k] = p[k] || (k === 'branch' ? 'main' : '');
    }
    this._write();
    return this.get();
  }

  /** 标记为已验证可用（= 归档完成）。同时它就不再是草稿了（见 isDraftProfile） */
  verifyProfile(id, info) {
    const p = (this.data.profiles || []).find((x) => x.id === id);
    if (!p) throw new Error('配置不存在');
    p.verified = true;
    p.verifiedAt = Date.now();
    if (info) {
      if (info.userName) p.userName = info.userName;
      if (info.repo) p.repoInfo = info.repo;
    }
    this._write();
    return this.get();
  }

  deleteProfile(id) {
    const list = this.data.profiles || [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('配置不存在');
    const wasActive = list[idx].id === this.data.activeProfileId;
    list.splice(idx, 1);
    if (!list.length) {
      // 删光了就补一个空的，别让「切换平台 / 新建」没有落点。
      // 它是空的、没验证过，所以在列表里也不会显示成一份配置（见 isDraftProfile）。
      list.push(profileFromTop(DEFAULT_CONFIG));
      this._mirrorFrom(list[0]);
    } else if (wasActive) {
      this._mirrorFrom(list[Math.min(idx, list.length - 1)]);
    }
    this._write();
    return this.get();
  }

  getToken() {
    return this._decryptToken(this.data);
  }

  /* ------------------------------------------------- 归档配置：导出 / 导入 */

  /**
   * 导出为可移植的 JSON。
   *
   * 只导出「换台电脑也能立刻用上」的东西：
   *   - 各份归档配置的仓库信息 **+ Token**（明文，导入端会用本机的 DPAPI 重新加密落盘）
   *   - 一份全局的「文件链接」配置（链接规则 / 自定义域名 / 链接格式 / 预览代理）
   *
   * 故意不导出本地路径：换台电脑后 D:\xxx 往往根本不存在，写进去只会让导入端
   * 指向一个不存在的目录。导入端拿到 localDir='' 之后会引导用户为本机重新绑定目录。
   *
   * ⚠️ Token 是明文落在 JSON 里的，导出前必须让用户明确确认（见 profile:export 的确认框）。
   */
  exportProfiles() {
    const cfg = this.data;
    return {
      kind: 'Quick-FileDispatch',
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: {
        linkRule: cfg.linkRule || 'auto',
        customDomain: cfg.customDomain || '',
        linkFormat: cfg.linkFormat || 'markdown',
        proxyUrl: cfg.proxyUrl || ''
      },
      profiles: (cfg.profiles || []).map((p) => {
        const o = {
          name: p.name || '',
          note: p.note || '',
          platform: normalizePlatform(p.platform),
          owner: p.owner || '',
          repo: p.repo || '',
          branch: p.branch || 'main',
          apiBase: p.apiBase || '',
          // Token 一起带走：不带上，换台机器等于要用户从头再配一遍
          token: this._decryptToken(p) || ''
        };
        if (p.userName) o.userName = p.userName;
        return o;
      })
    };
  }

  /**
   * 导入归档配置。
   *
   * - 一律分配新 id，避免和本机已有配置撞车；
   * - 一律标记为「未验证」：换台机器后本地目录还没绑，必须由用户补目录后重新验证；
   * - Token 跟着配置一起进来，用本机 DPAPI 重新加密落盘；
   * - 本地路径**不导入**：换台电脑路径多半不存在，交给渲染层引导用户重新绑定；
   * - 同平台 + 同 owner/repo 的视为重复，默认跳过（除非同一文件里出现两次）。
   *
   * 返回 { added, skipped, settingsApplied, profiles }，
   * 由渲染层接手「引导填本地路径 + 可用性体检」。
   */
  importProfiles(payload) {
    const incoming = (payload && payload.profiles) || [];
    if (!Array.isArray(incoming) || !incoming.length) {
      throw new Error('文件里没有可导入的配置');
    }
    this.data.profiles = this.data.profiles || [];
    const added = [];
    const skipped = [];

    const keyOf = (p) => [normalizePlatform(p.platform), (p.owner || '').toLowerCase(), (p.repo || '').toLowerCase()].join('|');
    const seen = new Set(this.data.profiles.map(keyOf));

    for (const raw of incoming) {
      const p = {
        id: newProfileId(),
        name: String(raw.name || '').slice(0, 60),
        note: String(raw.note || '').slice(0, 200),
        platform: normalizePlatform(raw.platform),
        owner: String(raw.owner || '').trim(),
        repo: String(raw.repo || '').trim(),
        branch: String(raw.branch || 'main').trim() || 'main',
        apiBase: String(raw.apiBase || '').trim(),
        // 本地路径绝不从文件里带过来 —— 换台机器它多半不存在，
        // 由渲染层在导入后引导用户为本机重新绑定（见 settings.js renderAvailability）
        localDir: '',
        verified: false,
        verifiedAt: 0,
        createdAt: Date.now(),
        imported: true
      };
      if (raw.userName) p.userName = String(raw.userName).slice(0, 80);
      // Token 直接用本机 DPAPI 重新加密，落盘的永远不是明文
      if (raw.token) this._encryptInto(p, String(raw.token));
      const k = keyOf(p);
      if (!p.owner || !p.repo) {
        skipped.push({ profile: p, reason: '缺少用户名或仓库名' });
        continue;
      }
      if (seen.has(k)) {
        skipped.push({ profile: p, reason: '本机已有相同配置' });
        continue;
      }
      seen.add(k);
      this.data.profiles.push(p);
      added.push(p);
    }

    // 顺带恢复「文件链接」的全局配置。这几项是全 app 共用的，
    // 跟着配置文件一起搬过去，换机器就不用再手抄一遍链接规则。
    const st = payload && payload.settings;
    let settingsApplied = false;
    if (st && typeof st === 'object') {
      const patch = {};
      if (st.linkRule) patch.linkRule = String(st.linkRule);
      if (typeof st.customDomain === 'string') patch.customDomain = st.customDomain;
      if (st.linkFormat) patch.linkFormat = String(st.linkFormat);
      if (typeof st.proxyUrl === 'string') patch.proxyUrl = st.proxyUrl;
      if (Object.keys(patch).length) {
        Object.assign(this.data, patch);
        settingsApplied = true;
      }
    }

    if (added.length || settingsApplied) this._write();
    const out = this.get();
    return {
      added: added.length,
      skipped: skipped.length,
      settingsApplied: settingsApplied,
      skippedDetail: skipped.map((s) => ({ label: s.profile.owner + '/' + s.profile.repo, reason: s.reason })),
      profiles: out.profiles,
      cfg: out
    };
  }

  setToken(token) {
    this._encryptInto(this.data, token || '');
    this._write();
  }

  reset() {
    this.data = migrate(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    this._write();
    return this.get();
  }
}

function maskToken(t) {
  if (t.length <= 8) return '********';
  return t.slice(0, 4) + '*'.repeat(Math.min(12, t.length - 8)) + t.slice(-4);
}

module.exports = { Store, DEFAULT_CONFIG, PLATFORMS, normalizePlatform, migrateLegacyUserData };
