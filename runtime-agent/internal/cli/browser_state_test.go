package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const fakeState = `{"cookies":[{"name":"sid","value":"s","domain":"localhost","path":"/","expires":-1,"httpOnly":true,"secure":false,"sameSite":"Lax"}],"origins":[]}`

// fakeBrowserAgent answers browser-state as the agent does, keeping the
// origins it was asked for; refuse, when set, is its refusal.
func fakeBrowserAgent(t *testing.T, refuse string) (root string, asked *[][]string) {
	asked = &[][]string{}
	root = serveFakeBox(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/workspaces/ws-1/browser-state" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if refuse != "" {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"error":{"code":"UNSUPPORTED","message":"`+refuse+`"}}`)
			return
		}
		var req struct {
			Origins []string `json:"origins"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		*asked = append(*asked, req.Origins)
		_, _ = io.WriteString(w, `{"state":`+fakeState+`,"warnings":["left out https://other.example's localStorage (a tab's): timeout"]}`)
	})
	return root, asked
}

func TestBrowserStateWritesThePrivateFileOutsideTheRepoAndPrintsItsPath(t *testing.T) {
	root, asked := fakeBrowserAgent(t, "")
	code, stdout, stderr := run(t, "browser", "state", "--origin", "http://localhost:3000", "--origin", "https://app.example.com")
	if code != 0 {
		t.Fatalf("code %d: %s", code, stderr)
	}
	want := filepath.Join(root, "browser", "ws-1.json")
	if strings.TrimSpace(stdout) != want {
		t.Errorf("stdout = %q, want the path %s alone", stdout, want)
	}
	if len(*asked) != 1 || !slices.Equal((*asked)[0], []string{"http://localhost:3000", "https://app.example.com"}) {
		t.Errorf("asked for %v", *asked)
	}
	if !strings.Contains(stderr, "left out https://other.example's localStorage") {
		t.Errorf("the warning isn't shown: %q", stderr)
	}
	info, err := os.Stat(want)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600: it's a live sign-in", info.Mode().Perm())
	}
	data, _ := os.ReadFile(want)
	if strings.TrimSpace(string(data)) != fakeState {
		t.Errorf("file = %s", data)
	}
	if entries, _ := os.ReadDir(filepath.Dir(want)); len(entries) != 1 {
		t.Errorf("left beside it: %v", entries)
	}
}

// Written into a repository where it isn't ignored, it would be committed
// with the next change: said, and not where it's ignored.
func TestBrowserStateWarnsOfAFileARepoWouldCommit(t *testing.T) {
	fakeBrowserAgent(t, "")
	repo := t.TempDir()
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Skipf("no git: %v %s", err, out)
	}
	_ = os.WriteFile(filepath.Join(repo, ".gitignore"), []byte(".auth/\n"), 0o644)

	code, _, stderr := run(t, "browser", "state", "-o", filepath.Join(repo, "state.json"))
	if code != 0 || !strings.Contains(stderr, "add it to .gitignore") {
		t.Errorf("not ignored: code %d, stderr %q", code, stderr)
	}
	code, _, stderr = run(t, "browser", "state", "-o", filepath.Join(repo, ".auth", "state.json"))
	if code != 0 || strings.Contains(stderr, ".gitignore") {
		t.Errorf("ignored: code %d, stderr %q", code, stderr)
	}
}

func TestBrowserStateSaysWhyTheAgentRefused(t *testing.T) {
	root, _ := fakeBrowserAgent(t, "this session's computer has no desktop browser to read sign-ins from")
	code, stdout, stderr := run(t, "browser", "state")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "no desktop browser") {
		t.Errorf("code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(root, "browser", "ws-1.json")); !os.IsNotExist(err) {
		t.Errorf("a file was written: %v", err)
	}
}
