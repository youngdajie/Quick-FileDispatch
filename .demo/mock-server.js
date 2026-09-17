'use strict';

/**
 * 常驻的假 GitHub API（端口 8799），用于端到端跑通
 * 「拖拽 → 压缩 → 上传 → 生成链接」以及「改名 / 移动 / 替换 / 删除」。
 * 只实现程序会用到的接口，并严格校验请求形状。
 */

const http = require('http');

const PORT = 8799;
const OWNER = 'youngdajie';
const REPO_NAME = 'my-images';

/** path -> { sha, size, b64 } */
const REPO = {};
/** sha -> { size, b64 } */
const BLOBS = {};
let commitSeq = 0;
let pendingTree = [];
let pendingMessage = '';

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

/** 列目录：返回 dir 下一层的条目 */
function listDir(dir) {
  const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
  const dirs = new Set();
  const files = [];
  Object.keys(REPO).forEach((p) => {
    if (!p.startsWith(prefix)) return;
    const rest = p.slice(prefix.length);
    if (!rest) return;
    const seg = rest.split('/');
    if (seg.length > 1) dirs.add(prefix + seg[0]);
    else files.push({ name: seg[0], path: p, type: 'file', sha: REPO[p].sha, size: REPO[p].size });
  });
  const dirItems = Array.from(dirs).map((d) => ({ name: d.split('/').pop(), path: d, type: 'dir', sha: 'dir-' + d, size: 0 }));
  return dirItems.concat(files);
}

/* ================================================================
 * CNB 假接口
 * CNB 的仓库标识是「组织/仓库」一个整体；读接口在 api.cnb.cool 上，
 * 路径形如 /{slug}/-/git/contents、/{slug}/-/git/branches/{branch}。
 * ================================================================ */
const CNB_SLUG = 'youngdajie/cnb-files';
const CNB_BRANCH = 'main';
const CNB_SHA = '3888a2a1000000000000000000000000000000ff';
/** path -> utf8 content */
const CNB_REPO = {
  'docs/readme.md': '# cnb demo repo',
  'images/2026/09/seed-c.png': 'CNB-SEED-C'
};

function cnbTree(dir) {
  const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
  const dirs = new Set();
  const files = [];
  Object.keys(CNB_REPO).forEach((path) => {
    if (!path.startsWith(prefix)) return;
    const rest = path.slice(prefix.length);
    if (!rest) return;
    const seg = rest.split('/');
    if (seg.length > 1) dirs.add(prefix + seg[0]);
    else files.push(path);
  });
  const entries = Array.from(dirs).map((d) => ({ name: d.split('/').pop(), path: d, sha: 'tree-' + d, type: 'tree' }));
  files.forEach((path) => {
    entries.push({ name: path.split('/').pop(), path: path, sha: 'blob-' + path, type: 'blob' });
  });
  return entries;
}

