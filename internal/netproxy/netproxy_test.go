package netproxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 填了代理要能解析出来，且宽容对待不带 scheme 的写法
// （Clash 面板上显示的就是 127.0.0.1:7890，用户会直接粘过来）
func TestURLParsing(t *testing.T) {
	defer Set("")
	cases := []struct {
		in   string
		want string
	}{
		{"127.0.0.1:7890", "http://127.0.0.1:7890"},
		{"http://127.0.0.1:7890", "http://127.0.0.1:7890"},
		{"socks5://127.0.0.1:7891", "socks5://127.0.0.1:7891"},
		{"  http://127.0.0.1:1080  ", "http://127.0.0.1:1080"},
	}
	for _, c := range cases {
		Set(c.in)
		u := URL()
		if u == nil {
			t.Fatalf("%q 解析失败", c.in)
		}
		if u.String() != c.want {
			t.Fatalf("%q 解析成 %q，期望 %q", c.in, u.String(), c.want)
		}
	}
}

// 留空 = 不干预（不能把用户的 HTTPS_PROXY 之类环境变量覆盖掉）
func TestEmptyMeansNoOverride(t *testing.T) {
	defer Set("")
	Set("")
	if URL() != nil {
		t.Fatal("空值不该解析出 URL")
	}
	if got := Env(); got != nil {
		t.Fatalf("空值不该注入环境变量，却得到 %v", got)
	}
	tr := Transport()
	if tr == nil || tr.Proxy == nil {
		t.Fatal("Transport 仍然是可用的")
	}
}

// 环境变量：git 子进程靠这几个值走代理，必须带 scheme
func TestEnvCarriesProxy(t *testing.T) {
	defer Set("")
	Set("127.0.0.1:7890")
	env := Env()
	want := map[string]bool{
		"HTTP_PROXY=http://127.0.0.1:7890":  false,
		"HTTPS_PROXY=http://127.0.0.1:7890": false,
		"http_proxy=http://127.0.0.1:7890":  false,
		"https_proxy=http://127.0.0.1:7890": false,
	}
	for _, kv := range env {
		if _, ok := want[kv]; ok {
			want[kv] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Fatalf("环境变量里缺少 %s（实际：%v）", k, env)
		}
	}
}

// ★ 端到端：设了代理之后，http.Client 发出去的请求必须**真的经过那个代理**。
// 这条是整个功能的核心 —— 前面几条只验证"参数解析对了"，
// 只有这条能证明"流量确实走了代理"。
func TestRequestsActuallyGoThroughProxy(t *testing.T) {
	defer Set("")

	var hits int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		// 返回什么不重要，代理被访问到就说明流量过来了
		_, _ = w.Write([]byte("proxied"))
	}))
	defer proxy.Close()

	Set(proxy.URL)
	client := &http.Client{Transport: Transport()}
	// 目标地址随便写：正常情况下会被 DNS 拦下，走代理则会直接打到代理上
	_, _ = client.Get("http://example.invalid/whatever")

	if atomic.LoadInt32(&hits) == 0 {
		t.Fatal("请求没有经过代理 —— 代理配置没生效")
	}
}

// 没设代理时不能凭空把请求劫持到某个代理上
func TestNoProxyWhenUnset(t *testing.T) {
	defer Set("")
	Set("")
	tr := Transport()
	req, _ := http.NewRequest("GET", "https://api.github.com/user", nil)
	u, err := tr.Proxy(req)
	if err != nil {
		t.Fatalf("Proxy 报错：%v", err)
	}
	// 允许为 nil（直连）或来自环境变量的地址；这里断言"不是我们设的那个"
	if u != nil && strings.Contains(u.String(), "127.0.0.1:7890") {
		t.Fatalf("空配置下不该出现代理：%s", u)
	}
}

// ★ 国内平台永远直连：配代理是为了访问 GitHub，把 CNB 也塞进代理纯属帮倒忙
// （绕一圈更慢，或者干脆连不上）
func TestCNBAlwaysBypassesProxy(t *testing.T) {
	defer Set("")
	Set("127.0.0.1:7890")

	tr := Transport()
	for _, h := range []string{"cnb.cool", "api.cnb.cool", "lfs.cnb.cool", "cnb.cool:443", "CNB.COOL"} {
		req, err := http.NewRequest("GET", "https://"+h+"/x", nil)
		if err != nil {
			t.Fatalf("%s 构造请求失败：%v", h, err)
		}
		u, err := tr.Proxy(req)
		if err != nil {
			t.Fatalf("%s 取代理失败：%v", h, err)
		}
		if u != nil {
			t.Fatalf("%s 不该走代理，却拿到了 %s", h, u)
		}
	}

	// 对照组：GitHub 必须走代理，否则这个功能没意义
	req, _ := http.NewRequest("GET", "https://api.github.com/user", nil)
	u, _ := tr.Proxy(req)
	if u == nil {
		t.Fatal("GitHub 的请求应该走代理")
	}
	if u.Host != "127.0.0.1:7890" {
		t.Fatalf("代理地址不对：%s", u)
	}
}

// 环境变量里必须带 NO_PROXY，否则 git 推 CNB 也会绕道代理
func TestEnvCarriesNoProxy(t *testing.T) {
	defer Set("")
	Set("127.0.0.1:7890")

	env := Env()
	var noProxy string
	for _, kv := range env {
		if strings.HasPrefix(kv, "NO_PROXY=") {
			noProxy = kv
		}
	}
	if noProxy == "" {
		t.Fatalf("没有注入 NO_PROXY：%v", env)
	}
	if !strings.Contains(noProxy, "cnb.cool") {
		t.Fatalf("NO_PROXY 里没有 cnb.cool：%s", noProxy)
	}
}

// ★ 端到端：给 CNB 域名的请求，**一个字节都不该打到代理上**
// （用不存在的子域，DNS 会失败，但"代理没被碰过"正是这里要断言的）
func TestCNBRequestNeverReachesProxy(t *testing.T) {
	defer Set("")

	var hits int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte("proxied"))
	}))
	defer proxy.Close()

	Set(proxy.URL)
	client := &http.Client{Transport: Transport(), Timeout: 3 * time.Second}
	_, _ = client.Get("http://nonexistent-proxy-test.cnb.cool/x") // 会失败，无所谓

	if n := atomic.LoadInt32(&hits); n != 0 {
		t.Fatalf("CNB 域名的请求打到了代理上（%d 次）—— 国内平台应该直连", n)
	}
}
