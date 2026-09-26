package lfs

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// hasGitLFS 检查本机有没有 git-lfs（没有就跳过所有真实行为测试）。
func hasGitLFS(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没装 git，跳过")
	}
	p, err := exec.LookPath("git-lfs")
	if err != nil {
		t.Skip("没装 git-lfs，跳过")
	}
	return p
}

// TestEnableInRepoWritesGitAttributes 验证启用 LFS 之后仓库里真的多了
// 正确的跟踪规则。
//
// 为什么要跑真的 git：EnableInRepo 的全部价值就是「git 认不认这些规则」，
// 用 mock 测等于没测 —— 真正的失败模式是 .gitattributes 写错格式、
// 或者 filter 没注册上，那些只有真 git 才看得出来。
func TestEnableInRepoWritesGitAttributes(t *testing.T) {
	hasGitLFS(t)

	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	// 模拟一批上传文件：含子目录、含改过名的、含非 ASCII 名字
	paths := []string{
		"blog/2026/cover-abc123.avif",
		"images/photo.jpg",
		"中文目录/笔记.md",
	}
	for _, p := range paths {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir: dir,
		Paths:   paths,
	}); err != nil {
		t.Fatalf("EnableInRepo 失败：%v", err)
	}

	// 1) .gitattributes 应该存在，且每个路径都有一条规则
	ga, err := os.ReadFile(filepath.Join(dir, ".gitattributes"))
	if err != nil {
		t.Fatalf("没有生成 .gitattributes：%v", err)
	}
	for _, p := range paths {
		if !strings.Contains(string(ga), p) {
			t.Errorf(".gitattributes 里缺少 %q\n实际内容：\n%s", p, ga)
		}
	}
	t.Logf(".gitattributes 内容：\n%s", ga)

	// 2) 关键验证：git 是否真的认为这些文件要走 LFS。
	//    check-attr 会输出 "filter: lfs" —— 这是「LFS 生效」的唯一权威判据。
	//    光看 .gitattributes 有那一行不代表 git 认（格式错了照样匹配不上）。
	for _, p := range paths {
		out := gitOut(t, dir, "check-attr", "filter", "--", p)
		if !strings.Contains(out, "lfs") {
			t.Errorf("%q 没有被 git 认成 LFS 文件：%s", p, strings.TrimSpace(out))
		}
	}

	// 3) filter.lfs.* 应该在仓库级配置里（--local，不污染全局）
	cfg := gitOut(t, dir, "config", "--local", "--get", "filter.lfs.process")
	if !strings.Contains(cfg, "git-lfs") {
		t.Errorf("filter.lfs.process 没注册上：%q", cfg)
	}
}

// TestEnableInRepoIdempotent 验证重复启用不报错。
//
// 真实场景就是重复的：用户勾着 LFS 传了三次同一批文件，
// EnableInRepo 会被调三次。第二次开始 `git lfs track` 会因为
// 「规则已存在」返回非零退出码 —— 没加 --force 的话这里就炸了。
func TestEnableInRepoIdempotent(t *testing.T) {
	hasGitLFS(t)

	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	abs := filepath.Join(dir, "a.png")
	if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := EnableParams{RepoDir: dir, Paths: []string{"a.png"}}
	for i := 0; i < 3; i++ {
		if err := EnableInRepo(context.Background(), p); err != nil {
			t.Fatalf("第 %d 次启用失败：%v", i+1, err)
		}
	}

	// 规则不该重复堆叠
	ga, _ := os.ReadFile(filepath.Join(dir, ".gitattributes"))
	if n := strings.Count(string(ga), "a.png"); n != 1 {
		t.Errorf("a.png 的规则出现了 %d 次，应该只有 1 次：\n%s", n, ga)
	}
}

// TestEnableInRepoCNBLocksVerify 验证 CNB 需要的 locksverify 被设置。
//
// 不设的话 git-lfs 在 push 时会卡在 "Locking support detected..."
// 反复重试（CNB 侧有公开 issue 记录），表现出来就是「上传一直不动」。
func TestEnableInRepoCNBLocksVerify(t *testing.T) {
	hasGitLFS(t)

	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	remote := "https://cnb.cool/me/repo.git"
	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir:   dir,
		Paths:     []string{"big.bin"},
		RemoteURL: remote,
	}); err != nil {
		t.Fatalf("EnableInRepo 失败：%v", err)
	}

	key := "lfs." + remote + ".locksverify"
	got := gitOut(t, dir, "config", "--local", "--get", key)
	if strings.TrimSpace(got) != "false" {
		t.Errorf("%s = %q，想要 false", key, strings.TrimSpace(got))
	}
}

// TestEnableInRepoNonCNBNoLocks 确认非 CNB 平台不会被塞这个配置
// （GitHub 的 LFS 服务不需要，多余配置只会让人困惑）。
func TestEnableInRepoNonCNBNoLocks(t *testing.T) {
	hasGitLFS(t)

	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir:   dir,
		Paths:     []string{"big.bin"},
		RemoteURL: "https://github.com/me/repo.git",
	}); err != nil {
		t.Fatalf("EnableInRepo 失败：%v", err)
	}

	out := gitOut(t, dir, "config", "--local", "--list")
	if strings.Contains(out, "locksverify") {
		t.Errorf("GitHub 不该写 locksverify：\n%s", out)
	}
}

/* ------------------------------------------------------------ 小工具 */

func mustRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s 失败：%v\n%s", strings.Join(args, " "), err, out)
	}
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, _ := cmd.CombinedOutput()
	return string(out)
}
