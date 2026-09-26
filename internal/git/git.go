// Package git 封装对 git CLI 的调用。
//
// 为什么是「调 git.exe」而不是用 Go 的 git 库：这个程序的同步逻辑
// （clone / commit / push / 凭据、以及 CNB 那套固定用户名 cnb 的地址拼法）
// Electron 版已经在 src/main/git.js 里调通了，行为一模一样最省心 ——
// 用户机器上本来就有 git，换个库反而要担心 LF/CRLF、credential helper 这些差异。
//
// 通道名 / 返回字段严格对齐 src/main/git.js 与 main.js 里的 ipcMain.handle，
// 渲染层是按这些字段当契约用的（缺一个就会在界面上表现成「检测不到」）。
package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// extraPath 是追加到 git 子进程 PATH **最前面**的目录。
//
// 它存在的唯一理由是 git-lfs：git 执行 filter 时会去找名叫 git-lfs
// 的可执行文件（filter.lfs.clean = "git-lfs clean -- %f"），找的地方就是
// PATH。程序自动装的 git-lfs 放在配置目录里（不动系统、不要管理员权限），
// 所以每次起 git 子进程都得把这个目录塞进 PATH。
//
// 只影响**子进程**的环境，不改用户的系统 PATH —— 这是刻意的：
// 改注册表级别的 PATH 是侵入性的，而且某些情况下要提权。
var extraPath string

// SetExtraPath 设置 git 子进程 PATH 的追加目录（放 git-lfs.exe）。
// 由 main 在启动时调用一次；传空串表示不需要。
func SetExtraPath(dir string) { extraPath = dir }

// GIT_ENV：一律非交互。没有这组环境变量，凭据缺失时 git 会弹一个
// 谁也看不见的凭据框，进程就那么挂着（Electron 版当年踩过）。
func gitEnv() []string {
	env := os.Environ()
	if extraPath != "" {
		env = prependPath(env, extraPath)
	}
	env = append(env,
		"GIT_TERMINAL_PROMPT=0",
		"GCM_INTERACTIVE=never",
		"GIT_ASKPASS=echo",
		"LANG=en_US.UTF-8",
	)
	return env
}

// prependPath 把 dir 插到环境变量里 PATH 的最前面。
//
// 不能简单 append 一个 "PATH=..."：Windows 的环境块里可能已经有一个
// "Path=..."（大小写不同），两个同名项同时存在时哪个生效是不确定的，
// 表现出来就是「有时能找到 git-lfs，有时找不到」。所以这里遍历替换，
// 保留原有的键名大小写。
func prependPath(env []string, dir string) []string {
	const key = "PATH="
	sep := string(os.PathListSeparator)
	for i, kv := range env {
		if len(kv) >= len(key) && strings.EqualFold(kv[:len(key)], key) {
			// 用 kv[:len(key)] 而不是 key —— 保留系统原来的写法（Path= / PATH=）
			env[i] = kv[:len(key)] + dir + sep + kv[len(key):]
			return env
		}
	}
	return append(env, key+dir)
}

type result struct {
	Ok     bool
	Stdout string
	Stderr string
	Err    error
}

/* ------------------------------------------------------------ 给兄弟包用 */

// OpResult 已经在 ops.go 定义（{ok, message}），这里复用。

// Run 执行一条 git 命令，把结果收敛成人话。
//
// 它是 run() 的导出形式，给 internal/lfs 这类兄弟包用 ——
// 那些包要调 git 但又不想各自复制一套「找 git、设环境、藏窗口」的逻辑。
func Run(ctx context.Context, dir string, timeout time.Duration, args ...string) OpResult {
	r := run(ctx, args, dir, timeout)
	if r.Ok {
		return OpResult{OK: true, Message: strings.TrimSpace(r.Stdout)}
	}
	return OpResult{Message: CleanError(r)}
}

// SetConfig 写一条**仓库级** git 配置（等价 git config <key> <value>）。
//
// 忽略错误：配置写不进去时后续操作会自己报错，这里再报一次只是噪音。
func SetConfig(ctx context.Context, dir, key, value string) {
	run(ctx, []string{"config", key, value}, dir, 20*time.Second)
}

// HideWindow 是 hideWindow 的导出形式，给兄弟包（internal/lfs）复用。
//
// 不直接把 hideWindow 改名导出，是为了不动这里已有的十来个调用点 ——
// 那属于「为了整洁去改一堆没坏的东西」，风险不值。
func HideWindow(cmd *exec.Cmd) { hideWindow(cmd) }

/* ------------------------------------------------------------ 基础执行 */

func run(ctx context.Context, args []string, dir string, timeout time.Duration) result {
	if _, err := exec.LookPath("git"); err != nil {
		return result{Err: errors.New("NOT_INSTALLED")}
	}
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(c, "git", args...)
	if dir != "" {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			cmd.Dir = dir
		}
	}
	cmd.Env = gitEnv()
	hideWindow(cmd)

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return result{
		Ok:     err == nil,
		Stdout: strings.TrimSpace(stdout.String()),
		Stderr: strings.TrimSpace(stderr.String()),
		Err:    err,
	}
}

