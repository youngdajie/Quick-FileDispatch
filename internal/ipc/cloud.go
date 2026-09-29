package ipc

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/cloud"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/cnb"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/lfs"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/local"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/paths"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/progress"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/textenc"
)

/* ------------------------------------------------------------ 连接信息 */

// conn 是当前生效那份配置的「连接信息」—— 建客户端 / 调 git 都要它。
func (e *Env) conn() (map[string]any, *cloud.Client, error) {
	cfg := e.Store.Raw()
	owner, _ := cfg["owner"].(string)
	repo, _ := cfg["repo"].(string)
	if owner == "" || repo == "" {
		return cfg, nil, errors.New("尚未配置仓库：请先在「设置」页填写用户名（owner）与仓库名（repo）")
	}
	token := e.Store.GetToken()
	if token == "" {
		return cfg, nil, errors.New("尚未配置访问令牌：请先在「设置」页填写 Token")
	}
	branch, _ := cfg["branch"].(string)
	apiBase, _ := cfg["apiBase"].(string)
	client := cloud.New(strOf(cfg["platform"]), owner, repo, branch, token, apiBase)
	return cfg, client, nil
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

// isCNB 判断当前配置是不是 CNB —— CNB 的写操作全部走 git 通道。
func isCNB(cfg map[string]any) bool {
	return strOf(cfg["platform"]) == "cnb"
}

// cnbConn 组装 CNB 写入通道要的信息。
// 比 cloud.Client 多带一个 localDir：有绑定就就地改，没有就临时克隆。
func (e *Env) cnbConn(cfg map[string]any) cnb.Conn {
	return cnb.Conn{
		Platform: "cnb",
		Owner:    strOf(cfg["owner"]),
		Repo:     strOf(cfg["repo"]),
		Branch:   defStr2(cfg["branch"], "main"),
		Token:    e.Store.GetToken(),
		LocalDir: strOf(cfg["localDir"]),
	}
}

/* ------------------------------------------------------------ cloud:verify */

func (e *Env) cloudVerify() (any, error) {
	out := map[string]any{"ok": false, "steps": []any{}}
	steps := []any{}
	addStep := func(name string, ok bool, msg string) {
		steps = append(steps, map[string]any{"name": name, "ok": ok, "message": msg})
	}

	cfg, client, err := e.conn()
	if err != nil {
		addStep("账号鉴权", false, friendly(err))
		out["steps"] = steps
		return out, nil
	}

	user, err := client.Whoami()
	if err != nil {
		addStep("账号鉴权", false, friendly(err))
		out["steps"] = steps
		return out, nil
	}
	addStep("账号鉴权", true, "已登录："+firstNonEmpty(user.Name, user.Login))
	out["user"] = user

	repo, err := client.RepoInfo()
	if err != nil {
		// 账号过了但仓库读不到，是很常见的情况（Token 没勾 repo 权限）。
		// 单独记一步，让用户看得出「Token 是好的，只是没这个仓库的权限」。
		addStep("仓库访问", false, friendly(err))
		out["steps"] = steps
		// out["ok"] 末尾统一算（line 120），这里不用再赋 false
		return out, nil
	}
	out["repo"] = repo
	addStep("仓库访问", true, fmt.Sprintf("%s · %s · 已用 %s",
		repo.FullName,
		map[bool]string{true: "私有", false: "公开"}[repo.Private],
		paths.FormatBytes(repo.SizeKB*1024)))

	items, err := client.ListDir("")
	if err != nil {
		addStep("分支读取", false, friendly(err))
		out["steps"] = steps
		return out, nil
	}
	addStep("分支读取", true, fmt.Sprintf("分支 %s 可读，根目录 %d 项", defStr2(cfg["branch"], "main"), len(items)))

	ok := true
	for _, s := range steps {
		if m, is := s.(map[string]any); is {
			if b, is2 := m["ok"].(bool); is2 && !b {
				ok = false
			}
		}
	}
	out["ok"] = ok
	out["steps"] = steps
	return out, nil
}

/* ------------------------------------------------------------ cloud:list */

func (e *Env) cloudList(payload map[string]any) (any, error) {
	dirRel := paths.Normalize(strOf(payload["dir"]))
	cfg := e.Store.Raw()
	localReady := e.localReady(cfg)

	// 管理页默认读本地（快）；本地不可用时**静默退回远程**，
	// 而不是报错 —— 用户只是想看文件列表，不该被「本地目录没绑」挡住。
	if strOf(payload["source"]) == "local" && localReady {
		items, err := local.ListDir(strOf(cfg["localDir"]), dirRel)
		if err != nil {
			return nil, err
		}
		return map[string]any{"source": "local", "dir": dirRel, "items": items, "localReady": localReady}, nil
	}
	_, client, err := e.conn()
	if err != nil {
		return nil, err
	}
	items, err := client.ListDir(dirRel)
	if err != nil {
		return nil, err
	}
	return map[string]any{"source": "remote", "dir": dirRel, "items": items, "localReady": localReady}, nil
}

// localReady：本地目录存在且是 Git 仓库。
func (e *Env) localReady(cfg map[string]any) bool {
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return false
	}
	return git.IsRepo(context.Background(), dir)
}

/* ------------------------------------------------------------ cloud:tree */

