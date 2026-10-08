// Package netproxy 统一管理「出站代理」。
//
// 为什么要自己管：Go 的 http.ProxyFromEnvironment **只认环境变量**
// （HTTPS_PROXY / HTTP_PROXY / NO_PROXY），**不认 Windows「设置 → 代理」里那个
// 系统代理** —— 那东西存在注册表 HKCU\...\Internet Settings 里，标准库从不读它。
// 而 Clash / v2rayN 这类工具默认就是改注册表那一套（它们的「系统代理」开关）。
//
// 结果就是：用户开着系统代理，浏览器一切正常，本程序却仍然直连 ——
// 上传、推送全卡住，而且报出来的错跟代理毫无关系，极难自查。
//
// 所以这里做两件事：
//  1. 提供一个**显式**的代理配置，填了就走；
//  2. 让三个出站通道共用这一份设置：REST API、git 子进程、LFS 下载。
//
// 没填时不干预 —— 仍按 Go 的默认行为（读环境变量）走，
// 这样在命令行里设过 HTTPS_PROXY 的人不受影响。
package netproxy

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
)

var (
	mu  sync.RWMutex
	raw string
)

// directHosts 是「永远直连、绝不走代理」的域名后缀。
//
// 为什么要写死 CNB：它是国内平台，直连才是最快的 —— 把它塞进代理里纯属帮倒忙
// （要么绕一圈更慢，要么干脆连不上）。而用户配代理本来就是为了访问 GitHub。
// 所以代理只作用于**境外**，国内平台自动绕过。
var directHosts = []string{
	"cnb.cool",
}

// hostOnly 去掉端口，IPv6 的 [::1]:8080 也能正确处理。
func hostOnly(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if i := strings.LastIndex(h, ":"); i >= 0 {
		if j := strings.LastIndex(h, "]"); j < i {
			return h[:i]
		}
	}
	return h
}

// shouldDirect 判断这个 host 是不是「不该走代理」的。
func shouldDirect(host string) bool {
	h := hostOnly(host)
	if h == "" {
		return false
	}
	for _, d := range directHosts {
		if h == d || strings.HasSuffix(h, "."+d) {
			return true
		}
	}
	return false
}

// DirectList 给子进程用的直连名单（NO_PROXY 的格式，逗号分隔）。
func DirectList() string {
	parts := make([]string, 0, len(directHosts)*2)
	for _, d := range directHosts {
		// 带点和不带点都写：不同程序对前导点的解释不一致，多写一份没坏处
		parts = append(parts, d, "."+d)
	}
	return strings.Join(parts, ",")
}

// Set 设置代理地址。传空串 = 不指定（回到「只认环境变量」的默认行为）。
func Set(v string) {
	mu.Lock()
	raw = strings.TrimSpace(v)
	mu.Unlock()
}

// Raw 返回用户填的原始值（界面上显示用）。
func Raw() string {
	mu.RLock()
	defer mu.RUnlock()
	return raw
}

// URL 把用户填的地址解析成 *url.URL，空值或解析不出来时返回 nil。
//
// 宽容一点：Clash 面板上显示的是 127.0.0.1:7890（不带 scheme），
// 直接粘过来也该能用 —— 默认按 http:// 处理。
func URL() *url.URL {
	s := Raw()
	if s == "" {
		return nil
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil
	}
	return u
}

// Transport 基于 http.DefaultTransport **克隆**一份，按需挂上代理。
//
// 克隆而不是新建：默认那份里的连接池、TLS 参数、超时都是调过的，
// 从零造一份反而会丢东西（keep-alive 少了会让批量上传慢一大截）。
//
// 代理是**按域名分流**的：国内平台（见 directHosts）直连，其余走代理。
func Transport() *http.Transport {
	base, _ := http.DefaultTransport.(*http.Transport)
	var t *http.Transport
	if base != nil {
		t = base.Clone()
	} else {
		t = &http.Transport{Proxy: http.ProxyFromEnvironment}
	}
	if u := URL(); u != nil {
		proxy := u
		t.Proxy = func(req *http.Request) (*url.URL, error) {
			if req == nil || req.URL == nil {
				return nil, nil
			}
			if shouldDirect(req.URL.Host) {
				return nil, nil // 直连
			}
			return proxy, nil
		}
	}
	return t
}

// Env 返回要注入给子进程（git / git-lfs）的代理环境变量。
//
// git 自己不读 Windows 系统代理，但认这几个环境变量；
// 而 internal/git 那边是 os.Environ() 全量继承再追加，塞进去就能生效。
// 大小写两种都写：不同平台 / 不同程序的读取习惯不一致，多写一份没坏处。
//
// NO_PROXY 是必须的：不然推 CNB 也会绕道代理（那是国内平台，绕一圈更慢甚至失败），
// 而用户想要的其实是「GitHub 走代理、CNB 照旧直连」。
func Env() []string {
	u := URL()
	if u == nil {
		return nil
	}
	s := u.String() // 用解析后的，把 127.0.0.1:7890 补成 http://127.0.0.1:7890
	direct := DirectList()
	return []string{
		"HTTP_PROXY=" + s, "HTTPS_PROXY=" + s,
		"http_proxy=" + s, "https_proxy=" + s,
		"NO_PROXY=" + direct, "no_proxy=" + direct,
	}
}
