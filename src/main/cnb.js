'use strict';

/**
 * CNB（cnb.cool）写入通道
 *
 * 为什么单独搞一个模块：CNB 的公开 Open API 里**没有**创建 Tree / 创建 Commit /
 * 更新 Ref 的接口（`POST /{repo}/-/git/blobs` 的文档写着「通常与创建 Tree/Commit
 * 接口配合使用」，但那两个接口并未开放）。孤立的 blob 没有落点，等于白造。
 *
 * 所以 CNB 的写入只能走 Git 本身：把仓库弄到本地工作区 → 改文件 → commit → push。
 * 工作区优先复用当前配置绑定的本地目录（本来就是同一个仓库，改完顺带一致）；
 * 没有绑定、或者绑的目录其实指向别的仓库时，临时克隆一份到 userData 下，
 * 提交推送完立刻删掉，不在用户磁盘上留垃圾。
 *
 * 这样上传 / 删除 / 改名 / 替换四条写路径在 CNB 上都是「一次提交」，和 GitHub 的
 * Git Data API 效果对齐。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');

const git = require('./git');
const local = require('./local');

/** 临时工作区根目录（挂在 userData 下，随应用卸载一起走） */
function tmpRoot() {
  return path.join(app.getPath('userData'), 'cnb-work');
}

/**
 * 删掉临时工作区。
 * 用异步删：临时克隆出来的是整个仓库，可能几千个文件，同步删会把主进程卡住，
 * 而这一步只是收尾清理，没必要拦住界面。
 */
async function removeDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    /* 删不掉就算了，下次启动可以再清 —— 别因为清理失败让主流程报错 */
  }
}

/** 判断某个本地仓库的 origin 是否就是目标平台 / 仓库，避免把 A 仓库的内容推到 B 仓库 */
function remoteMatches(summary, platform, owner, repo) {
  if (!summary || !summary.remote) return false;
  const host = git.hostOf(platform);
  const tail = `${owner}/${repo}`.toLowerCase();
  const url = String(summary.remote).toLowerCase();
  return url.indexOf(host) >= 0 && url.indexOf(tail) >= 0;
}

/**
 * 在一个可用的 Git 工作区里执行 fn(dir)。
 * 返回 { dir, used: 'local' | 'temp', message }
 */
async function withWorkspace(conn, fn) {
  const bound = String(conn.localDir || '').trim();

  if (bound && local.exists(bound) && (await git.isRepo(bound))) {
    const sum = await git.repoSummary(bound);
    if (remoteMatches(sum, conn.platform, conn.owner, conn.repo)) {
      await git.configureIdentity(bound);
      return { used: 'local', dir: bound, result: await fn(bound), message: '已就地更新本地目录' };
    }
    // 目录是别人的仓库：宁可临时克隆，也不要把文件推错地方
  }

  if (!(await git.version())) {
    throw new Error('CNB 平台的文件写入依赖 Git：请先安装 Git for Windows 并加入 PATH，或为这份配置绑定本地目录');
  }

  const tmp = path.join(tmpRoot(), 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const c = await git.clone({
    platform: conn.platform,
    owner: conn.owner,
    repo: conn.repo,
    branch: conn.branch,
    token: conn.token,
    dir: tmp
  });
  if (!c.ok) throw new Error('CNB 写入需要先把仓库拉到本地，克隆失败：' + c.message);
  try {
    return { used: 'temp', dir: tmp, result: await fn(tmp), message: '已通过临时克隆提交' };
  } finally {
    await removeDir(tmp);
  }
}

/** 把一批文件写进工作区（自动建目录，路径做越界防护） */
function writeFiles(dir, files) {
  for (const f of files) {
    const abs = local.safeJoin(dir, f.path);
    local.ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, f.buff);
  }
}

function deletePaths(dir, paths) {
  let removed = 0;
  for (const rel of paths) {
    const abs = local.safeJoin(dir, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
    removed += 1;
  }
  return removed;
}

function movePaths(dir, items) {
  for (const it of items) {
    const from = local.safeJoin(dir, it.from);
    const to = local.safeJoin(dir, it.to);
    if (!fs.existsSync(from)) continue;
    local.ensureDir(path.dirname(to));
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }
}

/* ---------------------------------------------------------------- 对外 */

/** 上传一批文件（files: [{ path, buff }]），返回 git 通道得到的 [{ path, ok, error }] */
async function uploadBatch(conn, files, message) {
  const ws = await withWorkspace(conn, async (dir) => {
    writeFiles(dir, files);
    return git.commitAndPush({
      platform: conn.platform,
      owner: conn.owner,
      repo: conn.repo,
      branch: conn.branch,
      token: conn.token,
      dir,
      message: message || 'chore: 通过 JIE 分发服务上传'
    });
  });
  if (!ws.result.ok) {
    return files.map((f) => ({ path: f.path, ok: false, error: ws.result.message }));
  }
  return files.map((f) => ({ path: f.path, ok: true, error: null, via: ws.used, note: ws.message }));
}

async function deleteBatch(conn, paths, message) {
  const ws = await withWorkspace(conn, async (dir) => {
    deletePaths(dir, paths);
    return git.commitAndPush({
      platform: conn.platform,
      owner: conn.owner,
      repo: conn.repo,
      branch: conn.branch,
      token: conn.token,
      dir,
      message: message || 'chore: 删除文件'
    });
  });
  if (!ws.result.ok) return paths.map((p) => ({ path: p, ok: false, error: ws.result.message }));
  return paths.map((p) => ({ path: p, ok: true, error: null, via: ws.used }));
}

async function moveBatch(conn, items, message) {
  const ws = await withWorkspace(conn, async (dir) => {
    movePaths(dir, items);
    return git.commitAndPush({
      platform: conn.platform,
      owner: conn.owner,
      repo: conn.repo,
      branch: conn.branch,
      token: conn.token,
      dir,
      message: message || 'chore: 移动文件'
    });
  });
  if (!ws.result.ok) {
    return items.map((it) => ({ path: it.to, from: it.from, ok: false, error: ws.result.message }));
  }
  return items.map((it) => ({ path: it.to, from: it.from, ok: true, error: null, via: ws.used }));
}

/** 用一份新内容覆盖某个已存在的路径（保持路径不变） */
async function replaceFile(conn, rel, buff, message) {
  const ws = await withWorkspace(conn, async (dir) => {
    writeFiles(dir, [{ path: rel, buff }]);
    return git.commitAndPush({
      platform: conn.platform,
      owner: conn.owner,
      repo: conn.repo,
      branch: conn.branch,
      token: conn.token,
      dir,
      message: message || `chore: 替换 ${rel}`
    });
  });
  if (!ws.result.ok) throw new Error(ws.result.message);
  return { used: ws.used };
}

module.exports = { withWorkspace, uploadBatch, deleteBatch, moveBatch, replaceFile, tmpRoot, removeDir };
