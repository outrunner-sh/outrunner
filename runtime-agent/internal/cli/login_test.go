package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeApp is the app's half of signing in, as lib/auth/cli-login.ts has it:
// it hands out a code for a challenge, and trades the code and its verifier
// for a token once.
type fakeApp struct {
	mu     sync.Mutex
	codes  map[string]string // code -> challenge
	tokens map[string]bool
	server *httptest.Server
}

func (app *fakeApp) setCode(code, challenge string) {
	app.mu.Lock()
	defer app.mu.Unlock()
	app.codes[code] = challenge
}

func (app *fakeApp) hasCode(code string) bool {
	app.mu.Lock()
	defer app.mu.Unlock()
	_, ok := app.codes[code]
	return ok
}

func (app *fakeApp) tokenWorks(token string) bool {
	app.mu.Lock()
	defer app.mu.Unlock()
	return app.tokens[token]
}

func newFakeApp(t *testing.T) *fakeApp {
	app := &fakeApp{codes: map[string]string{}, tokens: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/cli/token", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Code, Verifier string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		app.mu.Lock()
		defer app.mu.Unlock()
		challenge, ok := app.codes[body.Code]
		delete(app.codes, body.Code)
		sum := sha256.Sum256([]byte(body.Verifier))
		if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"That sign-in has expired or was already used."}`))
			return
		}
		app.tokens["or_cli_token"] = true
		_, _ = w.Write([]byte(`{"token":"or_cli_token","user":{"login":"immad","name":"Immad","email":"immad@example.com"}}`))
	})
	mux.HandleFunc("GET /api/cli/whoami", func(w http.ResponseWriter, r *http.Request) {
		if !app.tokenWorks(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"login":"immad","name":"Immad","email":null}`))
	})
	mux.HandleFunc("DELETE /api/cli/token", func(w http.ResponseWriter, r *http.Request) {
		app.mu.Lock()
		defer app.mu.Unlock()
		delete(app.tokens, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		w.WriteHeader(http.StatusNoContent)
	})
	app.server = httptest.NewServer(mux)
	t.Cleanup(app.server.Close)
	return app
}

// approve is the browser: open /cli-login, approve, follow the redirect back
// to the CLI. It returns where the CLI sent the browser next.
func (app *fakeApp) approve(t *testing.T, state string) func(string) error {
	return func(loginURL string) error {
		u, err := url.Parse(loginURL)
		if err != nil || u.Path != "/cli-login" {
			t.Errorf("opened %q, not /cli-login", loginURL)
			return nil
		}
		q := u.Query()
		if q.Get("name") == "" || len(q.Get("challenge")) != 43 {
			t.Errorf("login URL is missing parts: %q", loginURL)
		}
		app.setCode("the-code", q.Get("challenge"))
		if state == "" {
			state = q.Get("state")
		}
		callback := "http://127.0.0.1:" + q.Get("port") + "/callback?code=the-code&state=" + url.QueryEscape(state)
		go func() {
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			res, err := client.Get(callback)
			if err == nil {
				res.Body.Close()
			}
		}()
		return nil
	}
}

func TestLoginTradesTheBrowsersCodeForAToken(t *testing.T) {
	app := newFakeApp(t)
	var out bytes.Buffer
	token, user, err := Login(context.Background(), LoginOptions{
		BaseURL: app.server.URL, DeviceName: "Mac", After: "/onboarding",
		OpenBrowser: app.approve(t, ""), Out: &out,
	})
	if err != nil {
		t.Fatal(err)
	}
	if token != "or_cli_token" || user.Login != "immad" {
		t.Fatalf("got %q as %+v", token, user)
	}
	if !strings.Contains(out.String(), app.server.URL+"/cli-login?") {
		t.Errorf("the URL to open isn't printed: %q", out.String())
	}
}

