package netproxy

import (
	"bufio"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
 * 本机代理探测：设置页「扫描」按钮背后那件事。
 *
 * 两步，谁先给出结果用谁：
 *   1. Windows 系统代理（注册表 HKCU\...\Internet Settings），用户自己开的开关，
 *      最可信。注意 ProxyEnable 关着时 ProxyServer 里还留着上次的地址，
 *      照着它去连是连到空气，所以必须连带看那个开关。
 *   2. 端口探测：在常见代理端口上握一次手，问清楚「你是 HTTP 还是 SOCKS5」。
 *      这一步是为了兜住「软件开着、但没开系统代理」的情况，而本程序恰恰
 *      不读系统代理（见 netproxy 包注释），用户点了扫描就该有个能填的地址。
 *
 * 握手而不是只 dial：只判断端口通不通会把一堆本地服务误认成代理
 * （8080 上的开发服务器、9090 上的面板都开着门）。
 */

// DetectResult 是「扫描」的返回。字段名直接给渲染层用。
type DetectResult struct {
	Found  bool   `json:"found"`
	URL    string `json:"url"`
	Source string `json:"source"` // system（系统代理）/ port（端口探测）
}

// probe 是一个待试的端口 + 它可能是什么代理。
// 顺序即优先级：同一台机器上 Clash 和 v2rayN 都开着时，先报排在前面的那个。
type probe struct {
	port int
	kind string // http | socks5
}

var probes = []probe{
	{7890, "http"},   // Clash / Clash Verge / Mihomo 的混合端口
	{7897, "http"},   // Clash Verge Rev 默认混合端口
	{10809, "http"},  // v2rayN 的 HTTP 端口
	{7890, "socks5"}, // 混合端口也能当 SOCKS5 用
	{7891, "socks5"}, // Clash 的 SOCKS 端口
	{10808, "socks5"}, // v2rayN 的 SOCKS 端口
	{1080, "socks5"},  // 通用 SOCKS5
	{1087, "http"},    // 老版 v2rayN
	{6152, "http"},    // Surge
	{8889, "http"},    // Surge / ClashX
}

const (
	dialTimeout  = 160 * time.Millisecond
	probeTimeout = 500 * time.Millisecond
)

// Detect 扫一遍本机，给出一个能直接填进设置页的代理地址。
func Detect() DetectResult {
	if raw, ok := systemProxy(); ok {
		if u := normalizeProxy(raw); u != "" {
			return DetectResult{Found: true, URL: u, Source: "system"}
		}
	}
	if u, ok := scanPorts(); ok {
		return DetectResult{Found: true, URL: u, Source: "port"}
	}
	return DetectResult{Found: false}
}

// scanPorts 并发试一遍候选端口，取优先级最高的那个命中。
func scanPorts() (string, bool) {
	type hit struct {
		idx int
		url string
	}
	ch := make(chan hit, len(probes))
	var wg sync.WaitGroup
	for i, p := range probes {
		wg.Add(1)
		go func(i int, p probe) {
			defer wg.Done()
			if handshakes(p) {
				ch <- hit{i, p.kind + "://127.0.0.1:" + strconv.Itoa(p.port)}
			}
		}(i, p)
	}
	wg.Wait()
	close(ch)

	best := -1
	url := ""
	for h := range ch {
		if best < 0 || h.idx < best {
			best, url = h.idx, h.url
		}
	}
	return url, best >= 0
}

// handshakes 判断这个端口上是不是真的有个对应协议的代理在听。
func handshakes(p probe) bool {
	addr := "127.0.0.1:" + strconv.Itoa(p.port)
	conn, err := net.DialTimeout("tcp", addr, dialTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(probeTimeout))

	if p.kind == "socks5" {
		// SOCKS5 打招呼：VER=5, NMETHODS=1, METHOD=无认证
		if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
			return false
		}
		buf := make([]byte, 2)
		if _, err := readFull(conn, buf); err != nil {
			return false
		}
		// 服务器回 5,0（无需认证）或 5,2（要账号密码）都算，是 SOCKS5 就行
		return buf[0] == 0x05
	}

	// HTTP 代理：发一个 CONNECT 看它认不认。普通 Web 服务会回 400/404/501，
	// 只有代理会接下这个「帮我打通到 github 的隧道」的请求。
	req := "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Connection: keep-alive\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		return false
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return false
	}
	// 期望 "HTTP/1.1 200 ..."；407 是「要认证」，也说明它是个代理
	return strings.HasPrefix(line, "HTTP/") &&
		(strings.Contains(line, " 200") || strings.Contains(line, " 407"))
}

// readFull 只为一两个字节，不值得引 io.ReadFull 的语义负担。
func readFull(conn net.Conn, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := conn.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

// normalizeProxy 把系统代理那一串整理成「scheme://host:port」。
//
// Windows 里它可能是 "127.0.0.1:7890"，也可能是按协议分列的
// "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"。
// 分列时优先 https，GitHub 全是 https，那一条才是真正会走的那条。
func normalizeProxy(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "=") {
		byScheme := map[string]string{}
		for _, part := range strings.Split(s, ";") {
			kv := strings.SplitN(part, "=", 2)
			if len(kv) != 2 {
				continue
			}
			byScheme[strings.ToLower(strings.TrimSpace(kv[0]))] = strings.TrimSpace(kv[1])
		}
		if v := byScheme["https"]; v != "" {
			return withScheme("http", v)
		}
		if v := byScheme["http"]; v != "" {
			return withScheme("http", v)
		}
		if v := byScheme["socks"]; v != "" {
			return withScheme("socks5", v)
		}
		return ""
	}
	return withScheme("http", s)
}

func withScheme(scheme, host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	if strings.Contains(host, "://") {
		return host
	}
	// 没端口的一律当填错了：代理地址必须能落到一个端口上
	if _, port, err := net.SplitHostPort(host); err != nil || port == "" {
		return ""
	}
	return scheme + "://" + host
}
