// Package store 负责配置的读写，对应 Electron 版的 src/main/store.js。
//
// 两边**共用同一个文件**（%APPDATA%\Quick-FileDispatch\config.json），
// 这是刻意的：Go demo 一启动就能读到你在 Electron 版里的真实配置，
// 也能顺手验证「迁移之后配置不丢」这件事本身。
//
// 所以这里的铁律是「不许丢字段」：
//   - 读取时不重建结构，而是在默认值上做深度合并；
//   - 写回时同样只覆盖提交上来的那几个键，其余原样留着。
//
// 违反它会很难查 —— Electron 版里有上百处直接读 cfg.xxx，字段被悄悄抹掉
// 通常表现为「某个开关自己变回默认了」，跟存储层看起来毫无关系。
//
// 待办：Token 落盘加密。Electron 用 safeStorage（Windows 上是 DPAPI），
// Go 这边可以纯 syscall 调 crypt32.dll 的 CryptProtectData / CryptUnprotectData，
// 不需要 cgo。在那之前本文件**不碰** Token 的真值：只报告「有没有」，
// 掩码一律给 ****。
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// 与 Electron 版 store.js 的 DEFAULT_CONFIG 逐字段对应，改一处必须改两处。
func Defaults() map[string]any {
	return map[string]any{
		"version":       8,
		"onboarded":     false,
		"platform":      "github", // github | cnb
		"owner":         "",
		"repo":          "",
		"branch":        "main",
		"apiBase":       "",
		"localDir":      "",
		"commitMessage": "chore: 通过 JIE 分发服务上传",

		"profiles":        []any{},
		"activeProfileId": "",

		"linkRule":     "auto",
		"customDomain": "",
		"linkFormat":   "markdown",
		"proxyUrl":     "",

		"compress": map[string]any{
			"enabled":       true,
			"quality":       80,
			"maxWidth":      0,
			"maxHeight":     0,
			"format":        "avif",
			"targetSizeKB":  0,
			"skipIfSmaller": true,
			"skipBelowKB":   100,
		},
		"watermark": map[string]any{
			"enabled":  false,
			"text":     "",
			"position": "bottom-right",
			"opacity":  0.35,
			"fontSize": 22,
			"color":    "#1296db",
		},
		"rename": map[string]any{
			"mode":       "keep",
			"prefix":     "",
			"hashLength": 8,
		},

		"concurrency": 0,
		"sync": map[string]any{
			"autoPull": true,
			"strategy": "pull",
		},
		"ui": map[string]any{
			"theme":    "dark",
			"font":     "",
			"pageSize": 60,
		},
	}
}

// Store 是配置文件的读写句柄。并发访问由 mu 保护：渲染层可能同时打多个接口。
type Store struct {
	mu   sync.Mutex
	file string
	data map[string]any
}

func New(file string) *Store {
	s := &Store{file: file}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = s.read()
	return s
}

func (s *Store) File() string { return s.file }

// LocalDir 只读当前绑定的本地目录。
// /__local 每张图都会问一次，不走 Get() 那套深拷贝 —— 那会把整份配置
// （含所有 profile）复制一遍，放在图片请求的热路径上纯属浪费。
func (s *Store) LocalDir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, _ := s.data["localDir"].(string)
	return d
}

// read 读文件并深度合并到默认值上。
// 文件不存在 / 坏了都退回默认值 —— 但**不回写**，避免把坏文件直接覆盖掉，
// 用户还有机会手动救回来。
func (s *Store) read() map[string]any {
	raw, err := os.ReadFile(s.file)
	if err != nil {
		return Defaults()
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		fmt.Fprintf(os.Stderr, "配置解析失败，按默认值走（文件未改动）：%s\n", err)
		return Defaults()
	}
	return merge(Defaults(), parsed)
}

// write 先写临时文件再改名，避免中途断电留下半截 JSON。
func (s *Store) write() error {
	buf, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// Get 返回「对外可见」的配置：Token 不出现真值，只给 hasToken / tokenMask。
func (s *Store) Get() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.view()
}

