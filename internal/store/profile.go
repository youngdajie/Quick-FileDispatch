package store

import (
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/paths"
)

/* ------------------------------------------------------------ profile 常量 */

// profileFields 是「属于这一份配置」的字段：切 profile 时整组一起换。
//
// linkRule / customDomain / linkFormat 也在内 —— 一份配置 = 仓库信息 + 本地目录 + 文件链接。
// 早先它们放在顶层当全局设置，结果切到另一个平台时，平台专属的规则
// （如 jsdelivr 只给 GitHub）在新平台的下拉里不存在，表单只能回落到「自动」，
// 一保存就把用户的规则冲掉了。
// linkFormat（默认复制格式）同理：不同仓库的用途不一样，图床要 Markdown、素材库要裸链接，
// 它跟着配置走才合理。
var profileFields = []string{
	"platform", "owner", "repo", "branch", "apiBase", "localDir", "linkRule", "customDomain", "linkFormat",
}

// profileFieldDefault 是上面那些字段「空值该回落到什么」。
var profileFieldDefault = map[string]string{"branch": "main", "linkRule": "auto", "linkFormat": "markdown"}

func profileDefaultOf(k string) string {
	if v, ok := profileFieldDefault[k]; ok {
		return v
	}
	return ""
}

/* ------------------------------------------------------------ Token */

// GetToken 取当前生效那份的明文 Token。
//
// 只在本进程内部用，绝不经过 IPC 出去 —— 界面上看到的永远是掩码。
func (s *Store) GetToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.decryptToken(s.data)
}

// GetProfileToken 取某份配置的明文 Token。
//
// 自己没存，就顺着「同平台 + 同 owner/repo/branch」找一份有 Token 的借用 ——
// 导入进来的配置天生不带凭据，靠这条把可用性体检（profile:check）做得有意义，
// 否则每份导入的配置都会显示「本机没有可用 Token」，其实只是没存在它自己身上。
func (s *Store) GetProfileToken(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.data["profiles"].([]any)
	p := findProfile(list, id)
	if p == nil {
		return ""
	}
	if own := s.decryptToken(p); own != "" {
		return own
	}
	same := findSameRepo(list, p)
	if same == nil {
		return ""
	}
	return s.decryptToken(same)
}

// decryptToken 解开某个持有者（配置本体 或 一份 profile）上的 Token。
//
// 解不开（换了用户 / 重装系统 / 密文损坏）时**返回空串**而不是报错：
// 这时界面该显示「没有 Token，请重新填写」，而不是抛一个看不懂的系统错误。
func (s *Store) decryptToken(holder map[string]any) string {
	if holder == nil {
		return ""
	}
	if enc, ok := holder["_tokenEnc"].(string); ok && enc != "" {
		if s.vault == nil {
			return ""
		}
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return ""
		}
		plain, err := s.vault.Decrypt(raw)
		if err != nil {
			// 解不开就当没有 —— 但要把原因留给你排查
			if s.onTokenFail != nil {
				s.onTokenFail(err)
			}
			return ""
		}
		return string(plain)
	}
	if plain, ok := holder["_tokenPlain"].(string); ok {
		return plain
	}
	return ""
}

// encryptInto 把 Token 加密后写进某个持有者。
//
// 加密失败（平台不支持 / DPAPI 不可用）时**不落明文**，直接报错 ——
// 「已加密」这个承诺不能打折，关于页上是这么写的。
func (s *Store) encryptInto(holder map[string]any, token string) error {
	delete(holder, "_tokenEnc")
	delete(holder, "_tokenPlain")
	if token == "" {
		return nil
	}
	if s.vault == nil {
		return errors.New("本机不支持 Token 加密，未写入")
	}
	blob, err := s.vault.Encrypt([]byte(token))
	if err != nil {
		return fmt.Errorf("Token 加密失败，未写入：%w", err)
	}
	holder["_tokenEnc"] = base64.StdEncoding.EncodeToString(blob)
	return nil
}

