package lfs

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件测「大文件在走 LFS / 不走 LFS 两种模式下能否完成上传」。
//
// 用**本地裸仓库**当远端（file:// 强制走传输协议），所以不需要任何
// 平台凭据 —— 但测的是完整的 git 通道：克隆 → 写文件 → 提交 → 推送。
// CNB 的上传走的正是这条链路（见 internal/cnb）。
//
// 大文件测试默认跳过：跑一次要造几百 MB 数据，很慢。
// 需要时用 `go test ./internal/lfs/ -run LargeFile -v` 显式跑。

const mb = 1 << 20

// pseudoRandom 造一段**不可压缩**的数据。
//
// 为什么不能用全 0：git 对全 0 的 zlib 压缩率极高（200MB 能压到几百 KB），
// 那样测出来的「仓库体积」「push 耗时」全是假的，完全反映不了真实场景。
// 用 LCG 生成伪随机字节，压缩率接近 1（真实二进制文件就是这样）。
func pseudoRandom(n int) []byte { return pseudoRandomSeed(n, 0x9E3779B97F4A7C15) }

// pseudoRandomSeed 同上，但可以指定种子 —— 批量测试需要**每个文件内容不同**，
// 否则 LFS 会按内容哈希把它们去重成一份，「10 个文件占多少空间」就测不出来。
func pseudoRandomSeed(n int, seed uint64) []byte {
	b := make([]byte, n)
	for i := range b {
		seed = seed*6364136223846793005 + 1442695040888963407
		b[i] = byte(seed >> 33)
	}
	return b
}

// dirSize 递归统计目录占用（用来对比「文件进了 git 对象」还是「进了 LFS 缓存」）。
func dirSize(t *testing.T, root string) int64 {
	t.Helper()
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // 忽略个别读不到的文件
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		t.Fatalf("统计目录大小失败：%v", err)
	}
	return total
}

// runGit 跑一条 git 命令，返回输出与错误。
// 与 mustRun 的区别：不自动 fail —— push 这种要自己判断成败并给上下文的场合用它。
func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// setupRemote 建一个空裸仓库当远端，并克隆到工作区。
func setupRemote(t *testing.T) (bare, work string) {
	t.Helper()
	root := t.TempDir()
	bare = filepath.Join(root, "remote.git")
	work = filepath.Join(root, "work")

	mustRun(t, root, "init", "--bare", "-q", bare)
	mustRun(t, root, "clone", "-q", bare, work)
	mustRun(t, work, "config", "user.email", "t@example.com")
	mustRun(t, work, "config", "user.name", "t")
	mustRun(t, work, "checkout", "-q", "-b", "main")
	return bare, work
}

// pushFile 把一份内容推到远端，返回远端仓库的占用。
func pushFile(t *testing.T, bare, work, name string, data []byte, useLFS bool) int64 {
	t.Helper()

	if useLFS {
		if err := EnableInRepo(context.Background(), EnableParams{
			RepoDir: work,
			Paths:   []string{name},
		}); err != nil {
			t.Fatalf("启用 LFS 失败：%v", err)
		}
	}

	abs := filepath.Join(work, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		t.Fatal(err)
	}

	mustRun(t, work, "add", "-A")
	mustRun(t, work, "commit", "-q", "-m", "add "+name)

	// 用 file:// 而不是裸路径：git 对本地路径会走硬链接优化、跳过传输，
	// 那样测不到「真的把字节推过去」这件事。
	if out, err := runGit(work, "push", "-q", "file://"+filepath.ToSlash(bare), "HEAD:main"); err != nil {
		t.Fatalf("push %s 失败：%v\n%s", name, err, out)
	}
	return dirSize(t, bare)
}

