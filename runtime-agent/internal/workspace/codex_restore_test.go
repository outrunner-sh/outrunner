package workspace

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/codex"
	"runtime-agent/internal/protocol"
)

// snapshotServer serves a Snapshot's artifacts: a bundle of branch feature,
// no WIP, and whatever else is given.
func snapshotServer(t *testing.T, extra map[string][]byte) *httptest.Server {
	t.Helper()
	repo := newCheckout(t)
	run(t, repo, "switch", "-q", "-c", "feature")
	bundle := filepath.Join(t.TempDir(), "worktree.bundle")
	run(t, repo, "bundle", "create", bundle, "--all")
	data, err := os.ReadFile(bundle)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{"/bundle": data, "/patch": nil}
	for k, v := range extra {
		files[k] = v
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := files[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// restoringService is a fresh box: a bare mirror, no facts, Codex installed.
func restoringService(t *testing.T) (*Service, *fakeSessions) {
	t.Helper()
	isolateGit(t)
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.lookPath = func(string) (string, error) { return "/usr/local/bin/codex", nil }
	s.runCommand = (&loginRecorder{}).run
	fake := newFakeSessions()
	fake.pane = codexPane(t, "ready-trusted.txt")
	s.tmux = fake
	run(t, s.Root, "init", "-q", "--bare", s.mirrorPath())
	t.Cleanup(func() { s.Stop(context.Background(), "ws-r") })
	return s, fake
}

func downloads(srv *httptest.Server, artifacts ...string) []protocol.RestoreDownload {
	var out []protocol.RestoreDownload
	for _, a := range artifacts {
		out = append(out, protocol.RestoreDownload{Artifact: a, URL: srv.URL + "/" + a})
	}
	return out
}

func TestACodexSessionIsRestoredWithItsRolloutAndCredential(t *testing.T) {
	for _, credential := range []protocol.SetAuthRequest{
		{Kind: AuthOpenAIAPIKey, Token: testOpenAIKey},
		{Kind: AuthCodexAccessToken, Token: "synthetic-workspace-access-token"},
	} {
		t.Run(credential.Kind, func(t *testing.T) {
			s, fake := restoringService(t)
			login := &loginRecorder{}
			s.runCommand = login.run
			rollout := fixtureRollout(t, "/work/repo")
			var conversation []byte
			tr := codex.NewTranslator()
			offset := int64(0)
			for _, line := range bytes.SplitAfter(rollout, []byte("\n")) {
				for _, rec := range append(tr.Line(offset, line), tr.Flush()...) {
					conversation = append(conversation, rec.Line...)
				}
				offset += int64(len(line))
			}
			srv := snapshotServer(t, map[string][]byte{"/conversation": conversation, "/rollout": rollout})
			id := fixtureSessionID
			_, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{
				Branch: "feature", BaseBranch: "main", SessionID: &id, Agent: AgentCodex,
				Auth:      &credential,
				Downloads: downloads(srv, "bundle", "patch", "conversation", "rollout"),
			}, nil)
			if err != nil {
				t.Fatalf("Restore: %v", err)
			}
			f, _ := s.getFacts("ws-r")
			sessions := filepath.Join(s.codexHome("ws-r"), "sessions")
			if f.Agent != AgentCodex || f.Auth != credential.Kind || f.CodexSessionID != id ||
				!strings.HasPrefix(f.CodexRollout, sessions) || !strings.HasSuffix(f.CodexRollout, "-"+id+".jsonl") {
				t.Fatalf("facts = %+v, want Codex on its key, its rollout in its own home", f)
			}
			if got := readFileString(t, f.CodexRollout); got != string(rollout) {
				t.Error("the restored rollout differs")
			}
			argv := fake.lastLaunch()
			if !slices.Contains(argv, "CODEX_HOME="+s.codexHome("ws-r")) || !slices.Contains(argv, "resume") || !slices.Contains(argv, id) {
				t.Errorf("launch = %q, want codex resume <id> in its own home", argv)
			}
			// The tail started with the session finds the log already whole.
			s.stopCodexTail("ws-r")
			if got := readFileString(t, conversationPath(s.Root, "ws-r")); got != string(conversation) {
				t.Errorf("the restored conversation was written to again:\n%s", got)
			}
			flag := "--with-api-key"
			if credential.Kind == AuthCodexAccessToken {
				flag = "--with-access-token"
			}
			if len(login.calls) != 1 || !slices.Contains(login.calls[0].argv, flag) || login.calls[0].stdin != credential.Token+"\n" {
				t.Fatal("restore did not log in with the provided credential's own mode")
			}
		})
	}
}

// One on Outrunner's model comes back on it on a fresh box: its rollout in a
// Codex home of its own, whose config puts it on OpenRouter on its key.
func TestACodexSessionOnAGatewayIsRestoredOnIt(t *testing.T) {
	s, fake := restoringService(t)
	s.runCommand = (&loginRecorder{}).run
	srv := snapshotServer(t, map[string][]byte{"/conversation": []byte("{}\n"), "/rollout": fixtureRollout(t, "/work/repo")})
	id := fixtureSessionID
	_, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", BaseBranch: "main", SessionID: &id, Agent: AgentCodex,
		Downloads: downloads(srv, "bundle", "patch", "conversation", "rollout"),
	}, &ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: testGatewayKey2})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	home := s.codexHome("ws-r")
	if f, _ := s.getFacts("ws-r"); f.Gateway != claude.OpenRouter || !strings.HasPrefix(f.CodexRollout, filepath.Join(home, "sessions")) {
		t.Fatalf("facts = %+v, want the session on OpenRouter, its rollout in its own home", f)
	}
	argv := fake.lastLaunch()
	if !slices.Contains(argv, "CODEX_HOME="+home) || !slices.Contains(argv, "resume") || !slices.Contains(argv, "z-ai/glm-5.3") {
		t.Errorf("launch = %q, want codex resume on GLM in its own home", argv)
	}
	if strings.Contains(strings.Join(argv, " "), testGatewayKey2) {
		t.Errorf("the key is on the command line: %q", argv)
	}
	if config := readFileString(t, filepath.Join(home, "config.toml")); !strings.Contains(config, `model_provider = "openrouter"`) || !strings.Contains(config, testGatewayKey2) {
		t.Errorf("config.toml:\n%s", config)
	}
}