func TestLoginRefusedByTheAppIsAnError(t *testing.T) {
	app := newFakeApp(t)
	open := app.approve(t, "")
	_, _, err := Login(context.Background(), LoginOptions{
		BaseURL: app.server.URL, DeviceName: "Mac",
		OpenBrowser: func(u string) error {
			_ = open(u)
			app.setCode("the-code", "a-different-challenge")
			return nil
		},
		Out: &bytes.Buffer{},
	})
	if err == nil || !strings.Contains(err.Error(), "expired or was already used") {
		t.Fatalf("got %v", err)
	}
}

func TestLoginIgnoresACallbackForAnotherTerminal(t *testing.T) {
	app := newFakeApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	status := 0
	_, _, err := Login(ctx, LoginOptions{
		BaseURL: app.server.URL, DeviceName: "Mac",
		OpenBrowser: func(loginURL string) error {
			u, _ := url.Parse(loginURL)
			app.setCode("the-code", u.Query().Get("challenge"))
			res, err := http.Get("http://127.0.0.1:" + u.Query().Get("port") + "/callback?code=the-code&state=someone-elses-state")
			if err == nil {
				status = res.StatusCode
				res.Body.Close()
			}
			// Refused, and still waiting for its own browser: stop it here.
			cancel()
			return nil
		},
		Out: &bytes.Buffer{},
	})
	if status != http.StatusBadRequest {
		t.Errorf("the other terminal's callback got %d", status)
	}
	if err == nil || app.tokenWorks("or_cli_token") || !app.hasCode("the-code") {
		t.Fatalf("signed in through another terminal's callback: %v", err)
	}
}

func TestConfigIsOnlyTheUsersToRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "cli.json")
	if err := SaveConfig(path, Config{URL: "https://app", Token: "or_cli_x", Login: "immad"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, %v", info.Mode().Perm(), err)
	}
	got, err := LoadConfig(path)
	if err != nil || got.Token != "or_cli_x" {
		t.Fatalf("got %+v, %v", got, err)
	}
	empty, err := LoadConfig(filepath.Join(t.TempDir(), "none.json"))
	if err != nil || empty.Token != "" {
		t.Fatalf("a missing config isn't empty: %+v, %v", empty, err)
	}
}

func TestWhoAmIAndLogout(t *testing.T) {
	app := newFakeApp(t)
	app.tokens["or_cli_token"] = true // before any request: no race
	t.Setenv("OUTRUNNER_CONFIG", filepath.Join(t.TempDir(), "cli.json"))
	path, _ := ConfigPath()
	_ = SaveConfig(path, Config{URL: app.server.URL, Token: "or_cli_token"})

	var out, errOut bytes.Buffer
	if code := Main(context.Background(), []string{"--url", app.server.URL, "whoami"}, &out, &errOut); code != 0 {
		t.Fatalf("whoami: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "immad") {
		t.Errorf("whoami printed %q", out.String())
	}

	if code := Main(context.Background(), []string{"--url", app.server.URL, "logout"}, &out, &errOut); code != 0 {
		t.Fatalf("logout: %d %s", code, errOut.String())
	}
	if app.tokenWorks("or_cli_token") {
		t.Error("logout left the token working")
	}
	if config, _ := LoadConfig(path); config.Token != "" {
		t.Error("logout left the token saved")
	}
	errOut.Reset()
	if code := Main(context.Background(), []string{"--url", app.server.URL, "whoami"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "Not signed in") {
		t.Fatalf("whoami after logout: %d %q", code, errOut.String())
	}
}

func TestATokenIsOnlyForTheAppItCameFrom(t *testing.T) {
	app := newFakeApp(t)
	t.Setenv("OUTRUNNER_CONFIG", filepath.Join(t.TempDir(), "cli.json"))
	path, _ := ConfigPath()
	_ = SaveConfig(path, Config{URL: "https://another.app", Token: "or_cli_token"})
	var out, errOut bytes.Buffer
	if code := Main(context.Background(), []string{"--url", app.server.URL, "whoami"}, &out, &errOut); code != 1 {
		t.Fatalf("a token for another app was sent: %d", code)
	}
}
