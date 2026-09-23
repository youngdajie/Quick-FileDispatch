package git

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

/* ------------------------------------------------------------ 远端地址 */

// HostOf 返回平台的 Git 主机。Gitee 已下线，现在只有 GitHub 与 CNB。
func HostOf(platform string) string {
	if platform == "cnb" {
		return "cnb.cool"
	}
	return "github.com"
}

// RemoteDir 是不带凭据的公开远端地址（给用户看 / 写进配置时用）。
func RemoteDir(platform, owner, repo string) string {
	return "https://" + HostOf(platform) + "/" + owner + "/" + repo + ".git"
}

// AuthURL 是带凭据的远端地址。
//
// 两家的用户名规则不一样，写错就 401：
//
//	CNB:   用户名固定填 cnb，密码填访问令牌（官方要求）
//	GitHub: 用户名填 x-access-token
//
// Token 要转义：里面可能有 @ / : 这类会破坏 URL 结构的字符。
func AuthURL(platform, owner, repo, token string) string {
	repoPath := HostOf(platform) + "/" + owner + "/" + repo + ".git"
	if token == "" {
		return "https://" + repoPath
	}
	user := "x-access-token"
	if platform == "cnb" {
		user = "cnb"
	}
	return "https://" + user + ":" + url.QueryEscape(token) + "@" + repoPath
}

// 提交身份 —— 应用往 GitHub / CNB 推文件时用的署名。
//
// 早先写死成「JIE Dispatch」，结果每次由应用发起的提交都会在仓库里
// 留下一个署名 JIE 的作者，贡献者列表里也多出一个「JIE Dispatch」。
// 改成账号本人之后，提交才会正确归到本人名下。
const (
	CommitName  = "youngdajie"
	CommitEmail = "ok@yangjie.site"
)

// ConfigureIdentity 把提交身份写进仓库的本地配置。
func ConfigureIdentity(ctx context.Context, dir string) {
	run(ctx, []string{"config", "user.name", CommitName}, dir, 20*time.Second)
	run(ctx, []string{"config", "user.email", CommitEmail}, dir, 20*time.Second)
}

/* ------------------------------------------------------------ 基础查询 */

// HeadSHAFull 取完整 40 位 SHA。同步检测器用它和云端 HEAD 做**严格**比对 ——
// 短 SHA 只有 7 位，碰撞概率虽小但没必要冒。
func HeadSHAFull(ctx context.Context, dir string) string {
	return run(ctx, []string{"rev-parse", "HEAD"}, dir, 20*time.Second).Stdout
}

// OpResult 是各类写操作的统一返回，对应 git.js 里 { ok, message } 的形状。
type OpResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// baseArgs 是所有网络操作共用的 git 参数。
//
//   - safe.directory=*：目录归属和当前用户不一致时 git 会拒绝操作
//     （常见于把仓库放在移动硬盘 / 别的账户建的目录里）
//   - http.postBuffer=524288000：大仓库 push 时默认的 1MB 缓冲会直接失败
//   - credential.helper=：**禁用系统凭据助手**，凭据只从 URL 里来。
//     不禁用时，Windows 凭据管理器里存过的旧账号会抢在 URL 前面，
//     表现为「Token 明明是对的，却报认证失败」。
func baseArgs() []string {
	return []string{"-c", "safe.directory=*", "-c", "http.postBuffer=524288000", "-c", "credential.helper="}
}

/* ------------------------------------------------------------ 克隆 */

// CloneParams 是克隆所需的全部信息。
type CloneParams struct {
	Platform string
	Owner    string
	Repo     string
	Branch   string
	Token    string
	Dir      string
}