func TestACodexSessionWithoutARolloutStartsAfresh(t *testing.T) {
	s, fake := restoringService(t)
	srv := snapshotServer(t, nil)
	_, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", Agent: AgentCodex, Downloads: downloads(srv, "bundle", "patch"),
	}, nil)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if argv := fake.lastLaunch(); argv[0] != "codex" || slices.Contains(argv, "resume") {
		t.Errorf("launch = %q, want a fresh codex in the user's home", argv)
	}
}

// The control plane saves the worktree a restore reports: a session imported
// from a Mac has none on record. It must be the folder the restore rebuilt.
func TestTheWorktreeARestoreReportsIsTheOneItRebuilt(t *testing.T) {
	s, _ := restoringService(t)
	srv := snapshotServer(t, nil)
	if _, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", Agent: AgentCodex, Downloads: downloads(srv, "bundle", "patch"),
	}, nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	worktree := s.Worktree("ws-r")
	if worktree != filepath.Join(s.Root, "workspaces", "ws-r") {
		t.Errorf("worktree = %q, want it under the agent's root", worktree)
	}
	if branch := run(t, worktree, "symbolic-ref", "--short", "HEAD"); branch != "feature" {
		t.Errorf("the reported worktree is on %q, want the restored branch", branch)
	}
}

// A fresh box has no record of the session's model: the restore brings it,
// and the session relaunches on it, through its gateway on its key.
func TestAClaudeSessionIsRestoredOnItsModel(t *testing.T) {
	s, fake := restoringService(t)
	srv := snapshotServer(t, map[string][]byte{"/conversation": []byte("{}\n")})
	id := "sess-1"
	_, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{
		Branch: "feature", BaseBranch: "main", SessionID: &id, Downloads: downloads(srv, "bundle", "patch", "conversation"),
	}, &ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: testGatewayKey2})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if f, _ := s.getFacts("ws-r"); f.Model != "z-ai/glm-5.3" || f.Gateway != claude.OpenRouter {
		t.Fatalf("facts = %+v, want the session on GLM through OpenRouter", f)
	}
	argv := fake.lastLaunch()
	if !slices.Contains(argv, s.gatewayFiles().path("ws-r")) {
		t.Errorf("launch = %q, want claude run after sourcing its gateway's file", argv)
	}
	if strings.Contains(strings.Join(argv, " "), testGatewayKey2) {
		t.Errorf("the key is on the command line: %q", argv)
	}
	if got := readFileString(t, s.gatewayFiles().path("ws-r")); !strings.Contains(got, testGatewayKey2) {
		t.Errorf("gateway file = %q, want the session's key", got)
	}
}

