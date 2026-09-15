'use strict';

/**
 * 离线验证 Gitee（REST v5）链路：
 * 与 GitHub 不同，Gitee 走 Contents 接口逐文件提交，且 access_token 走 query。
 */

const http = require('http');
const path = require('path');
const { CloudClient } = require(path.join(__dirname, '..', 'src', 'main', 'platform.js'));

const calls = [];
const files = {
  'images/old.png': { sha: 'g-sha-old', size: 999, b64: Buffer.from('OLD-GITEE-CONTENT').toString('base64') }
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
  const q = Object.fromEntries(u.searchParams);
  const body = req.method === 'GET' ? null : await readBody(req);
  calls.push({ method: req.method, path: p, token: q.access_token, ref: q.ref, body });

  if (p === '/user') return json(res, 200, { login: 'gitee-user', name: '杰哥', avatar_url: '', html_url: '' });
  if (p === '/repos/o/r') return json(res, 200, { full_name: 'o/r', private: false, size: 512, default_branch_name: 'main', html_url: '' });

  if (p.startsWith('/repos/o/r/contents/')) {
    const rel = p.slice('/repos/o/r/contents/'.length);
    if (req.method === 'GET') {
      if (!q.access_token) return json(res, 401, { message: 'access_token 缺失' });
      if (rel === '') {
        return json(res, 200, Object.keys(files).map((k) => ({ name: k.split('/').pop(), path: k, type: 'file', sha: files[k].sha, size: files[k].size })));
      }
      if (files[rel]) return json(res, 200, { name: rel.split('/').pop(), path: rel, type: 'file', sha: files[rel].sha, size: files[rel].size, content: files[rel].b64 || '' });
      return json(res, 404, { message: 'Not Found' });
    }
    if (req.method === 'POST') {
      if (files[rel]) return json(res, 409, { message: '已存在，应使用 PUT' });
      if (!body.content || !body.branch) return json(res, 422, { message: '缺少 content/branch' });
      files[rel] = { sha: 'g-' + rel, size: Buffer.from(body.content, 'base64').length, b64: body.content };
      return json(res, 201, { content: { path: rel } });
    }
    if (req.method === 'PUT') {
      if (!files[rel]) return json(res, 404, { message: '不存在，应使用 POST' });
      if (body.sha !== files[rel].sha) return json(res, 409, { message: 'sha 不匹配' });
      files[rel] = { sha: 'g-' + rel + '-v2', size: Buffer.from(body.content, 'base64').length, b64: body.content };
      return json(res, 200, { content: { path: rel } });
    }
    if (req.method === 'DELETE') {
      if (!files[rel]) return json(res, 404, { message: 'Not Found' });
      if (body.sha !== files[rel].sha) return json(res, 409, { message: 'sha 不匹配' });
      delete files[rel];
      return json(res, 200, {});
    }
  }
  return json(res, 404, { message: 'mock 未覆盖：' + req.method + ' ' + p });
});

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = new CloudClient({ platform: 'gitee', owner: 'o', repo: 'r', branch: 'main', token: 'gtoken', apiBase: base });

  const results = [];
  const check = (name, cond, extra) => {
    results.push(name);
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
    if (!cond) results.failed = (results.failed || 0) + 1;
  };

  try {
    const user = await client.whoami();
    check('whoami', user.login === 'gitee-user');

    const repo = await client.repoInfo();
    check('repoInfo 用 default_branch_name', repo.defaultBranch === 'main');

    const list = await client.listDir('');
    check('listDir 带上了 access_token', calls[0].token === 'gtoken' || calls.some((c) => c.token === 'gtoken'));
    check('listDir 带上了 ref 分支', calls.some((c) => c.ref === 'main'));
    check('listDir 结果正确', list.length === 1 && list[0].path === 'images/old.png');

    const up = await client.uploadBatch(
      [{ path: 'images/new.png', buff: Buffer.from('NEW') }, { path: 'images/old.png', buff: Buffer.from('REPLACED') }],
      'chore: gitee upload'
    );
    check('uploadBatch 两个文件都成功', up.every((r) => r.ok), JSON.stringify(up));

    const postCall = calls.find((c) => c.method === 'POST' && c.path.indexOf('/contents/images/new.png') >= 0);
    const putCall = calls.find((c) => c.method === 'PUT' && c.path.indexOf('/contents/images/old.png') >= 0);
    check('新文件用 POST 创建', !!postCall);
    check('已存在文件用 PUT 覆盖', !!putCall, putCall ? 'sha=' + putCall.body.sha : '');
    check('PUT 带上了原 sha', putCall && putCall.body.sha === 'g-sha-old');
    check('提交信息正确', postCall && postCall.body.message === 'chore: gitee upload');
    check('分支正确', postCall && postCall.body.branch === 'main');
    check('content 是 base64', !!postCall && Buffer.from(postCall.body.content, 'base64').toString() === 'NEW');

    const raw = client.rawUrl('images/new.png');
    check('gitee rawUrl 规则', raw === 'https://gitee.com/o/r/raw/main/images/new.png', raw);

    const del = await client.deleteBatch(['images/old.png'], 'chore: delete');
    check('deleteBatch 成功', del[0].ok, JSON.stringify(del));
    check('删除后 mock 里已不存在', !files['images/old.png']);

    // ---------- 改名 / 移动（Gitee 没有改名接口：先建后删） ----------
    files['images/keep.png'] = { sha: 'g-keep', size: 11, b64: Buffer.from('KEEP-CONTENT').toString('base64') };
    const mv = await client.moveBatch([{ from: 'images/keep.png', to: 'docs/keep-moved.png' }], 'chore: move on gitee');
    check('Gitee moveBatch 成功', mv.length === 1 && mv[0].ok, JSON.stringify(mv));
    check('新路径已创建且内容一致', !!files['docs/keep-moved.png'] && Buffer.from(files['docs/keep-moved.png'].b64, 'base64').toString() === 'KEEP-CONTENT');
    check('旧路径已被删除', !files['images/keep.png']);

    const mvPost = calls.filter((c) => c.method === 'POST' && c.path.indexOf('/contents/docs/keep-moved.png') >= 0).pop();
    const mvDel = calls.filter((c) => c.method === 'DELETE' && c.path.indexOf('/contents/images/keep.png') >= 0).pop();
    check('先 POST 新路径', !!mvPost);
    check('再 DELETE 旧路径（带原 sha）', !!mvDel && mvDel.body.sha === 'g-keep', mvDel ? String(mvDel.body.sha) : '');

    // ---------- 替换内容（PUT 覆盖原路径） ----------
    const rep = await client.uploadBatch([{ path: 'images/new.png', buff: Buffer.from('REPLACED-ON-GITEE') }], 'chore: replace');
    check('Gitee 替换成功', rep[0].ok, JSON.stringify(rep));
    check('替换后内容已更新', Buffer.from(files['images/new.png'].b64, 'base64').toString() === 'REPLACED-ON-GITEE');
  } catch (e) {
    check('整体执行', false, e.message);
  }

  const failed = results.failed || 0;
  console.log('\n' + results.length + ' 项检查，' + failed + ' 项失败');
  server.close();
  process.exit(failed ? 1 : 0);
});