// Clone 把仓库克隆到本地。
//
// 目标目录已存在且非空时：如果它已经是仓库就直接算成功（不重复克隆），
// 否则报错 —— 不能往一个装着别的东西的目录里克隆，那样会把用户文件弄乱。
func Clone(ctx context.Context, p CloneParams) OpResult {
	if p.Dir == "" {
		return OpResult{Message: "缺少目标目录"}
	}
	if entries, err := os.ReadDir(p.Dir); err == nil && len(entries) > 0 {
		if IsRepo(ctx, p.Dir) {
			return OpResult{OK: true, Message: "目录已存在且是一个 Git 仓库，无需重复克隆"}
		}
		return OpResult{Message: "目标目录已存在且非空，请换一个空目录"}
	}
	if err := os.MkdirAll(p.Dir, 0o755); err != nil {
		return OpResult{Message: "无法创建目录：" + err.Error()}
	}
	branch := p.Branch
	if branch == "" {
		branch = "main"
	}
	args := []string{"-c", "safe.directory=*"}
	args = append(args, "clone", "--branch", branch, "--single-branch", "--depth", "1",
		AuthURL(p.Platform, p.Owner, p.Repo, p.Token), p.Dir)
	r := run(ctx, args, "", 10*time.Minute)
	if !r.Ok {
		return OpResult{Message: CleanError(r)}
	}
	ConfigureIdentity(ctx, p.Dir)
	return OpResult{OK: true, Message: "克隆完成"}
}

/* ------------------------------------------------------------ 拉取 */

// PullParams 是拉取所需的全部信息。Strategy 为 "reset" 时强制对齐云端。
type PullParams struct {
	Platform string
	Owner    string
	Repo     string
	Branch   string
	Token    string
	Dir      string
	Strategy string // pull | reset
}

// Pull 让本地与云端保持一致。
//
// reset 策略直接 fetch + reset --hard，会**丢弃本地所有未提交的改动** ——
// 这是设置页里用户自己选的「强制对齐」，不是默认行为。
func Pull(ctx context.Context, p PullParams) OpResult {
	if p.Dir == "" {
		return OpResult{Message: "本地目录不存在，请先克隆仓库到本地"}
	}
	if st, err := os.Stat(p.Dir); err != nil || !st.IsDir() {
		return OpResult{Message: "本地目录不存在，请先克隆仓库到本地"}
	}
	if !IsRepo(ctx, p.Dir) {
		return OpResult{Message: "本地目录不是一个 Git 仓库"}
	}
	branch := p.Branch
	if branch == "" {
		branch = "main"
	}
	url := AuthURL(p.Platform, p.Owner, p.Repo, p.Token)
	args := baseArgs()

	if p.Strategy == "reset" {
		f := run(ctx, append(args, "fetch", "--depth", "1", url, branch), p.Dir, 5*time.Minute)
		if !f.Ok {
			return OpResult{Message: CleanError(f)}
		}
		rs := run(ctx, append(args, "reset", "--hard", "FETCH_HEAD"), p.Dir, time.Minute)
		if !rs.Ok {
			return OpResult{Message: CleanError(rs)}
		}
		return OpResult{OK: true, Message: "已强制同步至云端版本"}
	}

	r := run(ctx, append(args, "pull", "--no-rebase", "--no-edit", url, branch), p.Dir, 5*time.Minute)
	if r.Ok {
		msg := r.Stdout
		if msg == "" {
			msg = "已是最新"
		}
		return OpResult{OK: true, Message: msg}
	}

	// pull 失败（最常见的是本地有未提交改动）→ 退化成 fetch + reset。
	// 这一步会丢本地改动，所以 message 里必须说清楚，别让用户以为改动还在。
	f := run(ctx, append(args, "fetch", "--depth", "1", url, branch), p.Dir, 5*time.Minute)
	if !f.Ok {
		return OpResult{Message: CleanError(r)}
	}
	rs := run(ctx, append(args, "reset", "--hard", "FETCH_HEAD"), p.Dir, time.Minute)
	if !rs.Ok {
		return OpResult{Message: CleanError(rs)}
	}
	return OpResult{OK: true, Message: "本地存在改动，已强制对齐云端版本"}
}

