// Package main 是「快捷文件分发服务@JIE」Go 重写版（go 分支）的入口。
//
// 这一版的目标是复刻 Electron 主进程那 3,278 行的职责，**渲染层一行都不改**：
// 渲染层（src/renderer）全部用绝对路径加载资源、所有原生能力都走
// window.cloudpic 这一个对象，所以只要
//
//  1. 把 src/renderer 原样当静态资源托管；
//  2. 用一个垫片（web/bridge.js）把 window.cloudpic 从「Electron IPC」
//     接到「本地 HTTP 的 /ipc」上；
//
// 那 9,587 行界面代码就能直接跑起来。这也是本项目要证明的事。
//
// 窗口壳是 WebView2（internal/wvhost，纯 syscall 不引第三方包）：
// 无边框 + 渲染层自绘标题栏，和 Electron 版 frame:false 一个观感。
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/dialog"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/dpapi"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/ipc"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/lfs"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/progress"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/store"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/webui"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/wvhost"
)

// 版本号规则：3.0.0 起去掉 -go 后缀（2.8.1~2.9.0 的 -go 是
// 与 Electron 时代 v* 标签区分发布线的过渡写法）。
const version = "3.4.1"

// appName 沿用 Electron 时代定下的 userData 目录名（appData + 应用名）：
// 两边对不上就会各自读一份配置，看起来像「配置丢了」——老用户升级到 Go 版
// 配置必须还能读到，所以这个名字不能改。
const appName = "Quick-FileDispatch"

// 窗口与任务栏图标。Electron 版由 electron-builder 从 build/icon.ico 打进去；
// Go 不会给 exe 嵌资源（那是 rcedit 干的活），窗口运行时用的是这里嵌的一份。
//
//go:embed build/icon.ico
var iconICO []byte

func main() {
	// exe 是 windowsgui 子系统（双击不弹 CMD 窗口），从终端跑 --check 时
	// 要主动接回控制台才有输出；管道 / 重定向场景它自己会识别并跳过
	attachConsole()

	var (
		headless  = flag.Bool("headless", false, "只起服务，不开窗口")
		check     = flag.Bool("check", false, "跑一遍自检（起服务 + 打几个接口）后退出")
		dev       = flag.Bool("dev", false, "静态资源直接从磁盘读（改渲染层立即生效），而不是用编译进 exe 的那份")
		port      = flag.Int("port", 0, "监听端口，0 = 随机挑一个空闲端口")
		profile   = flag.String("profile", "", "配置目录，留空用真实的 userData；给个临时目录可以拿假配置做测试")
		debugPort = flag.Int("debug-port", 0, "给 WebView2 开远程调试端口（自检 / 排障用），0 = 不开")
	)
	flag.Parse()

	if err := run(*headless, *check, *dev, *port, *profile, *debugPort); err != nil {
		fmt.Fprintln(os.Stderr, "启动失败："+err.Error())
		os.Exit(1)
	}
}

func run(headless, check, dev bool, port int, profile string, debugPort int) error {
	cfgDir, err := configDir(profile)
	if err != nil {
		return err
	}
	// Token 的加密材料挂在配置目录里（Local State 与 config.json 同级）。
	// --profile 指向临时目录时，这一整套也跟着走，不会碰本机的真实加密材料。
	vault := dpapi.New(cfgDir)
	st := store.New(filepath.Join(cfgDir, "config.json"), vault)
	// 解不开老 Token 时打一句原因：这种情况界面只显示「没有 Token」，
	// 不打日志的话完全查不出是「换了用户」还是「我们的代码解错了」
	st.SetTokenFailHook(func(err error) {
		fmt.Fprintf(os.Stderr, "[token] 解不开已存的 Token（多半是换过 Windows 用户或重装过系统）：%v\n", err)
	})

	static := renderer
	if dev {
		static = os.DirFS("src/renderer")
	}

	// 上传进度中心：把后端「传到哪了」实时推给界面（SSE）。
	// 一个进程一个，所有上传任务共用。
	hub := progress.NewHub()

	env := &ipc.Env{
		Store:     st,
		Version:   version,
		ConfigDir: cfgDir,
		TmpRoot:   filepath.Join(cfgDir, "cnb-work"),
		// 主题切换时窗口底色跟着换（页面没铺满前露出的一瞬就是它）
		OnBackground: wvhost.SetBackground,
		Progress:     hub,
	}
	reg := ipc.New()
	ipc.Register(reg, env)

	// git-lfs 如果已经装过（上次用过 LFS 上传），启动时就把它挂进
	// git 子进程的 PATH —— 这样用户不必先触发一次上传才能用。
	// 没装的话这里什么都不做，等真正勾选 LFS 时再下载。
	if binDir := lfs.InstalledBinDir(cfgDir); binDir != "" {
		git.SetExtraPath(binDir)
	}

	// 两个闭包捕获的是 env 这个指针变量，调用时才取值 ——
	// 所以哪怕这里 env 还没用完也不影响（切仓库后读到的也是最新配置）
	handler := webui.New(reg, static, bridgeJS,
		func(abs string) bool { return env.AllowsLocal(abs) },
		func(rel string) ([]byte, string, error) { return env.FetchRemote(rel) },
		hub,
	)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return fmt.Errorf("监听端口失败：%w", err)
	}
	base := "http://" + ln.Addr().String()

	srv := &http.Server{
		Handler: handler,
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

	return openAppWindow(base, cfgDir, debugPort, initialBackground(st))
}

