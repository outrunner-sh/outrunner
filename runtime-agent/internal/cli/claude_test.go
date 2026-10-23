package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/creack/pty"
)

const fakeLink = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
const fakeToken = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789"

// fakeClaude writes a `claude` that does what setup-token's script says, and
// puts it first on the PATH.
func fakeClaude(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	body := "#!/bin/sh\n[ \"$1\" = setup-token ] || exit 64\n" + script + "\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}

// The link as Claude Code prints it: wrapped in an OSC-8 hyperlink, in colour.
const printLink = `printf 'Opening browser to sign in\033[0m\n\033]8;id=1;` + fakeLink + `\033\\` + fakeLink + `\033]8;;\033\\\n'`

func TestSetupTokenFinishesOnItsOwnOnceApproved(t *testing.T) {
	binary := fakeClaude(t, printLink+"\nsleep 0.2\nprintf '\\033[32m"+fakeToken+"\\033[0m\\n'")
	var out bytes.Buffer
	token, err := SetupToken(context.Background(), ClaudeOptions{Binary: binary, Lines: make(chan string), Out: &out})
	if err != nil || token != fakeToken {
		t.Fatalf("got %q, %v", token, err)
	}
	if !strings.Contains(out.String(), fakeLink) {
		t.Errorf("the sign-in link isn't shown: %q", out.String())
	}
	if strings.Contains(out.String(), fakeToken) {
		t.Error("the token was printed")
	}
}

func TestSetupTokenTakesACodeTheUserPastes(t *testing.T) {
	binary := fakeClaude(t, printLink+`
printf 'Paste code here if prompted > '
read code
[ "$code" = "the-code#state" ] && echo `+fakeToken+` || { echo "Invalid code"; exit 1; }`)
	lines := make(chan string, 1)
	lines <- "  the-code#state  "
	token, err := SetupToken(context.Background(), ClaudeOptions{Binary: binary, Lines: lines, Out: &bytes.Buffer{}})
	if err != nil || token != fakeToken {
		t.Fatalf("got %q, %v", token, err)
	}
}

func TestSetupTokenWithoutASubscriptionSaysWhatClaudeSaid(t *testing.T) {
	binary := fakeClaude(t, printLink+"\necho 'Error: this account has no Claude subscription'\nexit 1")
	_, err := SetupToken(context.Background(), ClaudeOptions{Binary: binary, Lines: make(chan string), Out: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), "Pro or Max") || !strings.Contains(err.Error(), "no Claude subscription") {
		t.Fatalf("got %v", err)
	}
}

func TestSetupTokenThatGivesNoLinkSaysSo(t *testing.T) {
	binary := fakeClaude(t, "echo 'Welcome to Claude Code! Choose a theme'\nexit 0")
	_, err := SetupToken(context.Background(), ClaudeOptions{Binary: binary, Lines: make(chan string), Out: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), "sign-in link") || !strings.Contains(err.Error(), "Choose a theme") {
		t.Fatalf("got %v", err)
	}
}

func TestAFailureNeverShowsAToken(t *testing.T) {
	if said := lastLines("\x1b[31mtoken sk-ant-oat01-secretsecretsecret\x1b[0m\nfailed\n"); strings.Contains(said, "secret") {
		t.Fatalf("got %q", said)
	}
}

func TestClaudeCommandSavesTheTokenToTheAccount(t *testing.T) {
	app := newFakeApp(t)
	app.tokens["or_cli_token"] = true // before any request: no race
	var saved string
	app.server.Config.Handler.(*http.ServeMux).HandleFunc("PUT /api/cli/claude", func(w http.ResponseWriter, r *http.Request) {
		if !app.tokenWorks(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct{ Token string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		saved = body.Token
		_, _ = w.Write([]byte(`{"connected":true,"last4":"6789"}`))
	})
	fakeClaude(t, printLink+"\necho "+fakeToken)
	t.Setenv("OUTRUNNER_CONFIG", filepath.Join(t.TempDir(), "cli.json"))
	path, _ := ConfigPath()
	_ = SaveConfig(path, Config{URL: app.server.URL, Token: "or_cli_token", Login: "immad"})

	var out, errOut bytes.Buffer
	if code := Main(context.Background(), []string{"--url", app.server.URL, "claude"}, nil, &out, &errOut); code != 0 {
		t.Fatalf("claude: %d %s", code, errOut.String())
	}
	if saved != fakeToken {
		t.Fatalf("saved %q", saved)
	}
	if !strings.Contains(out.String(), "✓ Claude Code connected (token …6789)") {
		t.Errorf("printed %q", out.String())
	}
}

func TestClaudeCommandNeedsSigningInFirst(t *testing.T) {
	t.Setenv("OUTRUNNER_CONFIG", filepath.Join(t.TempDir(), "cli.json"))
	var out, errOut bytes.Buffer
	if code := Main(context.Background(), []string{"--url", "http://127.0.0.1:1", "claude"}, nil, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "outrunner login") {
		t.Fatalf("got %d %q", code, errOut.String())
	}
}

func TestOnlyATerminalIsAskedAnything(t *testing.T) {
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	if isTerminal(devNull) || isTerminal(strings.NewReader("yes\n")) || isTerminal(nil) {
		t.Error("something that isn't a terminal was taken for one")
	}
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Skip("no pty here:", err)
	}
	defer ptmx.Close()
	defer tty.Close()
	if !isTerminal(tty) {
		t.Error("a terminal wasn't taken for one")
	}
}
