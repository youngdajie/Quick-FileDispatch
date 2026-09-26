// Package cloud 是 GitHub / CNB 两个平台的统一读取客户端，对应 Electron 版的 src/main/platform.js。
//
// # 两个平台的能力是不对称的，这一点决定了整个包的结构
//
//	GitHub:  读 + 写都能走 REST（Git Data API 还能把多个文件合成一次提交）
//	CNB:     公开 Open API **没有** 创建 Tree / 创建 Commit / 更新 Ref 的接口
//	         （文档里 blob 接口写着「通常与 Tree/Commit 接口配合使用」，但那两个没开放），
//	         孤立的 blob 没有落点，等于白造。
//
// 所以这里的分工是：
//
//	本包只负责「读」，外加 GitHub 的「写」；
//	CNB 的「写」交给 internal/cnb —— 它把仓库弄到本地工作区，改完 commit + push。
//
// 把这条边界写清楚很重要：曾经有过的想法是「给 CNB 也造一套 blob 接口调用」，
// 走到一半才发现没有 commit 落点，白写的 blob 在仓库里根本看不见。
package cloud

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// GitHubAPI 与 CNBAPI 是各家的官方接口地址。
	// apiBase 可以覆盖它们（自建 GitHub Enterprise / 离线自测）。
	GitHubAPI = "https://api.github.com"
	CNBAPI    = "https://api.cnb.cool"
	// CNBWeb 是 CNB 的网页地址，用来拼文件直链。
	CNBWeb = "https://cnb.cool"
	// CNBGitHost 是 CNB 的 Git 远端主机。CNB 要求认证用户名固定填 cnb。
	CNBGitHost = "cnb.cool"
	// UserAgent：各家都建议带上，GitHub 甚至会拒掉没有 UA 的请求。
	UserAgent = "JIE-Dispatch/2.8 (+https://www.yangjie.site)"
)

// ApiError 是一次接口调用失败的**可读**结果。
//
// 关键在 Status：调用方靠它区分「Token 失效（401）」和「仓库不存在（404）」，
// 这两种的提示文案完全不同。把状态码吞掉，用户就只能看到一个「请求失败」。
type ApiError struct {
	Message string
	Status  int
}

func (e *ApiError) Error() string { return e.Message }

// Item 是列目录结果里的一项，字段与 platform.js 的返回逐字对应。
type Item struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Type        string `json:"type"` // "dir" | "file"
	Size        int64  `json:"size"`
	SHA         string `json:"sha"`
	DownloadURL string `json:"downloadUrl"`
	GitURL      string `json:"gitUrl"`
}

// RepoInfo 是仓库的基本信息。
type RepoInfo struct {
	FullName      string `json:"fullName"`
	Private       bool   `json:"private"`
	SizeKB        int64  `json:"sizeKB"`
	DefaultBranch string `json:"defaultBranch"`
	HTMLURL       string `json:"htmlUrl"`
	Description   string `json:"description"`
	Permissions   any    `json:"permissions"`
}

// UserInfo 是账号信息。
type UserInfo struct {
	Login   string `json:"login"`
	Name    string `json:"name"`
	Avatar  string `json:"avatar"`
	HTMLURL string `json:"htmlUrl"`
}

// Client 面向一个「平台 + 仓库 + 分支」的只读（GitHub 可写）客户端。
type Client struct {
	Platform string
	Owner    string
	Repo     string
	Branch   string
	Token    string
	APIBase  string

	http *http.Client
}

// New 造一个客户端。空字段会按 Electron 版的规则补默认值。
func New(platform, owner, repo, branch, token, apiBase string) *Client {
	c := &Client{
		Platform: NormalizePlatform(platform),
		Owner:    strings.Trim(owner, "/"),
		Repo:     strings.Trim(repo, "/"),
		Branch:   branch,
		Token:    token,
		APIBase:  strings.TrimRight(apiBase, "/"),
		http:     &http.Client{Timeout: 60 * time.Second},
	}
	if c.Branch == "" {
		c.Branch = "main"
	}
	if c.APIBase == "" {
		if c.Platform == "cnb" {
			c.APIBase = CNBAPI
		} else {
			c.APIBase = GitHubAPI
		}
	}
	return c
}

// NormalizePlatform 只认 GitHub 与 CNB 两个平台（Gitee 已下线）。
// 其它值一律当 github —— 存了个不认识的平台会让后续所有请求都失败，
// 而且界面上没有任何入口能改回来。
func NormalizePlatform(p string) string {
	if strings.TrimSpace(p) == "cnb" {
		return "cnb"
	}
	return "github"
}

