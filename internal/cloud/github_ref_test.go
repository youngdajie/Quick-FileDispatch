package cloud

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// GitHub 的「读引用」和「更新引用」路径不一样：
//
//	GET   /git/refs/{ref}   读引用（实测写成单数 /git/ref/ 它也认）
//	PATCH /git/refs/{ref}   更新引用 —— **只认复数**，单数直接 404
//
// 早先 uploadGitData / MoveBatch 里 GET 和 PATCH 共用了一个 "…/git/ref/heads/xxx"，
// 于是：blob 建好了、tree 建好了、commit 也建好了，最后那一步 PATCH 404。
// 用户看到的是「上传失败：仓库或分支不存在，请检查用户名 / 仓库名 / 分支名」，
// 可分支明明是好的、Token 也有权限 —— 前面每一步都不报错，只错最后一下。
// 文件管理页走本地 git push、不碰这个 API，所以「能推」和「传不上」能同时成立。
//
// 这个测试把 PATCH 的路径钉死。想验证它确实有效，把 write.go 改回单数跑一遍即可。
func TestGitHubUploadPatchesRefsPlural(t *testing.T) {
	var mu sync.Mutex
	var seen []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/git/ref"):
			_, _ = w.Write([]byte(`{"object":{"sha":"aaa111"}}`))
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/git/commits/"):
			_, _ = w.Write([]byte(`{"tree":{"sha":"ttt111"}}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/blobs"):
			_, _ = w.Write([]byte(`{"sha":"bbb111"}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/trees"):
			_, _ = w.Write([]byte(`{"sha":"ttt222"}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/commits"):
			_, _ = w.Write([]byte(`{"sha":"ccc222"}`))
		case r.Method == "PATCH":
			_, _ = w.Write([]byte(`{"object":{"sha":"ccc222"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	}))
	defer srv.Close()

	c := New("github", "youngdajie", "cdn.yangjie.site", "main", "tok", srv.URL)
	if _, err := c.uploadGitData([]File{{Path: "a.txt", Buff: []byte("hi")}}, "test", nil); err != nil {
		t.Fatalf("上传整条链路失败：%v", err)
	}

	var patch string
	for _, s := range seen {
		if strings.HasPrefix(s, "PATCH ") {
			patch = s
		}
	}
	if patch == "" {
		t.Fatalf("没有发出 PATCH 请求，收到的请求：%v", seen)
	}
	if strings.Contains(patch, "/git/ref/heads/") {
		t.Fatalf("PATCH 用了单数 ref，GitHub 会回 404：%q", patch)
	}
	if !strings.HasSuffix(patch, "/git/refs/heads/main") {
		t.Fatalf("PATCH 路径不对：%q，应为 .../git/refs/heads/main", patch)
	}
}

// 改名 / 移动走的是同一套 Git Data API，同一个坑，一并钉住。
func TestGitHubMovePatchesRefsPlural(t *testing.T) {
	var mu sync.Mutex
	var seen []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/git/ref"):
			_, _ = w.Write([]byte(`{"object":{"sha":"aaa111"}}`))
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/git/commits/"):
			_, _ = w.Write([]byte(`{"tree":{"sha":"ttt111"}}`))
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/contents/"):
			_, _ = w.Write([]byte(`{"content":"aGk=","encoding":"base64","size":2}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/blobs"):
			_, _ = w.Write([]byte(`{"sha":"bbb111"}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/trees"):
			_, _ = w.Write([]byte(`{"sha":"ttt222"}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/commits"):
			_, _ = w.Write([]byte(`{"sha":"ccc222"}`))
		case r.Method == "PATCH":
			_, _ = w.Write([]byte(`{"object":{"sha":"ccc222"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	}))
	defer srv.Close()

	c := New("github", "youngdajie", "cdn.yangjie.site", "main", "tok", srv.URL)
	if _, err := c.MoveBatch([]MoveItem{{From: "a.txt", To: "b.txt"}}, "move"); err != nil {
		t.Fatalf("移动整条链路失败：%v", err)
	}

	var patch string
	for _, s := range seen {
		if strings.HasPrefix(s, "PATCH ") {
			patch = s
		}
	}
	if patch == "" {
		t.Fatalf("没有发出 PATCH 请求，收到的请求：%v", seen)
	}
	if strings.Contains(patch, "/git/ref/heads/") {
		t.Fatalf("PATCH 用了单数 ref，GitHub 会回 404：%q", patch)
	}
}
