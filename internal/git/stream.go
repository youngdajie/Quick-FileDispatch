package git

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/progress"
)

/* ------------------------------------------------------------ 流式执行 */

// StreamResult 是流式执行的结果，字段与 result 对齐。
type StreamResult struct {
	Ok     bool
	Stdout string
	Stderr string
	Err    error
}

// RunStream 流式执行一条 git 命令。
//
// 与 run() 的唯一区别是 onLine 回调：run() 要等进程结束才能拿到全部输出，
// 而进度必须**边跑边报**。所以这里把 stderr/stdout 用管道接出来，
// 每读到一行就回调一次。
//
// 三个必须注意的点：
//
//   - **onLine 在 goroutine 上同步执行**，必须快速返回。在里面做慢操作
//     （写磁盘、发网络）会拖慢管道消费，git 的写端被堵住，push 反而变慢。
//     本项目里它只做一件事：解析字符串 + 往广播中心投一条事件（非阻塞）。
//   - **两个管道都要读**。哪怕 stdout 我们不用，也不能不读 —— 管道缓冲
//     满了 git 会卡死在写操作上（经典死锁）。
//   - **超时用 CommandContext**，超时后 context 取消会杀掉进程。
func RunStream(ctx context.Context, args []string, dir string, timeout time.Duration, onLine func(string)) StreamResult {
	if _, err := exec.LookPath("git"); err != nil {
		return StreamResult{Err: errors.New("NOT_INSTALLED")}
	}
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(c, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = gitEnv()
	hideWindow(cmd)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return StreamResult{Err: err}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return StreamResult{Err: err}
	}

	var stdout, stderr strings.Builder
	var wg sync.WaitGroup
	wg.Add(2)
	// git 把「人看的」进度写在 stderr（Writing objects: 45%…），
	// 真正的机器输出在 stdout。进度只可能来自 stderr。
	go func() { defer wg.Done(); scanCRLF(stderrPipe, &stderr, onLine) }()
	go func() { defer wg.Done(); scanCRLF(stdoutPipe, &stdout, nil) }()

	if err := cmd.Start(); err != nil {
		return StreamResult{Err: err}
	}
	wg.Wait()
	werr := cmd.Wait()

	return StreamResult{
		Ok:     werr == nil,
		Stdout: strings.TrimSpace(stdout.String()),
		Stderr: strings.TrimSpace(stderr.String()),
		Err:    werr,
	}
}

// scanCRLF 读尽一个管道，按 \r 或 \n 切行，逐行写进 sink 并回调。
//
// 为什么不能用默认的 bufio.ScanLines：git 的进度行是用 **\r 原地刷新**的
// （不换行、覆盖当前行）。只认 \n 会把整整一段进度当成一行攒着，
// 直到最后一个 \n 才吐出来 —— 那时候进度早就跑完了，等于没有实时。
func scanCRLF(r io.Reader, sink *strings.Builder, onLine func(string)) {
	sc := bufio.NewScanner(r)
	// 默认上限 64KB 对单个进度行够用，但 git 在某些情况下会把
	// 很长的文件名列表打到一行，留 1MB 余量。
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sc.Split(splitCRLF)

	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		if sink != nil {
			sink.WriteString(line)
			sink.WriteByte('\n')
		}
		if onLine != nil {
			onLine(line)
		}
	}
}

