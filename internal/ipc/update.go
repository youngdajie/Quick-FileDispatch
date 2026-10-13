package ipc

/*
 * 自动更新：查最新版、下载安装包、静默装上去。
 *
 * **首选 CNB 源**（2026-10-13 改）：国内直连，不用碰 GitHub。
 * CNB 的 Release 列表接口直接带 `is_latest` 标记，还给出附件的**公开下载地址**
 * （browser_download_url），下载那一步连令牌都不用。
 * 拿不到 CNB 令牌（或 CNB 那边暂时不通）时退回 GitHub —— 两个仓库的 Release
 * 内容是一样的（两边跑同一份构建脚本），互为备份。
 *
 * 下载走 netproxy.Transport()，用户在设置里配了代理就会生效。
 */

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/netproxy"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/store"
)

const (
	// 本程序的仓库（更新源）。跟用户自己配的仓库无关 —— 这儿查的是「程序有没有新版」
	updateRepoSlug = "youngdajie/Quick-FileDispatch"

	updateCNBAPI   = "https://api.cnb.cool/" + updateRepoSlug + "/-/releases"
	updateGHLatest = "https://api.github.com/repos/" + updateRepoSlug + "/releases/latest"

	// Release 列表的**网页**地址。它不需要登录（实测 200）。
	updateCNBWeb = "https://cnb.cool/" + updateRepoSlug + "/-/releases"

	/*
	 * 仓库里 main.go 的**原始文件**地址（杰哥提醒的：版本号就在源码里写着）。
	 * 这条是首选 —— 比解析 Release 页面稳得多：
	 *   - 页面是渲染出来的，改版就会变；源码里的 `const version` 不会
	 *   - 返回的是 text/plain 的真源码（实测 18 KB），不用去 HTML 里捞
	 *   - 同样**不需要令牌**
	 * 注意路径是 `/-/git/raw/<ref>/<path>` —— 少一个 `git` 就返回 SPA 的
	 * HTML 壳子（200 但内容是网页），这是试了几种才试出来的。
	 */
	updateCNBRaw = "https://cnb.cool/" + updateRepoSlug + "/-/git/raw/go/main.go"

	// 下载超时给足：安装包 7 MB 出头，但国内直连没代理时可能要几分钟
	updateDownloadTimeout = 15 * time.Minute
)

// cnbToken 找一个能用的 CNB 令牌：当前配置就挂在 CNB 上最好，否则翻归档配置。
func cnbToken(s *store.Store) string {
	if strOf(s.Get()["platform"]) == "cnb" {
		if t := s.GetToken(); t != "" {
			return t
		}
	}
	if p := s.FindByPlatform("cnb"); p != nil {
		if t := s.GetProfileToken(strOf(p["id"])); t != "" {
			return t
		}
	}
	return ""
}

type updateAsset struct {
	Name string
	Size int64
	URL  string
}

/*
 * checkCNBRaw 读 go 分支上的 main.go，从 `const version = "X.Y.Z"` 里抠版本号。
 *
 * 这是查更新的**首选路径**：源码里的常量，不会因为页面改版而失效；
 * 也不用令牌（实测 text/plain、200、18 KB）。下载地址按固定格式拼出来。
 */
func checkCNBRaw(current string) (map[string]any, error) {
	text, err := fetchText(updateCNBRaw, current, 1<<20)
	if err != nil {
		return nil, err
	}
	ver := pickGoVersion(text)
	if ver == "" {
		return nil, fmt.Errorf("main.go 里没找到 const version")
	}
	return buildUpdateResult(ver, current, ""), nil
}

// pickGoVersion 从 Go 源码里抠 `const version = "X.Y.Z"`。
// 逐行找标记再取引号里的内容 —— 老规矩，不用正则。
func pickGoVersion(src string) string {
	const marker = "const version"
	for _, ln := range strings.Split(src, "\n") {
		k := strings.Index(ln, marker)
		if k < 0 {
			continue
		}
		rest := ln[k+len(marker):]
		a := strings.Index(rest, "\"")
		if a < 0 {
			continue
		}
		b := strings.Index(rest[a+1:], "\"")
		if b < 0 {
			continue
		}
		if v := rest[a+1 : a+1+b]; v != "" {
			return v
		}
	}
	return ""
}

// buildUpdateResult 把「最新版本号」组装成前端要的样子。下载地址是固定格式，
// 不需要再去问接口。
func buildUpdateResult(latest, current, notes string) map[string]any {
	name := "QuickFileDispatch-Setup-" + latest + ".exe"
	return map[string]any{
		"hasUpdate": newerThan(latest, current),
		"current":   current,
		"latest":    latest,
		"notes":     notes,
		"source":    "CNB",
		"assetName": name,
		"url":       "https://cnb.cool/" + updateRepoSlug + "/-/releases/download/v" + latest + "/" + name,
		// 各版本的更新说明统一去 Release 页看 —— 弹窗里不铺开正文
		"releaseUrl": updateCNBWeb,
	}
}