function cnb(req, res, p, u, body) {
  const base = '/' + CNB_SLUG;
  if (p === '/user') {
    return json(res, 200, { username: OWNER, nickname: 'youngdajie', avatar: '', email: 'ok@yangjie.site' });
  }
  if (p === base) {
    return json(res, 200, {
      id: 'repo-1',
      name: 'cnb-files',
      path: CNB_SLUG,
      description: 'CNB 假仓库',
      visibility_level: 'Public',
      web_url: 'https://cnb.cool/' + CNB_SLUG,
      access: 'Owner'
    });
  }
  const branchM = p.match(new RegExp('^' + base + '/-/git/branches/(.+)$'));
  if (branchM && req.method === 'GET') {
    if (decodeURIComponent(branchM[1]) !== CNB_BRANCH) return json(res, 404, { message: 'branch not found' });
    return json(res, 200, {
      name: CNB_BRANCH,
      protected: false,
      locked: false,
      commit: { sha: CNB_SHA, commit: { message: 'test commit' } }
    });
  }
  const rawM = p.match(new RegExp('^' + base + '/-/git/raw/([^/]+)/(.+)$'));
  if (rawM) {
    const ref = decodeURIComponent(rawM[1]);
    const filePath = decodeURIComponent(rawM[2]);
    if (ref !== CNB_BRANCH || !(filePath in CNB_REPO)) return json(res, 404, { message: 'Not Found' });
    const raw = Buffer.from(CNB_REPO[filePath], 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': raw.length });
    return res.end(raw);
  }
  const contentBase = base + '/-/git/contents';
  if (p === contentBase || p.startsWith(contentBase + '/')) {
    const dir = p === contentBase ? '' : decodeURIComponent(p.slice(contentBase.length + 1));
    if (dir && CNB_REPO[dir] !== undefined) {
      const content = Buffer.from(CNB_REPO[dir], 'utf8');
      return json(res, 200, {
        name: dir.split('/').pop(),
        path: dir,
        type: 'blob',
        sha: 'blob-' + dir,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64')
      });
    }
    const entries = cnbTree(dir);
    if (!entries.length) return json(res, 200, { type: 'empty', path: dir, entries: [] });
    return json(res, 200, { type: 'tree', path: dir, sha: 'tree-' + dir, entries: entries });
  }
  return json(res, 404, { message: 'mock(cnb) 未覆盖: ' + req.method + ' ' + p });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(u.pathname);
  const body = req.method === 'GET' ? null : await readBody(req);
  const wantsRaw = String(req.headers.accept || '').indexOf('vnd.github.raw') >= 0;
  const wantsCnb = String(req.headers.accept || '').indexOf('vnd.cnb.api+json') >= 0;

  if (p === '/__state') {
    return json(res, 200, {
      files: Object.keys(REPO).sort().map((k) => ({ path: k, size: REPO[k].size })),
      commits: commitSeq,
      blobs: Object.keys(BLOBS).length,
      lastMessage: pendingMessage
    });
  }
  if (p === '/__reset') {
    Object.keys(REPO).forEach((k) => delete REPO[k]);
    Object.keys(BLOBS).forEach((k) => delete BLOBS[k]);
    commitSeq = 0;
    pendingTree = [];
    pendingMessage = '';
    return json(res, 200, { ok: true });
  }
  if (p === '/__seed') {
    // 预置一些文件，供管理页远端浏览 / 改动测试
    const seeds = [
      ['images/2026/09/seed-a.png', 'SEED-FILE-A-CONTENT'],
      ['images/2026/09/seed-b.png', 'SEED-FILE-B'],
      ['docs/readme.md', '# demo repo']
    ];
    seeds.forEach(([path, content]) => {
      const b64 = Buffer.from(content).toString('base64');
      const sha = 'seed-' + path;
      BLOBS[sha] = { size: Buffer.from(content).length, b64 };
      REPO[path] = { sha, size: Buffer.from(content).length, b64 };
    });
    return json(res, 200, { ok: true, files: Object.keys(REPO).length });
  }

  if (!/^Bearer .+/.test(req.headers.authorization || '')) {
    return json(res, 401, { message: 'Bad credentials' });
  }

  /* ================================================================
   * CNB（cnb.cool）形状的接口。
   * CNB 与 GitHub 的 /user 撞路径，靠 Accept 头区分：
   * 我们的 CNB 客户端固定发 application/vnd.cnb.api+json。
   * CNB 的写入走 git CLI（公开接口没有创建提交的端点），所以这里只做读。
   * ================================================================ */
  if (wantsCnb) return cnb(req, res, p, u, body);

  if (p === '/user') return json(res, 200, { login: OWNER, name: OWNER, avatar_url: '', html_url: '' });
  if (p === `/repos/${OWNER}/${REPO_NAME}`) {
    return json(res, 200, { full_name: `${OWNER}/${REPO_NAME}`, private: false, size: 128, default_branch: 'main', html_url: '' });
  }

  const refPath = `/repos/${OWNER}/${REPO_NAME}/git/ref/heads/main`;
  if (p === refPath && req.method === 'GET') return json(res, 200, { object: { sha: 'commit-' + commitSeq } });
  if (p === `/repos/${OWNER}/${REPO_NAME}/git/commits/commit-` + commitSeq && req.method === 'GET') {
    return json(res, 200, { sha: 'commit-' + commitSeq, tree: { sha: 'tree-' + commitSeq } });
  }
  if (p === `/repos/${OWNER}/${REPO_NAME}/git/blobs` && req.method === 'POST') {
    if (!body.content || body.encoding !== 'base64') return json(res, 422, { message: 'Invalid blob' });
    const raw = Buffer.from(body.content, 'base64');
    const sha = 'blob-' + (Object.keys(BLOBS).length + 1);
    BLOBS[sha] = { size: raw.length, b64: body.content };
    return json(res, 201, { sha: sha });
  }
  if (p === `/repos/${OWNER}/${REPO_NAME}/git/trees` && req.method === 'POST') {
    if (body.base_tree !== 'tree-' + commitSeq) return json(res, 422, { message: 'base_tree 不匹配: ' + body.base_tree });
    const entries = body.tree || [];
    // 每个条目必须能解析到 blob（sha: null 表示删除）
    for (const e of entries) {
      if (e.sha !== null && !BLOBS[e.sha]) return json(res, 422, { message: '未知 blob: ' + e.sha });
      if (e.mode !== '100644' || e.type !== 'blob') return json(res, 422, { message: 'tree 条目结构不对' });
    }
    pendingTree = entries;
    return json(res, 201, { sha: 'tree-' + (commitSeq + 1) });
  }
  if (p === `/repos/${OWNER}/${REPO_NAME}/git/commits` && req.method === 'POST') {
    if (!body.parents || body.parents[0] !== 'commit-' + commitSeq) return json(res, 422, { message: 'parents 不匹配' });
    commitSeq += 1;
    pendingMessage = body.message || '';
    pendingTree.forEach((e) => {
      if (e.sha === null) {
        delete REPO[e.path];
        return;
      }
      const blob = BLOBS[e.sha];
      REPO[e.path] = { sha: e.sha, size: blob ? blob.size : 0, b64: blob ? blob.b64 : '' };
    });
    return json(res, 201, { sha: 'commit-' + commitSeq });
  }
  if (p === refPath && req.method === 'PATCH') {
    if (body.sha !== 'commit-' + commitSeq) return json(res, 422, { message: 'ref sha 不匹配' });
    return json(res, 200, { object: { sha: body.sha } });
  }

  if (p.startsWith(`/repos/${OWNER}/${REPO_NAME}/contents`)) {
    const rel = p.replace(`/repos/${OWNER}/${REPO_NAME}/contents`, '').replace(/^\//, '');
    if (req.method === 'GET') {
      if (rel && REPO[rel] && wantsRaw) {
        const raw = Buffer.from(REPO[rel].b64, 'base64');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': raw.length });
        return res.end(raw);
      }
      if (!rel) return json(res, 200, listDir(''));
      if (REPO[rel]) {
        return json(res, 200, {
          name: rel.split('/').pop(),
          path: rel,
          type: 'file',
          sha: REPO[rel].sha,
          size: REPO[rel].size,
          content: REPO[rel].b64,
          encoding: 'base64'
        });
      }
      const sub = listDir(rel);
      if (sub.length) return json(res, 200, sub);
      return json(res, 404, { message: 'Not Found' });
    }
    if (req.method === 'PUT') {
      if (!REPO[rel]) return json(res, 404, { message: 'Not Found，应使用 POST' });
      if (body.sha !== REPO[rel].sha) return json(res, 409, { message: 'sha 不匹配' });
      const raw = Buffer.from(body.content || '', 'base64');
      const sha = 'put-' + rel + '-' + commitSeq;
      BLOBS[sha] = { size: raw.length, b64: body.content };
      REPO[rel] = { sha, size: raw.length, b64: body.content };
      commitSeq += 1;
      pendingMessage = body.message || '';
      return json(res, 200, { content: { path: rel } });
    }
    if (req.method === 'POST') {
      if (REPO[rel]) return json(res, 409, { message: '已存在，应使用 PUT' });
      const raw = Buffer.from(body.content || '', 'base64');
      const sha = 'post-' + rel + '-' + commitSeq;
      BLOBS[sha] = { size: raw.length, b64: body.content };
      REPO[rel] = { sha, size: raw.length, b64: body.content };
      commitSeq += 1;
      pendingMessage = body.message || '';
      return json(res, 201, { content: { path: rel } });
    }
    if (req.method === 'DELETE') {
      if (!REPO[rel]) return json(res, 404, { message: 'Not Found' });
      delete REPO[rel];
      commitSeq += 1;
      pendingMessage = body.message || '';
      return json(res, 200, { commit: { sha: 'commit-' + commitSeq } });
    }
  }

  return json(res, 404, { message: 'mock 未覆盖: ' + req.method + ' ' + p });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock github api listening on http://127.0.0.1:' + PORT);
});
