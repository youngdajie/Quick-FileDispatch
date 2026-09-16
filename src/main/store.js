'use strict';

/**
 * 配置持久化
 * - 存于 Electron userData/config.json
 * - Token 使用系统级加密（Windows DPAPI / safeStorage），落盘不明文
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_CONFIG = {
  version: 5,
  onboarded: false,
  platform: 'github', // github | gitee
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

  linkRule: 'auto', // auto|github_raw|jsdelivr|statically|githack|gitee_raw|ghpages|custom
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
    maxWidth: 1920,
    maxHeight: 1920,
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
   */
  newProfile(patch) {
    const p = {
      id: newProfileId(),
      name: (patch && patch.name) || '',
      note: (patch && patch.note) || '',
      verified: false,
      verifiedAt: 0,
      createdAt: Date.now(),
      platform: (patch && patch.platform) || this.data.platform || 'github',
      owner: '',
      repo: '',
      branch: 'main',
      apiBase: '',
      localDir: ''
    };
    this.data.profiles = this.data.profiles || [];
    this.data.profiles.push(p);
    this._mirrorFrom(p);
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

  /** 标记为已验证可用（= 归档完成） */
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
      // 删光了就补一个空的，别让「切换平台 / 新建」没有落点
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
   * 故意不导出 Token：落盘的 Token 是 Windows DPAPI 加密的，密钥绑在这台机器上，
   * 换台电脑根本解不开；与其导出一串废密文，不如明确告诉用户「导入后要补 Token」。
   */
  exportProfiles() {
    return {
      kind: 'jie-dispatch-profiles',
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles: (this.data.profiles || []).map((p) => {
        const o = {
          name: p.name || '',
          note: p.note || '',
          platform: p.platform || 'github',
          owner: p.owner || '',
          repo: p.repo || '',
          branch: p.branch || 'main',
          apiBase: p.apiBase || '',
          localDir: p.localDir || ''
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
   * - 一律标记为「未验证」：换台机器后 Token 没了、本地目录也未必在，
   *   必须由用户补 Token 后重新跑一次验证，不能直接冒充「已验证」；
   * - 同名同仓库同目录的视为重复，默认跳过（除非同一文件里出现两次）。
   *
   * 返回 { added, skipped, profiles }，由渲染层接手「可用性体检 + 引导修改」。
   */
  importProfiles(payload) {
    const incoming = (payload && payload.profiles) || [];
    if (!Array.isArray(incoming) || !incoming.length) {
      throw new Error('文件里没有可导入的配置');
    }
    this.data.profiles = this.data.profiles || [];
    const added = [];
    const skipped = [];

    const keyOf = (p) =>
      [p.platform || 'github', (p.owner || '').toLowerCase(), (p.repo || '').toLowerCase(), p.localDir || ''].join('|');
    const seen = new Set(this.data.profiles.map(keyOf));

    for (const raw of incoming) {
      const p = {
        id: newProfileId(),
        name: String(raw.name || '').slice(0, 60),
        note: String(raw.note || '').slice(0, 200),
        platform: raw.platform === 'gitee' ? 'gitee' : 'github',
        owner: String(raw.owner || '').trim(),
        repo: String(raw.repo || '').trim(),
        branch: String(raw.branch || 'main').trim() || 'main',
        apiBase: String(raw.apiBase || '').trim(),
        localDir: String(raw.localDir || '').trim(),
        verified: false,
        verifiedAt: 0,
        createdAt: Date.now(),
        imported: true
      };
      if (raw.userName) p.userName = String(raw.userName).slice(0, 80);
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

    if (added.length) this._write();
    const out = this.get();
    return {
      added: added.length,
      skipped: skipped.length,
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

module.exports = { Store, DEFAULT_CONFIG };
