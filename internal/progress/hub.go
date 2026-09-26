// Package progress 是上传进度的广播中心。
//
// 为什么需要它：上传链路（尤其是 CNB 的 git push）是一个几十秒起步的
// 阻塞调用。前端拿到响应之前完全是黑盒 —— 用户看到的就是「点了没反应」，
// 然后突然弹一个成功。这个包把中间过程从后端推到前端。
//
// 传输用 SSE（Server-Sent Events），不用轮询也不用 WebSocket：
//
//   - SSE 是单向的（服务端 → 客户端），正好匹配「进度」这种只能由后端
//     知道、前端只能听的信息，不需要双向握手；
//   - Go 标准库的 http.ResponseController.Flush() 就能推，零第三方依赖
//     （本项目从头到尾不引外部包，见 README 的取舍说明）；
//   - 浏览器的 EventSource 原生支持，带自动重连，前端不用写重连逻辑。
//
// 事件是**易失**的：没有订阅者时直接丢弃，不做历史回放。理由很直接 ——
// 进度是「此刻正在发生什么」，迟到的进度没有意义，反而会让进度条
// 突然回跳。前端连上后从下一个事件开始跟，界面初始态是「准备中」。
package progress

import (
	"sync"
	"time"
)

// 阶段常量。前端按这些字符串决定文案与图标，改这里要同步改
// src/renderer/js/lib/progress.js 里的映射表。
const (
	PhasePrepare = "prepare" // 准备（克隆 / 检查 LFS）
	PhaseLFS     = "lfs"     // 正在安装 git-lfs
	PhaseUpload  = "upload"  // 传输中
	PhaseCommit  = "commit"  // 提交
	PhaseDone    = "done"    // 完成
	PhaseError   = "error"   // 失败
)

// Event 是一条进度事件。字段全部小写开头，直接就是 SSE 的 JSON 形状。
type Event struct {
	// Task 是任务类型（upload / lfs-install），前端用来过滤
	// 「我只关心上传，不关心装 LFS」这类需求。
	Task string `json:"task"`
	// Phase 见上面的常量。
	Phase string `json:"phase"`
	// Percent 是 0-100；**-1 表示无法估算**（比如 git 还在枚举对象）。
	// 前端看到负数就画不确定态（条纹流动），而不是硬凑一个 0%。
	Percent float64 `json:"percent"`
	// Bytes / Total 是已传与总字节。Total 为 0 表示未知。
	Bytes int64 `json:"bytes"`
	Total int64 `json:"total"`
	// Speed 是瞬时速度（字节/秒），由 Reporter 按两次采样的差值算。
	Speed int64 `json:"speed"`
	// Message 是给用户看的一句话（如「正在安装 git-lfs…」）。
	Message string `json:"message,omitempty"`
	// Error 只在 Phase == PhaseError 时给。
	Error string `json:"error,omitempty"`
	// Seq 是单调递增序号。SSE 断线重连后前端用它判断有没有丢事件 ——
	// 丢了几条就说明进度可能跳变，可以据此做一次「补齐」请求。
	Seq int64 `json:"seq"`
}

// Hub 保存所有订阅者，并负责广播。
type Hub struct {
	mu   sync.RWMutex
	subs map[chan Event]struct{}
	seq  int64
}

func NewHub() *Hub {
	return &Hub{subs: map[chan Event]struct{}{}}
}

// Subscribe 注册一个订阅者，返回接收通道与注销函数。
//
// 通道带 32 容量缓冲：突发几条不会被丢，慢消费者也不会卡住上传线程。
// **调用方必须 defer cancel()** —— 不注销会一直占着一个通道，
// 每次刷新页面就漏一个。
func (h *Hub) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, ch)
			close(ch)
			h.mu.Unlock()
		})
	}
	return ch, cancel
}

// Count 返回当前订阅者数量（自检和调试用）。
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}

// Publish 广播一条事件。
//
// 两个设计要点，改之前先读：
//
//  1. **在持锁状态下发送**。这样 cancel 的 close(ch) 与发送天然互斥 ——
//     如果先复制一份订阅者切片、出锁再发，就会出现在「已 close 的通道上
//     发送」的竞态（Go 里直接 panic）。持锁发送之所以安全，是因为
//     下面一律用带 default 的 select：满了就丢，绝不会阻塞在锁里。
//  2. **订阅者跟不上就丢掉这一条**。发布方是上传主流程，为了送出一条
//     可有可无的进度而卡住真正的上传是本末倒置。丢一条无所谓，
//     前端下一次采样就追上了。
func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	e.Seq = h.seq
	for ch := range h.subs {
		select {
		case ch <- e:
		default:
		}
	}
}

