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
		{"3.4.10", "3.4.9", true},  // 10 > 9（按字符串比会说 "10" < "9"）
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

// 从 main.go 源码里抠 const version —— 这是查更新的首选路径，最要紧的一条。
func TestPickGoVersion(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string
	}{
		{
			name: "真实 main.go 的样子",
			src: "package main\n\nimport (\n\t\"flag\"\n)\n\n" +
				"const version = \"3.4.9\"\n\nfunc main() {}\n",
			want: "3.4.9",
		},
		{
			name: "前面还有别的常量",
			src:  "const appName = \"x\"\nconst version = \"1.2.3\"\n",
			want: "1.2.3",
		},
		{
			name: "带缩进的（写在函数里）",
			src:  "func f() {\n\tconst version = \"9.9.9\"\n}\n",
			want: "9.9.9",
		},
		{
			name: "文件里没有版本号",
			src:  "package main\n\nfunc main() {}\n",
			want: "",
		},
		{
			name: "引号不闭合（坏文件）",
			src:  "const version = \"3.4.9\n",
			want: "",
		},
		{
			name: "拿到的是网页壳子而不是源码",
			src:  "<!DOCTYPE html><html lang=\"zh\"></html>",
			want: "",
		},
	}
	for _, c := range cases {
		if got := pickGoVersion(c.src); got != c.want {
			t.Errorf("%s：pickGoVersion = %q，期望 %q", c.name, got, c.want)
		}
	}
}

// 从 Release 页面里抠版本号（兜底路径）。
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