// TestLargeFile200MBWithAndWithoutLFS 是用户问题的直接测试：
// 200MB 的文件，勾 LFS 和不勾 LFS，能不能传上去、传完什么样。
//
// 200MB 是 CNB 的单文件上限（GitHub 更低，只有 100MB）。
func TestLargeFile200MBWithAndWithoutLFS(t *testing.T) {
	hasGitLFS(t)
	if testing.Short() {
		t.Skip("大文件测试（200MB），-short 时跳过")
	}

	const size = 200 * mb
	t.Logf("生成 %d MB 不可压缩测试数据…", size/mb)
	data := pseudoRandom(size)

	t.Run("不走LFS", func(t *testing.T) {
		bare, work := setupRemote(t)
		remote := pushFile(t, bare, work, "big.bin", data, false)

		// 文件内容整个进了 git 对象库，所以远端占用应该 >= 文件本身
		t.Logf("远端仓库占用：%d MB（文件 %d MB）", remote/mb, size/mb)
		if remote < int64(size)/2 {
			t.Errorf("不走 LFS 时远端应该至少存下文件本身，实际只有 %d MB", remote/mb)
		}

		verifyStored(t, bare, "big.bin", size, false)
	})

	t.Run("走LFS", func(t *testing.T) {
		bare, work := setupRemote(t)
		remote := pushFile(t, bare, work, "big.bin", data, true)

		t.Logf("远端仓库占用：%d MB（文件 %d MB）", remote/mb, size/mb)

		// LFS 模式下，git 对象库里只有一个几百字节的指针，
		// 真正的 200MB 在 LFS 自己的存储区。所以远端 git 仓库**应该很小**。
		// 注意：本地 file:// 推送时，LFS 对象落在 bare 仓库的
		// lfs/objects 下，所以总占用仍然接近文件大小 —— 这里断言的是
		// 「git 对象库里没有原始内容」，用 git 侧的大小判断。
		gitOnly := dirSize(t, filepath.Join(bare, "objects"))
		t.Logf("远端 git 对象库占用：%.2f MB", float64(gitOnly)/float64(mb))
		if gitOnly > int64(size)/10 {
			t.Errorf("走 LFS 时 git 对象库不该装下原始内容（>%d MB）", size/10/mb)
		}

		// 指针必须存在且格式正确
		stored := gitOut(t, work, "show", "HEAD:big.bin")
		if len(stored) > 1024 {
			t.Errorf("仓库里存的应该是小指针，实际 %d 字节", len(stored))
		}

		verifyStored(t, bare, "big.bin", size, true)
	})
}

// verifyStored 验证远端**实际存了什么**。
//
// 为什么不用 clone 验证：LFS 在 file:// 协议下的对象拉取不完整 ——
// clone 会因为 smudge 拉不到对象而 checkout 失败。那是**测试环境的限制**
// （本地裸仓库不是一个完整的 LFS 服务端），不是产品的问题；真实平台
// （CNB / GitHub）有完整的 LFS 服务端。
//
// 所以这里直接读裸仓库内部，用两个权威判据：
//  1. git 对象的大小（cat-file -s）—— 指针还是原文件，一看便知；
//  2. LFS 对象库里有没有对应大小的文件。
func verifyStored(t *testing.T, bare, name string, fileSize int, useLFS bool) {
	t.Helper()

	raw := gitOut(t, bare, "cat-file", "-s", "main:"+name)
	sz := parseInt64(t, raw)

	if useLFS {
		// 走 LFS 时，仓库里存的应该是一个几百字节的**指针**
		if sz > 1024 {
			t.Errorf("走 LFS 时仓库里应该是指针（<1KB），实际 %d 字节", sz)
		}
		if sz == 0 {
			t.Errorf("读不到 %s 的大小（输出 %q）", name, raw)
		}
		t.Logf("仓库里存的是 %d 字节的指针 ✓", sz)

		// 而且 LFS 对象库要真的收下了原来的内容
		lfsSize := dirSize(t, filepath.Join(bare, "lfs", "objects"))
		t.Logf("远端 LFS 对象库占用：%.2f MB", float64(lfsSize)/float64(mb))
		if lfsSize < int64(fileSize)/2 {
			t.Errorf("LFS 对象库应该收下原始内容（%d MB），实际只有 %.2f MB",
				fileSize/mb, float64(lfsSize)/float64(mb))
		}
		return
	}

	// 不走 LFS：仓库对象就是原文件本身
	if sz != int64(fileSize) {
		t.Errorf("不走 LFS 时 git 对象大小应等于文件大小：%d != %d", sz, fileSize)
	}
	t.Logf("仓库里存的是完整的 %d MB 文件 ✓", sz/mb)
}