// view 必须在持锁状态下调用。
func (s *Store) view() map[string]any {
	out, _ := deepCopy(s.data).(map[string]any)
	if out == nil {
		out = map[string]any{}
	}

	hasToken := hasAnyToken(s.data)
	out["hasToken"] = hasToken
	out["tokenMask"] = maskPlaceholder(hasToken)
	delete(out, "_tokenEnc")
	delete(out, "_tokenPlain")

	activeID, _ := s.data["activeProfileId"].(string)
	list, _ := s.data["profiles"].([]any)
	profiles := make([]any, 0, len(list))
	for _, item := range list {
		p, ok := item.(map[string]any)
		if !ok {
			continue
		}
		cp, _ := deepCopy(p).(map[string]any)
		if cp == nil {
			continue
		}
		ph := hasAnyToken(p)
		cp["hasToken"] = ph
		cp["tokenMask"] = maskPlaceholder(ph)
		id, _ := p["id"].(string)
		cp["isActive"] = id != "" && id == activeID
		cp["label"] = profileLabel(p)
		// draft 是算出来的、不落盘 —— 渲染层只认这个字段决定要不要列出来
		cp["draft"] = isDraft(p)
		delete(cp, "_tokenEnc")
		delete(cp, "_tokenPlain")
		profiles = append(profiles, cp)
	}
	out["profiles"] = profiles
	return out
}

// Patch 深度合并一组改动并落盘。
func (s *Store) Patch(patch map[string]any) (map[string]any, error) {
	if patch == nil {
		return nil, errors.New("patch 是空的")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	// Token 单独处理：留空 / 全是 * 都表示「不改」，跟 Electron 版一致，
	// 免得设置页里那个被掩码填充的输入框一保存就把真 Token 冲成 ****
	if tok, ok := patch["token"]; ok {
		delete(patch, "token")
		if t, isStr := tok.(string); isStr && t != "" && strings.Trim(t, "*") != "" {
			// 待办：这里应该走 DPAPI 加密后写 _tokenEnc。
			// 在加密落地之前先不落盘，宁可让用户重填，也不要明文躺在磁盘上。
			return nil, errors.New("Token 落盘加密还没实现（待接 DPAPI），本次未写入")
		}
	}

	s.data = merge(s.data, patch)
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// Reset 恢复默认设置并落盘（对应设置页的「恢复默认设置」）。
func (s *Store) Reset() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = Defaults()
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

/* ------------------------------------------------------------ 小工具 */

// merge 把 patch 深度合并进 base 并返回 base。
// 只有「两边都是对象」时才递归，其余一律替换 —— 数组也替换，
// 因为「往数组里合并」的语义没法定义（删一个元素和留一个元素分不清）。
func merge(base, patch map[string]any) map[string]any {
	for k, v := range patch {
		if pm, ok := v.(map[string]any); ok {
			if bm, ok2 := base[k].(map[string]any); ok2 {
				base[k] = merge(bm, pm)
				continue
			}
		}
		base[k] = v
	}
	return base
}

func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, vv := range t {
			out[k] = deepCopy(vv)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, vv := range t {
			out[i] = deepCopy(vv)
		}
		return out
	default:
		return v
	}
}

func hasAnyToken(m map[string]any) bool {
	for _, k := range []string{"_tokenEnc", "_tokenPlain", "token"} {
		if v, ok := m[k].(string); ok && v != "" {
			return true
		}
	}
	return false
}

// maskPlaceholder：还不解密 Token，所以只能给个占位掩码。
// 待 DPAPI 接上之后换成真正的首尾各留几位的脱敏。
func maskPlaceholder(has bool) string {
	if has {
		return "****"
	}
	return ""
}

func profileLabel(p map[string]any) string {
	if name, _ := p["name"].(string); name != "" {
		return name
	}
	owner, _ := p["owner"].(string)
	repo, _ := p["repo"].(string)
	parts := make([]string, 0, 2)
	if owner != "" {
		parts = append(parts, owner)
	}
	if repo != "" {
		parts = append(parts, repo)
	}
	if len(parts) > 0 {
		return strings.Join(parts, "/")
	}
	return "未命名配置"
}

// isDraft：还没填过仓库、也没验证过的空落点，不算一份「归档配置」。
// 和 Electron 版一样是算出来的，不落盘 —— 存标记的话，导入 / 迁移 / 手改
// 都可能留下对不上的旧值。
func isDraft(p map[string]any) bool {
	verified, _ := p["verified"].(bool)
	owner, _ := p["owner"].(string)
	repo, _ := p["repo"].(string)
	return !verified && !(owner != "" && repo != "")
}
