package lfs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLFSEndToEndWorkflow 走一遍上传时的完整链路，验证「勾了 LFS，
// 文件确实存进了 LFS 对象库、仓库里只留指针」。
//
// 这是回答「压缩 + 水印 + LFS 一起勾，文件能不能正常处理」这个问题的
// 直接证据。测试模拟的正是上传链路做的事：
//
//	启用 LFS → 写文件（= 前端压缩/水印之后的输出）→ add → commit
//
// 关键判据是第 4 步：仓库里存的必须是 LFS **指针**而不是原内容。
// 只看 .gitattributes 有那一行是不够的 —— filter 没生效的话，
// 文件照样以普通 blob 进仓库，用户以为走了 LFS 其实没走。
func TestLFSEndToEndWorkflow(t *testing.T) {
	hasGitLFS(t)

	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	// 前端压缩 + 水印之后的产物（这里用一段可辨认的假数据代替）
	const rel = "blog/2026/cover-abc123.avif"
	content := []byte("FAKE-COMPRESSED-WATERMARKED-IMAGE-BYTES-0123456789")

	// 1) 上传前的第一步：启用 LFS 并 track 这批文件
	if err := EnableInRepo(context.Background(), EnableParams{
		RepoDir: dir,
		Paths:   []string{rel},
	}); err != nil {
		t.Fatalf("启用 LFS 失败：%v", err)
	}

	// 2) 写文件（= 后端 writeFiles）
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, content, 0o644); err != nil {
		t.Fatal(err)
	}

	// 3) 提交（= CommitAndPushStream 的 add + commit）
	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "chore: 通过 JIE 分发服务上传")

	// 4) 决定性验证：仓库里存的必须是指针，不是原内容
	stored := gitOut(t, dir, "show", "HEAD:"+rel)
	if !strings.HasPrefix(stored, "version https://git-lfs.github.com/spec/v1") {
		t.Fatalf("文件没走 LFS —— 仓库里存的是原内容（前 120 字节）：\n%.120s", stored)
	}
	if !strings.Contains(stored, "oid sha256:") {
		t.Errorf("LFS 指针缺少 oid：\n%s", stored)
	}
	if strings.Contains(stored, "FAKE-COMPRESSED") {
		t.Errorf("仓库里不该出现原内容，说明 filter 没生效")
	}
	t.Logf("仓库里存的是 LFS 指针：\n%s", strings.TrimSpace(stored))

	// 5) 内容应该真的进了本地 LFS 对象库（否则 push 会失败）
	objs := gitOut(t, dir, "lfs", "ls-files", "--long")
	if !strings.Contains(objs, rel) {
		t.Errorf("lfs ls-files 里没有 %s：\n%s", rel, objs)
	}
	if !strings.Contains(objs, " * ") {
		// lfs ls-files 用 "*" 表示对象已在本地
		t.Logf("提示：lfs ls-files 输出 = %s", strings.TrimSpace(objs))
	}

	// 6) 工作区的文件必须还是原内容（不能让用户看到指针）
	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(content) {
		t.Errorf("工作区内容被改动了：%q", got)
	}
}

// TestLFSMultipleFilesWithMixedPaths 验证一批混合路径（图片 / 非图片 /
// 深层目录 / 中文名）能全部正确进入 LFS。
//
// 真实的上传批次就是混的 —— 用户一次拖进 20 个文件，
// 压缩器只处理图片，其它原样上传，但**都要走 LFS**。
func TestLFSMultipleFilesWithMixedPaths(t *testing.T) {
	hasGitLFS(t)

	dir := t.TempDir()
	mustRun(t, dir, "init", "-q")
	mustRun(t, dir, "config", "user.email", "t@example.com")
	mustRun(t, dir, "config", "user.name", "t")

	paths := []string{
		"a.png",                     // 顶层图片
		"deep/nested/dir/video.mp4", // 深层目录
		"文档/说明.pdf",                  // 中文目录 + 中文名
		"with space.txt",            // 带空格
		"archive.tar.gz",            // 压缩包
	}

	if err := EnableInRepo(context.Background(), EnableParams{RepoDir: dir, Paths: paths}); err != nil {
		t.Fatalf("启用 LFS 失败：%v", err)
	}

	for i, p := range paths {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte{byte(i), byte(i + 1), byte(i + 2)}, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	mustRun(t, dir, "add", "-A")
	mustRun(t, dir, "commit", "-q", "-m", "batch")

	for _, p := range paths {
		stored := gitOut(t, dir, "show", "HEAD:"+p)
		if !strings.HasPrefix(stored, "version https://git-lfs.github.com/spec/v1") {
			t.Errorf("%q 没走 LFS（前 80 字节）：%.80s", p, stored)
		}
	}
}
