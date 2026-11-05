package ipc

/*
 * 本地目录状态判定。
 *
 * 「打开管理页时自动拉取云端」这句话真正的意思，是让本地目录变成这份配置
 * 对应的那份仓库。以前 syncLocal 遇到「不是 Git 仓库」就直接 skipped 跳过，
 * 于是文件管理页识别出「本地不是 Git 仓库」之后什么也没发生 —— 杰哥点名的
 * 就是这里。
 *
 * 现在把「能不能落地」拆成四种状态，交给前端决定怎么做：
 *   ready         本地就是这份配置的仓库 → 正常 pull
 *   empty         空目录（不是 Git 仓库）→ 可以从云端克隆下来
 *   foreign-repo  是别处的 Git 仓库（remote 对不上）→ 直接报错，绝不覆盖
 *   not-empty     非空且不是 Git 仓库 → 报错，别动用户已有的文件
 *
 * 判定只看 remote URL 里有没有 owner/repo，不猜平台：CNB / GitHub 的地址
 * 形态不一样，但都带这一截。
 */

import (
	"context"
	"os"
	"strings"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/local"
)

/** 这一份配置（或任意一份 profile map）和某个 remote 地址是不是同一间仓库 */
func remoteMatchesConfig(cfg map[string]any, remote string) bool {
	owner := strings.ToLower(strings.TrimSpace(strOf(cfg["owner"])))
	repo := strings.ToLower(strings.TrimSpace(strOf(cfg["repo"])))
	if owner == "" || repo == "" {
		return false
	}
	r := strings.ToLower(remote)
	return strings.Contains(r, owner+"/"+repo)
}

/**
 * inspectLocalDir 只读不写，回答「本地目录现在是什么状态」。
 * 供 git:inspect 通道和 profile:check 复用 —— 两边必须得出同一个结论，
 * 否则管理页说能克隆、向导最后一步却说不行（或者反过来）。
 */
func (e *Env) inspectLocalDir() map[string]any {
	cfg := e.Store.Raw()
	return inspectDir(cfg, strOf(cfg["localDir"]))
}

/** 同样一套判定，但按指定的 profile / 目录算（配置向导验证时用） */
func inspectDir(cfg map[string]any, dir string) map[string]any {
	out := map[string]any{"dir": dir}
	if dir == "" || !local.Exists(dir) {
		out["state"] = "no-dir"
		out["message"] = "还没绑定本地目录"
		return out
	}

	if git.IsRepo(context.Background(), dir) {
		remote, branch := "", ""
		if sum := git.RepoSummary(context.Background(), dir); sum != nil {
			remote = strOf(sum["remote"])
			branch = strOf(sum["branch"])
		}
		out["remote"] = remote
		out["branch"] = branch
		if !remoteMatchesConfig(cfg, remote) {
			out["state"] = "foreign-repo"
			out["message"] = "这个目录是别处的 Git 仓库（" + remote + "）"
		} else {
			out["state"] = "ready"
			out["message"] = "本地仓库就绪"
		}
		return out
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		out["state"] = "unreadable"
		out["message"] = "目录读不了：" + err.Error()
		return out
	}
	if len(entries) == 0 {
		out["state"] = "empty"
		out["message"] = "本地是空目录，可以向云端拉取"
	} else {
		out["state"] = "not-empty"
		out["entries"] = len(entries)
		out["message"] = "目录非空且不是 Git 仓库"
	}
	return out
}
