package cloud

import (
	"net/url"
	"strings"
)

/* ------------------------------------------------------------ 账号 / 仓库 */

// Whoami 取当前 Token 对应的账号。这是「验证」的第一步 ——
// 它能过，说明 Token 本身是有效的。
func (c *Client) Whoami() (*UserInfo, error) {
	data, err := c.req("GET", "/user", nil, nil)
	if err != nil {
		return nil, err
	}
	m, ok := data.(map[string]any)
	if !ok {
		return nil, &ApiError{Message: "无法读取账号信息"}
	}
	if c.IsCNB() {
		return &UserInfo{
			Login:   str(m["username"]),
			Name:    firstStr(m["nickname"], m["username"]),
			Avatar:  str(m["avatar"]),
			HTMLURL: cond(str(m["username"]) != "", "https://cnb.cool/"+str(m["username"]), ""),
		}, nil
	}
	return &UserInfo{
		Login:   firstStr(m["login"], m["name"]),
		Name:    firstStr(m["name"], m["login"]),
		Avatar:  str(m["avatar_url"]),
		HTMLURL: str(m["html_url"]),
	}, nil
}

// RepoInfo 取仓库信息。顺带能验证「这个 Token 对这个仓库有没有权限」。
func (c *Client) RepoInfo() (*RepoInfo, error) {
	var data any
	var err error
	if c.IsCNB() {
		data, err = c.req("GET", "/"+c.Slug(), nil, nil)
	} else {
		data, err = c.req("GET", "/repos/"+c.Owner+"/"+c.Repo, nil, nil)
	}
	if err != nil {
		return nil, err
	}
	m, ok := data.(map[string]any)
	if !ok {
		return nil, &ApiError{Message: "无法读取仓库信息"}
	}

	if c.IsCNB() {
		vis := str(m["visibility_level"])
		return &RepoInfo{
			FullName:      firstStr(m["path"], c.Slug()),
			Private:       vis != "" && vis != "Public",
			DefaultBranch: "main",
			HTMLURL:       firstStr(m["web_url"], CNBWeb+"/"+c.Slug()),
			Description:   str(m["description"]),
			Permissions:   nilIfEmpty(m["access"]),
		}, nil
	}
	return &RepoInfo{
		FullName:      str(m["full_name"]),
		Private:       boolOf(m["private"]),
		SizeKB:        intOf(m["size"]),
		DefaultBranch: firstStr(m["default_branch"], m["default_branch_name"], "main"),
		HTMLURL:       str(m["html_url"]),
		Description:   str(m["description"]),
		Permissions:   nilIfEmpty(m["permissions"]),
	}, nil
}

/* ------------------------------------------------------------ 列目录 */

// ListDir 列出某个目录。空 path 表示仓库根目录。
//
// 404 当「空目录」处理：新建的仓库、或者分支上还没有这个路径时，
// 接口就返回 404 —— 那不是错误，用户看到空列表才是对的。
func (c *Client) ListDir(path string) ([]Item, error) {
	clean := trimSlashes(path)
	var data any
	var err error

	if c.IsCNB() {
		base := "/" + c.Slug() + "/-/git/contents"
		p := base
		if clean != "" {
			p = base + "/" + encodePath(clean)
		}
		data, err = c.req("GET", p, url.Values{"ref": {c.Branch}}, nil)
	} else {
		p := "/repos/" + c.Owner + "/" + c.Repo + "/contents/" + encodePath(clean)
		data, err = c.req("GET", p, url.Values{"ref": {c.Branch}}, nil)
	}
	if err != nil {
		if ae, ok := err.(*ApiError); ok && ae.Status == 404 {
			return []Item{}, nil
		}
		return nil, err
	}
	if data == nil {
		return []Item{}, nil
	}
	if c.IsCNB() {
		return c.parseCNB(data), nil
	}
	return c.parseGitHub(data), nil
}