func (e *Env) cloudTree(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	if strOf(payload["source"]) == "local" && e.localReady(cfg) {
		return map[string]any{
			"source": "local",
			"tree":   local.Tree(strOf(cfg["localDir"]), "", 0, 2),
		}, nil
	}
	_, client, err := e.conn()
	if err != nil {
		return nil, err
	}
	items, err := client.ListDir("")
	if err != nil {
		return nil, err
	}
	// 远程模式只列一级目录：逐层点开时再请求，避免一次拉爆接口
	tree := []any{}
	for _, it := range items {
		if it.Type == "dir" {
			tree = append(tree, map[string]any{"name": it.Name, "path": it.Path, "children": []any{}})
		}
	}
	return map[string]any{"source": "remote", "tree": tree}, nil
}

/* ------------------------------------------------------------ cloud:stats */

func (e *Env) cloudStats(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	key := e.repoKey()

	if strOf(payload["source"]) == "local" && strOf(cfg["localDir"]) != "" && local.Exists(strOf(cfg["localDir"])) {
		out, err := e.cache.Cached("stats|local|"+key, repoStatsTTL, func() (any, error) {
			c := local.CountDir(strOf(cfg["localDir"]), "", 0, nil)
			return map[string]any{
				"source": "local",
				"files":  c.Files,
				"bytes":  c.Bytes,
				"images": c.Images,
			}, nil
		})
		return out, err
	}
	// 远程统计要递归调接口（最多 60 次请求），切配置时最容易被反复触发 —— 必须缓存
	return e.cache.Cached("stats|remote|"+key, repoStatsTTL, func() (any, error) {
		_, client, err := e.conn()
		if err != nil {
			return nil, err
		}
		c := client.CountFiles("", 0, nil, nil)
		return map[string]any{
			"source":    "remote",
			"files":     c.Files,
			"bytes":     c.Bytes,
			"truncated": c.Truncated,
		}, nil
	})
}

/* ------------------------------------------------------------ cloud:upload */

func (e *Env) cloudUpload(payload map[string]any) (any, error) {
	files, _ := payload["files"].([]any)
	if len(files) == 0 {
		return map[string]any{"ok": false, "message": "没有待上传的文件"}, nil
	}
	// 勾了「用 LFS 存储」才走对象存储；没勾就是原来的行为（内容进 git 仓库）。
	useLFS := boolOf(payload["useLFS"])
	// 进度上报器。Progress 没接上时是 nil，而 Reporter 的所有方法都是
	// nil-safe，所以下面一行判空都不用写。
	rep := e.Progress.Task("upload")

	cfg, client, err := e.conn()
	if err != nil {
		rep.Fail(err)
		return nil, err
	}
	platform := cloud.NormalizePlatform(strOf(cfg["platform"]))
	limit := cloud.FileLimitBytes(platform)
	subDir := paths.Normalize(strOf(payload["dir"]))

	results := []any{}
	accepted := []cloud.File{}
	meta := map[string]map[string]any{}

	for _, f := range files {
		m, ok := f.(map[string]any)
		if !ok {
			continue
		}
		buf, err := decodeBytes(m["data"])
		if err != nil {
			return nil, err
		}
		name := paths.Sanitize(strOf(m["name"]))
		// 上传到哪里完全由上传页选的「目标目录」决定，不再叠加隐式的日期目录
		rel := paths.Join(subDir, name)
		if int64(len(buf)) > limit {
			results = append(results, map[string]any{
				"name": name, "path": rel, "ok": false,
				"error": fileTooBigMsg(platform, int64(len(buf))),
			})
			continue
		}
		accepted = append(accepted, cloud.File{Path: rel, Buff: buf})
		meta[rel] = map[string]any{"name": name, "size": len(buf)}
	}

	if len(accepted) > 0 {
		n := len(accepted)
		msg := defStr2(cfg["commitMessage"], "chore: 通过 JIE 分发服务上传") +
			fmt.Sprintf(" (%d file%s)", n, map[bool]string{true: "s", false: ""}[n > 1])

		var batch []map[string]any
		var batchErr error
		if isCNB(cfg) {
			// 勾了 LFS 才需要 git-lfs。它可能要现下载（约 6MB），
			// 所以**先准备好再开始传** —— 失败就直接返回，
			// 不让用户白等一轮压缩和克隆。
			if useLFS {
				if err := e.ensureLFS(rep); err != nil {
					rep.Fail(err)
					return nil, err
				}
			}
			batch, batchErr = cnb.UploadBatch(context.Background(), e.cnbConn(cfg), e.TmpRoot,
				toCNBFiles(accepted), msg, cnb.UploadOptions{
					UseLFS:     useLFS,
					OnProgress: gitProgressBridge(rep),
				})
		} else {
			var rs []cloud.Result
			rs, batchErr = client.UploadBatch(accepted, msg, func(done, total int64) {
				rep.Report(progress.PhaseUpload, done, total, "")
			})
			for _, r := range rs {
				batch = append(batch, map[string]any{"path": r.Path, "ok": r.OK, "error": r.Error})
			}
		}
		if batchErr != nil {
			rep.Fail(batchErr)
			// 整批失败：给每条都记上同一个原因，界面上才知道是「一个都没传上去」
			for _, f := range accepted {
				results = append(results, map[string]any{
					"name": meta[f.Path]["name"], "size": meta[f.Path]["size"],
					"path": f.Path, "ok": false, "error": friendly(batchErr),
				})
			}
		} else {
			for _, r := range batch {
				info := meta[strOf(r["path"])]
				item := map[string]any{"path": r["path"], "ok": r["ok"], "error": r["error"]}
				if info != nil {
					item["name"] = info["name"]
					item["size"] = info["size"]
				}
				if v, ok := r["via"]; ok {
					item["via"] = v
				}
				if v, ok := r["note"]; ok {
					item["note"] = v
				}
				results = append(results, item)
			}
		}
	}

	uploaded := 0
	for _, r := range results {
		if m, ok := r.(map[string]any); ok {
			if b, is := m["ok"].(bool); is && b {
				uploaded++
			}
		}
	}
	// 进度条的终态。成功/失败都要明确推一次 —— 否则前端会一直停在
	// 「上传中 87%」，直到用户自己刷新页面。
	if uploaded > 0 {
		rep.Done(fmt.Sprintf("已上传 %d 个文件", uploaded))
	} else if len(results) > 0 {
		rep.Fail(errors.New("一个文件都没传上去"))
	}
	var sync any
	if uploaded > 0 {
		sync = e.syncLocal("upload")
	}
	return map[string]any{
		"ok": uploaded > 0, "results": results, "sync": sync,
		"uploaded": uploaded, "failed": len(results) - uploaded,
	}, nil
}

