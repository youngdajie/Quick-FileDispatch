package cloud

import (
	"errors"
	"net/url"
	"strings"
)

// CNBWriteHint：CNB 的写入要走的提示。
//
// 这条错误信息必须说清「为什么」：只说「不支持」会让人以为是我们没做，
// 而实际是平台没开接口，得绕道 git。
const CNBWriteHint = "CNB 的公开接口不支持直接创建提交（没有 Tree/Commit 接口），写入需要通过 Git 完成"

var ErrCNBWrite = errors.New(CNBWriteHint)

// File 是一次写入的目标：仓库内相对路径 + 内容。
type File struct {
	Path string
	Buff []byte
}

// MoveItem 是一次移动 / 改名。
type MoveItem struct {
	From string
	To   string
}

/* ------------------------------------------------------------ 上传 */

// ProgressFunc 上报「已处理 / 共多少字节」。
//
// 单独定义在 cloud 包而不是复用 git 包的同名类型：语义虽然一样，
// 但强行合并会让 cloud 为了一个函数类型去依赖 git 包（它现在只依赖
// 标准库 + 自己的 read.go），不值得。
type ProgressFunc func(done, total int64)

// UploadBatch 批量上传。onProgress 可为 nil。
//
// GitHub 用 Git Data API 把整批文件合成**一次提交** —— 传 20 张图
// 在仓库里只出现一条提交记录，而不是 20 条。
// CNB 没有提交接口，直接拒绝（调用方应分流到 internal/cnb）。
//
// 进度是**连续**的：不只是「每传完一个文件跳一格」，单个大文件
// 内部也有进度（靠包装请求体读取实现，见 createBlob 的注释）。
func (c *Client) UploadBatch(files []File, message string, onProgress ProgressFunc) ([]Result, error) {
	if len(files) == 0 {
		return []Result{}, nil
	}
	if c.IsCNB() {
		return nil, ErrCNBWrite
	}
	return c.uploadGitData(files, message, onProgress)
}

func (c *Client) uploadGitData(files []File, message string, onProgress ProgressFunc) ([]Result, error) {
	refPath := "/repos/" + c.Owner + "/" + c.Repo + "/git/ref/heads/" + url.PathEscape(c.Branch)
	parentSHA, err := c.refSHA(refPath)
	if err != nil {
		return nil, err
	}
	baseTree, err := c.commitTree(parentSHA)
	if err != nil {
		return nil, err
	}

	var totalBytes int64
	for _, f := range files {
		totalBytes += int64(len(f.Buff))
	}

	tree := make([]map[string]any, 0, len(files))
	var done int64 // 前面几个文件已传完的字节
	for _, f := range files {
		buf := f.Buff
		sz := int64(len(buf))
		blob, err := c.createBlob(buf, func(fileSent, _ int64) {
			if onProgress != nil {
				// 整批进度 = 已完成文件 + 当前文件的内部进度
				onProgress(done+fileSent, totalBytes)
			}
		})
		if err != nil {
			return nil, err
		}
		tree = append(tree, map[string]any{"path": f.Path, "mode": "100644", "type": "blob", "sha": blob})
		done += sz
		// 文件之间也补一次「已整份传完」，这样即使没有中间回调
		// （小文件一次 Read 就读完了），进度也不会漏掉这一段。
		if onProgress != nil {
			onProgress(done, totalBytes)
		}
	}
	if err := c.pushCommit(refPath, parentSHA, baseTree, tree, message); err != nil {
		return nil, err
	}
	out := make([]Result, 0, len(files))
	for _, f := range files {
		out = append(out, Result{Path: f.Path, OK: true})
	}
	return out, nil
}

// Result 是单个文件的操作结果，字段与 platform.js 对齐
// （渲染层直接读 ok / error 显示成一行行结果）。
type Result struct {
	Path  string `json:"path"`
	OK    bool   `json:"ok"`
	Error any    `json:"error"`
	Via   string `json:"via,omitempty"` // cnb 走 git 时会带上：local | temp
	Note  string `json:"note,omitempty"`
}

/* ------------------------------------------------------------ 删除 */

// DeleteBatch 批量删除。
//
// GitHub 的 contents DELETE 需要文件的 blob SHA，所以是逐个删
// （每条一次提交）—— 这是平台接口的限制，没法合成一次。
func (c *Client) DeleteBatch(paths []string, message string) ([]Result, error) {
	if len(paths) == 0 {
		return []Result{}, nil
	}
	if c.IsCNB() {
		return nil, ErrCNBWrite
	}
	out := make([]Result, 0, len(paths))
	for _, p := range paths {
		sha := c.FileSHA(p)
		if sha == "" {
			out = append(out, Result{Path: p, OK: false, Error: "文件不存在或已被删除"})
			continue
		}
		_, err := c.req("DELETE", "/repos/"+c.Owner+"/"+c.Repo+"/contents/"+encodePath(p), nil, map[string]any{
			"message": messageOr(message, "chore: delete "+p),
			"sha":     sha,
			"branch":  c.Branch,
		})
		if err != nil {
			out = append(out, Result{Path: p, OK: false, Error: err.Error()})
			continue
		}
		out = append(out, Result{Path: p, OK: true})
	}
	return out, nil
}

/* ------------------------------------------------------------ 移动 / 改名 */