/* ------------------------------------------------------------ 上报器 */

// Reporter 是一个任务的进度上报器。
//
// 它做两件上传链路不该操心的事：
//  1. **节流**：git push 的进度输出是逐字节刷新的，原文转发会把
//     SSE 灌爆（几百条/秒），浏览器光处理事件就卡了。这里合并到
//     最多 10 条/秒 —— 人眼在这个频率下已经看不出差别。
//  2. **算速度**：按相邻两次上报的字节差 / 时间差算瞬时速度。
//     调用方只管报「现在传了多少」，速度由这里统一算。
//
// Reporter 不是并发安全的（一个任务一个），上传链路本身就是串行的。
type Reporter struct {
	hub  *Hub
	task string

	start    time.Time
	lastAt   time.Time
	lastByte int64

	// minGap 是两次广播的最小间隔。100ms = 10Hz。
	// 调大延迟感明显，调小没意义（人眼分辨不出）。
	minGap time.Duration
}

// Task 创建某个任务的上报器。task 会出现在每条事件的 Task 字段里。
//
// 支持 nil receiver：Env.Progress 没接上（--check / 自检等无界面场景）时
// 返回 nil，调用方照常写 `rep.Report(...)` 也不会崩 —— 见下面各方法的
// nil 判断。这样上传链路里一行判空都不用写。
func (h *Hub) Task(task string) *Reporter {
	if h == nil {
		return nil
	}
	return &Reporter{
		hub:    h,
		task:   task,
		start:  time.Now(),
		lastAt: time.Now(),
		minGap: 100 * time.Millisecond,
	}
}

// Elapsed 返回任务开始到现在的时间（调用方可用来算平均速度）。
func (r *Reporter) Elapsed() time.Duration {
	if r == nil {
		return 0
	}
	return time.Since(r.start)
}

// Emit 上报一次进度。
//
// bytes / total 是累计值与总量；total <= 0 表示总量未知（Percent 会置 -1）。
// force 为 true 时跳过节流 —— 阶段切换、完成、失败必须立刻可见，
// 被节流吞掉会出现「进度条停在 87% 然后直接消失」这种观感。
func (r *Reporter) Emit(phase string, bytes, total int64, msg string, force bool) {
	if r == nil {
		return
	}
	now := time.Now()
	if !force && now.Sub(r.lastAt) < r.minGap {
		return
	}

	// 瞬时速度：用本次与上次的差值。第一次上报（lastAt 就是 start）
	// 时差值就是总量，速度算出来是平均值，可以接受。
	var speed int64
	if dt := now.Sub(r.lastAt).Seconds(); dt > 0.05 {
		if delta := bytes - r.lastByte; delta > 0 {
			speed = int64(float64(delta) / dt)
		}
	}
	r.lastAt = now
	r.lastByte = bytes

	pct := -1.0
	if total > 0 {
		pct = float64(bytes) / float64(total) * 100
		if pct > 100 {
			pct = 100
		}
	}

	r.hub.Publish(Event{
		Task:    r.task,
		Phase:   phase,
		Percent: pct,
		Bytes:   bytes,
		Total:   total,
		Speed:   speed,
		Message: msg,
	})
}

// Report 是 Emit 的日常用法。
//
// 强制还是节流由它自己判断，调用方不用关心：
//   - 带文案（msg 非空）的通常是**阶段切换**，必须立刻可见；
//   - LFS 安装是一条条状态，也要立刻可见；
//   - 纯数字的字节进度走节流（git push 每秒能刷上百行）。
func (r *Reporter) Report(phase string, bytes, total int64, msg string) {
	if r == nil {
		return
	}
	force := msg != "" || phase == PhaseLFS || phase == PhaseDone || phase == PhaseError
	r.Emit(phase, bytes, total, msg, force)
}

// Info 上报一条「没有数值、只有一句话」的状态（如「正在安装 git-lfs…」）。
func (r *Reporter) Info(phase, msg string) {
	if r == nil {
		return
	}
	r.Report(phase, 0, 0, msg)
}

// Fail 上报失败。这是终态，必须立刻可见。
func (r *Reporter) Fail(err error) {
	if r == nil {
		return
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	r.hub.Publish(Event{
		Task:    r.task,
		Phase:   PhaseError,
		Percent: 0,
		Message: msg,
		Error:   msg,
	})
}

// Done 上报成功终态。
func (r *Reporter) Done(msg string) {
	if r == nil {
		return
	}
	r.hub.Publish(Event{
		Task:    r.task,
		Phase:   PhaseDone,
		Percent: 100,
		Bytes:   r.lastByte,
		Total:   r.lastByte,
		Message: msg,
	})
}