/* ------------------------------------------------------------ git-lfs */

// lfsStatus 报告 git-lfs 的可用状态。
//
// **不触发下载** —— 设置页一打开就问一下，不该因此产生网络流量。
// 真正的安装是 lfsInstall（可能几十秒，带进度事件）。
func (e *Env) lfsStatus() map[string]any {
	exe, _, ok := lfs.Find(e.ConfigDir)
	ownPath := lfs.ExePath(e.ConfigDir)
	out := map[string]any{
		"available": ok,
		"path":      exe,
		// 程序内置要装的版本（界面上说明「点安装会装哪个版本」）
		"shipsVersion": lfs.Version,
		// 是不是程序自己装的那一份（false = 用的是用户系统里已有的）
		"managed": ok && exe == ownPath,
	}
	if ok {
		out["version"] = lfs.InstalledVersion(context.Background(), exe)
	}
	return out
}

// lfsInstall 下载并安装 git-lfs，带进度事件。
//
// 幂等：已经装过时 lfs.Ensure 会直接返回，不会重复下载。
// 所以前端不用「先查再调」，无脑调它就对了。
func (e *Env) lfsInstall() (any, error) {
	rep := e.Progress.Task("lfs-install")
	binDir, err := lfs.Ensure(context.Background(), e.ConfigDir, func(status string) {
		rep.Report(progress.PhaseLFS, 0, 0, status)
	})
	if err != nil {
		rep.Fail(err)
		return nil, err
	}
	if binDir != "" {
		// 装完立刻生效，不用重启程序
		git.SetExtraPath(binDir)
	}
	rep.Done("git-lfs 已就绪")
	return map[string]any{"ok": true, "path": lfs.ExePath(e.ConfigDir)}, nil
}

/* ------------------------------------------------------------ 上传辅助 */

// ensureLFS 确保 git-lfs 可用（没装就自动下载安装）。
//
// 装好后必须把 bin 目录注入 git 子进程的 PATH：git 执行 filter.lfs.clean
// 时要找名叫 git-lfs 的可执行文件，找不到的话 `git add` 会直接报错 ——
// 而且报的是「git-lfs: command not found」这种用户完全看不懂的话。
func (e *Env) ensureLFS(rep *progress.Reporter) error {
	binDir, err := lfs.Ensure(context.Background(), e.ConfigDir, func(status string) {
		rep.Report(progress.PhaseLFS, 0, 0, status)
	})
	if err != nil {
		return err
	}
	if binDir != "" {
		git.SetExtraPath(binDir)
	}
	return nil
}

// gitProgressBridge 把 git 包的进度回调接到上传上报器上。
//
// 两层之间用函数类型桥接而不是直接互相引用：cnb / git 那一层不需要知道
// 「进度最终去了 SSE 还是别处」，ipc 这一层本来就两边都认识。
func gitProgressBridge(rep *progress.Reporter) git.ProgressFunc {
	if rep == nil {
		return nil
	}
	return func(phase string, bytes, total int64, msg string) {
		rep.Report(phase, bytes, total, msg)
	}
}

// boolOf 取布尔值，取不到给 false。渲染层传上来的 JSON 里，
// 字段缺失是常态（老版本前端不会传 useLFS）。
func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}

// fileTooBigMsg：文件超限的提示跟着平台走 ——
// 两个平台上限不同（GitHub 100MB / CNB 200MB），说错了用户会以为是程序有 bug。
func fileTooBigMsg(platform string, size int64) string {
	if platform == "cnb" {
		return fmt.Sprintf("文件 %s 超过 CNB 单文件 200MB 限制", paths.FormatBytes(size))
	}
	return fmt.Sprintf("文件 %s 超过 GitHub 单文件 100MB 限制", paths.FormatBytes(size))
}

func toCNBFiles(fs []cloud.File) []cnb.File {
	out := make([]cnb.File, 0, len(fs))
	for _, f := range fs {
		out = append(out, cnb.File{Path: f.Path, Buff: f.Buff})
	}
	return out
}

/* ------------------------------------------------------------ cloud:delete */

func (e *Env) cloudDelete(payload map[string]any) (any, error) {
	rels := normalizeList(payload["paths"])
	if len(rels) == 0 {
		return map[string]any{"ok": false, "message": "没有选中任何文件"}, nil
	}
	cfg, client, err := e.conn()
	if err != nil {
		return nil, err
	}
	msg := defStr2(payload["message"], "chore: delete files via JIE Dispatch")

	var results []any
	if isCNB(cfg) {
		rs, err2 := cnb.DeleteBatch(context.Background(), e.cnbConn(cfg), e.TmpRoot, rels, msg)
		if err2 != nil {
			return nil, err2
		}
		results = toAnySlice(rs)
	} else {
		rs, err2 := client.DeleteBatch(rels, msg)
		if err2 != nil {
			return nil, err2
		}
		for _, r := range rs {
			results = append(results, map[string]any{"path": r.Path, "ok": r.OK, "error": r.Error})
		}
	}
	ok := anyOK(results)
	var sync any
	if ok {
		sync = e.syncLocal("delete")
	}
	return map[string]any{"ok": ok, "results": results, "sync": sync}, nil
}

