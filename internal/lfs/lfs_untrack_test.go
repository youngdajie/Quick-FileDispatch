package lfs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件回归一个真实 BUG（2026-09-26 杰哥反馈）：
//
//   git lfs track <路径> 会把规则写进 .gitattributes，而它随提交永久留在仓库。
//   删文件不会删规则。于是「勾 LFS 传过 1.avif → 删掉 → 不勾 LFS 再传一个
//   全新的 1.avif」时，第二次也被迫走了对象存储。
//
// 修复在 internal/cnb 的 UploadBatch / DeleteBatch：不勾 LFS 或删除文件时
// 都会调 lfs.UntrackInRepo 清掉残留规则。这里验证这两个时机。

// TestUntrackRemovesGitAttributesRule 验证 untrack 确实清掉了规则行。
func TestUntrackRemovesGitAttributesRule(t *testing.T) {
	hasGitLFS(t)
	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir: dir,
		Paths:   []string{"a.avif"},
	}); err != nil {
		t.Fatalf("track 失败：%v", err)
	}
	ga, _ := os.ReadFile(filepath.Join(dir, ".gitattributes"))
	if !strings.Contains(string(ga), "a.avif") {
		t.Fatalf("track 后 .gitattributes 应有 a.avif 规则：\n%s", ga)
	}

	UntrackInRepo(context.Background(), dir, []string{"a.avif"})

	ga2, _ := os.ReadFile(filepath.Join(dir, ".gitattributes"))
	if strings.Contains(string(ga2), "a.avif") {
		t.Errorf("untrack 后 .gitattributes 不该再留 a.avif：\n%s", ga2)
	}
}

// TestReuploadSameNameWithoutLFS 完整复现杰哥踩的坑：
//
//  1. 勾 LFS 上传 a.avif（仓库里是指针）
//  2. 删文件但**不清规则**（模拟当时的旧代码行为，规则残留）
//  3. 不勾 LFS 再传一个全新的 a.avif
//     —— 修复后，UploadBatch 的 else 分支会先 untrack，
//        这次必须走普通存储，而不是又被拖进对象存储
func TestReuploadSameNameWithoutLFS(t *testing.T) {
	hasGitLFS(t)
	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	// 第 1 步：勾 LFS 上传
	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir: dir,
		Paths:   []string{"a.avif"},
	}); err != nil {
		t.Fatalf("track 失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.avif"), []byte("FIRST-CONTENT"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "first (LFS)")
	first := gitOut(t, dir, "show", "HEAD:a.avif")
	if !strings.HasPrefix(first, "version https://git-lfs.github.com/spec/v1") {
		t.Fatalf("第一轮该是 LFS 指针：%.60s", first)
	}

	// 第 2 步：删文件，**不清规则**（复现旧代码的残留状态）
	if err := os.Remove(filepath.Join(dir, "a.avif")); err != nil {
		t.Fatal(err)
	}
	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "delete (规则残留)")
	ga, _ := os.ReadFile(filepath.Join(dir, ".gitattributes"))
	if !strings.Contains(string(ga), "a.avif") {
		t.Fatalf("这一步故意不清规则，.gitattributes 应仍有 a.avif：\n%s", ga)
	}

	// 第 3 步：不勾 LFS 再传同名 —— 对应 UploadBatch 的 else 分支
	UntrackInRepo(context.Background(), dir, []string{"a.avif"})
	if err := os.WriteFile(filepath.Join(dir, "a.avif"), []byte("SECOND-DIFFERENT-CONTENT"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "second (no LFS)")

	second := gitOut(t, dir, "show", "HEAD:a.avif")
	if strings.HasPrefix(second, "version https://git-lfs.github.com/spec/v1") {
		t.Errorf("第二轮没勾 LFS，不该再是 LFS 指针：%.60s", second)
	}
	if !strings.Contains(second, "SECOND-DIFFERENT-CONTENT") {
		t.Errorf("第二轮该是普通文件内容：%.60s", second)
	}
}

// TestDeleteUntracksRule 验证删除文件时会清规则（对应 DeleteBatch 的新逻辑）。
func TestDeleteUntracksRule(t *testing.T) {
	hasGitLFS(t)
	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir: dir,
		Paths:   []string{"a.bin"},
	}); err != nil {
		t.Fatalf("track 失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.bin"), []byte("X"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "add")

	// 删除时先 untrack（DeleteBatch 的行为），再删文件，一起提交
	UntrackInRepo(context.Background(), dir, []string{"a.bin"})
	if err := os.Remove(filepath.Join(dir, "a.bin")); err != nil {
		t.Fatal(err)
	}
	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "delete")

	ga, _ := os.ReadFile(filepath.Join(dir, ".gitattributes"))
	if strings.Contains(string(ga), "a.bin") {
		t.Errorf("删除后 .gitattributes 不该再留 a.bin：\n%s", ga)
	}
}
