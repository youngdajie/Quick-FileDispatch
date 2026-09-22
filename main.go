// Package main 是「快捷文件分发服务@JIE」Go 重写版（go 分支）的入口。
//
// 这一版的目标是复刻 Electron 主进程那 3,278 行的职责，**渲染层一行都不改**：
// 渲染层（src/renderer，9,587 行）全部用绝对路径加载资源、所有原生能力都走
// window.cloudpic 这一个对象，所以只要
//
//  1. 把 src/renderer 原样当静态资源托管；
//  2. 用一个垫片（web/bridge.js）把 window.cloudpic 从「Electron IPC」
//     接到「本地 HTTP 的 /ipc」上；
//
// 那 9,587 行界面代码就能直接跑起来。这也是本 demo 要证明的事。
//
// 当前进度：demo（只实现让界面跑起来的骨架通道）
//   - 已实现：app:info / config:get / config:set / config:reset / app:fonts /
//     shell:openExternal / shell:openLocalDir / win:*
//   - 未实现：cloud:* / git:* / profile:* / fs:* / dialog:chooseDir / ui:setBackground，
//     调用会返回「未实现（Go demo 阶段）：<通道名>」，在界面上表现为一条报错提示。
//
// 待办（按优先级）：
//   - 窗口壳：现在是拿系统的 Edge/Chrome 用 --app= 模式开一个无地址栏窗口，
//     只是过渡。正式版要换成 WebView2（复用系统 Chromium，安装包才能压到 10 MB 级）。
//   - Token 落盘加密：Electron 用 safeStorage（Windows 上是 DPAPI）。
//     Go 这边可以用 syscall 直接调 crypt32.dll 的 CryptProtectData，不需要 cgo。
//   - 图片压缩：Electron 版在主进程用多核 CPU 压 AVIF/WebP（vendor/avif 那套 wasm
//     在渲染层跑）。Go 版是否改为 Go 侧编码，还是保留渲染层的 wasm，待定。
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/ipc"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/store"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/webui"
)

// version 跟随 package.json 的版本号；Go 版正式发版后再独立走版本。
const version = "2.8.0-go.demo1"

// appName 必须与 package.json 的 name 保持一致：Electron 的 userData 目录是
// 「appData + 应用名」，两边对不上就会各自读一份配置，看起来像「配置丢了」。
const appName = "Quick-FileDispatch"

func main() {
	var (
		headless = flag.Bool("headless", false, "只起服务，不开窗口")
		check    = flag.Bool("check", false, "跑一遍自检（起服务 + 打几个接口）后退出")
		dev      = flag.Bool("dev", false, "静态资源直接从磁盘读（改渲染层立即生效），而不是用编译进 exe 的那份")
		port     = flag.Int("port", 0, "监听端口，0 = 随机挑一个空闲端口")
		profile  = flag.String("profile", "", "配置目录，留空用真实的 userData；给个临时目录可以拿假配置做测试")
	)
	flag.Parse()

	if err := run(*headless, *check, *dev, *port, *profile); err != nil {
		fmt.Fprintln(os.Stderr, "启动失败："+err.Error())
		os.Exit(1)
	}
}

func run(headless, check, dev bool, port int, profile string) error {
	cfgDir, err := configDir(profile)
	if err != nil {
		return err
	}
	st := store.New(filepath.Join(cfgDir, "config.json"))

	static := renderer
	if dev {
		static = os.DirFS("src/renderer")
	}

	env := &ipc.Env{
		Store:     st,
		Version:   version,
		ConfigDir: cfgDir,
	}
	reg := ipc.New()
	ipc.Register(reg, env)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return fmt.Errorf("监听端口失败：%w", err)
	}
	base := "http://" + ln.Addr().String()

	srv := &http.Server{
		Handler: webui.New(reg, static, bridgeJS, st.LocalDir),
		// 上传大文件时写超时要给够，否则一次几 MB 的图片就会被掐断
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
	}
	go func() {
		if e := srv.Serve(ln); e != nil && e != http.ErrServerClosed {
			fmt.Fprintln(os.Stderr, "服务异常退出："+e.Error())
		}
	}()

	// 这行是给脚本（和以后的流水线）用的：拿到它就知道服务起来了
	fmt.Printf("LISTENING %s\n", base)
	fmt.Printf("配置目录 %s\n", cfgDir)
	done, total := reg.Progress()
	fmt.Printf("通道 %d/%d 已实现\n", done, total)
	if check {
		if rest := reg.Remaining(); len(rest) > 0 {
			fmt.Printf("待实现：%s\n", strings.Join(rest, " "))
		}
	}
	if dev {
		fmt.Println("模式 dev（静态资源走磁盘 src/renderer）")
	}

	if check {
		return selfCheck(base)
	}

	if headless {
		select {} // 一直跑着，等人来打接口
	}

	return openAppWindow(base)
}