// SetToken 设置当前生效那份的 Token。
func (s *Store) SetToken(token string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.encryptInto(s.data, token); err != nil {
		return nil, err
	}
	// 顶层是「当前生效那份」的镜像，两边要同步，
	// 否则切走再切回来会看到旧 Token
	copyToken(s.data, s.activeProfileLocked())
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// copyToken 把 from 上的 Token 原样搬到 to，先清空 to 上的。
func copyToken(from, to map[string]any) {
	if to == nil {
		return
	}
	delete(to, "_tokenEnc")
	delete(to, "_tokenPlain")
	if from == nil {
		return
	}
	if v, ok := from["_tokenEnc"]; ok {
		to["_tokenEnc"] = v
		return
	}
	if v, ok := from["_tokenPlain"]; ok {
		to["_tokenPlain"] = v
	}
}

/* ------------------------------------------------------------ 迁移 */

// migrate 逐版升级老配置。
//
// 每一版的注释都写清「为什么要动」和「为什么只动这一类」——
// 迁移跑在用户看不见的地方，写错了不会报错，只会表现为
// 「我的某个设置怎么自己变了」，那是最难查的一类问题。
func migrate(cfg map[string]any) map[string]any {
	v := numOf(cfg["version"])

	if v < 3 {
		// AVIF 编码器内置完成后，默认输出格式从「智能」改成 AVIF。
		// 只动「从没改过、还是 auto」的老配置；用户主动选过的一律不动。
		if m, ok := cfg["compress"].(map[string]any); ok {
			if f, _ := m["format"].(string); f == "" || f == "auto" {
				m["format"] = "avif"
			}
		}
		cfg["version"] = 3
	}
	if v < 4 {
		// 引入「归档的仓库配置」：把现有的一组连接信息收成一个 profile
		if cfg["_tokenEnc"] != nil || cfg["_tokenPlain"] != nil ||
			nonEmpty(cfg["owner"]) || nonEmpty(cfg["repo"]) {
			p := profileFromTop(cfg)
			p["note"] = "原有配置"
			cfg["profiles"] = []any{p}
		}
		// 水印默认色改成品牌蓝（和界面主色一致），同样只动从没改过的
		if m, ok := cfg["watermark"].(map[string]any); ok {
			if c, _ := m["color"].(string); c == "" || c == "#ffffff" {
				m["color"] = "#1296db"
			}
		}
		cfg["version"] = 4
	}
	if v < 5 {
		// 路径模板取消：上传目标目录改到上传页自己选。
		// 残留值必须删掉 —— 留着就是一个看不见却还会影响上传路径的字段。
		delete(cfg, "pathTemplate")
		cfg["version"] = 5
	}
	if v < 6 {
		// 早先预置了 1920 的最大宽高，等于偷偷替用户做了「缩图」的决定。
		// 还原成 0（不限制），但只还原还停在旧默认值的那些。
		if m, ok := cfg["compress"].(map[string]any); ok {
			if numOf(m["maxWidth"]) == 1920 {
				m["maxWidth"] = 0
			}
			if numOf(m["maxHeight"]) == 1920 {
				m["maxHeight"] = 0
			}
		}
		cfg["version"] = 6
	}
	if v < 7 {
		// Gitee 已下线。残留的 gitee 一律归到 github，
		// 否则设置页找不到对应的平台按钮、云端连不上还查不出原因。
		demote := func(obj map[string]any) {
			if obj == nil {
				return
			}
			if str(obj["platform"]) == "gitee" {
				obj["platform"] = "github"
				if api := strings.ToLower(str(obj["apiBase"])); strings.Contains(api, "gitee") {
					obj["apiBase"] = ""
				}
				// 它原来的 Token 是 Gitee 的，不能继续冒充已验证
				obj["verified"] = false
				obj["verifiedAt"] = float64(0)
				delete(obj, "repoInfo")
				delete(obj, "userName")
			}
		}
		if list, ok := cfg["profiles"].([]any); ok {
			for _, it := range list {
				if m, ok := it.(map[string]any); ok {
					demote(m)
				}
			}
		}
		if str(cfg["platform"]) == "gitee" {
			cfg["platform"] = "github"
			if api := strings.ToLower(str(cfg["apiBase"])); strings.Contains(api, "gitee") {
				cfg["apiBase"] = ""
			}
		}
		cfg["platform"] = normalizePlatform(cfg["platform"])
		cfg["version"] = 7
	}
	if v < 8 {
		// 链接规则 / 自定义域名从「一份全局设置」改成「每份配置自己的」。
		// 补法是「原来那份全局规则是谁的，就还给谁」，但只在该规则确实
		// 适用于它的平台时才给（见 paths.RuleFits），不适用就留 'auto'。
		wantRule := str(cfg["linkRule"])
		if wantRule == "" {
			wantRule = "auto"
		}
		wantDomain := str(cfg["customDomain"])
		if list, ok := cfg["profiles"].([]any); ok {
			for _, it := range list {
				m, ok := it.(map[string]any)
				if !ok {
					continue
				}
				if _, exists := m["linkRule"]; !exists {
					if paths.RuleFits(wantRule, normalizePlatform(m["platform"])) {
						m["linkRule"] = wantRule
					} else {
						m["linkRule"] = "auto"
					}
				}
				if _, exists := m["customDomain"]; !exists {
					m["customDomain"] = wantDomain
				}
			}
		}
		/**
		 * 顶层是「当前生效那份」的镜像，必须跟着它对齐。
		 * 不对齐就出大问题：老的全局规则是 jsdelivr（GitHub 专属）、生效配置却是 CNB，
		 * 那份配置只能拿 'auto'，可顶层还留着 jsdelivr —— 生成链接读的是顶层，
		 * 于是给 CNB 仓库拼出一条 jsdelivr 链接；而且下次保存任何设置时
		 * syncActive 又会把顶层这个 jsdelivr 写回 CNB 那份配置里，越描越黑。
		 */
		if act := firstProfile(cfg); act != nil {
			cfg["linkRule"] = defStr(act["linkRule"], "auto")
			cfg["customDomain"] = defStr(act["customDomain"], "")
		}
		cfg["version"] = 8
	}
	if v < 9 {
		// bgBlur 换了语义：以前是「毛玻璃强度」（0-24，越大人越透、还带模糊），
		// 现在是「面板不透明度」（0-100，越大越实心）。模糊那套先撤了 ——
		// 老逻辑里强度 0 反而是全白实心，跟直觉反着来。
		// 按 (1 - 旧/24) * 100 换算，同一档位观感尽量对上：
		//   旧 0（关毛玻璃 = 实心） → 新 100（不透明）
		//   旧 24（最强、最透）     → 新 0（全透明）
		if ui, ok := cfg["ui"].(map[string]any); ok {
			if b, ok := ui["bgBlur"].(float64); ok && b >= 0 && b <= 24 {
				ui["bgBlur"] = math.Round((1 - b/24) * 100)
			}
		}
		cfg["version"] = 9
	}
	if v < 10 {
		// 水印的位置从「边距由字号推导」改成「可以精确指定」：
		// 新增 marginX / marginY（距图片边缘的**绝对像素**）、fontFamily、fontWeight。
		//
		// 老配置按旧公式折算一版，让它在 1000px 宽（缩放系数正好 = 1）的图上观感不变：
		//   旧的边距 m = round(size × 0.9)，右下角时 x 边距就是 m；
		//   旧的 y 是文字垂直中心（h - size - m），换算成「文字底边距底边」
		//   就是 size/2 + m ≈ size × 1.4。
		// 图更宽时旧实现的边距会跟着字号一起变大，新实现是固定像素 ——
		// 这正是这次要的效果：说「距右边 20px」就是 20px，不再随图浮动。
		if wm, ok := cfg["watermark"].(map[string]any); ok {
			fs := 22.0
			if n, ok := wm["fontSize"].(float64); ok && n > 0 {
				fs = n
			}
			if _, has := wm["marginX"]; !has {
				wm["marginX"] = math.Round(fs * 0.9)
			}
			if _, has := wm["marginY"]; !has {
				wm["marginY"] = math.Round(fs * 1.4)
			}
			if _, has := wm["fontFamily"]; !has {
				wm["fontFamily"] = ""
			}
			if _, has := wm["fontWeight"]; !has {
				wm["fontWeight"] = float64(600)
			}
		}
		cfg["version"] = 10
	}

	list, _ := cfg["profiles"].([]any)
	if len(list) == 0 {
		// 保证永远至少有一个 profile：切换平台 / 新建配置都要有落点
		cfg["profiles"] = []any{profileFromTop(cfg)}
		list = cfg["profiles"].([]any)
	}
	active := str(cfg["activeProfileId"])
	if findProfile(list, active) == nil {
		if len(list) > 0 {
			if m, ok := list[0].(map[string]any); ok {
				cfg["activeProfileId"] = str(m["id"])
			}
		}
	}
	return cfg
}

// profileFromTop 从当前顶层字段造一个 profile（迁移 / 兜底用）。
func profileFromTop(cfg map[string]any) map[string]any {
	p := map[string]any{
		"id":         newProfileID(),
		"name":       "",
		"verified":   false,
		"verifiedAt": float64(0),
		"note":       "",
		"createdAt":  float64(time.Now().UnixMilli()),
	}
	for _, k := range profileFields {
		p[k] = defStr(cfg[k], profileDefaultOf(k))
	}
	if cfg["_tokenEnc"] != nil {
		p["_tokenEnc"] = cfg["_tokenEnc"]
	} else if cfg["_tokenPlain"] != nil {
		p["_tokenPlain"] = cfg["_tokenPlain"]
	}
	return p
}

var idSeq int64

func newProfileID() string {
	idSeq++
	return fmt.Sprintf("p%x%x", time.Now().UnixMilli(), idSeq)
}

func normalizePlatform(v any) string {
	if s := strings.TrimSpace(str(v)); s == "cnb" {
		return "cnb"
	}
	return "github"
}

/* ------------------------------------------------------------ profile 操作 */

// NewProfile 新建一个空白配置（默认不抢占「当前使用」这个位置）。
//
// 为什么必须走这里而不是 patch()：patch 改的是「当前生效的那个」，
// 用 patch 建新配置会变成把现有配置覆盖掉。
func (s *Store) NewProfile(patch map[string]any) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	p := map[string]any{
		"id":           newProfileID(),
		"name":         defStr(patch["name"], ""),
		"note":         defStr(patch["note"], ""),
		"verified":     false,
		"verifiedAt":   float64(0),
		"createdAt":    float64(time.Now().UnixMilli()),
		"platform":     normalizePlatform(defOr(patch["platform"], s.data["platform"])),
		"owner":        "",
		"repo":         "",
		"branch":       "main",
		"apiBase":      "",
		"localDir":     "",
		"linkRule":     "auto",
		"customDomain": "",
	}
	// 允许把连接字段一起带进来建（设置页「配置某个平台 → 保存」走的就是这条）
	if patch != nil {
		for _, k := range profileFields {
			if v, ok := patch[k]; ok {
				p[k] = v
			}
		}
	}
	if defStr(p["branch"], "") == "" {
		p["branch"] = "main"
	}
	if patch != nil {
		if tok, ok := patch["token"].(string); ok && tok != "" {
			if err := s.encryptInto(p, tok); err != nil {
				return nil, err
			}
		}
	}
	list, _ := s.data["profiles"].([]any)
	s.data["profiles"] = append(list, p)
	// activate === false：只建，不抢「当前使用」这个位置
	if patch == nil || patch["activate"] != false {
		s.mirrorFromLocked(p)
	}
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// FindByPlatform 按平台找落点：优先已验证的，其次最近创建的。
func (s *Store) FindByPlatform(platform string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.data["profiles"].([]any)
	var pool []map[string]any
	for _, it := range list {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		if normalizePlatform(m["platform"]) != platform {
			continue
		}
		pool = append(pool, m)
	}
	if len(pool) == 0 {
		return nil
	}
	var verified []map[string]any
	for _, m := range pool {
		if b, _ := m["verified"].(bool); b {
			verified = append(verified, m)
		}
	}
	candidates := pool
	if len(verified) > 0 {
		candidates = verified
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return numOf(candidates[i]["verifiedAt"]) > numOf(candidates[j]["verifiedAt"])
	})
	return candidates[0]
}

