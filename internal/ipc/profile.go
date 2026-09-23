package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/cloud"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/dialog"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/local"
)

/* ------------------------------------------------------------ profile:check */

// profileCheck 是单份配置的可用性体检：本地目录 + 云端仓库各查一遍。
//
// 导入之后靠它告诉用户「哪一块不可用、该去哪里改」，而不是丢一句「导入失败」。
// 所以每个分支都带 fix 字段：光说「目录不是 Git 仓库」没用，
// 得说「点『克隆到此处』把仓库克隆到这个目录」。
func (e *Env) profileCheck(payload map[string]any) (any, error) {
	id := strOf(payload["id"])
	cfg := e.Store.Raw()
	var p map[string]any
	if list, ok := cfg["profiles"].([]any); ok {
		for _, it := range list {
			if m, ok := it.(map[string]any); ok && strOf(m["id"]) == id {
				p = m
				break
			}
		}
	}
	if p == nil {
		return map[string]any{"ok": false, "missing": true, "error": "配置不存在，可能已被删除"}, nil
	}

	label := firstNonEmpty(strOf(p["name"]), joinSlash(p), "未命名配置")
	out := map[string]any{
		"ok":       true,
		"id":       id,
		"label":    label,
		"platform": cloud.NormalizePlatform(strOf(p["platform"])),
		"local": map[string]any{
			"ok": false, "code": "missing", "message": "没有填写本地目录",
			"fix": "到「本地目录」选一个文件夹",
		},
		"cloud": map[string]any{
			"ok": false, "code": "missing", "message": "没有填写仓库信息",
			"fix": "到「仓库信息」填写用户名与仓库名",
		},
	}

	/* ---- 本地目录 ---- */
	dir := strOf(p["localDir"])
	if dir != "" {
		if !local.Exists(dir) {
			out["local"] = map[string]any{
				"ok": false, "code": "not-exist", "dir": dir,
				"message": "目录不存在：" + dir,
				"fix":     "点「选择…」重新指到本机的仓库目录，或点「克隆到此处」把仓库拉下来",
			}
		} else if !git.IsRepo(context.Background(), dir) {
			out["local"] = map[string]any{
				"ok": false, "code": "not-repo", "dir": dir,
				"message": "目录存在，但不是 Git 仓库（没有 .git）",
				"fix":     "点「克隆到此处」把仓库克隆到这个目录",
			}
		} else {
			sum := git.RepoSummary(context.Background(), dir)
			st := git.Status(context.Background(), dir)
			dirty, _ := st["dirty"].(bool)
			branch := ""
			if sum != nil {
				branch = strOf(sum["branch"])
			}
			msg := "本地仓库就绪"
			if branch != "" {
				msg += "（分支 " + branch + "）"
			}
			out["local"] = map[string]any{
				"ok": true, "code": "ready", "dir": dir, "branch": branch,
				"dirty": dirty, "message": msg,
			}
		}
	}

	/* ---- 云端仓库 ---- */
	owner, repo := strOf(p["owner"]), strOf(p["repo"])
	if owner != "" && repo != "" {
		token := e.Store.GetProfileToken(id)
		if token == "" {
			out["cloud"] = map[string]any{
				"ok": false, "code": "no-token", "owner": owner, "repo": repo,
				"message": owner + "/" + repo + "：本机没有可用 Token",
				"fix": "把「归档配置」切到这一份，在「仓库信息 → 访问令牌」补上 Token 后点「验证并归档」。" +
					"（若这份是从配置文件导入的，说明导出时那份配置本身就没带 Token）",
			}
		} else {
			client := cloud.New(strOf(p["platform"]), owner, repo,
				defStr2(p["branch"], "main"), token, strOf(p["apiBase"]))
			user, err := client.Whoami()
			if err != nil {
				out["cloud"] = cloudFail(owner, repo, friendly(err))
			} else {
				info, err := client.RepoInfo()
				if err != nil {
					out["cloud"] = cloudFail(owner, repo, friendly(err))
				} else {
					// 列一次根目录，确认「能读」而不只是「能连上」
					if _, err := client.ListDir(""); err != nil {
						out["cloud"] = cloudFail(owner, repo, friendly(err))
					} else {
						privacy := "公开"
						if info.Private {
							privacy = "私有"
						}
						out["cloud"] = map[string]any{
							"ok": true, "code": "ready", "owner": owner, "repo": repo,
							"userName": firstNonEmpty(user.Name, user.Login),
							"repoInfo": info,
							"message":  "云端可达：" + info.FullName + " · " + privacy,
						}
					}
				}
			}
		}
	}

	lm, _ := out["local"].(map[string]any)
	cm, _ := out["cloud"].(map[string]any)
	lo, _ := lm["ok"].(bool)
	co, _ := cm["ok"].(bool)
	out["ok"] = lo && co
	return out, nil
}

