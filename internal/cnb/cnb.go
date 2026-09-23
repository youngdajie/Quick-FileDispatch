// Package cnb 是 CNB（cnb.cool）平台的写入通道，对应 Electron 版的 src/main/cnb.js。
//
// # 为什么要有这个包
//
// CNB 的公开 Open API 里**没有**创建 Tree / 创建 Commit / 更新 Ref 的接口
// （blob 接口的文档写着「通常与 Tree/Commit 接口配合使用」，但那两个并没开放）。
// 孤立的 blob 没有落点，等于白造 —— 所以 CNB 的上传 / 删除 / 改名 / 替换
// 只能走 Git 本身：把仓库弄到一个工作区 → 改文件 → commit → push。
//
// # 工作区从哪来
//
//	优先复用配置里绑定的本地目录（本来就是同一个仓库，改完顺带一致）；
//	没有绑定、或者绑的目录其实指向**别的仓库**时，临时克隆一份到 userData 下，
//	提交推送完立刻删掉，不在用户磁盘上留垃圾。
//
// 「绑的目录是别人的仓库」这条判断是硬的：不查就直接改，等于把 A 仓库的
// 文件推进 B 仓库，而且 push 会真的成功 —— 后果比报错严重得多。
package cnb

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/paths"
)

// Conn 是写入一条 CNB 仓库所需的全部信息。
type Conn struct {
	Platform string
	Owner    string
	Repo     string
	Branch   string
	Token    string
	LocalDir string
}

// Workspace 是一次写入用到的 Git 工作区。
type Workspace struct {
	Used string // "local" | "temp"
	Dir  string
}

// File 是待写入的一个文件。
type File struct {
	Path string
	Buff []byte
}

// MoveItem 是一次移动 / 改名。
type MoveItem struct {
	From string
	To   string
}

// remoteMatches 判断某个本地仓库的 origin 是不是目标仓库。
//
// 两个条件都要满足：主机对 + owner/repo 对。只看其中一个的话，
// 同名仓库（不同人）会被误判成同一个。
func remoteMatches(remote, platform, owner, repo string) bool {
	if remote == "" {
		return false
	}
	host := git.HostOf(platform)
	tail := strings.ToLower(owner + "/" + repo)
	u := strings.ToLower(remote)
	return strings.Contains(u, host) && strings.Contains(u, tail)
}

// withWorkspace 在一个可用的 Git 工作区里执行 fn，用完清理临时工作区。
//
// fn 的返回值会原样透出，所以调用方能拿到 git 通道的真实结果
// （成功 / 失败原因），不至于被这一层吞掉。
func withWorkspace(ctx context.Context, c Conn, tmpRoot string, fn func(dir string) (git.OpResult, error)) (*Workspace, git.OpResult, error) {
	bound := strings.TrimSpace(c.LocalDir)
	if bound != "" {
		if st, err := os.Stat(bound); err == nil && st.IsDir() && git.IsRepo(ctx, bound) {
			sum := git.RepoSummary(ctx, bound)
			remote, _ := sum["remote"].(string)
			if remoteMatches(remote, c.Platform, c.Owner, c.Repo) {
				git.ConfigureIdentity(ctx, bound)
				res, err := fn(bound)
				return &Workspace{Used: "local", Dir: bound}, res, err
			}
			// 目录是别人的仓库：宁可临时克隆，也不要把文件推错地方
		}
	}

	if git.Version(ctx) == "" {
		return nil, git.OpResult{}, errors.New(
			"CNB 平台的文件写入依赖 Git：请先安装 Git for Windows 并加入 PATH，或为这份配置绑定本地目录")
	}

	tmp := filepath.Join(tmpRoot, "w"+time.Now().Format("150405.000")+randSuffix())
	cr := git.Clone(ctx, git.CloneParams{
		Platform: c.Platform, Owner: c.Owner, Repo: c.Repo,
		Branch: c.Branch, Token: c.Token, Dir: tmp,
	})
	if !cr.OK {
		return nil, git.OpResult{}, errors.New("CNB 写入需要先把仓库拉到本地，克隆失败：" + cr.Message)
	}
	// 临时工作区必须删掉：里面是整个仓库，几千个文件，
	// 留在用户磁盘上就是一堆没人认领的垃圾
	defer removeDir(tmp)

	res, err := fn(tmp)
	return &Workspace{Used: "temp", Dir: tmp}, res, err
}

// removeDir 删掉临时工作区。删不掉就算了 ——
// 只是收尾清理，别因为清理失败让主流程报错（下次启动可以再清）。
func removeDir(dir string) {
	_ = os.RemoveAll(dir)
}

var seq int64

func randSuffix() string {
	seq++
	return fmt.Sprintf("%d", time.Now().UnixNano()%100000+seq)
}

/* ------------------------------------------------------------ 写入动作 */