/* ------------------------------------------------------------ cloud:move */

func (e *Env) cloudMove(payload map[string]any) (any, error) {
	items := []cnb.MoveItem{}
	if arr, ok := payload["items"].([]any); ok {
		for _, it := range arr {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			from := paths.Normalize(strOf(m["from"]))
			to := paths.Normalize(strOf(m["to"]))
			if from == "" || to == "" || from == to {
				continue
			}
			items = append(items, cnb.MoveItem{From: from, To: to})
		}
	}
	if len(items) == 0 {
		return map[string]any{"ok": false, "message": "没有需要移动的文件（源路径与目标路径一致）"}, nil
	}
	cfg, client, err := e.conn()
	if err != nil {
		return nil, err
	}
	msg := defStr2(payload["message"], fmt.Sprintf("chore: 移动 %d 个文件", len(items)))

	var results []any
	if isCNB(cfg) {
		rs, err2 := cnb.MoveBatch(context.Background(), e.cnbConn(cfg), e.TmpRoot, items, msg)
		if err2 != nil {
			return nil, err2
		}
		results = toAnySlice(rs)
	} else {
		gitItems := make([]cloud.MoveItem, 0, len(items))
		for _, it := range items {
			gitItems = append(gitItems, cloud.MoveItem{From: it.From, To: it.To})
		}
		rs, err2 := client.MoveBatch(gitItems, msg)
		if err2 != nil {
			return nil, err2
		}
		for i, r := range rs {
			item := map[string]any{"path": r.Path, "ok": r.OK, "error": r.Error}
			if i < len(items) {
				item["from"] = items[i].From
			}
			results = append(results, item)
		}
	}
	ok := anyOK(results)
	var sync any
	if ok {
		sync = e.syncLocal("move")
	}
	return map[string]any{"ok": ok, "results": results, "sync": sync}, nil
}

/* ------------------------------------------------------------ cloud:replace */

func (e *Env) cloudReplace(payload map[string]any) (any, error) {
	rel := paths.Normalize(strOf(payload["path"]))
	if rel == "" {
		return nil, errors.New("缺少目标路径")
	}
	buf, err := decodeBytes(payload["data"])
	if err != nil {
		return nil, err
	}
	if len(buf) == 0 {
		return nil, errors.New("替换的内容为空")
	}
	cfg, client, err := e.conn()
	if err != nil {
		return nil, err
	}
	limit := cloud.FileLimitBytes(cloud.NormalizePlatform(strOf(cfg["platform"])))
	if int64(len(buf)) > limit {
		return nil, fmt.Errorf("文件 %s 超过平台单文件上限（%s）",
			paths.FormatBytes(int64(len(buf))), paths.FormatBytes(limit))
	}

	if isCNB(cfg) {
		if err := cnb.ReplaceFile(context.Background(), e.cnbConn(cfg), e.TmpRoot, rel, buf, "chore: 替换 "+rel); err != nil {
			return nil, err
		}
	} else {
		// 替换是单个文件、用户没在等进度条，所以回调传 nil
		rs, err2 := client.UploadBatch([]cloud.File{{Path: rel, Buff: buf}}, "chore: 替换 "+rel, nil)
		if err2 != nil {
			return nil, err2
		}
		if len(rs) == 0 || !rs[0].OK {
			msg := "替换失败"
			if len(rs) > 0 && rs[0].Error != nil {
				msg = fmt.Sprint(rs[0].Error)
			}
			return nil, errors.New(msg)
		}
	}
	sync := e.syncLocal("replace")
	return map[string]any{"ok": true, "path": rel, "size": len(buf), "sync": sync}, nil
}

/* ------------------------------------------------------------ cloud:readText */

// textReadMax 文本预览能接受的最大体积。再大就不是「看一眼」，是编辑器该干的活了。
const textReadMax = 2 * 1024 * 1024

func (e *Env) cloudReadText(payload map[string]any) (any, error) {
	rel := paths.Normalize(strOf(payload["path"]))
	if rel == "" {
		return nil, errors.New("缺少目标路径")
	}
	cfg := e.Store.Raw()

	var buf []byte
	if strOf(payload["source"]) == "local" {
		dir := strOf(cfg["localDir"])
		if dir == "" || !local.Exists(dir) {
			return nil, errors.New("尚未配置本地目录")
		}
		abs, err := paths.SafeJoin(dir, rel)
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(abs)
		if err != nil {
			return nil, errors.New("文件不存在：" + rel)
		}
		if st.IsDir() {
			return nil, errors.New("这是一个目录，不是文件")
		}
		if st.Size() > textReadMax {
			return map[string]any{"ok": false, "reason": "tooLarge", "size": st.Size(), "limit": textReadMax}, nil
		}
		buf, err = os.ReadFile(abs)
		if err != nil {
			return nil, err
		}
	} else {
		// 云端会整份拉下来，所以先按后缀挡一道：不认识的类型不浪费这次网络往返
		if !paths.IsTextName(rel) {
			return map[string]any{"ok": false, "reason": "binary", "size": 0}, nil
		}
		_, client, err := e.conn()
		if err != nil {
			return nil, err
		}
		buf, err = client.ReadRaw(rel)
		if err != nil {
			return nil, err
		}
		if int64(len(buf)) > textReadMax {
			return map[string]any{"ok": false, "reason": "tooLarge", "size": len(buf), "limit": textReadMax}, nil
		}
	}

	dec := textenc.Decode(buf)
	if !dec.OK {
		return map[string]any{"ok": false, "reason": dec.Reason, "size": len(buf)}, nil
	}
	return map[string]any{
		"ok":       true,
		"path":     rel,
		"source":   defStr2(payload["source"], "remote"),
		"size":     len(buf),
		"text":     dec.Text,
		"bom":      dec.BOM,
		"eol":      dec.EOL,
		"encoding": dec.Encoding,
		// 不是 UTF-8 的文件只给看：改写回去会改变整个文件的编码
		"editable": dec.Editable,
	}, nil
}

