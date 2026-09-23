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

// UploadBatch 批量上传。
//
// GitHub 用 Git Data API 把整批文件合成**一次提交** —— 传 20 张图
// 在仓库里只出现一条提交记录，而不是 20 条。
// CNB 没有提交接口，直接拒绝（调用方应分流到 internal/cnb）。
func (c *Client) UploadBatch(files []File, message string) ([]Result, error) {
	if len(files) == 0 {
		return []Result{}, nil
	}
	if c.IsCNB() {
		return nil, ErrCNBWrite
	}
	return c.uploadGitData(files, message)
}

func (c *Client) uploadGitData(files []File, message string) ([]Result, error) {
	refPath := "/repos/" + c.Owner + "/" + c.Repo + "/git/ref/heads/" + url.PathEscape(c.Branch)
	parentSHA, err := c.refSHA(refPath)
	if err != nil {
		return nil, err
	}
	baseTree, err := c.commitTree(parentSHA)
	if err != nil {
		return nil, err
	}

	tree := make([]map[string]any, 0, len(files))
	for _, f := range files {
		blob, err := c.createBlob(f.Buff)
		if err != nil {
			return nil, err
		}
		tree = append(tree, map[string]any{"path": f.Path, "mode": "100644", "type": "blob", "sha": blob})
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
		blob, err := c.createBlob(buf)
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
func (c *Client) createBlob(b []byte) (string, error) {
	data, err := c.req("POST", "/repos/"+c.Owner+"/"+c.Repo+"/git/blobs", nil, map[string]any{
		"content":  b64encode(b),
		"encoding": "base64",
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