// fetchText 拉一个纯文本资源（带 UA、限长、走代理）。
func fetchText(url, ua string, limit int64) (string, error) {
	client := &http.Client{Timeout: 20 * time.Second, Transport: netproxy.Transport()}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "QuickFileDispatch/"+ua)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

/*
 * checkCNBPublic 是第二条路：读 Release 网页，从 HTML 里抠安装包文件名。
 *
 * 首选其实是上面的 checkCNBRaw（直接读源码）—— 这条留着兜底，
 * 万一 go 分支改名 / main.go 挪位置，Release 页还在就能查。
 *
 * 为什么不用 CNB 的 API：它要认证（不带令牌直接 401），而网页是公开的。
 *
 * 这里刻意**不用正则**：Go 的 raw string 要嵌反斜杠，而这个文件是在一堆
 * 转义层里改出来的，用纯字符串查找反而更不容易出错。
 */
func checkCNBPublic(current string) (map[string]any, error) {
	body, err := fetchText(updateCNBWeb, current, 4<<20)
	if err != nil {
		return nil, err
	}
	best := pickSetupVersion(body)
	if best == "" {
		return nil, fmt.Errorf("页面里没找到安装包信息")
	}
	return buildUpdateResult(best, current, ""), nil
}

// pickSetupVersion 在页面里找所有 QuickFileDispatch-Setup-<版本>.exe，取最大的那个。
// 纯字符串扫描：找前缀 → 往后吃数字和点 → 看后面是不是 .exe。
func pickSetupVersion(html string) string {
	const tag = "QuickFileDispatch-Setup-"
	best := ""
	for i := 0; i < len(html); {
		j := strings.Index(html[i:], tag)
		if j < 0 {
			break
		}
		start := i + j + len(tag)
		end := start
		for end < len(html) {
			c := html[end]
			if (c >= '0' && c <= '9') || c == '.' {
				end++
				continue
			}
			break
		}
		/*
		 * 这里的边界容易想当然：扫描循环把 `3.4.8.exe` 里结尾那个点**也吃进去了**，
		 * 所以 end 停在 'e' 上，而不是点前面。于是：
		 *   - 版本号是 html[start : end-1]（砍掉那个点）
		 *   - 后面要匹配的是 "exe"，不是 ".exe"
		 *   - 再排除 "exe." 开头的情况（`Setup-3.4.8.exe.bak` 不是附件）
		 * 这三行是照着单元测试的失败信息一点点校出来的。
		 */
		if end > start && html[end-1] == '.' {
			v := html[start : end-1]
			rest := html[end:]
			if v != "" && strings.HasPrefix(rest, "exe") && !strings.HasPrefix(rest, "exe.") {
				if best == "" || newerThan(v, best) {
					best = v
				}
			}
		}
		if end <= i {
			break
		}
		i = end
	}
	return best
}