// parseGitHub：GitHub 的 contents 返回数组（目录）或单个对象（文件）。
func (c *Client) parseGitHub(data any) []Item {
	arr, ok := data.([]any)
	if !ok {
		if one, ok2 := data.(map[string]any); ok2 {
			arr = []any{one}
		} else {
			return []Item{}
		}
	}
	out := make([]Item, 0, len(arr))
	for _, it := range arr {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		name := str(m["name"])
		if name == "" {
			continue
		}
		typ := "file"
		if str(m["type"]) == "dir" {
			typ = "dir"
		}
		out = append(out, Item{
			Name:        name,
			Path:        str(m["path"]),
			Type:        typ,
			Size:        intOf(m["size"]),
			SHA:         str(m["sha"]),
			DownloadURL: str(m["download_url"]),
			GitURL:      str(m["url"]),
		})
	}
	return out
}

// parseCNB：CNB 的 contents 返回 { type: 'tree'|'blob'|'empty', entries: [...] }。
// 三种形状都要认 —— 只处理 tree 的话，「目录下只有一个文件」会显示成空的。
func (c *Client) parseCNB(data any) []Item {
	m, ok := data.(map[string]any)
	if !ok {
		return []Item{}
	}
	if str(m["type"]) == "empty" {
		return []Item{}
	}
	entries, _ := m["entries"].([]any)
	if len(entries) > 0 || str(m["type"]) == "tree" {
		out := make([]Item, 0, len(entries))
		for _, it := range entries {
			e, ok := it.(map[string]any)
			if !ok {
				continue
			}
			name := str(e["name"])
			if name == "" {
				continue
			}
			t := str(e["type"])
			typ := "file"
			if t == "tree" || t == "submodule" {
				typ = "dir"
			}
			out = append(out, Item{
				Name:        name,
				Path:        str(e["path"]),
				Type:        typ,
				SHA:         str(e["sha"]),
				DownloadURL: c.RawURL(str(e["path"])),
			})
		}
		return out
	}
	// 单个 blob：contents 指向的就是一个文件
	if t := str(m["type"]); t == "blob" || t == "lfs" {
		return []Item{{
			Name:        str(m["name"]),
			Path:        str(m["path"]),
			Type:        "file",
			Size:        intOf(m["size"]),
			SHA:         str(m["sha"]),
			DownloadURL: c.RawURL(str(m["path"])),
		}}
	}
	return []Item{}
}

/* ------------------------------------------------------------ 递归统计 */

// Count 是递归统计的结果。
type Count struct {
	Files     int64 `json:"files"`
	Bytes     int64 `json:"bytes"`
	Truncated bool  `json:"truncated"`
}

// CountFiles 递归统计文件数与总字节。
//
// budget 限制总请求数：大仓库一次统计能打出上百次请求，
// 而它只是界面角落里的一个数字 —— 不设上限会把接口配额刷爆，
// 之后真正的上传反而报 403（频率限制）。
func (c *Client) CountFiles(path string, depth int, acc *Count, budget *struct{ Requests, Max int }) *Count {
	if acc == nil {
		acc = &Count{}
	}
	if budget == nil {
		budget = &struct{ Requests, Max int }{0, 60}
	}
	if depth > 6 || budget.Requests >= budget.Max {
		acc.Truncated = true
		return acc
	}
	budget.Requests++
	items, err := c.ListDir(path)
	if err != nil {
		acc.Truncated = true
		return acc
	}
	for _, it := range items {
		if it.Type == "dir" {
			c.CountFiles(it.Path, depth+1, acc, budget)
		} else {
			acc.Files++
			acc.Bytes += it.Size
		}
		if budget.Requests >= budget.Max {
			acc.Truncated = true
			break
		}
	}
	return acc
}

/* ------------------------------------------------------------ 读文件 */

// ReadFile 读单个文件的内容（<= 1MB 时用）。
// 读不到返回 nil 而不是错误 —— 调用方通常只是「试着读一下」。
func (c *Client) ReadFile(path string) []byte {
	entry, err := c.contentEntry(path)
	if err != nil {
		return nil
	}
	m, ok := entry.(map[string]any)
	if !ok {
		return nil
	}
	if content, ok := m["content"].(string); ok && content != "" {
		return b64decode(content)
	}
	return nil
}

