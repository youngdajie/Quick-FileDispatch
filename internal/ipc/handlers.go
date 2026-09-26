package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/cloud"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/dialog"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/progress"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/store"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/winfont"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/wvhost"
)

// Env 是处理函数需要的依赖。用结构体传进去而不是包级全局，
// 这样以后要开两个实例（比如自检里同时跑真实配置和临时配置）也不用改代码。
type Env struct {
	Store     *store.Store
	Version   string
	ConfigDir string
	// TmpRoot 是 CNB 写入时临时克隆仓库的地方（挂在配置目录下，随配置一起走）。
	// 不放系统临时目录是因为：克隆出来的整个仓库可能有上千个文件，
	// 放系统临时目录容易留下没人认领的垃圾，而放在配置目录下用户一眼能看到。
	TmpRoot string
	Verbose bool

	// OnBackground 是「窗口底色要换了」的钩子：换主题时缩放带露出来的
	// 那圈颜色必须跟着页面走。由 main 注入 wvhost.SetBackground；为 nil
	// 时（--headless / --check）跳过。
	OnBackground func(color uint32)

	// Progress 是上传进度的广播中心。为 nil 时所有上报静默丢弃
	// （progress.Hub.Task 支持 nil receiver），所以自检场景不用特殊处理。
	Progress *progress.Hub

	cache *repoCache
	roots *rootGuard
}

// 窗口缩放带的底色，与渲染层两套主题的页面底色一致（A<<24|R<<16|G<<8|B）。
const (
	BgDark  uint32 = 0xFF0A1018 // #0a1018，Electron 版 backgroundColor 同款
	BgLight uint32 = 0xFFF7F9FC // #f7f9fc，浅色主题的页面底色
)

// themeBackground 按配置里的 ui.theme 算窗口底色；没写就是深色（默认主题）。
func themeBackground(theme string) uint32 {
	if theme == "light" {
		return BgLight
	}
	return BgDark
}

// rootGuard 是 /__local 允许访问的根目录白名单。
type rootGuard struct {
	mu    sync.Mutex
	roots map[string]bool
}

