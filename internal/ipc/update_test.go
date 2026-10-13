package ipc

import "testing"

// 版本号比较：三段数字，从 "v3.4.9" / "3.4.9-go" 这类形式里都能抠出来
func TestNewerThan(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v3.4.9", "3.4.8", true},
		{"3.4.8", "v3.4.9", false},
		{"v3.4.8", "3.4.8", false}, // 一样新
		{"3.5.0", "3.4.99", true},  // 比的是每段数字，不是字符串
		{"3.4.10", "3.4.9", true},  // 10 > 9（字符串比会说 "10" < "9"）
		{"4.0.0", "3.99.99", true},
		{"3.4.8-go", "3.4.7", true},
		{"坏数据", "3.4.8", false}, // 解析不了就不说"有新版本"
	}
	for _, c := range cases {
		if got := newerThan(c.a, c.b); got != c.want {
			t.Errorf("newerThan(%q, %q) = %v，期望 %v", c.a, c.b, got, c.want)
		}
	}
}

// 从 Release 页面里抠版本号。这是「不用令牌也能查更新」的核心，
// 页面长得五花八门也不能抠错。
func TestPickSetupVersion(t *testing.T) {
	cases := []struct {
		name string
		html string
		want string
	}{
		{
			name: "只有一个附件",
			html: `{"name":"QuickFileDispatch-Setup-3.4.8.exe","size":7517769}`,
			want: "3.4.8",
		},
		{
			name: "附件藏在 HTML 的 href 里",
			html: `<a href="/youngdajie/Quick-FileDispatch/-/releases/download/v3.4.8/QuickFileDispatch-Setup-3.4.8.exe">下载</a>`,
			want: "3.4.8",
		},
		{
			name: "列表里有多个版本，取最大的",
			html: `QuickFileDispatch-Setup-3.4.6.exe ... QuickFileDispatch-Setup-3.4.9.exe ... QuickFileDispatch-Setup-3.4.7.exe`,
			want: "3.4.9",
		},
		{
			name: "两位数版本段也要比大小（3.4.10 > 3.4.9）",
			html: `QuickFileDispatch-Setup-3.4.9.exe QuickFileDispatch-Setup-3.4.10.exe`,
			want: "3.4.10",
		},
		{
			name: "免安装的那个单 exe 不能被误当成安装包",
			html: `QuickFileDispatch-3.4.9.exe`,
			want: "",
		},
		{
			name: "版本号后面不是 .exe 的忽略",
			html: `QuickFileDispatch-Setup-3.4.8.exe.bak`,
			want: "",
		},
		{
			name: "页面里根本没有附件信息",
			html: `<html><body>暂无版本</body></html>`,
			want: "",
		},
	}
	for _, c := range cases {
		if got := pickSetupVersion(c.html); got != c.want {
			t.Errorf("%s：pickSetupVersion = %q，期望 %q", c.name, got, c.want)
		}
	}
}
