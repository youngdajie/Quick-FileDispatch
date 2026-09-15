'use strict';

/**
 * 离线验证 CloudClient 的完整读写链路：
 * 起一个假的 GitHub API，走真实的 uploadBatch / listDir / deleteBatch 代码，
 * 校验请求形状是否符合 GitHub 规范，以及返回结果是否正确。
 */

const http = require('http');
const path = require('path');
const { CloudClient } = require(path.join(__dirname, '..', 'src', 'main', 'platform.js'));

const calls = [];
const BLOBS = {};
let pendingTree = [];
const tree = {
  'images/existing.png': { sha: 'sha-existing', size: 1234, b64: Buffer.from('EXISTING-CONTENT').toString('base64') }
};

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(u.pathname);
  const body = req.method === 'GET' ? null : await readBody(req);
  calls.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), body });

  if (p === '/repos/o/r/git/ref/heads/main' && req.method === 'GET') {
    return json(res, 200, { object: { sha: 'commit-0' } });
  }
  if (p === '/repos/o/r/git/commits/commit-0' && req.method === 'GET') {
    return json(res, 200, { sha: 'commit-0', tree: { sha: 'tree-0' } });
  }
  if (p === '/repos/o/r/git/blobs' && req.method === 'POST') {
    if (!body.content || body.encoding !== 'base64') return json(res, 422, { message: 'blob 形状不对' });
    const decoded = Buffer.from(body.content, 'base64');
    const sha = 'blob-' + decoded.length;
    BLOBS[sha] = { size: decoded.length, b64: body.content };
    return json(res, 201, { sha: sha });
  }
  if (p === '/repos/o/r/git/trees' && req.method === 'POST') {
    if (body.base_tree !== 'tree-0') return json(res, 422, { message: 'base_tree 不对' });
    for (const e of body.tree || []) {
      if (e.sha !== null && !BLOBS[e.sha]) return json(res, 422, { message: '未知 blob: ' + e.sha });
    }
    pendingTree = body.tree || [];
    return json(res, 201, { sha: 'tree-1', entries: body.tree });
  }
  if (p === '/repos/o/r/git/commits' && req.method === 'POST') {
    if (body.parents[0] !== 'commit-0') return json(res, 422, { message: 'parents 不对' });
    pendingTree.forEach((e) => {
      if (e.sha === null) { delete tree[e.path]; return; }
      const b = BLOBS[e.sha];
      tree[e.path] = { sha: e.sha, size: b ? b.size : 0, b64: b ? b.b64 : '' };
    });
    return json(res, 201, { sha: 'commit-1' });
  }
  if (p === '/repos/o/r/git/ref/heads/main' && req.method === 'PATCH') {
    if (body.sha !== 'commit-1') return json(res, 422, { message: 'ref 更新 sha 不对' });
    return json(res, 200, { object: { sha: body.sha } });
  }

  if (p.startsWith('/repos/o/r/contents/')) {
    const rel = p.slice('/repos/o/r/contents/'.length);
    const wantsRaw = String(req.headers.accept || '').indexOf('vnd.github.raw') >= 0;
    if (req.method === 'GET') {
      if (rel && tree[rel] && wantsRaw) {
        const raw = Buffer.from(tree[rel].b64 || '', 'base64');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': raw.length });
        return res.end(raw);
      }
      if (tree[rel]) return json(res, 200, { name: rel.split('/').pop(), path: rel, type: 'file', sha: tree[rel].sha, size: tree[rel].size, content: tree[rel].b64 });
      if (rel === '') {
        return json(res, 200, Object.keys(tree).map((k) => ({ name: k.split('/').pop(), path: k, type: 'file', sha: tree[k].sha, size: tree[k].size })));
      }
      return json(res, 404, { message: 'Not Found' });
    }
    if (req.method === 'DELETE') {
      if (!tree[rel]) return json(res, 404, { message: 'Not Found' });
      if (body.sha !== tree[rel].sha) return json(res, 409, { message: 'sha 不匹配' });
      delete tree[rel];
      return json(res, 200, { commit: { sha: 'del-commit' } });
    }
  }

  if (p === '/user') return json(res, 200, { login: 'youngdajie', name: 'youngdajie', avatar_url: '', html_url: '' });
  if (p === '/repos/o/r') return json(res, 200, { full_name: 'o/r', private: true, size: 42, default_branch: 'main' });

  return json(res, 404, { message: 'mock 未覆盖：' + req.method + ' ' + p });
});

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = new CloudClient({ platform: 'github', owner: 'o', repo: 'r', branch: 'main', token: 't', apiBase: base });

  const results = [];
  const check = (name, cond, extra) => {
    results.push({ name, ok: !!cond, extra: extra === undefined ? '' : extra });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  };

  try {
    const user = await client.whoami();
    check('whoami', user.login === 'youngdajie', user.login);

    const repo = await client.repoInfo();
    check('repoInfo', repo.fullName === 'o/r' && repo.private === true);

    const list = await client.listDir('');
    check('listDir 根目录', list.length === 1 && list[0].path === 'images/existing.png');

    const payload = [
      { path: 'images/a.png', buff: Buffer.from('AAAA-first-file') },
      { path: 'images/b.jpg', buff: Buffer.from('BB-second-file-longer') }
    ];
    const up = await client.uploadBatch(payload, 'chore: test upload');
    check('uploadBatch 全部成功', up.length === 2 && up.every((r) => r.ok), JSON.stringify(up.map((r) => r.path)));

    const blobCalls = calls.filter((c) => c.path === '/repos/o/r/git/blobs');
    check('blob 数量 = 文件数', blobCalls.length === 2, blobCalls.length + ' 个');
    check('blob 内容可 base64 还原', Buffer.from(blobCalls[0].body.content, 'base64').toString() === 'AAAA-first-file');

    const commitCall = calls.find((c) => c.path === '/repos/o/r/git/commits');
    check('整批只提交一次 commit', calls.filter((c) => c.path === '/repos/o/r/git/commits').length === 1);
    check('commit message 正确', commitCall.body.message === 'chore: test upload', commitCall.body.message);

    const treeCall = calls.find((c) => c.path === '/repos/o/r/git/trees');
    check('tree 条目数 = 文件数', treeCall.body.tree.length === 2);
    check('tree 条目结构正确', treeCall.body.tree[0].mode === '100644' && treeCall.body.tree[0].type === 'blob' && treeCall.body.tree[0].path === 'images/a.png');

    const patchCall = calls.find((c) => c.path === '/repos/o/r/git/ref/heads/main' && c.method === 'PATCH');
    check('ref 更新到新 commit', patchCall && patchCall.body.sha === 'commit-1');

    const raw = client.rawUrl('images/a.png');
    check('rawUrl 规则', raw === 'https://raw.githubusercontent.com/o/r/main/images/a.png', raw);

    const del = await client.deleteBatch(['images/existing.png'], 'chore: delete');
    check('deleteBatch 成功', del.length === 1 && del[0].ok, JSON.stringify(del));
    check('删除后 mock 里已不存在', !tree['images/existing.png']);

    const delMissing = await client.deleteBatch(['images/nope.png']);
    check('删除不存在的文件能优雅失败', delMissing[0].ok === false && /不存在/.test(delMissing[0].error), delMissing[0].error);

    // ---------- 改名 / 移动 ----------
    const treesBefore = calls.filter((c) => c.path === '/repos/o/r/git/trees').length;
    const commitsBefore = calls.filter((c) => c.path === '/repos/o/r/git/commits').length;
    const moveRes = await client.moveBatch([{ from: 'images/a.png', to: 'images/renamed/b.png' }], 'chore: move');
    check(
      'moveBatch 成功并返回新路径',
      moveRes.length === 1 && moveRes[0].ok && moveRes[0].path === 'images/renamed/b.png',
      JSON.stringify(moveRes)
    );

    const treesAfter = calls.filter((c) => c.path === '/repos/o/r/git/trees');
    const commitsAfter = calls.filter((c) => c.path === '/repos/o/r/git/commits');
    check('移动只新增一次 tree（整批原子）', treesAfter.length - treesBefore === 1, treesAfter.length - treesBefore + ' 次');
    check('移动只新增一次 commit', commitsAfter.length - commitsBefore === 1, commitsAfter.length - commitsBefore + ' 次');

    const mv = treesAfter[treesAfter.length - 1].body.tree;
    check(
      'tree = 新路径写入 + 旧路径删除',
      mv.length === 2 && mv[0].path === 'images/renamed/b.png' && mv[1].path === 'images/a.png' && mv[1].sha === null,
      JSON.stringify(mv.map((e) => e.path + ':' + e.sha))
    );

    const moveBlob = calls.filter((c) => c.path === '/repos/o/r/git/blobs').pop();
    check(
      '移动是「读原文再重建」，内容无损',
      Buffer.from(moveBlob.body.content, 'base64').toString() === 'AAAA-first-file',
      Buffer.from(moveBlob.body.content, 'base64').toString()
    );

    // ---------- 替换内容（路径不变，覆盖写） ----------
    const rep = await client.uploadBatch([{ path: 'images/b.jpg', buff: Buffer.from('REPLACED-CONTENT') }], 'chore: replace');
    check('replace 走同一条原子提交路径', rep[0].ok && rep[0].path === 'images/b.jpg', JSON.stringify(rep));

    const errStat = await client.listDir('').then(() => 200).catch((e) => e.status);
    check('listDir 正常返回状态', errStat === 200, String(errStat));
  } catch (e) {
    check('整体执行', false, e.message + '\n' + e.stack);
  }

  const bad = new CloudClient({ platform: 'github', owner: 'o', repo: 'r', branch: 'main', token: 't', apiBase: 'http://127.0.0.1:1' });
  try {
    await bad.whoami();
    check('网络不可达时报错清晰', false);
  } catch (e) {
    check('网络不可达时报错清晰', /网络请求失败/.test(e.message), e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' 项检查，' + failed.length + ' 项失败');
  server.close();
  process.exit(failed.length ? 1 : 0);
});