func (g *rootGuard) allow(dir string) {
	if dir == "" || g == nil {
		return
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.roots[strings.ToLower(filepath.Clean(abs))] = true
}

// Allows 判断某个绝对路径在不在白名单里。
func (g *rootGuard) Allows(abs string) bool {
	if g == nil {
		return false
	}
	target := strings.ToLower(filepath.Clean(abs))
	g.mu.Lock()
	defer g.mu.Unlock()
	for root := range g.roots {
		if target == root || strings.HasPrefix(target, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// AllowsLocal 给 /__local 做边界判断。
func (e *Env) AllowsLocal(abs string) bool {
	if e.roots == nil {
		return false
	}
	return e.roots.Allows(abs)
}

// allowRoot 把本地目录加进 /__local 的白名单。
func (e *Env) allowRoot(dir string) {
	if e.roots != nil {
		e.roots.allow(dir)
	}
}

// repoKey 是仓库的身份串：换仓库 / 换分支 / 换本地目录都会变，
// 拿它当缓存键，配置一改缓存自然失效（对齐 main.js 的 repoKey()）。
func (e *Env) repoKey() string {
	cfg := e.Store.Raw()
	get := func(k, def string) string {
		if v, ok := cfg[k].(string); ok && v != "" {
			return v
		}
		return def
	}
	return strings.Join([]string{
		cloud.NormalizePlatform(get("platform", "github")),
		get("owner", ""), get("repo", ""), get("branch", "main"), get("localDir", ""),
	}, "|")
}

// copyFile 把 src 原样复制到 dst（覆盖语义）。背景图副本、导出附件这类
// 「整个文件搬个家」的需求都用它；文件不大，不值得上缓冲池花样。
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Register 把这一版实现的通道挂上去。
//
// 通道名逐字对照 src/main/preload.js 与 main.js 里的 ipcMain.handle，
// 别自己改名 —— 渲染层是按名字调的，改一个字母就是「点了没反应」。
func Register(r *Registry, env *Env) {
	if env.cache == nil {
		env.cache = newRepoCache()
	}
	if env.roots == nil {
		env.roots = &rootGuard{roots: map[string]bool{}}
	}
	// 配置里已经绑了本地目录的话，启动时就得放行 ——
	// 否则刷新一次界面，本地图片预览会先 403 一次（要等下一次 config:set 才恢复）
	if dir := env.Store.LocalDir(); dir != "" {
		env.allowRoot(dir)
	}
	// 临时目录也要放行：CNB 写入通道克隆出来的工作区在里面
	if env.TmpRoot != "" {
		env.allowRoot(env.TmpRoot)
	}
	// 自定义背景图的副本目录同理：配置里记着它，启动就得放行，
	// 否则重启后浅色背景先 403 一次（和上面本地目录是同一个坑）
	if cfg := env.Store.Get(); cfg != nil {
		if ui, ok := cfg["ui"].(map[string]any); ok {
			if bg, _ := ui["bgImage"].(string); bg != "" {
				env.allowRoot(filepath.Dir(bg))
			}
		}
	}

	/* ---------------------------------------------------------- 应用信息 */

	r.Handle("app:info", func(json.RawMessage) (any, error) {
		return map[string]any{
			"name":    "快捷文件分发服务@JIE",
			"version": env.Version,
			"author":  "小杰",
			// 提交署名必须是账号本人，别让上传的提交挂在「JIE」名下
			"gitAuthor":      "youngdajie",
			"gitAuthorEmail": "ok@yangjie.site",
			"site":           "https://www.yangjie.site",
			"platform":       runtime.GOOS,
			"userData":       env.ConfigDir,
			"configFile":     env.Store.File(),
			"cpuCount":       runtime.NumCPU(),
			// 下面三个是 Go 版的运行信息。About 页的「技术栈」那一段是写死在
			// 渲染层里的文字（还写着 Electron / Node.js），等 Go 版定型了要一起改。
			"go":       runtime.Version(),
			"shell":    "WebView2（internal/wvhost，纯 syscall 零依赖）",
			"electron": "", // 明确留空：Go 版没有 Electron
			"isDev":    false,
		}, nil
	})

	// 本机字体家族名。GDI 一次枚举搞定（见 internal/winfont），不再绕 PowerShell ——
	// 那条路既慢又在这台机器上跑不出结果，而它被渲染层的启动链路 await 着，
	// 慢一步界面就晚一步上主题色。
	r.Handle("app:fonts", func(json.RawMessage) (any, error) {
		return winfont.Families(), nil
	})

	// git-lfs 状态与安装。只在 CNB 用 LFS 上传时才是必需的，但设置页
	// 提前把状态摆出来，用户不用等到上传失败了才发现缺东西。
	//
	// 注意这个查询**不触发下载** —— 只是看本地有没有。
	// 真正的安装是 lfsInstall（可能几十秒，带进度事件）。
	r.Handle("app:lfsStatus", func(json.RawMessage) (any, error) {
		return env.lfsStatus(), nil
	})

	r.Handle("app:lfsInstall", func(json.RawMessage) (any, error) {
		return env.lfsInstall()
	})

	/* ---------------------------------------------------------- 配置 */

	r.Handle("config:get", func(json.RawMessage) (any, error) {
		return env.Store.Get(), nil
	})

	r.Handle("config:set", func(payload json.RawMessage) (any, error) {
		patch, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		out, err := env.Store.Patch(patch)
		if err != nil {
			return nil, err
		}
		// 换了本地目录就要立刻放行它，否则新目录里的图片预览全是 403
		if dir, ok := out["localDir"].(string); ok && dir != "" {
			env.allowRoot(dir)
		}
		// 换了主题就把窗口底色一起换掉：左右下三边留的缩放带露的就是这块
		if env.OnBackground != nil {
			if ui, ok := out["ui"].(map[string]any); ok {
				theme, _ := ui["theme"].(string)
				env.OnBackground(themeBackground(theme))
			}
		}
		env.cache.Invalidate()
		return out, nil
	})

	r.Handle("config:reset", func(json.RawMessage) (any, error) {
		return env.Store.Reset()
	})

	/* ---------------------------------------------------------- 系统交互 */

	r.Handle("shell:openExternal", func(payload json.RawMessage) (any, error) {
		target, err := decodeString(payload)
		if err != nil {
			return nil, err
		}
		if !isSafeTarget(target) {
			return nil, BadPayload("这个地址不允许用系统程序打开：%s", target)
		}
		return true, openExternal(target)
	})

	r.Handle("shell:openLocalDir", func(json.RawMessage) (any, error) {
		dir, _ := env.Store.Get()["localDir"].(string)
		if dir == "" {
			return false, fmt.Errorf("还没有绑定本地目录")
		}
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return false, fmt.Errorf("本地目录不存在：%s", dir)
		}
		return true, openExternal(dir)
	})

	// 在资源管理器里定位某个文件：用 /select, 让它在所在目录里被选中
	r.Handle("shell:showItem", func(payload json.RawMessage) (any, error) {
		p, err := decodeString(payload)
		if err != nil {
			return nil, err
		}
		if p == "" {
			return false, BadPayload("路径是空的")
		}
		if runtime.GOOS == "windows" {
			return true, exec.Command("explorer", "/select,"+filepath.FromSlash(p)).Start()
		}
		return true, openExternal(filepath.Dir(p))
	})

	/* ---------------------------------------------------------- 窗口 */

	// 这些操作只碰 HWND（ShowWindow / PostMessage / IsZoomed 跨线程安全），
	// 从 HTTP 协程里调没问题；WebView2 的接口指针则只留在 UI 线程里（见 wvhost）。
	r.Handle("win:minimize", func(json.RawMessage) (any, error) {
		return wvhost.Minimize(), nil
	})
	// 「最大化 / 还原」二合一，返回切换后的状态（渲染层拿它切图标）
	r.Handle("win:maximize", func(json.RawMessage) (any, error) {
		return wvhost.ToggleMaximize(), nil
	})
	r.Handle("win:close", func(json.RawMessage) (any, error) {
		return wvhost.CloseWin(), nil
	})
	r.Handle("win:isMaximized", func(json.RawMessage) (any, error) {
		return wvhost.IsMaximized(), nil
	})
	// 标题栏拖动：渲染层的 -webkit-app-region 是 Electron 专属，WebView2 里
	// 由 bridge.js 在 mousedown 时调这条，宿主触发系统原生拖动
	// （新运行时走 IsNonClientRegionSupportEnabled 原生接管，这条是兜底）
	r.Handle("win:drag", func(json.RawMessage) (any, error) {
		wvhost.BeginDrag()
		return true, nil
	})
	// 边缘缩放：bridge.js 在窗口边缘的隐形缩放条上 mousedown 时调这条，
	// payload 是方向字符串。宿主在 UI 线程轮询光标自己缩放（wvhost.ResizeEdge），
	// HTTP 协程只负责把方向投过去，不碰窗口。
	r.Handle("win:resizeEdge", func(p json.RawMessage) (any, error) {
		var dir string
		if err := json.Unmarshal(p, &dir); err != nil {
			return nil, fmt.Errorf("win:resizeEdge 需要 string 方向，收到：%s", string(p))
		}
		if !wvhost.ResizeEdge(dir) {
			return nil, fmt.Errorf("不是合法的缩放方向：%q（left/right/top/bottom + 四角）", dir)
		}
		return true, nil
	})
	r.Handle("ui:setBackground", func(json.RawMessage) (any, error) { return true, nil })

	/* ---------------------------------------------------------- Git */

	// Git 版本：引导流程（onboard.js 的「本地目录」那一步）和设置页都要先问一句
	// 「本机有没有 git」。返回 {version:"2.47.0"}，没装就是空串 —— 渲染层判的是
	// gv.version 有没有值，而不是这个通道有没有抛错。
	//
	// 这个通道以前没实现，界面上表现成一条 unhandled rejection：功能看着正常
	// （引导里那步本来就该显示「未检测到 Git」），但控制台是脏的，排查真问题时
	// 会被它带偏 —— 所以宁可实现掉，不留「故意不实现」的通道。
	r.Handle("git:version", func(json.RawMessage) (any, error) {
		return map[string]any{"version": git.Version(context.Background())}, nil
	})

	// 仓库状态。字段逐个对齐 main.js 的 git:status：
	//   configured / isRepo / dir / dirty / changes / branch / head / remote
	// 远端地址里的 Token 由 internal/git 剥掉，别在界面上明文露出来。
	r.Handle("git:status", func(json.RawMessage) (any, error) {
		cfg := env.Store.Raw()
		dir, _ := cfg["localDir"].(string)
		return git.StatusCached(context.Background(), env.repoKey(), dir), nil
	})

	/* ---------------------------------------------------------- 归档配置 */

	r.Handle("profile:new", func(payload json.RawMessage) (any, error) {
		patch, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		out, err := env.Store.NewProfile(patch)
		if err != nil {
			return nil, err
		}
		if dir, ok := out["localDir"].(string); ok && dir != "" {
			env.allowRoot(dir)
		}
		env.cache.Invalidate()
		return out, nil
	})

	r.Handle("profile:activate", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		out, err := env.Store.ActivateProfile(strOf(obj["id"]))
		if err != nil {
			return nil, err
		}
		if dir, ok := out["localDir"].(string); ok && dir != "" {
			env.allowRoot(dir)
		}
		env.cache.Invalidate()
		return out, nil
	})

	r.Handle("profile:update", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		patch, _ := obj["patch"].(map[string]any)
		out, err := env.Store.UpdateProfile(strOf(obj["id"]), patch)
		if err != nil {
			return nil, err
		}
		if dir, ok := out["localDir"].(string); ok && dir != "" {
			env.allowRoot(dir)
		}
		env.cache.Invalidate()
		return out, nil
	})

	r.Handle("profile:delete", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		out, err := env.Store.DeleteProfile(strOf(obj["id"]))
		if err != nil {
			return nil, err
		}
		if dir, ok := out["localDir"].(string); ok && dir != "" {
			env.allowRoot(dir)
		}
		env.cache.Invalidate()
		return out, nil
	})

	r.Handle("profile:verify", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		info, _ := obj["info"].(map[string]any)
		return env.Store.VerifyProfile(strOf(obj["id"]), info)
	})

	r.Handle("profile:check", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.profileCheck(obj)
	})

	r.Handle("profile:export", func(json.RawMessage) (any, error) {
		return env.profileExport()
	})

	r.Handle("profile:import", func(json.RawMessage) (any, error) {
		return env.profileImport()
	})

	/* ---------------------------------------------------------- 对话框 */

	// 选文件夹。取消返回 null（渲染层判的是 null，不是报错）。
	r.Handle("dialog:chooseDir", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		dir, err := dialog.ChooseDir(strOf(obj["title"]), strOf(obj["defaultPath"]))
		if err != nil {
			return nil, err
		}
		if dir == "" {
			return nil, nil
		}
		return dir, nil
	})

	/* ---------------------------------------------------------- 自定义背景图 */

	// 背景图不存用户选的原始路径，而是**拷一份进配置目录 bg/ 里再记这个副本**：
	// 原图在 U 盘 / 下载目录里，哪天删了换台机器，背景就悄悄失效还查不出原因。
	// 副本目录单独放（不和 config.json 混在一起），/__local 的白名单只放行
	// bg/ 这一个目录 —— 不为一张图把整个配置目录（里面有加密 Token）暴露出去。
	chooseBg := func() (any, error) {
		picked, err := dialog.OpenFile("选择背景图片（仅浅色模式生效）", []dialog.Filter{
			{Name: "图片文件", Exts: []string{"jpg", "jpeg", "png", "webp", "bmp", "gif"}},
			{Name: "所有文件", Exts: []string{"*"}},
		})
		if err != nil {
			return nil, err
		}
		if picked == "" {
			return map[string]any{"canceled": true}, nil
		}
		ext := strings.ToLower(filepath.Ext(picked))
		if ext == "" {
			return nil, errors.New("选中的文件没有扩展名，认不出是什么格式")
		}
		if ext == ".jpeg" {
			ext = ".jpg"
		}
		bgDir := filepath.Join(env.ConfigDir, "bg")
		if err := os.MkdirAll(bgDir, 0o755); err != nil {
			return nil, err
		}
		// 换图时把旧副本清干净，bg/ 里永远只有当前这一张
		if entries, e2 := os.ReadDir(bgDir); e2 == nil {
			for _, it := range entries {
				if !it.IsDir() {
					_ = os.Remove(filepath.Join(bgDir, it.Name()))
				}
			}
		}
		// 文件名带时间戳：换图时如果还是 custom.jpg 这个老名字，
		// 页面里那张 <url> 被浏览器缓存住，看着就是「设了没反应」
		dst := filepath.Join(bgDir, fmt.Sprintf("custom-%d%s", time.Now().UnixNano(), ext))
		if err := copyFile(picked, dst); err != nil {
			return nil, fmt.Errorf("背景图复制失败：%w", err)
		}
		env.allowRoot(bgDir)
		out, err := env.Store.Patch(map[string]any{"ui": map[string]any{"bgImage": dst}})
		if err != nil {
			return nil, err
		}
		return out, nil
	}
	r.Handle("ui:chooseBgImage", func(json.RawMessage) (any, error) { return chooseBg() })

	r.Handle("ui:clearBgImage", func(json.RawMessage) (any, error) {
		bgDir := filepath.Join(env.ConfigDir, "bg")
		if entries, e2 := os.ReadDir(bgDir); e2 == nil {
			for _, it := range entries {
				if !it.IsDir() {
					_ = os.Remove(filepath.Join(bgDir, it.Name()))
				}
			}
		}
		return env.Store.Patch(map[string]any{"ui": map[string]any{"bgImage": ""}})
	})

	/* ---------------------------------------------------------- 云端 */

	r.Handle("cloud:verify", func(json.RawMessage) (any, error) { return env.cloudVerify() })

	r.Handle("cloud:list", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudList(obj)
	})

	r.Handle("cloud:tree", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudTree(obj)
	})

	r.Handle("cloud:stats", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudStats(obj)
	})

	r.Handle("cloud:upload", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudUpload(obj)
	})

	r.Handle("cloud:delete", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudDelete(obj)
	})

	r.Handle("cloud:move", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudMove(obj)
	})

	r.Handle("cloud:replace", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudReplace(obj)
	})

	r.Handle("cloud:readText", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.cloudReadText(obj)
	})

	// 检测结论带 1.5 秒缓存：它要跑一次 git fetch（走网络），
	// 来回点几份配置时每点一次都重算没意义
	r.Handle("cloud:detect", func(json.RawMessage) (any, error) {
		return env.cache.Cached("detect|"+env.repoKey(), detectTTL, func() (any, error) {
			return env.detectCloud()
		})
	})

	r.Handle("cloud:pushLocal", func(json.RawMessage) (any, error) { return env.cloudPushLocal() })

	/* ---------------------------------------------------------- Git */

	r.Handle("git:clone", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.gitClone(obj)
	})

	r.Handle("git:pull", func(json.RawMessage) (any, error) { return env.gitPull() })

	r.Handle("git:commit", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.gitCommit(obj)
	})

	/* ---------------------------------------------------------- 本地文件 */

	r.Handle("fs:exportText", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.fsExportText(obj)
	})

	r.Handle("fs:localRename", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.fsLocalRename(obj)
	})

	r.Handle("fs:localWrite", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.fsLocalWrite(obj)
	})

	r.Handle("fs:localDelete", func(payload json.RawMessage) (any, error) {
		obj, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.fsLocalDelete(obj)
	})
}