/* ------------------------------------------------------------ cloud:detect */

// detectCloud 回答「云端更新了、本地怎么没跟上」。
//
// 只读不写：任何「拉 / 推」都由渲染层拿到结论后再显式触发，
// 免得用户只是进个页面，仓库就被悄悄动了。
func (e *Env) detectCloud() (any, error) {
	ctx := context.Background()
	cfg := e.Store.Raw()
	branch := defStr2(cfg["branch"], "main")

	out := map[string]any{
		"ok":           false,
		"platform":     cloud.NormalizePlatform(strOf(cfg["platform"])),
		"branch":       branch,
		"repoLabel":    repoLabel(cfg),
		"gitAvailable": git.Version(ctx) != "",
		"local": map[string]any{
			"isRepo": false, "dir": strOf(cfg["localDir"]), "sha": "", "short": "",
			"dirty": false, "changes": 0, "branch": "",
		},
		"cloud":    map[string]any{"ok": false, "sha": "", "short": "", "message": ""},
		"ahead":    0,
		"behind":   0,
		"relation": "unknown",
	}

	if strOf(cfg["owner"]) == "" || strOf(cfg["repo"]) == "" {
		out["relation"] = "unconfigured"
		return out, nil
	}

	/* ---- 本地 HEAD ---- */
	dir := strings.TrimSpace(strOf(cfg["localDir"]))
	localMap := out["local"].(map[string]any)
	if dir != "" && local.Exists(dir) && git.IsRepo(ctx, dir) {
		st := git.Status(ctx, dir)
		sum := git.RepoSummary(ctx, dir)
		dirty, _ := st["dirty"].(bool)
		changes, _ := st["changes"].(int)
		localMap["isRepo"] = true
		localMap["sha"] = git.HeadSHAFull(ctx, dir)
		localMap["dirty"] = dirty
		localMap["changes"] = changes
		if sum != nil {
			localMap["short"] = strOf(sum["head"])
			localMap["branch"] = strOf(sum["branch"])
		}
	} else if dir != "" {
		localMap["reason"] = "目录不存在或不是 Git 仓库"
	}

	/* ---- 云端 HEAD ---- */
	token := e.Store.GetToken()
	if token == "" {
		out["cloud"].(map[string]any)["message"] = "本机没有可用 Token，无法读取云端提交"
		if b, _ := localMap["isRepo"].(bool); b {
			out["relation"] = "unknown"
		} else {
			out["relation"] = "no-local"
		}
		return out, nil
	}
	_, client, err := e.conn()
	if err != nil {
		return nil, err
	}
	sha, err := client.HeadSHA(branch)
	if err != nil {
		c := out["cloud"].(map[string]any)
		c["message"] = friendly(err)
		if b, _ := localMap["isRepo"].(bool); b {
			out["relation"] = "unknown"
		} else {
			out["relation"] = "no-local"
		}
		return out, nil
	}
	cloudMap := out["cloud"].(map[string]any)
	cloudMap["sha"] = sha
	cloudMap["ok"] = sha != ""
	if sha != "" {
		cloudMap["short"] = sha[:min(7, len(sha))]
	} else {
		cloudMap["message"] = "云端分支「" + branch + "」为空或不存在"
	}

	if b, _ := localMap["isRepo"].(bool); !b {
		out["relation"] = "no-local"
		out["ok"] = true
		return out, nil
	}

	// SHA 完全一致：连 fetch 都省了
	if strOf(localMap["sha"]) != "" && sha != "" && strOf(localMap["sha"]) == sha {
		out["relation"] = "same"
		out["ok"] = true
		return out, nil
	}
	if sha == "" {
		// 云端 HEAD 都没读到（空分支 / 接口不通），别再去 fetch ——
		// 比不出结论，白跑一次网络还可能把真实远端的凭据试探一遍
		out["relation"] = "unknown"
		out["ok"] = true
		return out, nil
	}
	// 接口地址被改成自定义的（GitHub Enterprise / 自建网关 / 离线自测）时，
	// 没法从接口地址反推 Git 远端主机，就别硬比提交了
	if custom := strings.TrimRight(strOf(cfg["apiBase"]), "/"); custom != "" &&
		custom != officialAPI(strOf(cfg["platform"])) {
		cloudMap["message"] = "接口地址是自定义的（" + custom + "），无法据此推断 Git 远端，跳过提交比对"
		out["relation"] = "unknown"
		out["ok"] = true
		return out, nil
	}
	if b, _ := out["gitAvailable"].(bool); !b {
		cloudMap["message"] = "未检测到 Git，无法比较提交历史"
		out["relation"] = "unknown"
		out["ok"] = true
		return out, nil
	}

	// 仓库内容变了，缓存里的旧结论作废
	f := git.FetchRef(ctx, git.PullParams{
		Platform: strOf(cfg["platform"]), Owner: strOf(cfg["owner"]), Repo: strOf(cfg["repo"]),
		Branch: branch, Token: token, Dir: dir,
	})
	if !f.OK {
		cloudMap["message"] = f.Message
		out["relation"] = "unknown"
		out["ok"] = true
		return out, nil
	}
	if s := git.FetchHeadSHA(ctx, dir); s != "" {
		cloudMap["short"] = s
	}
	cmp := git.CompareRefs(ctx, dir)
	if cmp == nil {
		out["relation"] = "unknown"
		out["ok"] = true
		return out, nil
	}
	out["ahead"] = cmp.Ahead
	out["behind"] = cmp.Behind
	switch {
	case cmp.Ahead > 0 && cmp.Behind > 0:
		out["relation"] = "diverged"
	case cmp.Ahead > 0:
		out["relation"] = "local-ahead"
	case cmp.Behind > 0:
		out["relation"] = "local-behind"
	default:
		out["relation"] = "same"
	}
	out["ok"] = true
	return out, nil
}

