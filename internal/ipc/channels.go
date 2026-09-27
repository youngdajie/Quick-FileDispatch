package ipc

import "sort"

// known 是渲染层会调用的**全部**通道名。清单最初逐条抄自 Electron 版的
// src/main/preload.js（那份代码定格在 v2.8.0，git 历史里还能查到）。
//
// 为什么要维护这份清单，而不是「没注册就当未实现」：
//
//	通道名打错一个字母时，如果和「还没实现」报同一句话，你就会去查「这条怎么还没写」，
//	而真正的问题是名字拼错了 —— 这类错最容易浪费时间。
//	分开之后：在清单里 = 还没写；不在清单里 = 名字写错了。
//
// 它同时是进度表：启动时打印「已实现 44/44」，一眼看得见还剩多少。
// 渲染层加新通道时必须同步改这里（漏改的话，新通道会被误报成「名字写错了」，
// 反而比误报成「未实现」更容易发现 —— 这是故意的取舍）。
var known = []string{
	// 应用
	"app:info",
	"app:fonts",
	"app:lfsStatus",
	"app:lfsInstall",
	"ui:setBackground",

	// 配置
	"config:get",
	"config:set",
	"config:reset",

	// 归档配置（远端仓库 + 本地目录 + 链接规则打包成一份）
	"profile:new",
	"profile:activate",
	"profile:update",
	"profile:delete",
	"profile:verify",
	"profile:check",
	"profile:export",
	"profile:import",

	"dialog:chooseDir",

	// 自定义背景图（仅浅色模式生效；选图 / 清除）
	"ui:chooseBgImage",
	"ui:clearBgImage",

	// 云端仓库读写
	"cloud:verify",
	"cloud:list",
	"cloud:tree",
	"cloud:stats",
	"cloud:upload",
	"cloud:delete",
	"cloud:move",
	"cloud:replace",
	"cloud:detect",
	"cloud:readText",
	"cloud:pushLocal",

	// Git
	"git:version",
	"git:status",
	"git:clone",
	"git:pull",
	"git:commit",

	// 剪贴板：由 web/bridge.js 直接在前端做，不经过后端（见该文件说明）
	"clipboard:write",

	// 系统交互
	"shell:openExternal",
	"shell:showItem",
	"shell:openLocalDir",

	// 本地文件
	"fs:exportText",
	"fs:localRename",
	"fs:localWrite",
	"fs:localDelete",
	"fs:localMkdir",

	// 窗口
	"win:minimize",
	"win:maximize",
	"win:close",
	"win:isMaximized",
	// Go 壳专属：Electron 靠 CSS 的 -webkit-app-region 拖无边框窗口，
	// WebView2 没有这东西，bridge.js 在标题栏 mousedown 时改调这条
	"win:drag",
	// Go 壳专属：边缘缩放。页面铺满后宿主收不到边缘的命中测试
	//（WebView2 子窗口全吃掉），bridge.js 在边缘隐形缩放条 mousedown 时
	// 调这条，宿主在 UI 线程轮询光标自己缩放（internal/wvhost/resize_windows.go）
	"win:resizeEdge",
}

// clientSide 是「不用后端也能算实现」的通道：剪贴板走浏览器的
// navigator.clipboard，不占后端通道名额，否则进度永远差一条看着别扭。
var clientSide = map[string]bool{
	"clipboard:write": true,
}

var knownSet = func() map[string]bool {
	m := make(map[string]bool, len(known))
	for _, c := range known {
		m[c] = true
	}
	return m
}()

// Known 返回全部已知通道名（排序后的副本）。
func Known() []string {
	out := make([]string, len(known))
	copy(out, known)
	sort.Strings(out)
	return out
}

// IsKnown 判断一个通道名是否在渲染层的接口面里。
func IsKnown(channel string) bool {
	return knownSet[channel]
}

// UnknownChannelError 表示这个名字根本不在接口面里 —— 基本就是拼错了。
// 和「还没实现」分开报，查起来省一半时间。
type UnknownChannelError struct {
	Channel string
}

func (e *UnknownChannelError) Error() string {
	return "未知通道：" + e.Channel + "（不在渲染层的接口面里，八成是名字写错了；清单见 internal/ipc/channels.go）"
}

// Progress 回报「已实现 / 总共」。
// 分母算上了前端自办的通道，免得进度永远差一条到不了头。
// 用 seen 去重：万一以后某个通道两边都算上了，也不会重复计数。
func (r *Registry) Progress() (done, total int) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	total = len(known)
	seen := make(map[string]bool, len(r.m)+len(clientSide))
	for c := range r.m {
		if knownSet[c] && !seen[c] {
			seen[c] = true
			done++
		}
	}
	for c := range clientSide {
		if knownSet[c] && !seen[c] {
			seen[c] = true
			done++
		}
	}
	return done, total
}

// Remaining 返回还没实现的通道名，按分组前缀排好，当待办清单用。
func (r *Registry) Remaining() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []string
	for _, c := range known {
		if _, ok := r.m[c]; ok {
			continue
		}
		if clientSide[c] {
			continue
		}
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}
