'use strict';

/**
 * Git 本地仓库同步
 * 让「本地目录」始终等于「云端仓库」—— 云端上传/删除后自动拉取到本地
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: 'echo',
  LANG: 'en_US.UTF-8'
});

function run(args, cwd, timeout = 180000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        env: GIT_ENV,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim(),
          error: err && err.code === 'ENOENT' ? 'NOT_INSTALLED' : err ? err.message : null
        });
      }
    );
  });
}

async function version() {
  const r = await run(['--version']);
  if (!r.ok) return null;
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : r.stdout;
}

async function isRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const r = await run(['rev-parse', '--is-inside-work-tree'], dir);
  return r.ok && r.stdout === 'true';
}

async function currentBranch(dir) {
  const r = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return r.ok ? r.stdout : '';
}

async function headSha(dir) {
  const r = await run(['rev-parse', '--short', 'HEAD'], dir);
  return r.ok ? r.stdout : '';
}

/** 完整 40 位 SHA —— 云端同步检测器用它和云端 HEAD 做严格比对 */
async function headShaFull(dir) {
  const r = await run(['rev-parse', 'HEAD'], dir);
  return r.ok ? r.stdout : '';
}

async function status(dir) {
  const r = await run(['status', '--porcelain=v1', '-uall'], dir);
  if (!r.ok) return { dirty: false, changes: 0 };
  const lines = r.stdout.split('\n').filter(Boolean);
  return { dirty: lines.length > 0, changes: lines.length };
}

/**
 * Git 远端主机。Gitee 已下线，现在只有 GitHub 与 CNB 两个平台。
 * CNB 的 Git 地址是 cnb.cool/{组织}/{仓库}，认证用户名为固定值 cnb。
 */
function hostOf(platform) {
  return platform === 'cnb' ? 'cnb.cool' : 'github.com';
}

function remoteDir(platform, owner, repo) {
  return `https://${hostOf(platform)}/${owner}/${repo}.git`;
}

function authUrl(platform, owner, repo, token) {
  const repoPath = `${hostOf(platform)}/${owner}/${repo}.git`;
  if (!token) return `https://${repoPath}`;
  // CNB 官方要求：用户名固定填 cnb，密码填访问令牌
  if (platform === 'cnb') return `https://cnb:${encodeURIComponent(token)}@${repoPath}`;
  return `https://x-access-token:${encodeURIComponent(token)}@${repoPath}`;
}

async function clone({ platform, owner, repo, branch, token, dir }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    const ok = await isRepo(dir);
    if (ok) return { ok: true, message: '目录已存在且是一个 Git 仓库，无需重复克隆' };
    return { ok: false, message: '目标目录已存在且非空，请换一个空目录' };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const url = authUrl(platform, owner, repo, token);
  const r = await run(
    ['-c', 'safe.directory=*', 'clone', '--branch', branch, '--single-branch', '--depth', '1', url, dir],
    null,
    600000
  );
  if (!r.ok) return { ok: false, message: cleanGitError(r) };
  await configureIdentity(dir);
  return { ok: true, message: '克隆完成' };
}

/**
 * 提交身份 —— 应用往 GitHub / CNB 推文件时用的署名。
 *
 * 早先这里写死成「JIE Dispatch」，结果每次由应用发起的提交都会在仓库里
 * 留下一个署名 JIE 的作者，贡献者列表里也多出一个「JIE Dispatch」。
 * 改成账号本人（youngdajie）+ GitHub 已验证邮箱，提交才会正确归到本人名下。
 */
const COMMIT_IDENTITY = {
  name: 'youngdajie',
  email: 'ok@yangjie.site'
};

async function configureIdentity(dir) {
  await run(['config', 'user.name', COMMIT_IDENTITY.name], dir);
  await run(['config', 'user.email', COMMIT_IDENTITY.email], dir);
}

/** 拉取最新：让本地与云端保持一致 */
async function pull({ platform, owner, repo, branch, token, dir, strategy = 'pull' }) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, message: '本地目录不存在，请先克隆仓库到本地' };
  if (!(await isRepo(dir))) return { ok: false, message: '本地目录不是一个 Git 仓库' };

  const url = authUrl(platform, owner, repo, token);
  const base = ['-c', 'safe.directory=*', '-c', 'http.postBuffer=524288000', '-c', 'credential.helper='];

  if (strategy === 'reset') {
    const f = await run(base.concat(['fetch', '--depth', '1', url, branch]), dir, 300000);
    if (!f.ok) return { ok: false, message: cleanGitError(f) };
    const rs = await run(base.concat(['reset', '--hard', 'FETCH_HEAD']), dir);
    if (!rs.ok) return { ok: false, message: cleanGitError(rs) };
    return { ok: true, message: '已强制同步至云端版本' };
  }

  const r = await run(base.concat(['pull', '--no-rebase', '--no-edit', url, branch]), dir, 300000);
  if (r.ok) return { ok: true, message: r.stdout || '已是最新' };

  // pull 失败（常见于本地有未提交改动）时，退化为 fetch + reset
  const f = await run(base.concat(['fetch', '--depth', '1', url, branch]), dir, 300000);
  if (!f.ok) return { ok: false, message: cleanGitError(r) };
  const rs = await run(base.concat(['reset', '--hard', 'FETCH_HEAD']), dir);
  if (!rs.ok) return { ok: false, message: cleanGitError(rs) };
  return { ok: true, message: '本地存在改动，已强制对齐云端版本' };
}

