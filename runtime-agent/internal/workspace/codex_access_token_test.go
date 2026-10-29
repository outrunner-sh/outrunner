package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// These tests use synthetic credentials and a stand-in login process. They
// exercise the session lifecycle, not provider acceptance or entitlement.
func TestCodexAccessTokenLoginIsIsolatedAndSurvivesAnAgentRestart(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-access", Branch: "b"})
	const token = "synthetic-workspace-access-token"
	ctx := context.Background()
	s.env = []string{"PATH=/usr/bin", "CODEX_HOME=/another/home", "OPENAI_API_KEY=another-key", "CODEX_ACCESS_TOKEN=another-token"}
	if err := s.SetAuth(ctx, id, AuthCodexAccessToken, token); err != nil {
		t.Fatal(err)
	}
	// A restarted agent recovers the credential and kind from its own disk.
	restarted := NewService(s.Root)
	restarted.env, restarted.tmux, restarted.lookPath = s.env, fake, s.lookPath
	login := &loginRecorder{}
	restarted.runCommand = login.run
	if _, err := restarted.Start(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restarted.stopRecorder(ctx, id); restarted.stopCodexTail(id) })
	if len(login.calls) != 1 {
		t.Fatalf("login calls = %d, want 1", len(login.calls))
	}
	call := login.calls[0]
	if !slices.Equal(call.argv, []string{"codex", "login", "--with-access-token"}) || call.stdin != token+"\n" {
		t.Fatal("the access token was not passed through stdin to its own login mode")
	}
	for _, entry := range call.env {
		if strings.HasPrefix(entry, "OPENAI_API_KEY=") || strings.HasPrefix(entry, "CODEX_ACCESS_TOKEN=") || entry == "CODEX_HOME=/another/home" {
			t.Fatal("the login inherited another account's credential or home")
		}
	}
	if !slices.Contains(call.env, "CODEX_HOME="+s.codexHome(id)) {
		t.Fatal("login did not use the session's own home")
	}
	for _, name := range []string{s.authFiles().path(id), filepath.Join(s.codexHome(id), "config.toml")} {
		if stat, err := os.Stat(name); err != nil || stat.Mode().Perm() != 0o600 {
			t.Fatalf("%s must be owner-only: %v", name, err)
		}
	}
	argv := strings.Join(fake.lastLaunch(), " ")
	if strings.Contains(argv, token) || !strings.Contains(argv, "-u CODEX_ACCESS_TOKEN") || !strings.Contains(argv, "-u OPENAI_API_KEY") {
		t.Fatal("launch exposes the token or permits an inherited credential to win")
	}
	if !slices.Contains(restarted.RedactionSecrets(), token) {
		t.Fatal("restarted agent does not redact the access token")
	}
}

func TestCodexAccessTokenReplacementAndRemovalDiscardTheCachedLogin(t *testing.T) {
	t.Parallel()
	s, _, id := codexSession(t, CreateInput{WorkspaceID: "ws-replace", Branch: "b"})
	ctx := context.Background()
	const token = "synthetic-workspace-access-token"
	if err := s.SetAuth(ctx, id, AuthCodexAccessToken, token); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(s.codexHome(id), 0o700); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(s.codexHome(id), "auth.json")
	if err := os.WriteFile(cache, []byte(`{"synthetic":"cached-login"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAuth(ctx, id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatal("changing credential kind retained the old access-token cache")
	}
	if s.authFiles().value(id, "CODEX_ACCESS_TOKEN") != "" || s.authFiles().value(id, "OPENAI_API_KEY") != testOpenAIKey {
		t.Fatal("API-key replacement retained the active access token")
	}
	if !slices.Contains(s.RedactionSecrets(), token) {
		t.Fatal("replaced credential must remain redacted in the conversation")
	}
	if err := s.SetAuth(ctx, id, AuthCodexAccessToken, token); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cache, []byte(`{"synthetic":"cached-login"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAuth(ctx, id, AuthNone, ""); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{cache, s.authFiles().path(id)} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatal("removing a credential retained an active credential file")
		}
	}
}

func TestCodexAccessTokenFailureNeverLaunchesOrReturnsTheToken(t *testing.T) {
	t.Parallel()
	for _, missing := range []bool{false, true} {
		s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-refused", Branch: "b"})
		const token = "synthetic-workspace-access-token"
		if err := s.SetAuth(context.Background(), id, AuthCodexAccessToken, token); err != nil {
			t.Fatal(err)
		}
		s.runCommand = (&loginRecorder{err: errors.New("exit status 1"), out: "expired: " + token + " derived-credential-from-exchange"}).run
		if missing {
			if err := os.Remove(s.authFiles().path(id)); err != nil {
				t.Fatal(err)
			}
		}
		_, err := s.Start(context.Background(), id, "")
		if err == nil || strings.Contains(err.Error(), token) || strings.Contains(err.Error(), "derived-credential") || len(fake.launches) != 0 {
			t.Fatal("a missing/expired credential launched, or the failure disclosed the token")
		}
	}
}

func TestCodexAccessTokenHasItsOwnBounds(t *testing.T) {
	for _, length := range []int{19, 20, 400, 401, 16384, 16385} {
		valid := length >= 20 && length <= 16384
		if ValidAuthToken(AuthCodexAccessToken, strings.Repeat("a", length)) != valid {
			t.Errorf("access token length %d: want valid=%v", length, valid)
		}
	}
	if ValidAuthToken(AuthOpenAIAPIKey, strings.Repeat("a", 401)) {
		t.Fatal("API-key bounds were widened")
	}
	for _, suffix := range []string{" ", "\n", "'", "\\", "\x7f", "é"} {
		if ValidAuthToken(AuthCodexAccessToken, "synthetic-workspace-access-token"+suffix) {
			t.Fatalf("invalid access token suffix %q accepted", suffix)
		}
	}
}