func (c *Client) IsCNB() bool { return c.Platform == "cnb" }

// Slug 是 CNB 眼里的仓库标识：owner/repo。
func (c *Client) Slug() string { return c.Owner + "/" + c.Repo }

// FileLimitBytes 是平台对单个文件的硬上限。
// GitHub 100MB，CNB 200MB。超过就不要发 —— 发了也是浪费一次完整上传的带宽。
func FileLimitBytes(platform string) int64 {
	if platform == "cnb" {
		return 200 * 1024 * 1024
	}
	return 100 * 1024 * 1024
}

// RawURL 生成文件在仓库中的直链（按平台默认规则）。
func (c *Client) RawURL(path string) string {
	p := trimSlashes(path)
	if c.IsCNB() {
		return fmt.Sprintf("%s/%s/-/git/raw/%s/%s", CNBWeb, c.Slug(), c.Branch, p)
	}
	return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s", c.Owner, c.Repo, c.Branch, p)
}

/* ------------------------------------------------------------ HTTP 基础 */

func (c *Client) headers(raw bool) http.Header {
	h := http.Header{}
	h.Set("User-Agent", UserAgent)
	if c.IsCNB() {
		h.Set("Accept", "application/vnd.cnb.api+json")
	} else {
		accept := "application/vnd.github+json"
		if raw {
			accept = "application/vnd.github.raw"
		}
		h.Set("Accept", accept)
		h.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	if c.Token != "" {
		h.Set("Authorization", "Bearer "+c.Token)
	}
	return h
}

// req 发一次请求并解析 JSON。body 为 nil 表示 GET。
func (c *Client) req(method, path string, query url.Values, body any) (any, error) {
	return c.reqProgress(method, path, query, body, nil)
}

// reqProgress 与 req 完全一样，额外支持**上传请求体时上报进度**。
//
// 为什么能拿到进度：Go 的 http.Client 是通过 io.Reader 拉取 body 的，
// 每次 Read 就对应「这一批字节交给了内核发送缓冲」。把它包一层计数，
// 就得到了真实的传输进度 —— 既不需要平台支持分块上传，
// 也不需要客户端实现分片协议。
//
// onProgress 收到的是 **body 字节**（base64 + JSON 包装之后的），
// 不是用户概念里的文件大小。换算由调用方负责（见 write.go 的 createBlob）。
func (c *Client) reqProgress(method, path string, query url.Values, body any,
	onProgress func(sent, total int64)) (any, error) {
	var payload io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("序列化请求体失败：%w", err)
		}
		if onProgress != nil {
			payload = newProgressReader(bytes.NewReader(buf), int64(len(buf)), onProgress)
		} else {
			payload = bytes.NewReader(buf)
		}
	}

	u := c.APIBase + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	r, err := http.NewRequest(method, u, payload)
	if err != nil {
		return nil, &ApiError{Message: "构造请求失败：" + err.Error()}
	}
	for k, vv := range c.headers(false) {
		for _, v := range vv {
			r.Header.Add(k, v)
		}
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json;charset=UTF-8")
	}

	res, err := c.http.Do(r)
	if err != nil {
		return nil, &ApiError{Message: "网络请求失败：" + err.Error()}
	}
	defer res.Body.Close()
	text, _ := io.ReadAll(res.Body)

	if res.StatusCode >= 400 {
		return nil, &ApiError{
			Message: normalizeError(c.Platform, res.StatusCode, firstMessage(text)),
			Status:  res.StatusCode,
		}
	}
	if len(text) == 0 {
		return nil, nil
	}
	var out any
	if err := json.Unmarshal(text, &out); err != nil {
		return nil, &ApiError{Message: "接口返回的不是合法 JSON", Status: res.StatusCode}
	}
	return out, nil
}

/* ------------------------------------------------------------ 传输进度 */

// progressReader 包装一个 Reader，在每次 Read 时上报已读字节。
//
// 它是「GitHub 单文件上传进度」的全部魔法：Go 的 http.Client 在发送
// 请求体时会反复从这个 Reader 拿数据（每次几十 KB），所以 Read 的
// 累计量就是**已经交给网络栈的字节**。
//
// 两个必须注意的点：
//
//   - **要节流**。一个 100MB 的 body 会被读几千次，每次都往上回调会
//     把进度事件灌爆（progress 包里虽然还有一层 100ms 节流，但先在这里
//     挡掉大部分更省事）。
//   - **它是"已交付内核"，不是"对端已收到"**。大文件的末尾会有一小段
//     滞后（内核缓冲里的数据还没发完，Read 就已经读到 EOF 了）。
//     对本场景够用 —— 用户要看的是"在动"，不是精确的字节账。
type progressReader struct {
	r          io.Reader
	total      int64
	sent       int64
	last       time.Time
	onProgress func(sent, total int64)
}