// ActivateProfile 切换到某份配置（把它的连接字段镜像到顶层）。
func (s *Store) ActivateProfile(id string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.data["profiles"].([]any)
	p := findProfile(list, id)
	if p == nil {
		return nil, errors.New("配置不存在")
	}
	s.mirrorFromLocked(p)
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// UpdateProfile 更新归档信息（名称 / 备注 / 验证结果 / 连接字段 / Token）。
func (s *Store) UpdateProfile(id string, patch map[string]any) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.data["profiles"].([]any)
	p := findProfile(list, id)
	if p == nil {
		return nil, errors.New("配置不存在")
	}
	if patch == nil {
		patch = map[string]any{}
	}

	// Token 也要能改到「非当前使用」的那份上（设置页可以编辑任意一份配置）
	if tok, ok := patch["token"]; ok {
		delete(patch, "token")
		if t, isStr := tok.(string); isStr && !isAllStars(t) {
			if err := s.encryptInto(p, t); err != nil {
				return nil, err
			}
			if str(p["id"]) == str(s.data["activeProfileId"]) {
				copyToken(p, s.data)
			}
		}
	}

	conn := map[string]any{}
	for _, k := range profileFields {
		if v, exists := patch[k]; exists {
			conn[k] = v
			delete(patch, k)
		}
	}
	for k, v := range patch {
		p[k] = v
	}
	changed := len(conn) > 0
	for k, v := range conn {
		p[k] = v
	}
	// 改的是当前生效的那个：连接字段要立刻镜像回顶层
	if changed && str(p["id"]) == str(s.data["activeProfileId"]) {
		for _, k := range profileFields {
			s.data[k] = defStr(p[k], profileDefaultOf(k))
		}
	}
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// VerifyProfile 标记为已验证可用（= 归档完成）。
// 同时它就不再是草稿了（见 isDraft）。
func (s *Store) VerifyProfile(id string, info map[string]any) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.data["profiles"].([]any)
	p := findProfile(list, id)
	if p == nil {
		return nil, errors.New("配置不存在")
	}
	p["verified"] = true
	p["verifiedAt"] = float64(time.Now().UnixMilli())
	if info != nil {
		if v, ok := info["userName"]; ok {
			p["userName"] = v
		}
		if v, ok := info["repo"]; ok {
			p["repoInfo"] = v
		}
	}
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

// DeleteProfile 删除一份配置。
func (s *Store) DeleteProfile(id string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.data["profiles"].([]any)
	idx := -1
	for i, it := range list {
		if m, ok := it.(map[string]any); ok && str(m["id"]) == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, errors.New("配置不存在")
	}
	wasActive := str(s.data["activeProfileId"]) == id
	list = append(list[:idx], list[idx+1:]...)
	if len(list) == 0 {
		// 删光了就补一个空的，别让「切换平台 / 新建」没有落点。
		// 它是空的、没验证过，在列表里也不会显示成一份配置（见 isDraft）。
		list = append(list, profileFromTop(Defaults()))
		s.data["profiles"] = list
		if m, ok := list[0].(map[string]any); ok {
			s.mirrorFromLocked(m)
		}
	} else {
		s.data["profiles"] = list
		if wasActive {
			next := idx
			if next > len(list)-1 {
				next = len(list) - 1
			}
			if m, ok := list[next].(map[string]any); ok {
				s.mirrorFromLocked(m)
			}
		}
	}
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.view(), nil
}

/* ------------------------------------------------------------ 导出 / 导入 */

// ExportProfiles 导出为可移植的 JSON。
//
// 只导出「换台电脑也能立刻用上」的东西：
//   - 各份配置的仓库信息 + Token（明文）+ 各自的链接规则 / 自定义域名
//   - 一份全局的「文件链接」设置（链接格式 / 预览代理）
//
// 故意**不导出本地路径**：换台电脑后 D:\xxx 往往根本不存在，
// 写进去只会让导入端指向一个不存在的目录。导入端拿到空 localDir 之后
// 会引导用户为本机重新绑定目录。
//
// Token 是明文落在 JSON 里的 —— 导出前必须由渲染层弹确认框。
func (s *Store) ExportProfiles() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.data
	profiles := []any{}
	if list, ok := cfg["profiles"].([]any); ok {
		for _, it := range list {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			o := map[string]any{
				"name":         defStr(m["name"], ""),
				"note":         defStr(m["note"], ""),
				"platform":     normalizePlatform(m["platform"]),
				"owner":        defStr(m["owner"], ""),
				"repo":         defStr(m["repo"], ""),
				"branch":       defStr(m["branch"], "main"),
				"apiBase":      defStr(m["apiBase"], ""),
				"linkRule":     defStr(m["linkRule"], "auto"),
				"customDomain": defStr(m["customDomain"], ""),
				// Token 一起带走：不带上，换台机器等于要用户从头再配一遍
				"token": s.decryptToken(m),
			}
			if v, ok := m["userName"]; ok {
				o["userName"] = v
			}
			profiles = append(profiles, o)
		}
	}
	return map[string]any{
		"kind":       "Quick-FileDispatch",
		"version":    3,
		"exportedAt": time.Now().UTC().Format(time.RFC3339),
		"settings": map[string]any{
			// 当前生效那份的镜像，留给旧导入端当兜底
			"linkRule":     defStr(cfg["linkRule"], "auto"),
			"customDomain": defStr(cfg["customDomain"], ""),
			"linkFormat":   defStr(cfg["linkFormat"], "markdown"),
			"proxyUrl":     defStr(cfg["proxyUrl"], ""),
		},
		"profiles": profiles,
	}
}

