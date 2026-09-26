package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRunStreamRealPush 用一个真实的本地裸仓库跑一次 push，
// 验证「流式读取 + 进度解析」这条链路端到端是通的。
//
// 为什么要有这个测试：上面那些解析测试喂的是**我手写的字符串**，
// 只能证明「按我以为的格式解析是对的」。git 的进度输出格式会随
// 版本和平台变（本地传输还根本不输出进度），所以必须拿真家伙跑一次。
//
// 用 file:// 而不是裸路径：git 对「本地路径」会走硬链接优化，
// 跳过打包环节、也就没有任何进度输出 —— 那样测了个寂寞。
// 加上 file:// 强制走正常传输协议。
func TestRunStreamRealPush(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没装 git，跳过这个测试")
	}

	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	work := filepath.Join(root, "work")

	// 1) 建一个空的裸仓库当远端
	if out, err := exec.Command("git", "init", "--bare", "-q", remote).CombinedOutput(); err != nil {
		t.Fatalf("建裸仓库失败：%v\n%s", err, out)
	}

	// 2) clone 下来（clone 空仓库会警告，属正常）
	if out, err := exec.Command("git", "clone", "-q", remote, work).CombinedOutput(); err != nil {
		t.Fatalf("clone 失败：%v\n%s", err, out)
	}
	// 空仓库 clone 后没有分支，先建一个提交把 main 立起来
	mustGit(t, work, "config", "user.email", "test@example.com")
	mustGit(t, work, "config", "user.name", "test")
	mustGit(t, work, "checkout", "-q", "-b", "main")

	// 3) 造一个够大的文件。太小的话 git 打包瞬间完成，
	// 根本来不及输出多行进度（我们要的就是那些进度行）。
	blob := filepath.Join(work, "big.bin")
	if err := os.WriteFile(blob, make([]byte, 24<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, work, "add", "-A")
	mustGit(t, work, "commit", "-q", "-m", "add big file")

	// 4) 流式 push，收集**折叠后**的进度。
	//
	// 这里把三个真实函数串起来（RunStream + ParsePushLine + FoldPushProgress），
	// 和 CommitAndPushStream 里的串联一致 —— 没法直接调 CommitAndPushStream
	// 是因为它的远端地址是从 platform/owner/repo 拼出来的，指不到本地裸仓库。
	type ev struct {
		phase        string
		bytes, total int64
		msg          string
	}
	var events []ev
	res := RunStream(context.Background(),
		[]string{"push", "--progress", "file://" + filepath.ToSlash(remote), "HEAD:main"},
		work, 2*time.Minute,
		func(line string) {
			pp, ok := ParsePushLine(line)
			if !ok {
				return
			}
			phase, b, t, msg := FoldPushProgress(pp)
			events = append(events, ev{phase, b, t, msg})
		})
	if !res.Ok {
		t.Fatalf("push 失败：%s\n%s", res.Stderr, res.Stdout)
	}

	if len(events) == 0 {
		t.Fatal("一条进度事件都没解析出来 —— 要么 RunStream 没读到 stderr，" +
			"要么 ParsePushLine 的格式对不上真实输出")
	}

	// 5) 分组统计
	var prepares, uploads []ev
	for _, e := range events {
		switch e.phase {
		case "prepare":
			prepares = append(prepares, e)
		case "upload":
			uploads = append(uploads, e)
		}
	}
	t.Logf("共 %d 条事件：准备 %d 条、上传 %d 条", len(events), len(prepares), len(uploads))

	if len(uploads) == 0 {
		t.Errorf("没有上传阶段的事件（真实输出里应该有 Writing objects 行）")
	}

	// 6) 关键断言：**只有上传阶段带数字**。
	//
	// 这是那个「进度条来回跳」问题的防线 —— git 的 Counting / Compressing /
	// Writing 三个阶段各自从 0% 走到 100%，只要有一个准备阶段带着数字漏出去，
	// 界面上就会出现 33% → 100% → 33% 的回跳。
	for _, e := range prepares {
		if e.total != 0 {
			t.Errorf("准备阶段不该带总量（会让进度条回跳）：phase=%s bytes=%d total=%d msg=%q",
				e.phase, e.bytes, e.total, e.msg)
		}
	}
	for _, e := range uploads {
		if e.total <= 0 {
			t.Errorf("上传阶段应该带总量：bytes=%d total=%d", e.bytes, e.total)
		}
	}

	// 7) 上传阶段内部必须单调递增
	for i := 1; i < len(uploads); i++ {
		var prevPct, curPct float64
		if uploads[i-1].total > 0 {
			prevPct = float64(uploads[i-1].bytes) / float64(uploads[i-1].total) * 100
		}
		if uploads[i].total > 0 {
			curPct = float64(uploads[i].bytes) / float64(uploads[i].total) * 100
		}
		if curPct < prevPct {
			t.Errorf("上传阶段进度回退：第 %d 条 %.0f%% < 第 %d 条 %.0f%%",
				i, curPct, i-1, prevPct)
		}
	}

	// 8) 必须看到跑到 100%
	last := uploads[len(uploads)-1]
	if last.total > 0 && last.bytes < last.total {
		t.Errorf("最后一条上传进度没有到 100%%：%d/%d", last.bytes, last.total)
	}
}

func mustGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s 失败：%v\n%s", strings.Join(args, " "), err, out)
	}
}