// checkCNB 向 CNB 要版本列表，挑出被标了 is_latest 的那一版。
func checkCNB(token, current string) (map[string]any, error) {
	client := &http.Client{Timeout: 20 * time.Second, Transport: netproxy.Transport()}
	req, err := http.NewRequest("GET", updateCNBAPI+"?pageSize=20", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.cnb.api+json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("CNB 返回 %d", resp.StatusCode)
	}

	// 这个接口返回的是**裸数组**，不是 {data:[...]} —— cnb CLI 打印的 data: 那层
	// 信封是它自己加的，照那个写会解析不出来
	var list []struct {
		TagName  string `json:"tag_name"`
		Body     string `json:"body"`
		IsLatest bool   `json:"is_latest"`
		Assets   []struct {
			Name               string `json:"name"`
			Size               int64  `json:"size"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("解析 CNB 返回失败：%v", err)
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("CNB 上还没有 Release")
	}

	// 优先信 is_latest；万一没有标记，退回「按版本号挑最大的」
	pick := -1
	for i, r := range list {
		if r.IsLatest {
			pick = i
			break
		}
	}
	if pick < 0 {
		for i, r := range list {
			if pick < 0 || newerThan(r.TagName, list[pick].TagName) {
				pick = i
			}
		}
	}
	rel := list[pick]

	latest := strings.TrimPrefix(rel.TagName, "v")
	out := map[string]any{
		"hasUpdate": newerThan(rel.TagName, current),
		"current":   current,
		"latest":    latest,
		"notes":     rel.Body,
		"source":    "CNB",
	}
	for _, a := range rel.Assets {
		if strings.HasPrefix(a.Name, "QuickFileDispatch-Setup-") && strings.HasSuffix(a.Name, ".exe") {
			out["assetName"] = a.Name
			out["assetSize"] = a.Size
			out["url"] = a.BrowserDownloadURL // 公开地址，下载不用令牌
			break
		}
	}
	if _, ok := out["url"]; !ok {
		return nil, fmt.Errorf("最新版本没有可用的安装包")
	}
	return out, nil
}

// ---------- 版本比较 ----------

var verRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// parseVer 从 "v3.4.8" / "3.4.8" / "3.4.8-go" 里抠出三段数字。
// 抠不出来返回 nil（调用方当作「比较不了」，宁可不提示也别误报）。
func parseVer(s string) []int {
	m := verRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	out := make([]int, 3)
	for i := 0; i < 3; i++ {
		n, _ := strconv.Atoi(m[i+1])
		out[i] = n
	}
	return out
}

// newerThan 判断 a 是否比 b 新。任一侧解析不出来就返回 false。
func newerThan(a, b string) bool {
	va, vb := parseVer(a), parseVer(b)
	if va == nil || vb == nil {
		return false
	}
	for i := 0; i < 3; i++ {
		if va[i] != vb[i] {
			return va[i] > vb[i]
		}
	}
	return false
}

// ---------- 下载状态（前端轮询这个） ----------

var updateState struct {
	mu     sync.Mutex
	status string // idle / downloading / ready / installing / error
	got    int64
	total  int64
	errMsg string
	path   string
	ver    string
}

func setUpdateState(status string, got, total int64, errMsg, path, ver string) {
	updateState.mu.Lock()
	defer updateState.mu.Unlock()
	updateState.status = status
	updateState.got = got
	updateState.total = total
	updateState.errMsg = errMsg
	if path != "" {
		updateState.path = path
	}
	if ver != "" {
		updateState.ver = ver
	}
}

func snapshotUpdate() map[string]any {
	updateState.mu.Lock()
	defer updateState.mu.Unlock()
	return map[string]any{
		"status": updateState.status,
		"got":    updateState.got,
		"total":  updateState.total,
		"error":  updateState.errMsg,
		"ver":    updateState.ver,
	}
}

// ---------- 通道 ----------

func registerUpdate(r *Registry, env *Env) {
	r.Handle("update:check", func(json.RawMessage) (any, error) {
		return checkUpdate(env, env.Version)
	})

	// 开始下载（异步，立刻返回）。进度用 update:progress 轮询。
	r.Handle("update:download", func(payload json.RawMessage) (any, error) {
		p, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		url := strOf(p["url"])
		name := strOf(p["name"])
		ver := strOf(p["ver"])
		if url == "" || name == "" {
			return nil, BadPayload("缺少下载地址")
		}
		// 已经在下了就别重复起
		updateState.mu.Lock()
		busy := updateState.status == "downloading"
		updateState.mu.Unlock()
		if busy {
			return snapshotUpdate(), nil
		}
		setUpdateState("downloading", 0, 0, "", "", ver)
		go downloadInstaller(url, name, ver)
		return snapshotUpdate(), nil
	})

	r.Handle("update:progress", func(json.RawMessage) (any, error) {
		return snapshotUpdate(), nil
	})

	// 静默安装：起一个中转脚本，等主程序退出后再跑安装包
	r.Handle("update:install", func(json.RawMessage) (any, error) {
		updateState.mu.Lock()
		path, status := updateState.path, updateState.status
		updateState.mu.Unlock()
		if status != "ready" || path == "" {
			return nil, BadPayload("安装包还没准备好")
		}
		if _, err := os.Stat(path); err != nil {
			return nil, BadPayload("安装包不见了，请重新检查更新")
		}
		if err := launchSilentInstall(path); err != nil {
			return nil, err
		}
		setUpdateState("installing", 0, 0, "", path, "")
		// 给脚本一点时间起来，再退出自己 —— 不然安装包会撞上「文件正在使用」
		go func() {
			time.Sleep(400 * time.Millisecond)
			os.Exit(0)
		}()
		return true, nil
	})
}

// checkUpdate 问「最新版是多少」，跟当前版本比一比。
// 先试 CNB（国内直连），不行再退 GitHub。
func checkUpdate(env *Env, current string) (any, error) {
	// ① 读仓库里 main.go 的源码 —— 版本号是写在里面的常量，最稳，也不用令牌
	if out, err := checkCNBRaw(current); err == nil {
		return out, nil
	} else if env.Verbose {
		fmt.Fprintf(os.Stderr, "[update] 读 main.go 失败：%v", err)
	}

	// ② Release 网页 —— 也不用令牌，兜底
	if out, err := checkCNBPublic(current); err == nil {
		return out, nil
	} else if env.Verbose {
		fmt.Fprintf(os.Stderr, "[update] CNB 网页源不可用：%v", err)
	}

	// ③ 有令牌就走 API —— 能顺带拿到更新说明正文
	if token := cnbToken(env.Store); token != "" {
		if out, err := checkCNB(token, current); err == nil {
			return out, nil
		} else if env.Verbose {
			fmt.Fprintf(os.Stderr, "[update] CNB 源不可用，退回 GitHub：%v\n", err)
		}
	}
	return checkGitHub(current)
}

// checkGitHub 是备用源。国内直连 github.com 经常不通，所以它排在 CNB 后面。
func checkGitHub(current string) (any, error) {
	client := &http.Client{Timeout: 20 * time.Second, Transport: netproxy.Transport()}
	req, err := http.NewRequest("GET", updateGHLatest, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "QuickFileDispatch/"+current)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连不上 GitHub：%v（如果网络需要代理，去设置页填一下）", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("仓库里还没有 Release")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub 返回 %d", resp.StatusCode)
	}

	var rel struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		Assets  []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("解析 GitHub 返回失败：%v", err)
	}

	latest := strings.TrimPrefix(rel.TagName, "v")
	out := map[string]any{
		"hasUpdate": newerThan(rel.TagName, current),
		"current":   current,
		"latest":    latest,
		"notes":     rel.Body,
		"source":    "GitHub",
	}
	// 挑安装包（不是那个免安装单 exe）
	for _, a := range rel.Assets {
		if strings.HasPrefix(a.Name, "QuickFileDispatch-Setup-") && strings.HasSuffix(a.Name, ".exe") {
			out["assetName"] = a.Name
			out["assetSize"] = a.Size
			out["url"] = a.URL
			break
		}
	}
	if _, ok := out["url"]; !ok {
		out["hasUpdate"] = false
		out["notes"] = "最新版本没有可用的安装包"
	}
	return out, nil
}

// downloadInstaller 把安装包下到临时目录，进度写进 updateState。
func downloadInstaller(url, name, ver string) {
	client := &http.Client{Timeout: updateDownloadTimeout, Transport: netproxy.Transport()}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		setUpdateState("error", 0, 0, err.Error(), "", ver)
		return
	}
	req.Header.Set("User-Agent", "QuickFileDispatch")

	resp, err := client.Do(req)
	if err != nil {
		setUpdateState("error", 0, 0, "下载失败："+err.Error(), "", ver)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		setUpdateState("error", 0, 0, fmt.Sprintf("下载失败：HTTP %d", resp.StatusCode), "", ver)
		return
	}

	// 放进一个专门的目录，方便下次覆盖、也方便用户自己去找
	dir := filepath.Join(os.TempDir(), "QuickFileDispatch-update")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		setUpdateState("error", 0, 0, "建临时目录失败："+err.Error(), "", ver)
		return
	}
	dest := filepath.Join(dir, name)
	f, err := os.Create(dest)
	if err != nil {
		setUpdateState("error", 0, 0, "写文件失败："+err.Error(), "", ver)
		return
	}

	total := resp.ContentLength
	setUpdateState("downloading", 0, total, "", "", ver)

	buf := make([]byte, 64*1024)
	var got int64
	lastPush := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				os.Remove(dest)
				setUpdateState("error", got, total, "写文件失败："+werr.Error(), "", ver)
				return
			}
			got += int64(n)
			// 别每读一块就抢锁，250ms 推一次够了
			if time.Since(lastPush) > 250*time.Millisecond {
				setUpdateState("downloading", got, total, "", "", ver)
				lastPush = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(dest)
			setUpdateState("error", got, total, "下载中断："+rerr.Error(), "", ver)
			return
		}
	}
	f.Close()
	setUpdateState("ready", got, total, "", dest, ver)
}

/*
 * launchSilentInstall 起一个中转脚本去跑安装包。
 *
 * 为什么不直接 exec 安装包：主程序这时候还活着，安装包要覆盖的正是它自己，
 * Windows 上「文件正在使用」会直接失败。所以走一个 .bat ——
 * 它先等两秒（我们在这期间退出），再带 /S 静默跑安装包。
 *
 * /S 是 NSIS 的静默开关，安装器是 RequestExecutionLevel user（当前用户级），
 * 不需要管理员提权，静默装不会弹 UAC。
 */
func launchSilentInstall(pkg string) error {
	bat := filepath.Join(filepath.Dir(pkg), "apply-update.bat")
	// 引号包住路径：临时目录可能带空格
	script := "@echo off\r\n" +
		"timeout /t 2 /nobreak >nul\r\n" +
		"start \"\" \"" + pkg + "\" /S\r\n" +
		"del \"%~f0\"\r\n"
	if err := os.WriteFile(bat, []byte(script), 0o644); err != nil {
		return fmt.Errorf("写更新脚本失败：%v", err)
	}
	cmd := exec.Command("cmd", "/c", bat)
	git.HideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动安装程序失败：%v", err)
	}
	go cmd.Wait() // 收尸，免得留僵尸
	return nil
}