func writeFiles(dir string, files []File) error {
	for _, f := range files {
		abs, err := paths.SafeJoin(dir, f.Path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(abs, f.Buff, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func deletePaths(dir string, rels []string) int {
	removed := 0
	for _, rel := range rels {
		abs, err := paths.SafeJoin(dir, rel)
		if err != nil {
			continue
		}
		if _, err := os.Stat(abs); err != nil {
			continue
		}
		if err := os.RemoveAll(abs); err == nil {
			removed++
		}
	}
	return removed
}

func movePaths(dir string, items []MoveItem) error {
	for _, it := range items {
		from, err := paths.SafeJoin(dir, it.From)
		if err != nil {
			continue
		}
		to, err := paths.SafeJoin(dir, it.To)
		if err != nil {
			continue
		}
		if _, err := os.Stat(from); err != nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			continue
		}
		// 目标已存在就先删：跨设备 rename 不会覆盖，会直接失败
		if _, err := os.Stat(to); err == nil {
			_ = os.RemoveAll(to)
		}
		_ = os.Rename(from, to)
	}
	return nil
}

// commit 在工作区里提交并推送。
func (c *Conn) commit(ctx context.Context, dir, message string) (git.OpResult, error) {
	return git.CommitAndPush(ctx, git.CommitParams{
		Platform: c.Platform, Owner: c.Owner, Repo: c.Repo,
		Branch: c.Branch, Token: c.Token, Dir: dir, Message: message,
	}), nil
}

/* ------------------------------------------------------------ 对外 */

// UploadBatch 上传一批文件，返回逐条结果。
//
// 整批是一次提交：20 个文件在仓库里只出现一条提交记录，
// 和 GitHub 的 Git Data API 效果对齐（界面上不会看出两个平台的差别）。
func UploadBatch(ctx context.Context, c Conn, tmpRoot string, files []File, message string) ([]map[string]any, error) {
	if len(files) == 0 {
		return []map[string]any{}, nil
	}
	msg := message
	if strings.TrimSpace(msg) == "" {
		msg = "chore: 通过 JIE 分发服务上传"
	}
	ws, res, err := withWorkspace(ctx, c, tmpRoot, func(dir string) (git.OpResult, error) {
		if e := writeFiles(dir, files); e != nil {
			return git.OpResult{Message: e.Error()}, nil
		}
		return c.commit(ctx, dir, msg)
	})
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		if !res.OK {
			out = append(out, map[string]any{"path": f.Path, "ok": false, "error": res.Message})
			continue
		}
		out = append(out, map[string]any{
			"path": f.Path, "ok": true, "error": nil,
			"via":  ws.Used,
			"note": map[string]string{"local": "已就地更新本地目录", "temp": "已通过临时克隆提交"}[ws.Used],
		})
	}
	return out, nil
}

// DeleteBatch 删除一批路径。
func DeleteBatch(ctx context.Context, c Conn, tmpRoot string, rels []string, message string) ([]map[string]any, error) {
	if len(rels) == 0 {
		return []map[string]any{}, nil
	}
	msg := message
	if strings.TrimSpace(msg) == "" {
		msg = "chore: 删除文件"
	}
	ws, res, err := withWorkspace(ctx, c, tmpRoot, func(dir string) (git.OpResult, error) {
		deletePaths(dir, rels)
		return c.commit(ctx, dir, msg)
	})
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rels))
	for _, p := range rels {
		if !res.OK {
			out = append(out, map[string]any{"path": p, "ok": false, "error": res.Message})
			continue
		}
		out = append(out, map[string]any{"path": p, "ok": true, "error": nil, "via": ws.Used})
	}
	return out, nil
}

// MoveBatch 移动 / 改名一批文件。
func MoveBatch(ctx context.Context, c Conn, tmpRoot string, items []MoveItem, message string) ([]map[string]any, error) {
	if len(items) == 0 {
		return []map[string]any{}, nil
	}
	msg := message
	if strings.TrimSpace(msg) == "" {
		msg = fmt.Sprintf("chore: 移动 %d 个文件", len(items))
	}
	ws, res, err := withWorkspace(ctx, c, tmpRoot, func(dir string) (git.OpResult, error) {
		if e := movePaths(dir, items); e != nil {
			return git.OpResult{Message: e.Error()}, nil
		}
		return c.commit(ctx, dir, msg)
	})
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if !res.OK {
			out = append(out, map[string]any{"path": it.To, "from": it.From, "ok": false, "error": res.Message})
			continue
		}
		out = append(out, map[string]any{"path": it.To, "from": it.From, "ok": true, "error": nil, "via": ws.Used})
	}
	return out, nil
}

// ReplaceFile 用一份新内容覆盖某个已存在的路径（路径不变）。
func ReplaceFile(ctx context.Context, c Conn, tmpRoot, rel string, buff []byte, message string) error {
	msg := message
	if strings.TrimSpace(msg) == "" {
		msg = "chore: 替换 " + rel
	}
	_, res, err := withWorkspace(ctx, c, tmpRoot, func(dir string) (git.OpResult, error) {
		if e := writeFiles(dir, []File{{Path: rel, Buff: buff}}); e != nil {
			return git.OpResult{Message: e.Error()}, nil
		}
		return c.commit(ctx, dir, msg)
	})
	if err != nil {
		return err
	}
	if !res.OK {
		return errors.New(res.Message)
	}
	return nil
}