func newProgressReader(r io.Reader, total int64, onProgress func(sent, total int64)) *progressReader {
	return &progressReader{r: r, total: total, onProgress: onProgress, last: time.Now()}
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.sent += int64(n)
		if now := time.Now(); now.Sub(p.last) >= 100*time.Millisecond {
			p.last = now
			p.onProgress(p.sent, p.total)
		}
	}
	return n, err
}

// reqRaw 取原始字节（不解析 JSON），用于缩略图代理与文本预览。
func (c *Client) reqRaw(method, path string, query url.Values) ([]byte, error) {
	u := c.APIBase + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	r, err := http.NewRequest(method, u, nil)
	if err != nil {
		return nil, &ApiError{Message: "构造请求失败：" + err.Error()}
	}
	for k, vv := range c.headers(true) {
		for _, v := range vv {
			r.Header.Add(k, v)
		}
	}
	res, err := c.http.Do(r)
	if err != nil {
		return nil, &ApiError{Message: "网络请求失败：" + err.Error()}
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		body, _ := io.ReadAll(res.Body)
		return nil, &ApiError{
			Message: normalizeError(c.Platform, res.StatusCode, firstMessage(body)),
			Status:  res.StatusCode,
		}
	}
	return io.ReadAll(res.Body)
}

// firstMessage 从各家不同形状的错误响应里抠出那句人话。
func firstMessage(text []byte) string {
	trimmed := bytes.TrimSpace(text)
	if len(trimmed) == 0 {
		return ""
	}
	var v struct {
		Message string `json:"message"`
		Error   string `json:"error"`
		Msg     string `json:"msg"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(trimmed, &v); err == nil {
		if v.Message != "" {
			return v.Message
		}
		if v.Error != "" {
			return v.Error
		}
		if v.Msg != "" {
			return v.Msg
		}
		if len(v.Errors) > 0 && v.Errors[0].Message != "" {
			return v.Errors[0].Message
		}
	}
	return string(trimmed)
}

// normalizeError 把 HTTP 状态码翻译成用户能照着改的提示。
//
// 这些文案是踩出来的：401 多半是 Token 过期，403 是 Token 没勾 repo 权限，
// 404 在 CNB 上经常是「用了 MCP 令牌而不是经典令牌」—— 光说「404」
// 用户根本不知道该去哪儿改。
func normalizeError(platform string, status int, msg string) string {
	lower := strings.ToLower(msg)
	switch status {
	case 401:
		if platform == "cnb" {
			return "Token 无效或已过期（CNB 需选「经典令牌」并勾选 repo-code 读写）"
		}
		return "Token 无效或已过期"
	case 403:
		if strings.Contains(lower, "rate limit") {
			return "触发接口频率限制，请稍后重试或更换 Token"
		}
		return "没有权限：请确认 Token 勾选了仓库读写权限"
	case 404:
		if platform == "cnb" && (strings.Contains(lower, "mcp") || strings.Contains(lower, "token")) {
			return "CNB 返回 404：多半是 Token 类型不对 —— MCP 令牌不能调 REST 接口，请改用「经典令牌」"
		}
		return "仓库或分支不存在：请检查用户名 / 仓库名 / 分支名，以及 Token 是否可访问该私有仓库"
	case 413:
		return "文件体积超过平台限制"
	case 422:
		return "请求被拒绝（可能文件过大或路径非法）：" + msg
	case 0:
		return msg
	}
	if msg != "" {
		return msg
	}
	return fmt.Sprintf("请求失败（HTTP %d）", status)
}

/* ------------------------------------------------------------ 小工具 */

func trimSlashes(s string) string {
	return strings.Trim(strings.TrimSpace(s), "/")
}

// encodePath 逐段转义：整体转义会把路径里的 / 变成 %2F，接口就不认了。
func encodePath(p string) string {
	parts := strings.Split(trimSlashes(p), "/")
	out := make([]string, 0, len(parts))
	for _, s := range parts {
		if s == "" {
			continue
		}
		out = append(out, url.PathEscape(s))
	}
	return strings.Join(out, "/")
}

func b64encode(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func b64decode(s string) []byte {
	b, _ := base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\n', '\r', '\t':
			return -1
		}
		return r
	}, s))
	return b
}
