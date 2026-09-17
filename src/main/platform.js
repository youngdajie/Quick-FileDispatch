'use strict';

/**
 * 云端平台统一客户端
 *
 * - GitHub：REST v3 + Git Data API（多文件一次提交、改名天然原子）
 * - CNB（cnb.cool）：官方 Open API，Bearer Token 鉴权
 *
 * ⚠️ CNB 的公开 Open API **没有** 创建 Tree / 创建 Commit / 更新 Ref 的接口
 *    （`POST /{repo}/-/git/blobs` 的说明里写着「通常与创建 Tree/Commit 接口配合使用」，
 *     但那两个接口并未开放）。孤立的 blob 没有 commit 落点，等于白造。
 *    所以 CNB 的「写」（上传 / 删除 / 改名 / 替换）统一交给 git CLI 完成，
 *    见 main/cnb.js；这里只负责「读」，以及 GitHub 的「读写」。
 *
 * 对外暴露统一的 listDir / uploadBatch / deleteBatch / whoami / repoInfo / headSha
 */

const GITHUB_API = 'https://api.github.com';
const CNB_API = 'https://api.cnb.cool';
/** CNB 的网页 / Git 地址（拿不到接口时拼接直链用） */
const CNB_WEB = 'https://cnb.cool';
/** CNB 仓库的 Git 远端（HTTPS，用户名为固定值 cnb，密码为访问令牌） */
const CNB_GIT_HOST = 'cnb.cool';

class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function b64encode(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
}

function b64decode(s) {
  return Buffer.from(String(s || '').replace(/\s/g, ''), 'base64');
}