/** 在本地目录中提交并推送（当用户选择「本地直传」模式时使用） */
async function commitAndPush({ platform, owner, repo, branch, token, dir, message }) {
  if (!(await isRepo(dir))) return { ok: false, message: '本地目录不是一个 Git 仓库' };
  const url = authUrl(platform, owner, repo, token);
  const base = ['-c', 'safe.directory=*', '-c', 'http.postBuffer=524288000', '-c', 'credential.helper='];

  await run(base.concat(['add', '-A']), dir);
  const c = await run(base.concat(['commit', '-m', message || 'update']), dir);
  if (!c.ok && !/nothing to commit/i.test(c.stdout + c.stderr)) {
    return { ok: false, message: cleanGitError(c) };
  }
  const p = await run(base.concat(['push', url, `HEAD:${branch}`]), dir, 300000);
  if (!p.ok) return { ok: false, message: cleanGitError(p) };
  return { ok: true, message: '已推送到云端' };
}

/**
 * 把云端分支抓成本地的 FETCH_HEAD（不动工作区、不改 origin）。
 * 云端同步检测器靠它拿到「云端最新提交」，再和本地 HEAD 比 ahead / behind。
 */
async function fetchRef({ platform, owner, repo, branch, token, dir }) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, message: '本地目录不存在' };
  if (!(await isRepo(dir))) return { ok: false, message: '本地目录不是一个 Git 仓库' };
  const url = authUrl(platform, owner, repo, token);
  const f = await run(
    ['-c', 'safe.directory=*', '-c', 'credential.helper=', 'fetch', '--depth', '50', url, branch],
    dir,
    300000
  );
  if (!f.ok) return { ok: false, message: cleanGitError(f) };
  return { ok: true, message: '已获取云端最新提交' };
}

/**
 * 比较本地 HEAD 与刚 fetch 下来的 FETCH_HEAD。
 * 返回 { ahead, behind }：ahead = 本地领先几条提交，behind = 本地落后几条提交。
 */
async function compareRefs(dir) {
  const r = await run(['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD'], dir);
  if (!r.ok) return null;
  const parts = r.stdout.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { ahead: Number(parts[0]) || 0, behind: Number(parts[1]) || 0 };
}

/** FETCH_HEAD 指向的提交（= 云端那条），用于显示云端短 SHA */
async function fetchHeadSha(dir) {
  const r = await run(['rev-parse', '--short', 'FETCH_HEAD'], dir);
  return r.ok ? r.stdout : '';
}

/** 把本地 HEAD 推到云端分支。不改写历史 —— 有人抢先提交时 push 会失败，由调用方提示 */
async function pushHead({ platform, owner, repo, branch, token, dir }) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, message: '本地目录不存在' };
  if (!(await isRepo(dir))) return { ok: false, message: '本地目录不是一个 Git 仓库' };
  const url = authUrl(platform, owner, repo, token);
  const p = await run(
    ['-c', 'safe.directory=*', '-c', 'credential.helper=', 'push', url, `HEAD:${branch}`],
    dir,
    300000
  );
  if (!p.ok) return { ok: false, message: cleanGitError(p) };
  return { ok: true, message: '已把本地提交推送到云端' };
}

function cleanGitError(r) {
  let msg = (r.stderr || r.stdout || r.error || '未知错误').toString();
  msg = msg.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
  if (r.error === 'NOT_INSTALLED') return '未检测到 Git，请先安装 Git for Windows 并加入 PATH';
  if (/could not resolve host|unable to access/i.test(msg)) return '无法连接远端仓库，请检查网络 / 代理设置';
  if (/authentication failed|invalid username or password|403/i.test(msg)) return '认证失败：Token 无效或没有该仓库权限';
  if (/not found|repository not found|404/i.test(msg)) return '仓库不存在或无权访问，请检查用户名 / 仓库名 / Token';
  if (/diverged|non-fast-forward|behind/i.test(msg)) return '本地与云端出现分叉，请在设置中改用「强制对齐」同步策略';
  const lines = msg.split('\n').filter((l) => l.trim() && !/^\s*(hint|remote: counting|remote: compressing|remote: total)/i.test(l));
  return lines.slice(0, 3).join(' ') || 'Git 操作失败';
}

async function repoSummary(dir) {
  if (!(await isRepo(dir))) return null;
  return {
    branch: await currentBranch(dir),
    head: await headSha(dir),
    remote: (await run(['remote', 'get-url', 'origin'], dir)).stdout.replace(/https:\/\/[^@/]+@/, 'https://')
  };
}

module.exports = {
  run,
  version,
  isRepo,
  pull,
  clone,
  commitAndPush,
  status,
  repoSummary,
  remoteDir,
  authUrl,
  hostOf,
  headSha,
  headShaFull,
  fetchRef,
  compareRefs,
  fetchHeadSha,
  pushHead,
  configureIdentity,
  COMMIT_IDENTITY
};