// MoveBatch 批量移动 / 重命名。
//
// 走 Git Data API：内容写到新路径 + 旧路径置空（sha: null = 删除），
// 整批只产生一次提交，**天然原子** —— 不会出现「新名字建好了，旧的还在」
// 这个中间状态。
func (c *Client) MoveBatch(items []MoveItem, message string) ([]Result, error) {
	if len(items) == 0 {
		return []Result{}, nil
	}
	if c.IsCNB() {
		return nil, ErrCNBWrite
	}

	refPath := "/repos/" + c.Owner + "/" + c.Repo + "/git/ref/heads/" + url.PathEscape(c.Branch)
	parentSHA, err := c.refSHA(refPath)
	if err != nil {
		return nil, err
	}
	baseTree, err := c.commitTree(parentSHA)
	if err != nil {
		return nil, err
	}

	tree := make([]map[string]any, 0, len(items)*2)
	for _, it := range items {
		buf, err := c.ReadRaw(it.From)
		if err != nil {
			return nil, err
		}
		// 改名 / 移动没有进度条（用户没在等），回调传 nil
		blob, err := c.createBlob(buf, nil)
		if err != nil {
			return nil, err
		}
		tree = append(tree, map[string]any{"path": it.To, "mode": "100644", "type": "blob", "sha": blob})
		// sha 为 null 表示删除该路径
		tree = append(tree, map[string]any{"path": it.From, "mode": "100644", "type": "blob", "sha": nil})
	}
	if err := c.pushCommit(refPath, parentSHA, baseTree, tree, messageOr(message, "chore: move files")); err != nil {
		return nil, err
	}
	out := make([]Result, 0, len(items))
	for _, it := range items {
		out = append(out, Result{Path: it.To, OK: true})
	}
	return out, nil
}

/* ------------------------------------------------------------ Git Data 小步骤 */

// refSHA 取分支 ref 指向的提交 SHA。
func (c *Client) refSHA(refPath string) (string, error) {
	data, err := c.req("GET", refPath, nil, nil)
	if err != nil {
		return "", err
	}
	m, ok := data.(map[string]any)
	if !ok {
		return "", &ApiError{Message: "读不到分支引用：" + c.Branch}
	}
	obj, ok := m["object"].(map[string]any)
	if !ok {
		return "", &ApiError{Message: "读不到分支引用：" + c.Branch}
	}
	sha := str(obj["sha"])
	if sha == "" {
		return "", &ApiError{Message: "分支「" + c.Branch + "」还没有任何提交"}
	}
	return sha, nil
}

// commitTree 取某个提交对应的 tree SHA（构造新 tree 要以它为底）。
func (c *Client) commitTree(commitSHA string) (string, error) {
	data, err := c.req("GET", "/repos/"+c.Owner+"/"+c.Repo+"/git/commits/"+commitSHA, nil, nil)
	if err != nil {
		return "", err
	}
	m, ok := data.(map[string]any)
	if !ok {
		return "", &ApiError{Message: "读不到提交 " + commitSHA}
	}
	tree, ok := m["tree"].(map[string]any)
	if !ok {
		return "", &ApiError{Message: "读不到提交的目录树"}
	}
	return str(tree["sha"]), nil
}

// createBlob 造一个 blob，返回它的 SHA。
//
// onProgress 收到的是**原始文件的字节**进度，不是请求体字节。
// 为什么要换算：body 是 base64 + JSON 包装（比原文件大 33% 还有额外开销），
// 直接把 body 数字显示给用户，会看到「9 MB 的文件传了 12 MB」这种
// 一眼假的数字。换算系数就是两者长度之比，JSON 包装那几十字节可忽略。
//
// 这是 GitHub 侧唯一能拿到「单个大文件传到一半」的地方 ——
// Git Data API 一个文件一次 POST，本来是没有中间进度的，
// 靠 reqProgress 包装请求体读取才拿得到（见 cloud.go 的 progressReader）。
func (c *Client) createBlob(b []byte, onProgress func(sent, total int64)) (string, error) {
	n := int64(len(b))
	data, err := c.reqProgress("POST", "/repos/"+c.Owner+"/"+c.Repo+"/git/blobs", nil,
		map[string]any{
			"content":  b64encode(b),
			"encoding": "base64",
		},
		func(bodySent, bodyTotal int64) {
			if onProgress == nil || bodyTotal <= 0 {
				return
			}
			onProgress(bodySent*n/bodyTotal, n)
		})
	if err != nil {
		return "", err
	}
	m, ok := data.(map[string]any)
	if !ok {
		return "", &ApiError{Message: "创建 blob 失败"}
	}
	sha := str(m["sha"])
	if sha == "" {
		return "", &ApiError{Message: "创建 blob 没返回 SHA"}
	}
	return sha, nil
}

// pushCommit 造 tree → 造 commit → 移动分支指针。三步合起来才算一次提交。
func (c *Client) pushCommit(refPath, parentSHA, baseTree string, tree []map[string]any, message string) error {
	nt, err := c.req("POST", "/repos/"+c.Owner+"/"+c.Repo+"/git/trees", nil, map[string]any{
		"base_tree": baseTree,
		"tree":      tree,
	})
	if err != nil {
		return err
	}
	ntm, ok := nt.(map[string]any)
	if !ok {
		return &ApiError{Message: "创建目录树失败"}
	}
	newTree := str(ntm["sha"])

	cm, err := c.req("POST", "/repos/"+c.Owner+"/"+c.Repo+"/git/commits", nil, map[string]any{
		"message": messageOr(message, "upload files"),
		"tree":    newTree,
		"parents": []string{parentSHA},
	})
	if err != nil {
		return err
	}
	cmMap, ok := cm.(map[string]any)
	if !ok {
		return &ApiError{Message: "创建提交失败"}
	}
	commitSHA := str(cmMap["sha"])

	// force:false —— 有人抢先提交时这次推送会失败。
	// 强推会**抹掉别人的提交**，宁可让用户看到冲突提示。
	_, err = c.req("PATCH", refPath, nil, map[string]any{"sha": commitSHA, "force": false})
	return err
}

func messageOr(msg, fallback string) string {
	if strings.TrimSpace(msg) == "" {
		return fallback
	}
	return msg
}