function encodePath(p) {
  return String(p)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function trimSlashes(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

/** GitHub 单文件硬上限 100MB；CNB 单文件 200MB */
function fileLimitBytes(platform) {
  return platform === 'cnb' ? 200 * 1024 * 1024 : 100 * 1024 * 1024;
}

class CloudClient {
  constructor({ platform, owner, repo, branch, token, apiBase }) {
    this.platform = platform === 'cnb' ? 'cnb' : 'github';
    this.owner = trimSlashes(owner);
    this.repo = trimSlashes(repo);
    this.branch = branch || 'main';
    this.token = token || '';
    // 允许覆盖接口地址：便于自建 GitHub Enterprise 以及离线自测
    this.apiBase = trimSlashes(apiBase) ? String(apiBase).replace(/\/+$/, '') : this.isCnb ? CNB_API : GITHUB_API;
  }

  get isCnb() {
    return this.platform === 'cnb';
  }

  /** CNB 把「组织/仓库」当成一个整体标识：owner/repo */
  get slug() {
    return this.owner + '/' + this.repo;
  }

  /** CNB 仓库的 Git 远端地址（不带凭据） */
  get gitRemote() {
    return `https://${CNB_GIT_HOST}/${this.slug}.git`;
  }

  _url(pathname, query) {
    const url = new URL(this.apiBase + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  _headers(raw, accept) {
    const h = { 'User-Agent': 'JIE-Dispatch/1.2 (+https://www.yangjie.site)' };
    if (this.isCnb) {
      h.Accept = accept || 'application/vnd.cnb.api+json';
      if (this.token) h.Authorization = `Bearer ${this.token}`;
      return h;
    }
    h.Accept = accept || (raw ? 'application/vnd.github.raw' : 'application/vnd.github+json');
    h['X-GitHub-Api-Version'] = '2022-11-28';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async _req(method, pathname, { query, body, raw, accept } = {}) {
    const url = this._url(pathname, query);
    const init = { method, headers: this._headers(raw, accept) };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.headers['Content-Type'] = 'application/json;charset=UTF-8';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new ApiError(`网络请求失败：${e.message || e}`, 0, null);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }

    if (!res.ok) {
      const msg =
        (json && (json.message || json.error || json.msg || (Array.isArray(json.errors) && json.errors[0] && json.errors[0].message))) ||
        text ||
        res.statusText;
      throw new ApiError(normalizeError(this.platform, res.status, msg), res.status, { url, msg, json });
    }
    return json;
  }

  // ---------------------------------------------------------------- 账号

  async whoami() {
    const u = await this._req('GET', '/user');
    if (!u) throw new ApiError('无法读取账号信息', 0, null);
    if (this.isCnb) {
      return {
        login: u.username || '',
        name: u.nickname || u.username || '',
        avatar: u.avatar || '',
        htmlUrl: u.username ? `https://cnb.cool/${u.username}` : ''
      };
    }
    return {
      login: u.login || u.name || '',
      name: u.name || u.login || '',
      avatar: u.avatar_url || '',
      htmlUrl: u.html_url || ''
    };
  }

  async repoInfo() {
    if (this.isCnb) {
      const r = await this._req('GET', `/${this.slug}`);
      const vis = String(r.visibility_level || '');
      return {
        fullName: r.path || this.slug,
        private: !!vis && vis !== 'Public',
        sizeKB: 0,
        defaultBranch: 'main',
        htmlUrl: r.web_url || `${CNB_WEB}/${this.slug}`,
        description: r.description || '',
        permissions: r.access ? { access: r.access } : null
      };
    }
    const r = await this._req('GET', `/repos/${this.owner}/${this.repo}`);
    return {
      fullName: r.full_name,
      private: !!r.private,
      sizeKB: r.size || 0,
      defaultBranch: r.default_branch || r.default_branch_name || 'main',
      htmlUrl: r.html_url,
      description: r.description || '',
      permissions: r.permissions || null
    };
  }

  // ---------------------------------------------------------------- 读取

  /**
   * 列目录。path 为空表示仓库根目录。
   * 返回统一的条目结构 { name, path, type: 'dir'|'file', size, sha, downloadUrl }
   */
  async listDir(path = '') {
    const clean = trimSlashes(path);
    if (this.isCnb) return this._listDirCnb(clean);

    const pathname = `/repos/${this.owner}/${this.repo}/contents/${encodePath(clean)}`;
    let data;
    try {
      data = await this._req('GET', pathname, { query: { ref: this.branch } });
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
    if (!data) return [];
    const arr = Array.isArray(data) ? data : [data];
    return arr
      .map((it) => ({
        name: it.name,
        path: it.path,
        type: it.type === 'dir' ? 'dir' : 'file',
        size: it.size || 0,
        sha: it.sha || '',
        downloadUrl: it.download_url || '',
        gitUrl: it.url || ''
      }))
      .filter((it) => it.name);
  }

  async _listDirCnb(clean) {
    const base = `/${this.slug}/-/git/contents`;
    const pathname = clean ? `${base}/${encodePath(clean)}` : base;
    let data;
    try {
      data = await this._req('GET', pathname, { query: { ref: this.branch } });
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
    if (!data) return [];
    if (data.type === 'empty') return [];

    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length || data.type === 'tree') {
      return entries
        .map((it) => ({
          name: it.name,
          path: it.path,
          type: it.type === 'tree' || it.type === 'submodule' ? 'dir' : 'file',
          size: 0,
          sha: it.sha || '',
          downloadUrl: this.rawUrl(it.path),
          gitUrl: ''
        }))
        .filter((it) => it.name);
    }
    // 单文件：contents 指向的就是一个 blob
    if (data.type === 'blob' || data.type === 'lfs') {
      return [
        {
          name: data.name,
          path: data.path,
          type: 'file',
          size: data.size || 0,
          sha: data.sha || '',
          downloadUrl: this.rawUrl(data.path),
          gitUrl: ''
        }
      ];
    }
    return [];
  }

  /**
   * 递归统计仓库文件（用于配额提示）
   * budget.requests 限制总请求数，避免大仓库把接口配额刷爆
   */
  async countFiles(path = '', depth = 0, acc = null, budget = null) {
    const state = acc || { files: 0, bytes: 0, truncated: false };
    const b = budget || { requests: 0, max: 60 };
    if (depth > 6 || b.requests >= b.max) {
      state.truncated = true;
      return state;
    }
    b.requests += 1;
    let items = [];
    try {
      items = await this.listDir(path);
    } catch (e) {
      state.truncated = true;
      return state;
    }
    for (const it of items) {
      if (it.type === 'dir') await this.countFiles(it.path, depth + 1, state, b);
      else {
        state.files += 1;
        state.bytes += it.size;
      }
      if (b.requests >= b.max) {
        state.truncated = true;
        break;
      }
    }
    return state;
  }

  /** 读取单个文件内容（<= 1MB 时可用），返回 Buffer 或 null */
  async readFile(path) {
    try {
      const data = await this._contentEntry(path);
      if (data && data.content) return b64decode(data.content);
      return null;
    } catch (e) {
      return null;
    }
  }

  /** 读取单个文件 SHA（GitHub 删除时必需；CNB 走 git 通道，这里用于比对） */
  async fileSha(path) {
    try {
      const data = await this._contentEntry(path);
      if (Array.isArray(data)) return null;
      return data && data.sha ? data.sha : null;
    } catch (e) {
      return null;
    }
  }

  /** contents 接口的原始返回（GitHub / CNB 各自的形状归一到这里） */
  async _contentEntry(path) {
    const clean = trimSlashes(path);
    if (this.isCnb) {
      const pathname = `/${this.slug}/-/git/contents/${encodePath(clean)}`;
      return this._req('GET', pathname, { query: { ref: this.branch } });
    }
    const pathname = `/repos/${this.owner}/${this.repo}/contents/${encodePath(clean)}`;
    return this._req('GET', pathname, { query: { ref: this.branch } });
  }

  /** 读取原始二进制内容（私有仓库也可用），用于界面缩略图代理 */
  async readRaw(path) {
    const clean = trimSlashes(path);
    if (this.isCnb) {
      const url = this._url(`/${this.slug}/-/git/raw/${encodeURIComponent(this.branch)}/${encodePath(clean)}`);
      const res = await fetch(url, { headers: this._headers(true) });
      if (!res.ok) throw new ApiError(`读取文件失败（HTTP ${res.status}）`, res.status, null);
      return Buffer.from(await res.arrayBuffer());
    }

    const pathname = `/repos/${this.owner}/${this.repo}/contents/${encodePath(clean)}`;
    const res = await fetch(this._url(pathname, { ref: this.branch }), { headers: this._headers(true) });
    if (!res.ok) throw new ApiError(`读取文件失败（HTTP ${res.status}）`, res.status, null);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 取分支 HEAD 的完整 commit SHA —— 云端同步检测器就靠它和本地 HEAD 比对。
   * 读不到（分支不存在 / 空仓库）返回空串，让调用方去提示用户，而不是抛错。
   */
  async headSha(branch) {
    const b = branch || this.branch;
    try {
      if (this.isCnb) {
        const d = await this._req('GET', `/${this.slug}/-/git/branches/${encodeURIComponent(b)}`);
        return (d && d.commit && d.commit.sha) || '';
      }
      const r = await this._req('GET', `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(b)}`);
      if (r && r.object && r.object.sha) return r.object.sha;
      return '';
    } catch (e) {
      if (e.status === 404 || e.status === 409) return '';
      throw e;
    }
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 批量上传。files: [{ path, buff }]
   * GitHub 使用 Git Data API 一次提交；
   * CNB 的公开 API 造不了 commit，必须走 git CLI —— 调用方应先分流到 main/cnb.js。
   */
  async uploadBatch(files, message) {
    if (!files.length) return [];
    if (this.isCnb) throw new ApiError(CNB_WRITE_HINT, 0, null);
    return this._uploadBatchGitData(files, message);
  }

  async _uploadBatchGitData(files, message) {
    const refPath = `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`;
    const ref = await this._req('GET', refPath);
    const parentSha = ref.object.sha;
    const parentCommit = await this._req('GET', `/repos/${this.owner}/${this.repo}/git/commits/${parentSha}`);
    const baseTree = parentCommit.tree.sha;

    const tree = [];
    for (const f of files) {
      const blob = await this._req('POST', `/repos/${this.owner}/${this.repo}/git/blobs`, {
        body: { content: b64encode(f.buff), encoding: 'base64' }
      });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await this._req('POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
      body: { base_tree: baseTree, tree }
    });

    const commit = await this._req('POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
      body: { message: message || 'upload images', tree: newTree.sha, parents: [parentSha] }
    });

    await this._req('PATCH', refPath, { body: { sha: commit.sha, force: false } });
    return files.map((f) => ({ path: f.path, ok: true, error: null }));
  }

  /** 批量删除 */
  async deleteBatch(paths, message) {
    if (!paths.length) return [];
    if (this.isCnb) throw new ApiError(CNB_WRITE_HINT, 0, null);
    const results = [];
    for (const p of paths) {
      try {
        const sha = await this.fileSha(p);
        if (!sha) {
          results.push({ path: p, ok: false, error: '文件不存在或已被删除' });
          continue;
        }
        await this._req('DELETE', `/repos/${this.owner}/${this.repo}/contents/${encodePath(p)}`, {
          body: {
            message: message || `chore: delete ${p}`,
            sha,
            branch: this.branch
          }
        });
        results.push({ path: p, ok: true, error: null });
      } catch (e) {
        results.push({ path: p, ok: false, error: e.message });
      }
    }
    return results;
  }

  /**
   * 批量移动 / 重命名。items: [{ from, to }]
   * GitHub 走 Git Data API —— 内容重建 + 旧路径删除，整批只产生一次提交，天然原子。
   */
  async moveBatch(items, message) {
    if (!items.length) return [];
    if (this.isCnb) throw new ApiError(CNB_WRITE_HINT, 0, null);
    return this._moveBatchGitData(items, message);
  }

  async _moveBatchGitData(items, message) {
    const refPath = `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`;
    const ref = await this._req('GET', refPath);
    const parentSha = ref.object.sha;
    const parentCommit = await this._req('GET', `/repos/${this.owner}/${this.repo}/git/commits/${parentSha}`);
    const baseTree = parentCommit.tree.sha;

    const tree = [];
    for (const it of items) {
      const buf = await this.readRaw(it.from);
      const blob = await this._req('POST', `/repos/${this.owner}/${this.repo}/git/blobs`, {
        body: { content: b64encode(buf), encoding: 'base64' }
      });
      tree.push({ path: it.to, mode: '100644', type: 'blob', sha: blob.sha });
      // sha: null 表示删除该路径
      tree.push({ path: it.from, mode: '100644', type: 'blob', sha: null });
    }

    const newTree = await this._req('POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
      body: { base_tree: baseTree, tree }
    });
    const commit = await this._req('POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
      body: { message: message || 'chore: move files', tree: newTree.sha, parents: [parentSha] }
    });
    await this._req('PATCH', refPath, { body: { sha: commit.sha, force: false } });

    return items.map((it) => ({ path: it.to, from: it.from, ok: true, error: null }));
  }

  /** 生成文件在仓库中的直链（按平台默认规则） */
  rawUrl(path) {
    const p = trimSlashes(path);
    if (this.isCnb) {
      return `${CNB_WEB}/${this.slug}/-/git/raw/${this.branch}/${p}`;
    }
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${p}`;
  }
}

const CNB_WRITE_HINT =
  'CNB 的公开接口不支持直接创建提交（没有 Tree/Commit 接口），写入需要通过 Git 完成';

function normalizeError(platform, status, msg) {
  const m = String(msg || '').toLowerCase();
  if (status === 401) return platform === 'cnb' ? 'Token 无效或已过期（CNB 需选「经典令牌」并勾选 repo-code 读写）' : 'Token 无效或已过期';
  if (status === 403) {
    if (m.includes('rate limit')) return '触发接口频率限制，请稍后重试或更换 Token';
    return '没有权限：请确认 Token 勾选了仓库读写权限';
  }
  if (status === 404) {
    if (platform === 'cnb' && /mcp|token/.test(m)) {
      return 'CNB 返回 404：多半是 Token 类型不对 —— MCP 令牌不能调 REST 接口，请改用「经典令牌」';
    }
    return '仓库或分支不存在：请检查用户名 / 仓库名 / 分支名，以及 Token 是否可访问该私有仓库';
  }
  if (status === 422) return `请求被拒绝（可能文件过大或路径非法）：${msg}`;
  if (status === 413) return '文件体积超过平台限制';
  return msg || `请求失败（HTTP ${status}）`;
}

module.exports = {
  CloudClient,
  ApiError,
  fileLimitBytes,
  GITHUB_API,
  CNB_API,
  CNB_WEB,
  CNB_GIT_HOST,
  CNB_WRITE_HINT
};
