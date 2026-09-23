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

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/dpapi"
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
			"theme":    defaultTheme(),
			"font":     "",
			"pageSize": 60,
		},
	}
}

// defaultTheme 出厂默认主题：跟 Windows 的应用模式走（3.0.0 起的新功能）。
// 只在两种时刻生效：配置文件不存在（第一次启动）、设置页点「恢复默认」。
// 已有配置的用户永远不受影响 —— read() 的深度合并只补缺失字段，
// ui.theme 在就原样保留；用户在设置里选过的主题不会被启动探测覆盖。
func defaultTheme() string {
	if appsUseLightTheme() {
		return "light"
	}
	return "dark"
}

// Store 是配置文件的读写句柄。并发访问由 mu 保护：渲染层可能同时打多个接口。
type Store struct {
	mu   sync.Mutex
	file string
	data map[string]any
	// vault 负责 Token 的加解密。为 nil 时**不碰** Token 真值
	// （自检里可以用临时配置跑，不惊动本机的加密材料）。
	vault *dpapi.Vault
	// onTokenFail 是「Token 解不开」时的回调，只用于打日志。
	// 解不开不是错误 —— 换了用户 / 重装系统都会这样，
	// 界面该显示「没有 Token」，但排查时需要知道原因。
	onTokenFail func(error)
}

// New 打开一份配置。vault 可以为 nil（此时不读写 Token 真值）。
func New(file string, vault *dpapi.Vault) *Store {
	s := &Store{file: file, vault: vault}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = s.read()
	return s
}

// SetTokenFailHook 装一个「Token 解不开」的回调，用于打印原因。
func (s *Store) SetTokenFailHook(fn func(error)) { s.onTokenFail = fn }

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
	return migrate(merge(Defaults(), parsed))
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

	token := s.decryptToken(s.data)
	out["hasToken"] = token != ""
	out["tokenMask"] = maskToken(token)
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
		t := s.decryptToken(p)
		cp["hasToken"] = t != ""
		cp["tokenMask"] = maskToken(t)
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

// maskToken 脱敏：首尾各留 4 位，中间补星。
//
// 留首尾是有用的 —— 用户手里往往有好几个 Token，
// 全打星的话「现在用的是哪一个」根本看不出来。
func maskToken(t string) string {
	if t == "" {
		return ""
	}
	if len(t) <= 8 {
		return "********"
	}
	stars := t[4 : len(t)-4]
	if len(stars) > 12 {
		stars = stars[:12]
	}
	masked := ""
	for range stars {
		masked += "*"
	}
	return t[:4] + masked + t[len(t)-4:]
}

// Patch 深度合并一组改动并落盘。
func (s *Store) Patch(patch map[string]any) (map[string]any, error) {
	if patch == nil {
		return nil, errors.New("patch 是空的")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	// Token 单独处理：留空 / 全是 * 都表示「不改」——
	// 设置页那个输入框里填的是掩码，一保存如果当真值写进去，
	// 用户的 Token 就变成了 ****
	if tok, ok := patch["token"]; ok {
		delete(patch, "token")
		if t, isStr := tok.(string); isStr && t != "" && !isAllStars(t) {
			if err := s.encryptInto(s.data, t); err != nil {
				return nil, err
			}
		}
	}

	s.data = merge(s.data, patch)
	// 顶层是「当前生效那份」的镜像，改完要同步回去，
	// 否则切走再切回来会看到旧值
	s.syncActiveLocked()
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// Reset 恢复默认设置并落盘（对应设置页的「恢复默认设置」）。
//
// 这是全程序唯一一个「一次调用就全毁」的操作：profiles、Token、链接规则
// 一起没。真跑之前先把旧文件备份到 config.json.reset-bak.json ——
// 「恢复默认」防不住手滑，留一份后路防得住。
func (s *Store) Reset() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if raw, err := os.ReadFile(s.file); err == nil {
		_ = os.WriteFile(s.file+".reset-bak.json", raw, 0o644)
	}
	s.data = migrate(Defaults())
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// Raw 取配置的原始结构（含 Token 加密字段），只给主进程内部用。
// 对外一律走 Get / view —— 那是剥掉 Token 的版本。
func (s *Store) Raw() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out, _ := deepCopy(s.data).(map[string]any)
	return out
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

/* ------------------------------------------------------------ 取值小工具
 *
 * 配置是从 JSON 解出来的，所有数字都是 float64、所有字段都可能不存在。
 * 这一组函数统一处理「取不到 / 类型不对 / 空值」三种情况，
 * 免得每个调用点都写一遍类型断言 —— 那正是「某个开关自己变回默认了」
 * 这类 bug 的温床（一处漏了零值判断，默认值就被静默写进去）。
 */

// str 取字符串，取不到给空串。
func str(v any) string {
	s, _ := v.(string)
	return s
}

// defStr 取字符串，空值回落到 def。
func defStr(v any, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}

// defOr 取任意值，nil 时回落到 def。
func defOr(v, def any) any {
	if v == nil {
		return def
	}
	return v
}

// numOf 取数字。JSON 里解出来是 float64，但手改过的配置也可能是别的类型。
func numOf(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case float32:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	}
	return 0
}

// nonEmpty 判断字符串字段有没有填。
func nonEmpty(v any) bool {
	s, ok := v.(string)
	return ok && s != ""
}

// hasAnyToken 只回答「有没有」，不解密 —— 给不需要真值的地方用
// （比如判断要不要提示用户去填 Token）。
func hasAnyToken(m map[string]any) bool {
	for _, k := range []string{"_tokenEnc", "_tokenPlain", "token"} {
		if v, ok := m[k].(string); ok && v != "" {
			return true
		}
	}
	return false
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