/* ------------------------------------------------------------ 提交并推送 */

// CommitParams 是提交推送所需的全部信息。
type CommitParams struct {
	Platform string
	Owner    string
	Repo     string
	Branch   string
	Token    string
	Dir      string
	Message  string
}

// CommitAndPush 把本地目录的**全部改动**提交并推到云端。
//
// 注意是 add -A：整个工作区的改动一起走。这是这个应用的定位决定的 ——
// 本地目录就是云端仓库的镜像，不是用户日常开发的工作区。
func CommitAndPush(ctx context.Context, p CommitParams) OpResult {
	if !IsRepo(ctx, p.Dir) {
		return OpResult{Message: "本地目录不是一个 Git 仓库"}
	}
	branch := p.Branch
	if branch == "" {
		branch = "main"
	}
	msg := p.Message
	if strings.TrimSpace(msg) == "" {
		msg = "update"
	}
	url := AuthURL(p.Platform, p.Owner, p.Repo, p.Token)
	args := baseArgs()

	run(ctx, append(args, "add", "-A"), p.Dir, 2*time.Minute)
	c := run(ctx, append(args, "commit", "-m", msg), p.Dir, time.Minute)
	// 「没有东西可提交」不是错误：删文件时如果那个文件已经不在仓库里，
	// 就会走到这里。这时仍然要继续 push（可能有别的提交待推）。
	if !c.Ok && !nothingToCommit(c.Stdout+c.Stderr) {
		return OpResult{Message: CleanError(c)}
	}
	pr := run(ctx, append(args, "push", url, "HEAD:"+branch), p.Dir, 5*time.Minute)
	if !pr.Ok {
		return OpResult{Message: CleanError(pr)}
	}
	return OpResult{OK: true, Message: "已推送到云端"}
}

var nothingRe = regexp.MustCompile(`(?i)nothing to commit`)

func nothingToCommit(s string) bool { return nothingRe.MatchString(s) }

/* ------------------------------------------------------------ 同步检测器 */

// FetchRef 把云端分支抓成本地的 FETCH_HEAD。
//
// 刻意不改工作区、不改 origin：检测器必须是**只读**的，
// 否则用户只是打开页面看一眼，本地仓库就被悄悄动了。
func FetchRef(ctx context.Context, p PullParams) OpResult {
	if p.Dir == "" {
		return OpResult{Message: "本地目录不存在"}
	}
	if !IsRepo(ctx, p.Dir) {
		return OpResult{Message: "本地目录不是一个 Git 仓库"}
	}
	branch := p.Branch
	if branch == "" {
		branch = "main"
	}
	args := []string{"-c", "safe.directory=*", "-c", "credential.helper="}
	args = append(args, "fetch", "--depth", "50", AuthURL(p.Platform, p.Owner, p.Repo, p.Token), branch)
	f := run(ctx, args, p.Dir, 5*time.Minute)
	if !f.Ok {
		return OpResult{Message: CleanError(f)}
	}
	return OpResult{OK: true, Message: "已获取云端最新提交"}
}