// FileSHA 读单个文件的 blob SHA。GitHub 删除文件时必须带上它。
func (c *Client) FileSHA(path string) string {
	entry, err := c.contentEntry(path)
	if err != nil {
		return ""
	}
	m, ok := entry.(map[string]any)
	if !ok {
		return ""
	}
	return str(m["sha"])
}

// contentEntry 取 contents 接口的原始返回（两个平台形状不同，各自解释）。
func (c *Client) contentEntry(path string) (any, error) {
	clean := trimSlashes(path)
	if c.IsCNB() {
		return c.req("GET", "/"+c.Slug()+"/-/git/contents/"+encodePath(clean), url.Values{"ref": {c.Branch}}, nil)
	}
	return c.req("GET", "/repos/"+c.Owner+"/"+c.Repo+"/contents/"+encodePath(clean), url.Values{"ref": {c.Branch}}, nil)
}

// ReadRaw 读原始字节。私有仓库也能读（带 Token），用于缩略图代理与文本预览。
//
// 404 单独翻译成「文件不存在」：这里读的是**具体的某一个文件**，
// 而通用翻译会说「仓库或分支不存在」—— 用户刚改名 / 删过文件时
// 看到那句话会去查仓库配置，白白绕一圈。
func (c *Client) ReadRaw(path string) ([]byte, error) {
	clean := trimSlashes(path)
	var body []byte
	var err error
	if c.IsCNB() {
		body, err = c.reqRaw("GET", "/"+c.Slug()+"/-/git/raw/"+url.PathEscape(c.Branch)+"/"+encodePath(clean), nil)
	} else {
		body, err = c.reqRaw("GET", "/repos/"+c.Owner+"/"+c.Repo+"/contents/"+encodePath(clean),
			url.Values{"ref": {c.Branch}})
	}
	if err != nil {
		if ae, ok := err.(*ApiError); ok && ae.Status == 404 {
			return nil, &ApiError{Message: "文件不存在：" + clean, Status: 404}
		}
		return nil, err
	}
	return body, nil
}

// HeadSHA 取分支 HEAD 的完整 commit SHA —— 云端同步检测器靠它和本地 HEAD 比对。
//
// 读不到（分支不存在 / 空仓库）返回空串而不是报错：
// 「这个分支还没有提交」是正常状态，该由调用方决定怎么提示。
func (c *Client) HeadSHA(branch string) (string, error) {
	b := branch
	if b == "" {
		b = c.Branch
	}
	var data any
	var err error
	if c.IsCNB() {
		data, err = c.req("GET", "/"+c.Slug()+"/-/git/branches/"+url.PathEscape(b), nil, nil)
	} else {
		data, err = c.req("GET", "/repos/"+c.Owner+"/"+c.Repo+"/git/ref/heads/"+url.PathEscape(b), nil, nil)
	}
	if err != nil {
		if ae, ok := err.(*ApiError); ok && (ae.Status == 404 || ae.Status == 409) {
			return "", nil
		}
		return "", err
	}
	m, ok := data.(map[string]any)
	if !ok {
		return "", nil
	}
	if c.IsCNB() {
		if commit, ok := m["commit"].(map[string]any); ok {
			return str(commit["sha"]), nil
		}
		return "", nil
	}
	if obj, ok := m["object"].(map[string]any); ok {
		return str(obj["sha"]), nil
	}
	return "", nil
}

/* ------------------------------------------------------------ 取值小工具 */

func str(v any) string {
	s, _ := v.(string)
	return s
}

func firstStr(vals ...any) string {
	for _, v := range vals {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func intOf(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	}
	return 0
}

func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}

func nilIfEmpty(v any) any {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
		return nil
	}
	return v
}

func cond(b bool, yes, no string) string {
	if b {
		return yes
	}
	return no
}
