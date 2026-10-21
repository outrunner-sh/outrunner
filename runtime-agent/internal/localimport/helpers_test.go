package localimport

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/transcript"
)

// testHome is a scratch home for a scan: nothing of the real one is read.
func testHome(t *testing.T) (string, Options) {
	t.Helper()
	home := t.TempDir()
	if real, err := filepath.EvalSymlinks(home); err == nil {
		home = real // Claude names folders after the real path (/private/var)
	}
	opts := DefaultOptions(home)
	opts.CachePath = ""
	opts.Now = func() time.Time { return time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC) }
	return home, opts
}

// gitIn runs git in dir as a fixed author, failing the test on error.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// repoWithOrigin makes a GitHub-like origin (a bare repo, its remote URL
// rewritten to look like GitHub's) with one commit on main, and a clone of it
// at dir. It returns the origin's path, which a box's mirror is cloned from.
func repoWithOrigin(t *testing.T, dir string) string {
	t.Helper()
	origin := filepath.Join(t.TempDir(), "origin.git")
	gitIn(t, t.TempDir(), "init", "-q", "--bare", "-b", "main", origin)
	seed := t.TempDir()
	gitIn(t, seed, "init", "-q", "-b", "main")
	writeFile(t, filepath.Join(seed, "app.txt"), "v1\n")
	gitIn(t, seed, "add", "-A")
	gitIn(t, seed, "commit", "-q", "-m", "first")
	gitIn(t, seed, "push", "-q", origin, "main")

	gitIn(t, filepath.Dir(dir), "clone", "-q", origin, dir)
	// Call it GitHub: the scan reads the URL, and nothing here fetches.
	gitIn(t, dir, "remote", "set-url", "origin", "https://github.com/ada/app.git")
	return origin
}

// claudeLineJSON is a line of a Claude Code transcript.
func claudeLineJSON(t *testing.T, typ, cwd, branch, at, text string) string {
	t.Helper()
	rec := map[string]any{
		"type": typ, "cwd": cwd, "gitBranch": branch, "timestamp": at, "isSidechain": false,
		"message": map[string]any{"role": typ, "content": text},
	}
	if typ == "assistant" {
		rec["message"] = map[string]any{"role": "assistant", "model": "claude-opus-5-5",
			"content": []map[string]string{{"type": "text", "text": text}}}
	}
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// writeClaudeSession files a transcript where Claude Code would for cwd, and
// returns its path.
func writeClaudeSession(t *testing.T, home, cwd, id string, lines ...string) string {
	t.Helper()
	path := filepath.Join(transcript.ClaudeProjectDir(home, cwd), id+".jsonl")
	writeFile(t, path, strings.Join(lines, "\n")+"\n")
	return path
}

// sqliteExec runs SQL against a database file through the sqlite3 the scan
// uses; CI has it, and a missing one fails here rather than skipping.
func sqliteExec(t *testing.T, db, sql string) {
	t.Helper()
	bin, err := sqliteBinary()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, db)
	cmd.Stdin = strings.NewReader(sql)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sqlite3: %v: %s", err, out)
	}
}

func readTestdata(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func sessionByKey(t *testing.T, scan Scan, key string) Session {
	t.Helper()
	for _, s := range scan.Sessions {
		if s.Key == key {
			return s
		}
	}
	t.Fatalf("no session %s in scan: %+v", key, scan.Sessions)
	return Session{}
}

func sourceByID(t *testing.T, scan Scan, id string) Source {
	t.Helper()
	for _, s := range scan.Sources {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("no source %s", id)
	return Source{}
}