/* ------------------------------------------------------------ 参数解码 */

// decodeObject 要一个 JSON 对象。渲染层偶尔会传 null（比如 config.set() 不带参数），
// 那种情况给一个空对象，让后续的合并变成「什么都没改」而不是报错。
func decodeObject(payload json.RawMessage) (map[string]any, error) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" || trimmed == "null" {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, BadPayload("期望一个对象，实际是：%s", trimmed)
	}
	return out, nil
}

func decodeString(payload json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" || trimmed == "null" {
		return "", nil
	}
	var out string
	if err := json.Unmarshal(payload, &out); err != nil {
		return "", BadPayload("期望一个字符串，实际是：%s", trimmed)
	}
	return out, nil
}

// isSafeTarget：只允许 http/https/file 和普通本地路径，别让渲染层递进来一个
// 能被 cmd 解释成命令的字符串（start 对某些字符是有特殊行为的）。
func isSafeTarget(s string) bool {
	if s == "" {
		return false
	}
	for _, bad := range []string{"\r", "\n", "&", "|", ">", "<", "^"} {
		if strings.Contains(s, bad) {
			return false
		}
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return true
	}
	// 本地路径：必须存在，避免拿它当任意命令的启动器
	if strings.Contains(s, "://") {
		return false
	}
	_, err := os.Stat(s)
	return err == nil
}

func openExternal(target string) error {
	if runtime.GOOS == "windows" {
		// 空标题参数是为了让 start 把带引号的目标当成目标，而不是窗口标题
		return exec.Command("cmd", "/c", "start", "", target).Start()
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", target).Start()
	}
	return exec.Command("xdg-open", target).Start()
}