func TestRestoreRefusesWhatItCantResume(t *testing.T) {
	s, fake := restoringService(t)
	srv := snapshotServer(t, map[string][]byte{"/conversation": []byte("{}\n")})
	id := "sess-1"
	for _, c := range []struct {
		name string
		req  protocol.RestoreWorkspaceRequest
		want string
	}{
		{"a Claude session without its id", protocol.RestoreWorkspaceRequest{Branch: "feature"}, "no session id"},
		{"a Codex rollout without its id", protocol.RestoreWorkspaceRequest{Branch: "feature", Agent: AgentCodex,
			Downloads: downloads(srv, "bundle", "patch", "rollout")}, "no session id"},
		{"a credential for the other agent", protocol.RestoreWorkspaceRequest{Branch: "feature", SessionID: &id,
			Auth: &protocol.SetAuthRequest{Kind: AuthOpenAIAPIKey, Token: testOpenAIKey}}, ErrAuthMismatch.Error()},
	} {
		_, err := s.Restore(context.Background(), "ws-r", c.req, nil)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: Restore = %v, want %q", c.name, err, c.want)
		}
	}
	// A Codex session runs through no gateway serving only Claude's API.
	_, err := s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{Branch: "feature", Agent: AgentCodex,
		Downloads: downloads(srv, "bundle", "patch")}, &ModelChoice{Model: "claude-opus-5", Gateway: claude.Anthropic, Token: testAnthropic})
	if !errors.Is(err, ErrGatewayUnsupported) {
		t.Errorf("Restore of Codex through Anthropic's API = %v, want ErrGatewayUnsupported", err)
	}
	// A rollout that isn't the session's is not resumed.
	other := "02b2"
	srv = snapshotServer(t, map[string][]byte{"/conversation": []byte("{}\n"), "/rollout": fixtureRollout(t, "/x")})
	_, err = s.Restore(context.Background(), "ws-r", protocol.RestoreWorkspaceRequest{Branch: "feature", Agent: AgentCodex,
		SessionID: &other, Downloads: downloads(srv, "bundle", "patch", "conversation", "rollout")}, nil)
	if err == nil || !strings.Contains(err.Error(), "not session 02b2") {
		t.Errorf("Restore with another session's rollout = %v", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("an agent was launched: %q", fake.launches)
	}
}

func TestAgentsListsCodexOnlyWhenInstalled(t *testing.T) {
	s := NewService(t.TempDir())
	s.lookPath = func(string) (string, error) { return "", errors.New("not found") }
	if got := s.Agents(); !slices.Equal(got, []string{"claude"}) {
		t.Errorf("Agents without codex = %q", got)
	}
	s.lookPath = func(string) (string, error) { return "/bin/codex", nil }
	if got := s.Agents(); !slices.Equal(got, []string{"claude", "codex"}) {
		t.Errorf("Agents with codex = %q", got)
	}
}

func TestACodexSessionIsArchivedWithItsRollout(t *testing.T) {
	isolateGit(t)
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	run(t, resolved, "init", "-q", "-b", "main")
	run(t, resolved, "commit", "-q", "--allow-empty", "-m", "base")
	writeRollout(t, sessions, time.Now(), "rollout-a.jsonl", fixtureRollout(t, resolved), time.Now())
	drain(&codexTail{s: s, workspaceID: id})
	var mu sync.Mutex
	received := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		received[strings.TrimPrefix(r.URL.Path, "/")] = body
		mu.Unlock()
	}))
	defer srv.Close()
	var uploads []protocol.ArchiveUpload
	for _, a := range []string{"conversation", "cast", "bundle", "patch", "summary", "manifest", "rollout"} {
		uploads = append(uploads, protocol.ArchiveUpload{Artifact: a, URL: srv.URL + "/" + a})
	}
	manifest, err := s.Archive(context.Background(), id, protocol.ArchiveWorkspaceRequest{ArchivedAt: "2026-10-20T00:00:00Z", Uploads: uploads})
	if err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if manifest.SessionID == nil || *manifest.SessionID != fixtureSessionID || manifest.Rollout != "rollout.jsonl" {
		t.Errorf("manifest = %+v, want Codex's session id and the rollout", manifest)
	}
	if received["rollout"] == nil || !strings.Contains(string(received["conversation"]), "codex-"+fixtureSessionID) {
		t.Error("the rollout or the translated conversation wasn't uploaded")
	}
}