func cloudFail(owner, repo, msg string) map[string]any {
	return map[string]any{
		"ok": false, "code": "unreachable", "owner": owner, "repo": repo,
		"message": msg,
		"fix": "检查「仓库信息」里的 owner / 仓库名 / 分支是否写对，平台（GitHub / CNB）是否选错；" +
			"私有仓库还要确认 Token 有仓库读写权限",
	}
}

func joinSlash(p map[string]any) string {
	o, r := strOf(p["owner"]), strOf(p["repo"])
	switch {
	case o != "" && r != "":
		return o + "/" + r
	case o != "":
		return o
	case r != "":
		return r
	}
	return ""
}

/* ------------------------------------------------------------ profile:export */

// profileExport 导出归档配置到文件。
//
// ⚠️ 导出的 JSON 里 **Token 是明文**。这是刻意的（换台机器要能直接用），
// 但必须由渲染层先弹确认框 —— 后端无法确认用户是否知情，所以这里
// 只负责执行，确认的职责在界面上。
func (e *Env) profileExport() (any, error) {
	data := e.Store.ExportProfiles()
	stamp := time.Now().Format("2006-01-02")
	path, err := dialog.SaveFile("导出归档配置", "Quick-FileDispatch-"+stamp+".json", []dialog.Filter{
		{Name: "JSON 配置", Exts: []string{"json"}},
		{Name: "所有文件", Exts: []string{"*"}},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"ok": false, "canceled": true}, nil
	}
	buf, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		return nil, err
	}
	withToken := 0
	if list, ok := data["profiles"].([]any); ok {
		for _, it := range list {
			if m, ok := it.(map[string]any); ok && strOf(m["token"]) != "" {
				withToken++
			}
		}
	}
	return map[string]any{
		"ok": true, "filePath": path,
		"count":     len(data["profiles"].([]any)),
		"withToken": withToken,
	}, nil
}

/* ------------------------------------------------------------ profile:import */

func (e *Env) profileImport() (any, error) {
	path, err := dialog.OpenFile("导入归档配置", []dialog.Filter{
		{Name: "JSON 配置", Exts: []string{"json"}},
		{Name: "所有文件", Exts: []string{"*"}},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"ok": false, "canceled": true}, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// 兼容两种写法：带信封的 {profiles:[...]} 和裸数组
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, errors.New("不是有效的配置文件：" + err.Error())
	}
	payload, ok := parsed.(map[string]any)
	if !ok {
		if arr, isArr := parsed.([]any); isArr {
			payload = map[string]any{"profiles": arr}
		} else {
			return nil, errors.New("不是有效的配置文件")
		}
	}
	if _, ok := payload["profiles"].([]any); !ok {
		return nil, errors.New("配置文件里没有 profiles 列表")
	}
	// 老版本的 kind 是 jie-dispatch-profiles，一并认，免得以前导出的文件导不回来
	if kind := strOf(payload["kind"]); kind != "" &&
		kind != "Quick-FileDispatch" && kind != "jie-dispatch-profiles" {
		return nil, errors.New("这不像本程序导出的配置（kind=" + kind + "）")
	}

	res, err := e.Store.ImportProfiles(payload)
	if err != nil {
		return nil, err
	}
	e.cache.Invalidate()
	out := map[string]any{
		"ok":              true,
		"filePath":        path,
		"added":           res.Added,
		"skipped":         res.Skipped,
		"settingsApplied": res.SettingsApplied,
		"skippedDetail":   res.SkippedDetail,
		"cfg":             res.Cfg,
	}
	return out, nil
}

/* ------------------------------------------------------------ fs:exportText */

func (e *Env) fsExportText(payload map[string]any) (any, error) {
	name := defStr2(payload["defaultName"], "jie-export.txt")
	path, err := dialog.SaveFile("导出", name, []dialog.Filter{
		{Name: "文本文件", Exts: []string{"txt", "md"}},
		{Name: "所有文件", Exts: []string{"*"}},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"ok": false}, nil
	}
	if err := os.WriteFile(path, []byte(strOf(payload["content"])), 0o644); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "filePath": path}, nil
}
