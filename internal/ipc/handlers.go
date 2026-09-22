package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/store"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/winfont"
)

// Env 是处理函数需要的依赖。用结构体传进去而不是包级全局，
// 这样以后要开两个实例（比如自检里同时跑真实配置和临时配置）也不用改代码。
type Env struct {
	Store     *store.Store
	Version   string
	ConfigDir string
	Verbose   bool
}

// Register 把这一版实现的通道挂上去。
//
// 通道名逐字对照 src/main/preload.js 与 main.js 里的 ipcMain.handle，
// 别自己改名 —— 渲染层是按名字调的，改一个字母就是「点了没反应」。
func Register(r *Registry, env *Env) {
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
			"shell":    "edge-app（过渡，正式版换 WebView2）",
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

	/* ---------------------------------------------------------- 配置 */

	r.Handle("config:get", func(json.RawMessage) (any, error) {
		return env.Store.Get(), nil
	})

	r.Handle("config:set", func(payload json.RawMessage) (any, error) {
		patch, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		return env.Store.Patch(patch)
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

	// 过渡期（Edge --app 模式）拿不到窗口句柄，这几个只能是「不报错」。
	// 换成 WebView2 之后要接真的：最小化 / 最大化 / 关闭、以及最大化状态变化
	// 要推给渲染层（渲染层订阅的是 win:maximized 事件，现在的 HTTP 传输还推不了事件）。
	r.Handle("win:minimize", func(json.RawMessage) (any, error) { return true, nil })
	r.Handle("win:maximize", func(json.RawMessage) (any, error) { return false, nil })
	r.Handle("win:close", func(json.RawMessage) (any, error) { return true, nil })
	r.Handle("win:isMaximized", func(json.RawMessage) (any, error) { return false, nil })
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
		cfg := env.Store.Get()
		dir, _ := cfg["localDir"].(string)
		return git.StatusCached(context.Background(), repoKey(cfg), dir), nil
	})
}

// repoKey 是仓库的身份串：换仓库 / 换分支 / 换本地目录都会变，
// 拿它当缓存键，配置一改缓存自然失效（对齐 main.js 的 repoKey()）。
func repoKey(cfg map[string]any) string {
	get := func(k, def string) string {
		if v, ok := cfg[k].(string); ok && v != "" {
			return v
		}
		return def
	}
	return strings.Join([]string{
		get("platform", "github"), get("owner", ""), get("repo", ""),
		get("branch", "main"), get("localDir", ""),
	}, "|")
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