// ImportResult 是导入的结果。
type ImportResult struct {
	Added           int   `json:"added"`
	Skipped         int   `json:"skipped"`
	SettingsApplied bool  `json:"settingsApplied"`
	SkippedDetail   []any `json:"skippedDetail"`
	Cfg             any   `json:"cfg"`
}

// ImportProfiles 导入归档配置。
//
// 几条硬规则：
//   - 一律分配新 id，避免和本机已有配置撞车；
//   - 一律标记为「未验证」：换台机器后本地目录还没绑，必须补目录后重新验证；
//   - Token 用**本机**的 DPAPI 重新加密落盘；
//   - 本地路径不导入（同上）；
//   - 同平台 + 同 owner/repo 视为重复，跳过。
func (s *Store) ImportProfiles(payload map[string]any) (*ImportResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	incoming, _ := payload["profiles"].([]any)
	if len(incoming) == 0 {
		return nil, errors.New("文件里没有可导入的配置")
	}
	list, _ := s.data["profiles"].([]any)
	if list == nil {
		list = []any{}
	}

	seen := map[string]bool{}
	for _, it := range list {
		if m, ok := it.(map[string]any); ok {
			seen[keyOf(m)] = true
		}
	}

	st0, _ := payload["settings"].(map[string]any)
	added := 0
	skipped := []any{}

	for _, raw := range incoming {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		p := map[string]any{
			"id":       newProfileID(),
			"name":     truncate(defStr(m["name"], ""), 60),
			"note":     truncate(defStr(m["note"], ""), 200),
			"platform": normalizePlatform(m["platform"]),
			"owner":    strings.TrimSpace(defStr(m["owner"], "")),
			"repo":     strings.TrimSpace(defStr(m["repo"], "")),
			"branch":   defStr(strings.TrimSpace(defStr(m["branch"], "")), "main"),
			"apiBase":  strings.TrimSpace(defStr(m["apiBase"], "")),
			// 本地路径绝不从文件里带过来 —— 换台机器它多半不存在
			"localDir":     "",
			"linkRule":     defStr(m["linkRule"], defStr(st0["linkRule"], "auto")),
			"customDomain": defStr(m["customDomain"], defStr(st0["customDomain"], "")),
			"verified":     false,
			"verifiedAt":   float64(0),
			"createdAt":    float64(time.Now().UnixMilli()),
			"imported":     true,
		}
		if v, ok := m["userName"]; ok {
			p["userName"] = truncate(defStr(v, ""), 80)
		}
		if tok := defStr(m["token"], ""); tok != "" {
			if err := s.encryptInto(p, tok); err != nil {
				// 加密失败就把这条跳过，不要让整批导入失败
				skipped = append(skipped, map[string]any{
					"label":  defStr(m["owner"], "") + "/" + defStr(m["repo"], ""),
					"reason": err.Error(),
				})
				continue
			}
		}
		if defStr(p["owner"], "") == "" || defStr(p["repo"], "") == "" {
			skipped = append(skipped, map[string]any{
				"label":  defStr(m["owner"], "") + "/" + defStr(m["repo"], ""),
				"reason": "缺少用户名或仓库名",
			})
			continue
		}
		k := keyOf(p)
		if seen[k] {
			skipped = append(skipped, map[string]any{
				"label":  defStr(p["owner"], "") + "/" + defStr(p["repo"], ""),
				"reason": "本机已有相同配置",
			})
			continue
		}
		seen[k] = true
		list = append(list, p)
		added++
	}
	s.data["profiles"] = list

	/**
	 * 只恢复「真·全局」的那两项（链接格式 / 预览代理）。
	 * 链接规则和自定义域名现在跟着配置走，上面已经按每份配置还原过了 ——
	 * 这里再往顶层写一遍，等于用文件里那份配置的规则覆盖掉本机当前生效配置的规则，
	 * 用户明明只是导进来几份备份，自己正在用的规则却被改了。
	 */
	settingsApplied := false
	if st0 != nil {
		patch := map[string]any{}
		if v := defStr(st0["linkFormat"], ""); v != "" {
			patch["linkFormat"] = v
		}
		if v, ok := st0["proxyUrl"].(string); ok {
			patch["proxyUrl"] = v
		}
		if len(patch) > 0 {
			for k, v := range patch {
				s.data[k] = v
			}
			settingsApplied = true
		}
	}

	if added > 0 || settingsApplied {
		if err := s.write(); err != nil {
			return nil, err
		}
	}
	return &ImportResult{
		Added:           added,
		Skipped:         len(skipped),
		SettingsApplied: settingsApplied,
		SkippedDetail:   skipped,
		Cfg:             s.view(),
	}, nil
}