func officialAPI(platform string) string {
	if platform == "cnb" {
		return cloud.CNBAPI
	}
	return cloud.GitHubAPI
}

func repoLabel(cfg map[string]any) string {
	o := strOf(cfg["owner"])
	r := strOf(cfg["repo"])
	if o != "" && r != "" {
		return o + "/" + r
	}
	return ""
}

/* ------------------------------------------------------------ cloud:quota */

// cloudQuota 查 CNB 的存储用量，给管理页左侧画一根容量条。
//
// 刻意**不返回 error**：所有失败都塞进 {ok:false, reason:…}。
// 容量只是锦上添花的参考信息，不该因为它挂了就让整个侧栏报错 ——
// 那会盖掉下面更有用的「本地与云端是否同步」。
func (e *Env) cloudQuota() (any, error) {
	cfg := e.Store.Raw()
	out := map[string]any{
		"ok":       false,
		"platform": cloud.NormalizePlatform(strOf(cfg["platform"])),
		"owner":    strOf(cfg["owner"]),
		// CNB 的 charge 接口是组织级的，前端据此说明「含全部仓库」
		"scope": "org",
	}
	if out["platform"] != "cnb" {
		out["reason"] = "只有 CNB 能查容量"
		return out, nil
	}
	if out["owner"] == "" {
		out["reason"] = "还没配置仓库"
		return out, nil
	}
	_, client, err := e.conn()
	if err != nil {
		out["reason"] = friendly(err)
		return out, nil
	}
	q, err := client.Quota()
	if err != nil {
		out["reason"] = friendly(err)
		return out, nil
	}
	out["ok"] = true
	out["git"] = q.Git
	out["object"] = q.Object
	return out, nil
}

/* ------------------------------------------------------------ cloud:pushLocal */

func (e *Env) cloudPushLocal() (any, error) {
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return nil, errors.New("未绑定本地目录，无法推送")
	}
	if !git.IsRepo(context.Background(), dir) {
		return nil, errors.New("本地目录不是 Git 仓库，无法推送")
	}
	if strOf(cfg["owner"]) == "" || strOf(cfg["repo"]) == "" {
		return nil, errors.New("请先配置仓库信息")
	}
	r := git.CommitAndPush(context.Background(), git.CommitParams{
		Platform: strOf(cfg["platform"]), Owner: strOf(cfg["owner"]), Repo: strOf(cfg["repo"]),
		Branch: defStr2(cfg["branch"], "main"), Token: e.Store.GetToken(), Dir: dir,
		Message: defStr2(cfg["commitMessage"], "chore: 通过 JIE 分发服务更新"),
	})
	e.cache.Invalidate()
	return r, nil
}

/* ------------------------------------------------------------ /__remote 的内容源 */

// FetchRemote 给 /__remote 提供内容：从云端取某个文件的原始字节。
//
// 它存在的唯一理由是**私有仓库**：公开仓库的直链浏览器能直接取，
// 私有的要么带签名（会过期）要么带 Token（不能给渲染层）。
// 所以由后端代取，Token 从头到尾不出进程。
func (e *Env) FetchRemote(rel string) ([]byte, string, error) {
	_, client, err := e.conn()
	if err != nil {
		return nil, "", err
	}
	buf, err := client.ReadRaw(rel)
	if err != nil {
		return nil, "", err
	}
	return buf, mimeOf(rel), nil
}

var mimeByExt = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
	"gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
	"svg": "image/svg+xml", "avif": "image/avif", "ico": "image/x-icon",
}

func mimeOf(name string) string {
	if m, ok := mimeByExt[paths.Ext(name)]; ok {
		return m
	}
	return "application/octet-stream"
}

/* ------------------------------------------------------------ 同步 */