// Compare 是本地与云端的领先 / 落后关系。
type Compare struct {
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`
}

// CompareRefs 比较 HEAD 与 FETCH_HEAD，返回各领先几条提交。
// 深度 50 是刻意的：太浅（clone 时用的是 1）会算不出真实的历史关系。
func CompareRefs(ctx context.Context, dir string) *Compare {
	r := run(ctx, []string{"rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"}, dir, time.Minute)
	if !r.Ok {
		return nil
	}
	fields := strings.Fields(r.Stdout)
	if len(fields) < 2 {
		return nil
	}
	var ahead, behind int
	fmt.Sscanf(fields[0], "%d", &ahead)
	fmt.Sscanf(fields[1], "%d", &behind)
	return &Compare{Ahead: ahead, Behind: behind}
}

// FetchHeadSHA 取 FETCH_HEAD 指向的提交（= 云端那条），用于显示云端短 SHA。
func FetchHeadSHA(ctx context.Context, dir string) string {
	return run(ctx, []string{"rev-parse", "--short", "FETCH_HEAD"}, dir, 20*time.Second).Stdout
}

// PushHead 把本地 HEAD 推到云端分支。
//
// **不改写历史**：有人抢先提交时 push 会失败，由调用方提示用户。
// 强推会抹掉别人的提交，这种事不能由程序替用户决定。
func PushHead(ctx context.Context, p CommitParams) OpResult {
	if p.Dir == "" {
		return OpResult{Message: "本地目录不存在"}
	}
	if !IsRepo(ctx, p.Dir) {
		return OpResult{Message: "本地目录不是一个 Git 仓库"}
	}
	branch := p.Branch
	if branch == "" {
		branch = "main"
	}
	args := []string{"-c", "safe.directory=*", "-c", "credential.helper="}
	args = append(args, "push", AuthURL(p.Platform, p.Owner, p.Repo, p.Token), "HEAD:"+branch)
	r := run(ctx, args, p.Dir, 5*time.Minute)
	if !r.Ok {
		return OpResult{Message: CleanError(r)}
	}
	return OpResult{OK: true, Message: "已把本地提交推送到云端"}
}

/* ------------------------------------------------------------ 错误翻译 */

var (
	reCred     = regexp.MustCompile(`https://[^@\s]+@`)
	reHost     = regexp.MustCompile(`(?i)could not resolve host|unable to access`)
	reAuth     = regexp.MustCompile(`(?i)authentication failed|invalid username or password|403`)
	reNotFound = regexp.MustCompile(`(?i)not found|repository not found|404`)
	reDiverged = regexp.MustCompile(`(?i)diverged|non-fast-forward|behind`)
	reHint     = regexp.MustCompile(`(?i)^\s*(hint|remote: counting|remote: compressing|remote: total)`)
)

// CleanError 把 git 的原始报错翻成人看得懂、且**能照着改**的一句话。
//
// 两件事必须做：
//  1. 抹掉 URL 里的凭据 —— 报错里经常带着完整的 https://用户:Token@主机，
//     它会进日志、也可能被截图发出去；
//  2. 认出几类典型失败并给具体建议 —— 「unknown error」这种没人能照着改。
func CleanError(r result) string {
	if r.Err != nil && r.Err.Error() == "NOT_INSTALLED" {
		return "未检测到 Git，请先安装 Git for Windows 并加入 PATH"
	}
	msg := r.Stderr
	if msg == "" {
		msg = r.Stdout
	}
	if msg == "" && r.Err != nil {
		msg = r.Err.Error()
	}
	msg = reCred.ReplaceAllString(msg, "https://***@")

	switch {
	case reHost.MatchString(msg):
		return "无法连接远端仓库，请检查网络 / 代理设置"
	case reAuth.MatchString(msg):
		return "认证失败：Token 无效或没有该仓库权限"
	case reNotFound.MatchString(msg):
		return "仓库不存在或无权访问，请检查用户名 / 仓库名 / Token"
	case reDiverged.MatchString(msg):
		return "本地与云端出现分叉，请在设置中改用「强制对齐」同步策略"
	}

	// git 的输出里有一半是进度提示，留着会把真正的错误挤到看不见的地方
	lines := []string{}
	for _, l := range strings.Split(msg, "\n") {
		if strings.TrimSpace(l) == "" || reHint.MatchString(l) {
			continue
		}
		lines = append(lines, strings.TrimSpace(l))
		if len(lines) >= 3 {
			break
		}
	}
	if len(lines) == 0 {
		return "Git 操作失败"
	}
	return strings.Join(lines, " ")
}

// ErrNotInstalled 是「本机没有 git」的哨兵错误，调用方据此给出不同的提示。
var ErrNotInstalled = errors.New("git 未安装")
