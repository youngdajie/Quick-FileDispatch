'use strict';

/**
 * 云端平台统一客户端
 * 支持 GitHub（REST v3 + Git Data API）与 Gitee（REST v5）
 * 对外暴露统一的 listDir / uploadBatch / deleteBatch / whoami / repoInfo
 */

const GITHUB_API = 'https://api.github.com';
const GITEE_API = 'https://gitee.com/api/v5';

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

function encodePath(p) {
  return String(p)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/** GitHub 单文件硬上限 100MB；Gitee 免费版单文件 50MB */
function fileLimitBytes(platform) {
  return platform === 'gitee' ? 50 * 1024 * 1024 : 100 * 1024 * 1024;
}

class CloudClient {
  constructor({ platform, owner, repo, branch, token, apiBase }) {
    this.platform = platform === 'gitee' ? 'gitee' : 'github';
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
    this.token = token || '';
    // 允许覆盖接口地址：便于自建 GitHub Enterprise / 私有 Gitee 以及离线测试
    this.apiBase = apiBase || (this.isGitee ? GITEE_API : GITHUB_API);
  }

  get isGitee() {
    return this.platform === 'gitee';
  }

  _url(pathname, query) {
    const url = new URL(this.apiBase + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    if (this.isGitee && this.token) url.searchParams.set('access_token', this.token);
    return url.toString();
  }

  async _req(method, pathname, { query, body, raw } = {}) {
    const headers = {
      'User-Agent': 'JIE-Dispatch/1.2 (+https://www.yangjie.site)'
    };
    if (this.isGitee) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
    } else {
      headers['Accept'] = raw ? 'application/vnd.github.raw' : 'application/vnd.github+json';
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    }

    const url = this._url(pathname, query);
    const init = { method, headers };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
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
        (json && (json.message || json.error || (Array.isArray(json.errors) && json.errors[0] && json.errors[0].message))) ||
        text ||
        res.statusText;
      throw new ApiError(normalizeError(this.platform, res.status, msg), res.status, { url, msg, json });
    }
    return json;
  }

  // ---------------------------------------------------------------- 账号

  async whoami() {
    const u = await this._req('GET', this.isGitee ? '/user' : '/user');
    if (!u) throw new ApiError('无法读取账号信息', 0, null);
    return {
      login: u.login || u.name || '',
      name: u.name || u.login || '',
      avatar: u.avatar_url || '',
      htmlUrl: u.html_url || ''
    };
  }

  async repoInfo() {
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
   * 返回统一的条目结构
   */
  async listDir(path = '') {
    const clean = String(path).replace(/^\/+|\/+$/g, '');
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

  /** 读取单个文件内容（<= 1MB 时可用），返回 base64 或 null */
  async readFile(path) {
    try {
      const data = await this._req('GET', `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`, {
        query: { ref: this.branch }
      });
      if (data && data.content) {
        return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64');
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /** 读取单个文件 SHA（删除时必需，Gitee 尤其严格） */
  async fileSha(path) {    try {
      const data = await this._req('GET', `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`, {
        query: { ref: this.branch }
      });
      if (Array.isArray(data)) return null;
      return data && data.sha ? data.sha : null;
    } catch (e) {
      return null;
    }
  }

  /** 读取原始二进制内容（私有仓库也可用），用于界面缩略图代理 */
  async readRaw(path) {
    const clean = String(path).replace(/^\/+/, '');
    const pathname = `/repos/${this.owner}/${this.repo}/contents/${encodePath(clean)}`;

    if (!this.isGitee) {
      const res = await fetch(this._url(pathname, { ref: this.branch }), {
        headers: {
          'User-Agent': 'JIE-Dispatch/1.2',
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        }
      });
      if (!res.ok) throw new ApiError(`读取文件失败（HTTP ${res.status}）`, res.status, null);
      return Buffer.from(await res.arrayBuffer());
    }

    // Gitee：优先走 contents API 的 base64 字段，失败再尝试 download_url
    const data = await this._req('GET', pathname, { query: { ref: this.branch } });
    if (data && data.content) {
      return Buffer.from(String(data.content).replace(/\s/g, ''), 'base64');
    }
    const url = data && (data.download_url || data.html_url);
    if (url) {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    }
    throw new ApiError('Gitee 无法读取该文件内容（可能超出接口体积上限）', 0, null);
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 批量上传。files: [{ path, buff, }]
   * GitHub 使用 Git Data API 一次提交；Gitee 使用 Contents API 逐个提交
   * 返回 [{ path, ok, error }]
   */
  async uploadBatch(files, message) {
    if (!files.length) return [];
    if (this.isGitee) return this._uploadBatchContents(files, message);
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

  async _uploadBatchContents(files, message) {
    const results = [];
    for (const f of files) {
      try {
        const sha = await this.fileSha(f.path);
        const payload = {
          message: message || 'upload images',
          content: b64encode(f.buff),
          branch: this.branch
        };
        if (sha) payload.sha = sha;
        await this._req(sha ? 'PUT' : 'POST', `/repos/${this.owner}/${this.repo}/contents/${encodePath(f.path)}`, {
          body: payload
        });
        results.push({ path: f.path, ok: true, error: null });
      } catch (e) {
        results.push({ path: f.path, ok: false, error: e.message });
      }
    }
    return results;
  }

  /** 批量删除 */
  async deleteBatch(paths, message) {
    if (!paths.length) return [];
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
   * GitHub 走 Git Data API —— 内容重建 + 旧路径删除，整批只产生一次提交，天然原子；
   * Gitee 没有改名接口，退化为「先建新文件、再删旧文件」两次提交。
   */
  async moveBatch(items, message) {
    if (!items.length) return [];
    if (this.isGitee) return this._moveBatchContents(items, message);
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

  async _moveBatchContents(items, message) {
    const results = [];
    for (const it of items) {
      try {
        const buf = await this.readRaw(it.from);
        const existSha = await this.fileSha(it.to);
        const createPayload = {
          message: message || `chore: move ${it.from} → ${it.to}`,
          content: b64encode(buf),
          branch: this.branch
        };
        if (existSha) createPayload.sha = existSha;
        await this._req(existSha ? 'PUT' : 'POST', `/repos/${this.owner}/${this.repo}/contents/${encodePath(it.to)}`, {
          body: createPayload
        });

        const oldSha = await this.fileSha(it.from);
        if (oldSha) {
          await this._req('DELETE', `/repos/${this.owner}/${this.repo}/contents/${encodePath(it.from)}`, {
            body: { message: `chore: remove ${it.from}`, sha: oldSha, branch: this.branch }
          });
        }
        results.push({ path: it.to, from: it.from, ok: true, error: null });
      } catch (e) {
        results.push({ path: it.to, from: it.from, ok: false, error: e.message });
      }
    }
    return results;
  }

  /** 生成文件在仓库中的直链（按规则） */
  rawUrl(path) {
    const p = String(path).replace(/^\/+/, '');
    if (this.isGitee) {
      return `https://gitee.com/${this.owner}/${this.repo}/raw/${this.branch}/${p}`;
    }
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${p}`;
  }
}

function normalizeError(platform, status, msg) {
  const m = String(msg || '').toLowerCase();
  if (status === 401) {
    return platform === 'gitee' ? 'Token 无效或已过期（Gitee 需勾选 projects 权限）' : 'Token 无效或已过期';
  }
  if (status === 403) {
    if (m.includes('rate limit')) return '触发接口频率限制，请稍后重试或更换 Token';
    return '没有权限：请确认 Token 勾选了仓库读写权限';
  }
  if (status === 404) {
    return '仓库或分支不存在：请检查用户名 / 仓库名 / 分支名，以及 Token 是否可访问该私有仓库';
  }
  if (status === 422) return `请求被拒绝（可能文件过大或路径非法）：${msg}`;
  if (status === 413) return '文件体积超过平台限制';
  return msg || `请求失败（HTTP ${status}）`;
}

module.exports = { CloudClient, ApiError, fileLimitBytes, GITHUB_API, GITEE_API };