// configDir 决定配置放哪。
//
// 默认跟 Electron 版**同一个目录**（%APPDATA%\Quick-FileDispatch），于是这个 Go
// demo 一启动就能读到真实配置 —— 迁移期这样最省事，也能顺手验证「两边读的是同一份」。
// 给 --profile=<目录> 就换成那边，自检用临时目录，免得把你的真实配置写坏。
func configDir(profile string) (string, error) {
	dir := profile
	if dir == "" {
		appData := os.Getenv("APPDATA")
		if appData == "" {
			return "", fmt.Errorf("读不到 APPDATA 环境变量")
		}
		dir = filepath.Join(appData, appName)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("建配置目录失败：%w", err)
	}
	return dir, nil
}

/* ------------------------------------------------------------ 窗口壳（过渡方案） */

// openAppWindow 用系统里已有的 Edge / Chrome 开一个无地址栏窗口。
//
// 这只是过渡：正式版要换成 WebView2（复用系统 Chromium），安装包才能压到 10 MB 级。
// 换成 --app= 模式的好处是零依赖、马上能看见界面像不像原版；坏处是自绘的
// 最小化 / 最大化 / 关闭按钮不好使（那个要宿主进程配合，见 win:* 通道）。
func openAppWindow(base string) error {
	exe := findBrowser()
	if exe == "" {
		fmt.Println("没找到 Edge / Chrome，改成直接用默认浏览器打开：")
		fmt.Println(base)
		return openExternal(base)
	}
	cmd := exec.Command(exe, "--app="+base, "--window-size=1180,800", "--no-first-run")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动窗口失败：%w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func findBrowser() string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("LOCALAPPDATA"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// openExternal 用系统默认程序打开一个 URL / 文件，不经过浏览器选择逻辑。
func openExternal(target string) error {
	switch runtime.GOOS {
	case "windows":
		// cmd /c start 对 URL 和文件都管用；空标题参数是为了让 start 把带引号的
		// 参数当成目标而不是窗口标题
		return exec.Command("cmd", "/c", "start", "", target).Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

/* ------------------------------------------------------------ 自检 */

// jsonString 把一个字符串变成可以塞进 JSON 里的字面量。
// 自检里拼请求体时如果直接加引号，Windows 路径里的反斜杠会被 JSON 转义吃掉
// （D:\a → D:a），于是「读绑定目录内的文件」这条会莫名其妙地失败。
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// selfCheck 拿真实的 HTTP 请求打一遍自己的服务。
// 不碰真实配置（走的是 --profile 指定的临时目录），随便跑。
func selfCheck(base string) error {
	type probe struct {
		name string
		fn   func() (string, error)
	}
	var failed []string

	pass := func(name, detail string) {
		fmt.Printf("GOTEST ok   %-22s %s\n", name, detail)
	}
	fail := func(name, detail string) {
		fmt.Printf("GOTEST FAIL %-22s %s\n", name, detail)
		failed = append(failed, name)
	}

	get := func(path string) (int, string, error) {
		resp, err := http.Get(base + path)
		if err != nil {
			return 0, "", err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), err
	}

	post := func(channel string, payload string) (bool, string, error) {
		body := `{"channel":"` + channel + `","payload":` + payload + `}`
		resp, err := http.Post(base+"/ipc", "application/json", strings.NewReader(body))
		if err != nil {
			return false, "", err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			return false, "", err
		}
		var out struct {
			OK    bool            `json:"ok"`
			Data  json.RawMessage `json:"data"`
			Error string          `json:"error"`
		}
		if err := json.Unmarshal(b, &out); err != nil {
			return false, string(b), err
		}
		if !out.OK {
			return false, out.Error, nil
		}
		return true, string(out.Data), nil
	}

	probes := []probe{
		{"索引页可访问", func() (string, error) {
			code, body, err := get("/")
			if err != nil {
				return "", err
			}
			if code != 200 {
				return "", fmt.Errorf("HTTP %d", code)
			}
			if !strings.Contains(body, `<script src="/bridge.js"></script>`) {
				return "", fmt.Errorf("垫片没注入")
			}
			return fmt.Sprintf("HTTP 200 · %d B", len(body)), nil
		}},
		{"垫片可访问", func() (string, error) {
			code, body, err := get("/bridge.js")
			if err != nil {
				return "", err
			}
			if code != 200 || !strings.Contains(body, "window.cloudpic") {
				return "", fmt.Errorf("HTTP %d / 内容不对", code)
			}
			return fmt.Sprintf("HTTP 200 · %d B", len(body)), nil
		}},
		{"样式表可访问", func() (string, error) {
			code, body, err := get("/css/app.css")
			if err != nil {
				return "", err
			}
			if code != 200 {
				return "", fmt.Errorf("HTTP %d", code)
			}
			return fmt.Sprintf("HTTP 200 · %d B", len(body)), nil
		}},
		{"入口模块可访问", func() (string, error) {
			code, body, err := get("/js/app.js")
			if err != nil {
				return "", err
			}
			if code != 200 {
				return "", fmt.Errorf("HTTP %d", code)
			}
			return fmt.Sprintf("HTTP 200 · %d B", len(body)), nil
		}},
		{"接口 app:info", func() (string, error) {
			ok, out, err := post("app:info", "null")
			if err != nil {
				return "", err
			}
			if !ok {
				return "", errors.New(out)
			}
			return out, nil
		}},
		{"接口 config:get", func() (string, error) {
			ok, out, err := post("config:get", "null")
			if err != nil {
				return "", err
			}
			if !ok {
				return "", errors.New(out)
			}
			var cfg map[string]any
			if err := json.Unmarshal([]byte(out), &cfg); err != nil {
				return "", err
			}
			ver, _ := cfg["version"].(float64)
			if ver == 0 {
				return "", fmt.Errorf("配置里没有 version 字段")
			}
			_, hasToken := cfg["hasToken"]
			if !hasToken {
				return "", fmt.Errorf("配置里没有 hasToken 字段")
			}
			return fmt.Sprintf("version=%v onboarded=%v owner=%q", cfg["version"], cfg["onboarded"], cfg["owner"]), nil
		}},
		{"接口 config:set 回写", func() (string, error) {
			ok, out, err := post("config:set", `{"ui":{"font":"__go_check__"}}`)
			if err != nil {
				return "", err
			}
			if !ok {
				return "", errors.New(out)
			}
			var cfg struct {
				UI map[string]any `json:"ui"`
			}
			if err := json.Unmarshal([]byte(out), &cfg); err != nil {
				return "", err
			}
			if got, _ := cfg.UI["font"].(string); got != "__go_check__" {
				return "", fmt.Errorf("回写后读到的 font = %q", got)
			}
			// 改回去，别留脏值
			if _, _, err := post("config:set", `{"ui":{"font":""}}`); err != nil {
				return "", err
			}
			return "写入后再读，值对得上", nil
		}},
		{"未实现的通道会明确报错", func() (string, error) {
			ok, out, err := post("cloud:list", `{}`)
			if err != nil {
				return "", err
			}
			if ok {
				return "", fmt.Errorf("cloud:list 居然成功了，本该是「未实现」")
			}
			if !strings.Contains(out, "未实现") {
				return "", fmt.Errorf("错误信息里没有「未实现」字样：%s", out)
			}
			return out, nil
		}},
		{"名字写错的通道要报「未知通道」", func() (string, error) {
			ok, out, err := post("no:such", "null")
			if err != nil {
				return "", err
			}
			if ok {
				return "", fmt.Errorf("未知通道居然成功了")
			}
			// 必须和「还没实现」分开报：混在一起的话，通道名拼错会被
			// 当成「这条还没写」，白查半天
			if !strings.Contains(out, "未知通道") {
				return "", fmt.Errorf("没报「未知通道」：%s", out)
			}
			return out, nil
		}},
		{"/__local 只放行绑定目录", func() (string, error) {
			// 这个服务监听在 127.0.0.1 上，本机任何程序都够得着 ——
			// 不设边界就等于开了一个「读任意路径」的接口，所以要有一条断言盯着
			root, err := os.Getwd()
			if err != nil {
				return "", err
			}
			if _, _, err := post("config:set", `{"localDir":`+jsonString(root)+`}`); err != nil {
				return "", err
			}

			inside := filepath.Join(root, "src", "renderer", "index.html")
			code, body, err := get("/__local?p=" + url.QueryEscape(inside))
			if err != nil {
				return "", err
			}
			if code != 200 {
				return "", fmt.Errorf("绑定目录内的文件应该放行，实际 HTTP %d", code)
			}
			if !strings.Contains(body, "快捷文件分发服务") {
				return "", fmt.Errorf("放行了但内容不对（%d 字节）", len(body))
			}

			outside := filepath.Join(os.Getenv("WINDIR"), "win.ini")
			code2, _, err := get("/__local?p=" + url.QueryEscape(outside))
			if err != nil {
				return "", err
			}
			if code2 == 200 {
				return "", fmt.Errorf("越界读 %s 竟然放行了", outside)
			}
			return fmt.Sprintf("目录内 200 · 目录外 HTTP %d", code2), nil
		}},
	}

	for _, p := range probes {
		detail, err := p.fn()
		if err != nil {
			fail(p.name, err.Error())
			continue
		}
		pass(p.name, detail)
	}

	fmt.Println()
	if len(failed) == 0 {
		fmt.Println("GOCHECK_OK 全部通过")
		return nil
	}
	fmt.Printf("GOCHECK_FAILED %d 项：%s\n", len(failed), strings.Join(failed, ", "))
	os.Exit(1)
	return nil
}
