// Package ipc 是渲染层与 Go 侧之间的通道表。
//
// 它对应 Electron 版的 ipcMain.handle / ipcRenderer.invoke：
// 渲染层调 cloudpic.cloud.list(payload) → 这里按 "cloud:list" 找处理函数 → 回一个值。
// 通道名**故意和 Electron 版逐字相同**（见 src/main/preload.js），
// 这样渲染层不用改一个字，Go 侧也能一条一条对着搬。
//
// 传输换成 HTTP 只是因为 WebView2 里没有 ipcRenderer；语义（请求 / 应答、
// 抛错即 reject、payload 是 JSON）完全一致。
package ipc

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

// Handler 处理一次调用。payload 是原样的 JSON（可能是 null）；
// 返回的 any 会被序列化成 JSON 回给渲染层；返回 error 表示这次调用失败，
// 对应 Electron 里的 reject —— 渲染层那边会走 catch。
type Handler func(payload json.RawMessage) (any, error)

// Registry 是通道表。渲染层可能并发打多个接口，所以读写都要加锁。
type Registry struct {
	mu sync.RWMutex
	m  map[string]Handler
}

func New() *Registry {
	return &Registry{m: make(map[string]Handler)}
}

func (r *Registry) Handle(channel string, fn Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.m[channel]; dup {
		// 重名是编程错误，早炸早好：静默覆盖会让「我明明注册了」和
		// 「为什么走的是另一个实现」这两件事查半天
		panic("通道重复注册：" + channel)
	}
	r.m[channel] = fn
}

// Dispatch 按通道名调用。
//
// 未注册的通道分两种，报错要分开（见 channels.go 的说明）：
//   - 在接口面清单里 → 「还没实现」，属于进度问题；
//   - 不在清单里     → 「名字写错了」，属于笔误。
//
// 两种情况都**不静默兜底**：返回零值会让渲染层以为「成功了但没数据」，
// 界面表现成一个查不出原因的空白，远不如一条明确的错误有用。
func (r *Registry) Dispatch(channel string, payload json.RawMessage) (any, error) {
	r.mu.RLock()
	fn, ok := r.m[channel]
	r.mu.RUnlock()
	if !ok {
		if IsKnown(channel) {
			return nil, &NotImplementedError{Channel: channel}
		}
		return nil, &UnknownChannelError{Channel: channel}
	}
	return fn(payload)
}

// Channels 已移除：查「有哪些通道」请用 channels.go 的 Known()（完整接口面）
// 和 Registry.Remaining()（还没实现的）。注册表本身只回答「这条能不能用」。

func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.m)
}

// NotImplementedError 表示这条通道在这一版里还没写。
// 单独做成一个类型，自检可以据此断言「未实现是明确的，不是碰巧失败」。
type NotImplementedError struct {
	Channel string
}

func (e *NotImplementedError) Error() string {
	return "未实现（Go demo 阶段）：" + e.Channel
}

// IsNotImplemented 判断一个错误是不是「还没实现」。
func IsNotImplemented(err error) bool {
	var target *NotImplementedError
	return errors.As(err, &target)
}

// BadPayload 是参数不对时的统一错误（缺字段、类型不符等）。
func BadPayload(format string, args ...any) error {
	return fmt.Errorf("参数不对："+format, args...)
}
