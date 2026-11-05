package ipc

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

/*
 * 本地目录四态判定是「自动拉取」的核心：判错了要么把别处的仓库当成本配置的，
 * 要么往非空目录里硬克隆（git 会拒绝，用户只看到一句莫名其妙的失败）。
 */

func TestRemoteMatchesConfig(t *testing.T) {
	cfg := map[string]any{"owner": "youngdajie", "repo": "static"}
	cases := []struct {
		name   string
		remote string
		want   bool
	}{
		{"CNB https", "https://cnb.cool/youngdajie/static.git", true},
		{"GitHub https", "https://github.com/youngdajie/static.git", true},
		{"带凭据的地址也能认", "https://user:token@cnb.cool/youngdajie/static.git", true},
		{"SSH 形态", "git@cnb.cool:youngdajie/static.git", true},
		{"大小写不敏感", "https://CNB.cool/YoungDaJie/STATIC.git", true},
		{"别处的仓库", "https://github.com/someone/else.git", false},
		{"同 owner 不同 repo", "https://cnb.cool/youngdajie/other-repo.git", false},
		{"空 remote", "", false},
	}
	for _, c := range cases {
		if got := remoteMatchesConfig(cfg, c.remote); got != c.want {
			t.Errorf("%s：remoteMatchesConfig(%q) = %v，期望 %v", c.name, c.remote, got, c.want)
		}
	}
	if remoteMatchesConfig(map[string]any{"owner": "", "repo": ""}, "https://cnb.cool/a/b.git") {
		t.Error("没填仓库信息时不该判定为匹配")
	}
}

func TestInspectDirBasic(t *testing.T) {
	cfg := map[string]any{"owner": "youngdajie", "repo": "static"}
	root := t.TempDir()

	// 不存在的目录
	if got := inspectDir(cfg, filepath.Join(root, "nope")); got["state"] != "no-dir" {
		t.Errorf("不存在的目录应为 no-dir，实际 %v", got["state"])
	}
	// 空目录 → 可以克隆
	empty := filepath.Join(root, "empty")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := inspectDir(cfg, empty); got["state"] != "empty" {
		t.Errorf("空目录应为 empty，实际 %v", got["state"])
	}
	// 非空且不是 git → 不能克隆（别覆盖用户文件）
	nonEmpty := filepath.Join(root, "files")
	if err := os.Mkdir(nonEmpty, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nonEmpty, "keep.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := inspectDir(cfg, nonEmpty)
	if got["state"] != "not-empty" {
		t.Errorf("有文件的目录应为 not-empty，实际 %v", got["state"])
	}
	if got["entries"] != 1 {
		t.Errorf("entries 应为 1，实际 %v", got["entries"])
	}
}

/*
 * 造一个真实的 git 仓库，验证「别处的仓库」会被拦下来、
 * 「本配置的仓库」才算 ready。没有 git 命令就跳过（CI 里可能只装了编译器）。
 */
func TestInspectDirGitRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("本机没有 git 命令，跳过真实仓库判定")
	}
	root := t.TempDir()
	dir := filepath.Join(root, "repo")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v 失败：%v / %s", args, err, out)
		}
	}
	run("init", "-q")
	run("remote", "add", "origin", "https://github.com/someone/else.git")

	cfg := map[string]any{"owner": "youngdajie", "repo": "static"}
	if got := inspectDir(cfg, dir); got["state"] != "foreign-repo" {
		t.Errorf("别处的仓库应拦成 foreign-repo，实际 %v（remote=%v）", got["state"], got["remote"])
	}

	run("remote", "set-url", "origin", "https://cnb.cool/youngdajie/static.git")
	if got := inspectDir(cfg, dir); got["state"] != "ready" {
		t.Errorf("remote 对上后应为 ready，实际 %v（remote=%v）", got["state"], got["remote"])
	}
}
