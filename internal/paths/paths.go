// Package paths 复刻渲染层 src/renderer/js/lib/links.js 里的几个路径 / 名字工具。
//
// 为什么 Go 侧还要再写一遍：上传、改名、删除都要在**服务端**把路径规范化，
// 不能指望前端传进来的就是干净的 —— 越界防护必须握在真正动手的那一侧。
// 两边规则必须一致（比如都把反斜杠换成正斜杠），否则「界面上看着在 a/b，
// 实际写到了 a\b」这种错位很难查。
package paths

import (
	"errors"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var (
	reSlashes  = regexp.MustCompile(`/{2,}`)
	reBadChars = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
	reLeadDot  = regexp.MustCompile(`^\.+`)
	reExt      = regexp.MustCompile(`\.([a-z0-9]+)$`)
	reDotOnly  = regexp.MustCompile(`^\.([a-z0-9]+)$`)
)

// Normalize 把路径收拾成仓库内的相对路径：反斜杠换正斜杠、压掉重复斜杠、
// 去掉首尾斜杠。空串还是空串（表示仓库根目录）。
func Normalize(p string) string {
	s := strings.ReplaceAll(p, `\`, "/")
	s = reSlashes.ReplaceAllString(s, "/")
	s = strings.Trim(s, "/")
	return s
}

// Join 把若干段路径拼成一段干净的相对路径，空段自动跳过。
func Join(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if n := Normalize(p); n != "" {
			out = append(out, n)
		}
	}
	return strings.Join(out, "/")
}

// Ext 取扩展名（小写、不含点）；没有就是空串。
// 点文件（.gitignore）按 links.js 的写法也是取最后一段，
// 这样 .gitignore 的 ext 就是 "gitignore"，正好被 IsTextName 认下。
func Ext(name string) string {
	if m := reExt.FindStringSubmatch(name); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

// BaseName 取文件名部分（小写），用来匹配 Dockerfile / Makefile 这类没扩展名的文本文件。
func BaseName(name string) string {
	s := strings.ReplaceAll(name, `\`, "/")
	parts := strings.Split(s, "/")
	return strings.ToLower(parts[len(parts)-1])
}

// Sanitize 把文件名里的非法字符换成下划线，去掉开头的点，限长 180。
// 空结果给 "untitled" —— 宁可叫这个名字，也不要写出一个看不见的文件。
func Sanitize(name string) string {
	s := reBadChars.ReplaceAllString(name, "_")
	s = reLeadDot.ReplaceAllString(s, "")
	if len(s) > 180 {
		s = s[:180]
	}
	if s == "" {
		return "untitled"
	}
	return s
}

// FormatBytes 把字节数写成人能读的形式，和 links.js 的 formatBytes 对齐
// （1024 进制，两位小数起步，大了自动少留几位）。
func FormatBytes(n int64) string {
	if n < 1024 {
		return strconv.FormatInt(n, 10) + " B"
	}
	units := []string{"KB", "MB", "GB", "TB"}
	v := float64(n) / 1024
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	// v>=100 只留整数（"1.2 GB" 看着比 "1.23 GB" 干净），
	// 小于 10 才留两位 —— 和 links.js 的三档规则一致
	formatted := strconv.FormatFloat(v, 'f', 2, 64)
	switch {
	case v >= 100:
		formatted = strconv.FormatFloat(v, 'f', 0, 64)
	case v >= 10:
		formatted = strconv.FormatFloat(v, 'f', 1, 64)
	default:
		formatted = strconv.FormatFloat(v, 'f', 2, 64)
	}
	return formatted + " " + units[i]
}

/* ------------------------------------------------------------ 文本文件识别 */

// textExt 对应 highlight.js 的 TEXT_EXT（扩展名 → 语言）。
var textExt = map[string]bool{
	"js": true, "mjs": true, "cjs": true, "jsx": true, "ts": true, "tsx": true, "mts": true, "cts": true,
	"json": true, "jsonc": true, "json5": true, "webmanifest": true,
	"html": true, "htm": true, "xhtml": true, "vue": true, "svelte": true, "hbs": true, "ejs": true,
	"css": true, "scss": true, "less": true, "sass": true, "styl": true,
	"py": true, "pyw": true, "pyi": true,
	"go": true,
	"sh": true, "bash": true, "zsh": true, "ksh": true, "fish": true, "ps1": true, "psm1": true, "bat": true, "cmd": true,
	"yml": true, "yaml": true,
	"md": true, "markdown": true, "mdx": true,
	"ini": true, "conf": true, "cfg": true, "toml": true, "env": true, "properties": true, "mod": true,
	"npmrc": true, "editorconfig": true, "gitconfig": true, "pylintrc": true, "prettierrc": true,
	"eslintrc": true, "babelrc": true, "stylelintrc": true, "flake8": true,
	"gitignore": true, "gitattributes": true, "gitmodules": true, "dockerignore": true, "npmignore": true,
	"c": true, "h": true, "cpp": true, "cc": true, "cxx": true, "hpp": true, "hh": true,
	"hxx": true, "ino": true,
	"cs": true, "java": true, "kt": true, "kts": true, "swift": true, "dart": true,
	"php": true, "scala": true, "groovy": true, "gradle": true,
	"rs":  true,
	"sql": true,
	"rb":  true, "gemfile": true, "rakefile": true, "podfile": true, "brewfile": true, "vagrantfile": true,
	"txt": true, "text": true, "log": true, "rst": true, "csv": true, "tsv": true,
	"lock": true, "sum": true, "patch": true, "diff": true, "srt": true, "vtt": true,
}

// nameLang 对应 highlight.js 的 NAME_LANG（整个文件名 → 语言）。
var nameLang = map[string]bool{
	"dockerfile": true, "containerfile": true,
	"makefile": true, "gnumakefile": true, "cmakelists.txt": true, "procfile": true,
	"go.mod": true, "go.sum": true,
	"license": true, "licence": true, "notice": true, "authors": true,
	"readme": true, "changelog": true, "contributing": true,
	".bashrc": true, ".zshrc": true, ".bash_profile": true, ".profile": true, ".vimrc": true,
	"requirements.txt": true,
}

// IsTextName 判断这个文件名能不能当文本预览，对应 highlight.js 的 isTextName。
//
// 云端读文本前会先拿它挡一道：不认识的类型就不浪费一次网络往返
// （一张 100 MB 的图拉下来只为发现「它不是文本」，太亏）。
func IsTextName(name string) bool {
	base := BaseName(name)
	if base == "" {
		return false
	}
	if strings.HasPrefix(base, ".") {
		// 点文件走扩展名那条（.gitignore / .env / .editorconfig）
		switch Ext(base) {
		case "gitignore", "env", "editorconfig":
			return true
		}
	}
	if nameLang[base] {
		return true
	}
	return textExt[Ext(base)]
}

/* ------------------------------------------------------------ 链接规则
 *
 * 这张表是 src/renderer/js/lib/links.js 里 LINK_RULES 的 platforms 字段的复刻。
 * 只有迁移和表单回填会用到它：判断「这条规则能不能用在某个平台上」。
 *
 * 为什么值得为迁移单独维护一份：jsDelivr 是 GitHub 专属、cnb_raw 是 CNB 专属，
 * 硬塞过去会生成一条根本打不开的链接 —— 而它只在「老配置升级」时发生一次，
 * 平时根本没人会点到，错了能错很久。
 */

// rulePlatforms 是「规则 → 适用平台」。
var rulePlatforms = map[string][]string{
	"auto":          {"github", "cnb"},
	"github_raw":    {"github"},
	"jsdelivr":      {"github"},
	"statically":    {"github"},
	"githack":       {"github"},
	"ghpages":       {"github"},
	"cnb_raw":       {"cnb"},
	"cnb_jsdmirror": {"cnb"},
	"custom":        {"github", "cnb"},
}

// AutoRuleOf：「自动」在各平台对应哪条规则（GitHub → jsDelivr，CNB → 国内 CDN）。
func AutoRuleOf(platform string) string {
	if platform == "cnb" {
		return "cnb_jsdmirror"
	}
	return "jsdelivr"
}

// RuleFits 判断这条规则能不能用在某个平台上。
// 认 'auto' —— 它在两个平台的列表里都在，不用单独判断。
func RuleFits(ruleID, platform string) bool {
	p := platform
	if p != "cnb" {
		p = "github"
	}
	for _, ok := range rulePlatforms[ruleID] {
		if ok == p {
			return true
		}
	}
	return false
}

/* ------------------------------------------------------------ 本地路径越界防护 */

// errEscape：相对路径指到了根目录外面。刻意不把算出来的目标路径放进错误信息，
// 免得它反过来告诉攻击者「这个目录结构长这样」。
var errEscape = errors.New("路径越界：不允许访问本地目录之外的位置")

// SafeJoin 把相对路径挂到根目录上，并阻止越界。
//
// 这是**唯一的**路径拼接入口：所有来自界面的相对路径都必须过它，
// 否则 "..\\..\\Windows" 这种就能读到仓库外面去（删除通道尤其危险）。
func SafeJoin(root, rel string) (string, error) {
	clean := filepath.Clean(root)
	target := filepath.Join(clean, filepath.FromSlash(Normalize(rel)))
	// Join 已经把 .. 消解掉了，只要结果还在 root 里就安全
	if target != clean && !strings.HasPrefix(target, clean+string(filepath.Separator)) {
		return "", errEscape
	}
	return target, nil
}

// Parent 取一段相对路径的目录部分（用于建父目录）。
func Parent(rel string) string {
	return path.Dir(Normalize(rel))
}