// splitCRLF 按 \r 或 \n 切分，两者都当行分隔符。
func splitCRLF(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		// i+1 把分隔符也吃掉；\r\n 这种两字节分隔只吃 \r，
		// 下一轮开头的 \n 会产生一个空 token —— 上面已经 skip 空行。
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

/* ------------------------------------------------------------ 进度解析 */

// PushProgress 是从 git 输出里解析出来的一段进度。
type PushProgress struct {
	// Phase 是 progress 包的阶段常量（PhasePrepare / PhaseUpload）。
	Phase string
	// Percent 是 0-100。
	Percent float64
	// Bytes / Total 是已传与总字节。Total 由百分比反推，可能是估算值。
	Bytes int64
	Total int64
	// Speed 是 git 自报的速度（字节/秒）。git 不给时为 0。
	Speed int64
	// Done 表示这一段已经跑完（输出里带 ", done."）。
	Done bool
}

// toResult 把流式结果适配成 CleanError 认识的形状。
func (r StreamResult) toResult() result {
	return result{Ok: r.Ok, Stdout: r.Stdout, Stderr: r.Stderr, Err: r.Err}
}

// 进度行的形状（git 的英文输出，我们固定了 LANG=en_US.UTF-8）：
//
//	Writing objects:  45% (9/20), 1.20 MiB | 3.40 MiB/s
//	Writing objects: 100% (20/20), 5.60 MiB | 3.40 MiB/s, done.
//	Compressing objects:  66% (8/12)
//	Writing objects: 100% (3/3), 291 bytes | 291.00 KiB/s, done.
//
// 小包时 git 用 "bytes"（没有单位前缀），大包用 KiB/MiB/GiB。
var (
	// 抓「阶段 + 百分比 + 已完成/总数」
	pushHeadRe = regexp.MustCompile(`^(Writing|Compressing|Counting|Enumerating) objects:\s+(\d+)%\s+\((\d+)/(\d+)\)`)
	// 抓已传字节（可选的，Compressing 那行没有）
	pushBytesRe = regexp.MustCompile(`,\s+([\d.]+)\s+(bytes|B|KiB|MiB|GiB)`)
	// 抓速度
	pushSpeedRe = regexp.MustCompile(`\|\s+([\d.]+)\s+(bytes|B|KiB|MiB|GiB)/s`)
)

// ParsePushLine 解析 git push 的一行输出。
// ok=false 表示这行不含进度信息（正常输出、remote 提示等都会返回 false）。
func ParsePushLine(line string) (PushProgress, bool) {
	m := pushHeadRe.FindStringSubmatch(line)
	if m == nil {
		return PushProgress{}, false
	}

	pct, _ := strconv.ParseFloat(m[2], 64)
	done, _ := strconv.Atoi(m[3])
	totalObjs, _ := strconv.Atoi(m[4])

	p := PushProgress{
		Phase:   phaseForGitObject(m[1]),
		Percent: pct,
		Done:    strings.Contains(line, ", done."),
	}

	// 已传字节。没有这一项（Compressing 行）时用「对象个数」兜底 ——
	// 至少让前端能画出进度，不至于只有百分比没有具体量。
	if bm := pushBytesRe.FindStringSubmatch(line); bm != nil {
		p.Bytes = humanBytes(bm[1], bm[2])
		// 总字节由百分比反推。反推值在 0% 时不可用（除零），
		// 那时留 0 让前端显示「未知总量」。
		if pct > 0 {
			p.Total = int64(float64(p.Bytes) / (pct / 100))
		}
	} else if totalObjs > 0 {
		p.Bytes = int64(done)
		p.Total = int64(totalObjs)
	}

	if sm := pushSpeedRe.FindStringSubmatch(line); sm != nil {
		p.Speed = humanBytes(sm[1], sm[2])
	}
	return p, true
}

// FoldPushProgress 把 git 的一行进度折成「给用户看的一条进度」。
//
// **只让 Writing 阶段带数字**。原因是实测出来的：git 会依次跑
// Counting → Compressing → Writing，**每个阶段都从 0% 走到 100%**
// （三条各自独立的进度条）。原样全部上报的话，用户看到的是
// 33% → 100% → 50% → 100% → 33% → 100%，进度条来回跳，
// 比完全没有进度还难受。
//
// 而前两个阶段本质是「本地打包」——在用户视角里都算准备。
// 所以它们折叠成 total=0（前端据此画不确定态：条纹流动，不显示百分比）。
//
// 抽成独立函数是为了能被测试直接覆盖：这套折叠规则的正确性
// 不应该只能靠「跑一次真 push 看界面」来验证。
func FoldPushProgress(pp PushProgress) (phase string, bytes, total int64, msg string) {
	if pp.Phase == progress.PhaseUpload {
		return pp.Phase, pp.Bytes, pp.Total, ""
	}
	if pp.Done {
		return pp.Phase, 0, 0, "打包完成，准备推送"
	}
	return pp.Phase, 0, 0, "正在打包…"
}

// phaseForGitObject 把 git 的对象阶段映射成对用户友好的阶段名。
//
// Compressing 是「本地打包」——用户视角里这仍是准备阶段，还没开始传；
// Writing 才是真正在往远端发数据。区分开，进度条才不会在还没联网时
// 就跳到 100% 又跌回 0。
func phaseForGitObject(kind string) string {
	if kind == "Writing" {
		return progress.PhaseUpload
	}
	return progress.PhasePrepare
}

// humanBytes 把 git 的「数字 + 单位」换成人读的字节数。
func humanBytes(num, unit string) int64 {
	v, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	switch unit {
	case "bytes", "B":
		return int64(v)
	case "KiB", "KB":
		return int64(v * 1024)
	case "MiB", "MB":
		return int64(v * 1024 * 1024)
	case "GiB", "GB":
		return int64(v * 1024 * 1024 * 1024)
	}
	return int64(v)
}