func keyOf(p map[string]any) string {
	return strings.Join([]string{
		normalizePlatform(p["platform"]),
		strings.ToLower(defStr(p["owner"], "")),
		strings.ToLower(defStr(p["repo"], "")),
	}, "|")
}

/* ------------------------------------------------------------ 内部小工具 */

// activeProfileLocked 取当前生效那份（调用方须持锁）。
func (s *Store) activeProfileLocked() map[string]any {
	list, _ := s.data["profiles"].([]any)
	return findProfile(list, str(s.data["activeProfileId"]))
}

// syncActiveLocked 把「当前生效」的连接字段 + token 写回 active profile。
func (s *Store) syncActiveLocked() {
	p := s.activeProfileLocked()
	if p == nil {
		return
	}
	for _, k := range profileFields {
		p[k] = defStr(s.data[k], profileDefaultOf(k))
	}
	copyToken(s.data, p)
}

// mirrorFromLocked 把 profile 的连接字段 + token 镜像到顶层。
// 顶层才是全 app 读的那份（渲染层有上百处直接读 cfg.owner）。
func (s *Store) mirrorFromLocked(p map[string]any) {
	for _, k := range profileFields {
		s.data[k] = defStr(p[k], profileDefaultOf(k))
	}
	copyToken(p, s.data)
	s.data["activeProfileId"] = str(p["id"])
}