// syncLocal 上传 / 删除之后把云端变更拉回本地仓库。
//
// 失败**不返回 error**：这一步是「顺手同步」，主操作（上传）已经成功了。
// 因为同步失败就让整次上传报错，用户会以为文件没传上去。
func (e *Env) syncLocal(reason string) any {
	e.cache.Invalidate()
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if sync, ok := cfg["sync"].(map[string]any); ok {
		if b, is := sync["autoPull"].(bool); is && !b {
			return map[string]any{"skipped": true, "message": "未启用自动同步"}
		}
	}
	if dir == "" || !local.Exists(dir) {
		return map[string]any{"skipped": true, "message": "本地目录不存在"}
	}
	if !git.IsRepo(context.Background(), dir) {
		return map[string]any{"skipped": true, "message": "本地目录不是 Git 仓库，跳过同步"}
	}
	strategy := "pull"
	if sync, ok := cfg["sync"].(map[string]any); ok {
		if s, is := sync["strategy"].(string); is && s != "" {
			strategy = s
		}
	}
	r := git.Pull(context.Background(), git.PullParams{
		Platform: strOf(cfg["platform"]), Owner: strOf(cfg["owner"]), Repo: strOf(cfg["repo"]),
		Branch: defStr2(cfg["branch"], "main"), Token: e.Store.GetToken(),
		Dir: dir, Strategy: strategy,
	})
	return map[string]any{"reason": reason, "ok": r.OK, "message": r.Message}
}

/* ------------------------------------------------------------ Git 通道 */

func (e *Env) gitClone(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	if strOf(cfg["owner"]) == "" || strOf(cfg["repo"]) == "" {
		return nil, errors.New("请先配置用户名与仓库名")
	}
	dir := defStr2(payload["dir"], strOf(cfg["localDir"]))
	if dir == "" {
		return nil, errors.New("请先选择本地目录")
	}
	r := git.Clone(context.Background(), git.CloneParams{
		Platform: strOf(cfg["platform"]), Owner: strOf(cfg["owner"]), Repo: strOf(cfg["repo"]),
		Branch: defStr2(cfg["branch"], "main"), Token: e.Store.GetToken(), Dir: dir,
	})
	if r.OK {
		// 克隆成功就把这个目录记成本地目录 —— 用户原本可能没绑
		if _, err := e.Store.Patch(map[string]any{"localDir": dir}); err != nil {
			return nil, err
		}
		e.allowRoot(dir)
		e.cache.Invalidate()
	}
	return r, nil
}

func (e *Env) gitCommit(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return nil, errors.New("尚未配置本地目录")
	}
	if !git.IsRepo(context.Background(), dir) {
		return nil, errors.New("本地目录不是 Git 仓库，无法推送")
	}
	if strOf(cfg["owner"]) == "" || strOf(cfg["repo"]) == "" {
		return nil, errors.New("请先配置仓库信息")
	}
	msg := defStr2(payload["message"], defStr2(cfg["commitMessage"], "chore: 通过 JIE 分发服务更新"))
	r := git.CommitAndPush(context.Background(), git.CommitParams{
		Platform: strOf(cfg["platform"]), Owner: strOf(cfg["owner"]), Repo: strOf(cfg["repo"]),
		Branch: defStr2(cfg["branch"], "main"), Token: e.Store.GetToken(), Dir: dir, Message: msg,
	})
	// 推完「还有没有未推送的改动」就变了，缓存里的旧结论必须作废
	e.cache.Invalidate()
	return r, nil
}

func (e *Env) gitPull() (any, error) {
	return e.syncLocal("manual"), nil
}

/* ------------------------------------------------------------ 本地文件 */

func (e *Env) fsLocalRename(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return nil, errors.New("尚未配置本地目录")
	}
	from := paths.Normalize(strOf(payload["from"]))
	to := paths.Normalize(strOf(payload["to"]))
	if from == "" || to == "" {
		return nil, errors.New("路径不能为空")
	}
	if from == to {
		return nil, errors.New("源路径与目标路径一致")
	}
	absFrom, err := paths.SafeJoin(dir, from)
	if err != nil {
		return nil, err
	}
	absTo, err := paths.SafeJoin(dir, to)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(absFrom); err != nil {
		return nil, errors.New("源文件不存在：" + from)
	}
	if _, err := os.Stat(absTo); err == nil {
		if b, ok := payload["overwrite"].(bool); !ok || !b {
			return nil, errors.New("目标位置已存在同名文件：" + to)
		}
	}
	if err := local.EnsureDir(filepath.Dir(absTo)); err != nil {
		return nil, err
	}
	if err := os.Rename(absFrom, absTo); err != nil {
		return nil, err
	}
	e.cache.Invalidate()
	return map[string]any{"ok": true, "from": from, "to": to}, nil
}

func (e *Env) fsLocalWrite(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return nil, errors.New("尚未配置本地目录")
	}
	rel := paths.Normalize(strOf(payload["path"]))
	if rel == "" {
		return nil, errors.New("缺少目标路径")
	}
	buf, err := decodeBytes(payload["data"])
	if err != nil {
		return nil, err
	}
	if len(buf) == 0 {
		return nil, errors.New("替换的内容为空")
	}
	abs, err := paths.SafeJoin(dir, rel)
	if err != nil {
		return nil, err
	}
	if err := local.EnsureDir(filepath.Dir(abs)); err != nil {
		return nil, err
	}
	if err := os.WriteFile(abs, buf, 0o644); err != nil {
		return nil, err
	}
	e.cache.Invalidate()
	return map[string]any{"ok": true, "path": rel, "size": len(buf)}, nil
}

func (e *Env) fsLocalDelete(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return nil, errors.New("尚未配置本地目录")
	}
	rels := normalizeList(payload["paths"])
	results := []any{}
	for _, rel := range rels {
		abs, err := paths.SafeJoin(dir, rel)
		if err != nil {
			results = append(results, map[string]any{"path": rel, "ok": false, "error": err.Error()})
			continue
		}
		if _, err := os.Stat(abs); err != nil {
			results = append(results, map[string]any{"path": rel, "ok": false, "error": "文件不存在"})
			continue
		}
		// RemoveAll 对文件和目录都管用（删的可能是整个文件夹）
		if err := os.RemoveAll(abs); err != nil {
			results = append(results, map[string]any{"path": rel, "ok": false, "error": err.Error()})
			continue
		}
		results = append(results, map[string]any{"path": rel, "ok": true, "error": nil})
	}
	e.cache.Invalidate()
	return map[string]any{"ok": anyOK(results), "results": results}, nil
}