// initialBackground 按配置里的主题算窗口底色：页面加载前露出的一瞬就是
// 它（Controller 的 DefaultBackgroundColor），深浅两套主题各有一个底色，
// 避免深色主题启动闪白。
func initialBackground(st *store.Store) uint32 {
	cfg := st.Get()
	if ui, ok := cfg["ui"].(map[string]any); ok {
		if t, _ := ui["theme"].(string); t == "light" {
			return ipc.BgLight
		}
	}
	return ipc.BgDark
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

/* ------------------------------------------------------------ 窗口壳（WebView2） */

// openAppWindow 开主窗口。无边框、渲染层自绘标题栏，与 Electron 版 frame:false 一致；
// 初始 / 最小尺寸也逐字对齐（1360×880 / 1080×680）。
//
// WebView2 的浏览器数据目录（缓存 / Cookie / GPU 缓存）与配置目录分开：
// 配置在 Roaming（要跟着用户备份），浏览器缓存是典型的 Local 数据，
// 而且它自带 EBWebView 目录结构，塞进 Roaming 只会污染配置目录。
func openAppWindow(base, cfgDir string, debugPort int, bg uint32) error {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local = cfgDir
	}
	ud := filepath.Join(local, appName, "WebView2")

	// 远程调试：WebView2 认这个环境变量，专门给自检和排障用，
	// 平时不开（开着等于把 DevTools 协议暴露在本机端口上）
	if debugPort > 0 {
		os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
			fmt.Sprintf("--remote-debugging-port=%d", debugPort))
	}

	// 把主窗口句柄交给原生对话框：没有宿主窗口，选文件夹 / 选文件对话框会
	// 开在主窗口**背后**，用户以为点了没反应，反复点就会点出一堆窗口。
	// 窗口是在 wvhost.Run 里建的（那之后就一直阻塞在消息循环里），
	// 所以这里起一个短轮询等句柄出现。
	go func() {
		for i := 0; i < 150; i++ {
			if h := wvhost.Hwnd(); h != 0 {
				dialog.SetOwner(h)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()

	return wvhost.Run(wvhost.Options{
		URL:         base,
		UserDataDir: ud,
		Icon:        iconICO,
		Width:       1360,
		Height:      880,
		MinWidth:    1080,
		MinHeight:   680,
		// A<<24|R<<16|G<<8|B：页面加载前的底色，
		// 按配置里的主题挑（深色 #0a1018 / 浅色 #f7f9fc）
		Background: bg,
	})
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
		// 这条以前是「未实现的通道会明确报错」，探的是 cloud:list 还没写。
		// 通道全实现之后它就没意义了（cloud:list 现在会因为没配仓库而报别的错），
		// 留着会变成一条永远失败的假警报。
		// 换成下面两条更有用的：验证「缺配置」和「配置不可用」都是**人看得懂的中文**，
		// 而不是 Go 的堆栈腔调。
		{"没配仓库时云端通道给得出人话", func() (string, error) {
			ok, out, err := post("cloud:list", `{}`)
			if err != nil {
				return "", err
			}
			if ok {
				return "", fmt.Errorf("没配仓库竟然返回成功了：%s", out)
			}
			// 引导用户去哪儿改，比一句「请求失败」有用得多
			if !strings.Contains(out, "设置") {
				return "", fmt.Errorf("错误里没说该去哪改：%s", out)
			}
			return out, nil
		}},
		{"云端通道不会再报「未实现」", func() (string, error) {
			// 防止有人把某个通道的实现删掉却没发现：
			// 一旦退回「未实现」，这条就会红
			for _, ch := range []string{
				"cloud:list", "cloud:tree", "cloud:stats", "cloud:upload",
				"cloud:delete", "cloud:move", "cloud:replace", "cloud:readText",
				"cloud:detect", "cloud:pushLocal", "cloud:verify",
				"profile:new", "profile:check", "git:clone", "git:pull", "git:commit",
				"fs:localRename", "fs:localWrite", "fs:localDelete",
			} {
				ok, out, err := post(ch, `{}`)
				if err != nil {
					return "", fmt.Errorf("%s 传输失败：%w", ch, err)
				}
				if ok {
					continue
				}
				if strings.Contains(out, "未实现") {
					return "", fmt.Errorf("%s 退回成「未实现」了：%s", ch, out)
				}
			}
			return "19 个通道都在，没有退回未实现", nil
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