// findSameRepo 找一份「同平台 + 同 owner/repo/branch」的配置（不含自己）。
func findSameRepo(list []any, self map[string]any) map[string]any {
	for _, it := range list {
		m, ok := it.(map[string]any)
		if !ok || m == nil {
			continue
		}
		if str(m["id"]) == str(self["id"]) {
			continue
		}
		if normalizePlatform(m["platform"]) != normalizePlatform(self["platform"]) {
			continue
		}
		if defStr(m["owner"], "") != defStr(self["owner"], "") {
			continue
		}
		if defStr(m["repo"], "") != defStr(self["repo"], "") {
			continue
		}
		if defStr(m["branch"], "main") != defStr(self["branch"], "main") {
			continue
		}
		return m
	}
	return nil
}

func findProfile(list []any, id string) map[string]any {
	if id == "" {
		return nil
	}
	for _, it := range list {
		if m, ok := it.(map[string]any); ok && str(m["id"]) == id {
			return m
		}
	}
	return nil
}

// firstProfile 取「当前生效那份」，没有就拿第一份。
func firstProfile(cfg map[string]any) map[string]any {
	list, _ := cfg["profiles"].([]any)
	if p := findProfile(list, str(cfg["activeProfileId"])); p != nil {
		return p
	}
	for _, it := range list {
		if m, ok := it.(map[string]any); ok {
			return m
		}
	}
	return nil
}

func isAllStars(s string) bool {
	return s != "" && strings.Trim(s, "*") == ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