// fsLocalMkdir 在本地目录里新建一个空文件夹。
//
// 只动本地：和改名 / 删除同一路（改完要「提交并推送」才进仓库）。
// 注意 git **不跟踪空目录** —— 新建的文件夹要等里面有文件才会出现在云端，
// 界面上会提醒这一点，不然用户会以为没生效。
func (e *Env) fsLocalMkdir(payload map[string]any) (any, error) {
	cfg := e.Store.Raw()
	dir := strOf(cfg["localDir"])
	if dir == "" || !local.Exists(dir) {
		return nil, errors.New("尚未配置本地目录")
	}
	rel := paths.Normalize(strOf(payload["path"]))
	if rel == "" {
		return nil, errors.New("文件夹名不能为空")
	}
	abs, err := paths.SafeJoin(dir, rel)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(abs); err == nil {
		return nil, errors.New("同名文件夹或文件已经存在")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("创建文件夹失败：%w", err)
	}
	e.cache.Invalidate()
	return map[string]any{"ok": true, "path": rel}, nil
}

/* ------------------------------------------------------------ 小工具 */

// decodeBytes 接受三种形状：字节数组、base64 字符串，以及「被 JSON 化过的
// Uint8Array」。
//
// 为什么会有第三种：渲染层按 Electron 时代的老写法传 new Uint8Array(...)，
// 而 JSON.stringify(Uint8Array) **不会**变成数组，而是变成 {"0":104,"1":105}
// 这种数字键对象（结构化克隆才有 TypedArray 语义，HTTP+JSON 这条路上没有）。
// 于是三个吃字节的通道（cloud:upload / cloud:replace / fs:localWrite）在 Go
// 壳下全部报「期望字节数组或 base64 字符串」——这条兼容分支就是为了补上这个
// 落差，渲染层一个字都不用改。
//
// 三种都要认：Array.from(buffer) 在大文件上会产生一个几十万元素的 JSON 数组，
// 体积膨胀三四倍；所以大文件走 base64，小文件三种都行。
func decodeBytes(v any) ([]byte, error) {
	switch t := v.(type) {
	case []byte:
		return t, nil
	case []any:
		out := make([]byte, 0, len(t))
		for _, n := range t {
			switch x := n.(type) {
			case float64:
				out = append(out, byte(x))
			case int:
				out = append(out, byte(x))
			default:
				return nil, BadPayload("字节数组里有非数字元素")
			}
		}
		return out, nil
	case map[string]any:
		// Uint8Array 被 JSON 化后的形状：{"0":..,"1":..}。按数字键归位，
		// 键必须恰好覆盖 0..len-1，否则说明这个对象根本不是字节数组。
		if len(t) == 0 {
			return []byte{}, nil
		}
		out := make([]byte, len(t))
		seen := make([]bool, len(t))
		for k, n := range t {
			idx, err := strconv.Atoi(k)
			if err != nil || idx < 0 || idx >= len(out) || seen[idx] {
				return nil, BadPayload("期望字节数组或 base64 字符串")
			}
			f, ok := n.(float64)
			if !ok {
				return nil, BadPayload("字节数组里有非数字元素")
			}
			out[idx] = byte(f)
			seen[idx] = true
		}
		return out, nil
	case string:
		return decodeBase64(t)
	case nil:
		return nil, nil
	}
	return nil, BadPayload("期望字节数组或 base64 字符串")
}

func toAnySlice(in []map[string]any) []any {
	out := make([]any, 0, len(in))
	for _, m := range in {
		out = append(out, m)
	}
	return out
}

func normalizeList(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(arr))
	for _, it := range arr {
		if s := paths.Normalize(strOf(it)); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func anyOK(results []any) bool {
	for _, r := range results {
		if m, ok := r.(map[string]any); ok {
			if b, is := m["ok"].(bool); is && b {
				return true
			}
		}
	}
	return false
}

// friendly 把错误变成给界面看的一句话。
// ApiError 的 Message 已经是翻译过的，直接透出；
// 别的错误包一层，避免把 Go 的堆栈腔调（"json: cannot unmarshal..."）丢给用户。
func friendly(err error) string {
	if err == nil {
		return "未知错误"
	}
	if ae, ok := err.(*cloud.ApiError); ok {
		return ae.Message
	}
	return err.Error()
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// decodeBase64 解一段 base64 字符串。
//
// 渲染层走 src/renderer/js/lib/bytes.js 的 FileReader.readAsDataURL，
// 产物是**带 padding 的标准 base64**（+ 和 /）。这里用 base64.StdEncoding：
//
//   - 标准字符集（不认 - / _ 的 URL 安全变体）
//   - 必须有 padding（=）—— FileReader 总是给
//
// 旧实现走 json.Marshal + json.Unmarshal 凑效，是因为 base64 字符集
// 恰好没有 JSON 需要转义的字符 —— 看起来"碰巧能行"，但没有任何
// 注释说明意图，新人改 base64 解码时极易引入回归。
func decodeBase64(s string) ([]byte, error) {
	out, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, BadPayload("这段不是合法的 base64：" + err.Error())
	}
	return out, nil
}

func defStr2(v any, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}