// parseInt64 从 git 输出里解析一个整数（宽容处理换行/空格）。
func parseInt64(t *testing.T, s string) int64 {
	t.Helper()
	s = strings.TrimSpace(s)
	// 非数字（比如报错信息）时返回 0，由调用方判断
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

// TestManyFilesBatch 验证「一批多个大文件」能不能完成。
//
// 用户问的是 10 × 200MB（= 2GB）。真的跑 2GB 要很久且占磁盘，
// 所以这里用 -short 之外才跑真实规模，默认跑一个按比例缩小的批次
// （10 × 20MB = 200MB），先把「批量」这条路径验证掉。
//
// 真实 2GB 的结论见 memory 里的分析：**会被 IPC 的 512MB 请求体上限挡住**，
// 这不是本测试能覆盖的（那属于 webui 层的限制）。
func TestManyFilesBatch(t *testing.T) {
	hasGitLFS(t)

	batch := 10
	each := 20 * mb
	if !testing.Short() {
		// 非 short 模式跑更接近真实的规模（仍不是 2GB，见上面说明）
		each = 100 * mb
	}
	t.Logf("批次：%d 个文件 × %d MB = %d MB", batch, each/mb, batch*each/mb)

	bare, work := setupRemote(t)

	names := make([]string, 0, batch)
	for i := 0; i < batch; i++ {
		names = append(names, fmt.Sprintf("batch/f%02d.bin", i))
	}

	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir: work,
		Paths:   names,
	}); err != nil {
		t.Fatalf("启用 LFS 失败：%v", err)
	}

	for i, name := range names {
		abs := filepath.Join(work, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		// 每个文件内容不同 —— 否则会被 LFS 内容寻址去重成一份
		if err := os.WriteFile(abs, pseudoRandomSeed(each, uint64(i)*0x100000001B3+1), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	mustRun(t, work, "add", "-A")
	mustRun(t, work, "commit", "-q", "-m", "batch")
	if out, err := runGit(work, "push", "-q", "file://"+filepath.ToSlash(bare), "HEAD:main"); err != nil {
		t.Fatalf("批量 push 失败：%v\n%s", err, out)
	}

	// 远端 git 对象库应该很小（内容都进了 LFS）
	gitOnly := dirSize(t, filepath.Join(bare, "objects"))
	t.Logf("远端 git 对象库：%.2f MB（原始总量 %d MB）", float64(gitOnly)/float64(mb), batch*each/mb)
	if gitOnly > int64(batch*each)/10 {
		t.Errorf("批量走 LFS 时 git 对象库不该装下原始内容：%d MB", gitOnly/mb)
	}

	// 每个文件在仓库里都要是一个**指针**（内容进了 LFS 对象库）
	for _, name := range names {
		raw := gitOut(t, bare, "cat-file", "-s", "main:"+name)
		if sz := parseInt64(t, raw); sz == 0 || sz > 1024 {
			t.Errorf("%s 在仓库里应该是指针，实际 %s 字节", name, raw)
		}
	}

	// LFS 对象库要收下全部内容
	lfsSize := dirSize(t, filepath.Join(bare, "lfs", "objects"))
	t.Logf("远端 LFS 对象库：%.2f MB（原始总量 %d MB）", float64(lfsSize)/float64(mb), batch*each/mb)
	// 内容各不相同，所以 LFS 对象库应该接近原始总量
	// （略小是对的：LFS 按内容哈希去重，但我们每个文件都不同）
	if lfsSize < int64(batch*each)*8/10 {
		t.Errorf("LFS 对象库应该收下全部内容（%d MB），实际只有 %d MB",
			batch*each/mb, lfsSize/mb)
	}
}