var versionRe = regexp.MustCompile(`(\d+\.\d+\.\d+)`)

// Version 返回形如 "2.47.0" 的版本号；没装 git 返回空串。
//
// 结果在一个进程里只探一次 —— git 版本不会中途变，而 git:version 是被
// 引导流程和设置页反复问的通道。
func Version(ctx context.Context) string {
	versionOnce.Do(func() {
		r := run(ctx, []string{"--version"}, "", 10*time.Second)
		if !r.Ok {
			versionCache = ""
			return
		}
		if m := versionRe.FindString(r.Stdout); m != "" {
			versionCache = m
		} else {
			versionCache = r.Stdout
		}
	})
	return versionCache
}

var (
	versionOnce  sync.Once
	versionCache string
)

// IsRepo 判断目录是不是一个 Git 工作区。
func IsRepo(ctx context.Context, dir string) bool {
	if dir == "" {
		return false
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return false
	}
	r := run(ctx, []string{"rev-parse", "--is-inside-work-tree"}, dir, 20*time.Second)
	return r.Ok && r.Stdout == "true"
}

// Status 是工作区脏不脏、有几处改动。
func Status(ctx context.Context, dir string) map[string]any {
	r := run(ctx, []string{"status", "--porcelain=v1", "-uall"}, dir, 30*time.Second)
	if !r.Ok {
		return map[string]any{"dirty": false, "changes": 0}
	}
	changes := 0
	for _, line := range strings.Split(r.Stdout, "\n") {
		if strings.TrimSpace(line) != "" {
			changes++
		}
	}
	return map[string]any{"dirty": changes > 0, "changes": changes}
}

// RepoSummary 是分支 / HEAD / 远端地址。远端地址里的凭据要去掉再给界面 ——
// Token 就拼在 URL 里，直接显示出去等于在界面上明文露一次。
func RepoSummary(ctx context.Context, dir string) map[string]any {
	if !IsRepo(ctx, dir) {
		return nil
	}
	out := map[string]any{
		"branch": run(ctx, []string{"rev-parse", "--abbrev-ref", "HEAD"}, dir, 20*time.Second).Stdout,
		"head":   run(ctx, []string{"rev-parse", "--short", "HEAD"}, dir, 20*time.Second).Stdout,
	}
	remote := run(ctx, []string{"remote", "get-url", "origin"}, dir, 20*time.Second).Stdout
	out["remote"] = stripCreds(remote)
	return out
}

var credRe = regexp.MustCompile(`https://[^@/]+@`)

func stripCreds(url string) string {
	return credRe.ReplaceAllString(url, "https://")
}

/* ------------------------------------------------------------ 带缓存的查询 */

// statusTTL 对齐 main.js 的 GIT_STATUS_TTL：界面上每次重画都会问一遍
// git:status，但同一个仓库两秒内问三次没有任何意义，而每次都是好几个 git 进程。
const statusTTL = 2500 * time.Millisecond

type cacheEntry struct {
	at   time.Time
	data map[string]any
}

var (
	cacheMu   sync.Mutex
	statusHit = map[string]cacheEntry{}
	inflight  = map[string]*statusCall{}
)

type statusCall struct {
	wg   sync.WaitGroup
	data map[string]any
}

// StatusCached 是 git:status 通道用的入口：同一个 key（仓库身份串）在 TTL 内
// 直接回缓存；正在算的会被后来者跟上，不叠出第二份 git 进程。
func StatusCached(ctx context.Context, key, dir string) map[string]any {
	cacheMu.Lock()
	if e, ok := statusHit[key]; ok && time.Since(e.at) < statusTTL {
		cacheMu.Unlock()
		return e.data
	}
	if c, ok := inflight[key]; ok {
		cacheMu.Unlock()
		c.wg.Wait()
		return c.data
	}
	c := &statusCall{}
	c.wg.Add(1)
	inflight[key] = c
	cacheMu.Unlock()

	defer func() {
		c.wg.Done()
		cacheMu.Lock()
		delete(inflight, key)
		statusHit[key] = cacheEntry{at: time.Now(), data: c.data}
		cacheMu.Unlock()
	}()

	if dir == "" {
		c.data = map[string]any{"configured": false, "isRepo": false}
		return c.data
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		c.data = map[string]any{"configured": false, "isRepo": false}
		return c.data
	}
	if !IsRepo(ctx, dir) {
		c.data = map[string]any{"configured": true, "isRepo": false, "dir": dir}
		return c.data
	}
	c.data = map[string]any{"configured": true, "isRepo": true, "dir": dir}
	for k, v := range Status(ctx, dir) {
		c.data[k] = v
	}
	for k, v := range RepoSummary(ctx, dir) {
		c.data[k] = v
	}
	return c.data
}
