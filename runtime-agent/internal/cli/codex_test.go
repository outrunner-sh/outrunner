package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexDevicePromptNeverPrintsCredentials(t *testing.T) {
	var out bytes.Buffer
	p := &codexPrompt{out: &out, seen: map[string]bool{}}
	p.Write([]byte("access_token=never-echo-this https://auth.openai.com/codex/device\n https://auth.openai.com/codex/device\nABCD-"))
	p.Write([]byte("EFGHI\nrefresh_token=also-never-echo\nrefresh_token=LEAK-ABCDE\n"))
	got := out.String()
	if !strings.Contains(got, "ABCD-EFGHI") || !strings.Contains(got, "https://auth.openai.com/codex/device") || strings.Contains(got, "never-echo") || strings.Contains(got, "LEAK-ABCDE") {
		t.Fatal(got)
	}
}
func TestCodexLoginIsolatedUploadAndCleanup(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	marker := filepath.Join(dir, "home")
	script := `#!/bin/sh
set -eu
[ "$1 $2" = "login --device-auth" ]
[ -z "${OPENAI_API_KEY:-}" ]
[ -z "${CODEX_ACCESS_TOKEN:-}" ]
printf '%s' "$CODEX_HOME" > '` + marker + `'
printf '%s' '{"tokens":{"id_token":"synthetic-id-token","access_token":"synthetic-access-token","refresh_token":"synthetic-refresh-token","account_id":"acct"}}' > "$CODEX_HOME/auth.json"
printf 'https://auth.openai.com/codex/device\nABCD-EFGHI\n'
printf 'synthetic-refresh-token' >&2
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "synthetic-inherited-key")
	t.Setenv("CODEX_ACCESS_TOKEN", "synthetic-inherited-access")
	var out bytes.Buffer
	tokens, err := CodexLogin(context.Background(), binary, &out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(tokens, []byte("synthetic-refresh-token")) || strings.Contains(out.String(), "synthetic-") {
		t.Fatal("unsafe login result")
	}
	home, _ := os.ReadFile(marker)
	if _, err := os.Stat(string(home)); !os.IsNotExist(err) {
		t.Fatal("temporary login remains")
	}
}

func TestCodexCanceledLoginRemovesItsTemporaryHome(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	marker := filepath.Join(dir, "home")
	escaped := filepath.Join(dir, "escaped-child")
	// Match npm's wrapper/native-child shape, rather than exec'ing sleep in
	// place: killing only the wrapper leaves its native child running.
	script := "#!/bin/sh\nprintf '%s' \"$CODEX_HOME\" > '" + marker + "'\n(sleep 1; printf survived > '" + escaped + "') &\nwait\n"

	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := CodexLogin(ctx, binary, &bytes.Buffer{})
	if err == nil {
		t.Fatal("canceled login succeeded")
	}
	home, _ := os.ReadFile(marker)
	if _, err := os.Stat(string(home)); !os.IsNotExist(err) {
		t.Fatal("canceled temporary home remains")
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(escaped); !os.IsNotExist(err) {
		t.Fatal("canceled wrapper left its native login child running")
	}

}
func TestCodexConnectUploadsOnlyToExplicitOrganization(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	script := `#!/bin/sh
printf '%s' '{"tokens":{"id_token":"synthetic-id-token","access_token":"synthetic-access-token","refresh_token":"synthetic-refresh-token","account_id":"acct"}}' > "$CODEX_HOME/auth.json"
printf 'https://auth.openai.com/codex/device\nABCD-EFGHI\n'
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	var uploaded bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cli/codex" || r.URL.Query().Get("org") != "explicit-org" || r.Header.Get("Authorization") != "Bearer synthetic-cli-token" {
			t.Error("wrong upload authorization or scope")
		}
		if r.Method == "POST" {
			fmt.Fprint(w, `{"attempt":"attempt-one"}`)
			return
		}
		if r.Method == "PUT" {
			var login struct {
				Attempt string            `json:"attempt"`
				Tokens  map[string]string `json:"tokens"`
			}
			if json.NewDecoder(r.Body).Decode(&login) != nil || login.Attempt != "attempt-one" || login.Tokens["refresh_token"] != "synthetic-refresh-token" {
				t.Error("wrong upload")
			}
			uploaded = true
			fmt.Fprint(w, `{"connected":true}`)
			return
		}
	}))
	defer server.Close()
	var out, errout bytes.Buffer
	if code := connectCodex(context.Background(), server.URL, Config{Token: "synthetic-cli-token"}, []string{"--org", "explicit-org"}, &out, &errout); code != 0 {
		t.Fatal(errout.String())
	}
	if !uploaded || strings.Contains(out.String(), "synthetic-") || strings.Contains(errout.String(), "synthetic-") {
		t.Fatal("missing upload or credentials exposed")
	}
}
