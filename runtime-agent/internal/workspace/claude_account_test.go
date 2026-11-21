package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/protocol"
)

const (
	workToken     = "sk-ant-oat01-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	personalToken = "sk-ant-oat01-personal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func reply(model, text string) *protocol.ConversationMessage {
	return &protocol.ConversationMessage{Role: "assistant", Model: model, Content: []protocol.ContentBlock{{Type: "text", Text: text}}}
}

func TestOnlyClaudeCodesOwnLimitNoticeCounts(t *testing.T) {
	for _, tc := range []struct {
		message *protocol.ConversationMessage
		hit     bool
		resets  string
	}{
		{reply("<synthetic>", "You've hit your session limit · resets 3pm (Asia/Calcutta)"), true, ""},
		{reply("<synthetic>", "You've hit your weekly limit · resets Nov 27, 9am"), true, ""},
		{reply("<synthetic>", "You've hit your 5-hour limit"), true, ""},
		{reply("<synthetic>", "Claude AI usage limit reached|1795251600"), true, "2026-11-21T09:00:00Z"},
		// The model talking about limits is not a limit.
		{reply("claude-opus-5-5", "You've hit your session limit, so I'll stop here."), false, ""},
		{reply("<synthetic>", "No response requested."), false, ""},
		{reply("<synthetic>", "API Error: 500 internal server error"), false, ""},
		{&protocol.ConversationMessage{Role: "user", Content: []protocol.ContentBlock{{Type: "text", Text: "usage limit reached"}}}, false, ""},
	} {
		hit, resets := claudeLimit(tc.message)
		if hit != tc.hit || resets != tc.resets {
			t.Errorf("%q: got %v %q, want %v %q", tc.message.Content[0].Text, hit, resets, tc.hit, tc.resets)
		}
	}
}

func TestTheSubscriptionTokenIsReadBackFromItsAuthFile(t *testing.T) {
	if got := oauthTokenOf(authEnvFile(AuthClaudeOAuthToken, workToken)); got != workToken {
		t.Fatalf("got %q", got)
	}
	if got := oauthTokenOf(authEnvFile(AuthAnthropicAPIKey, "sk-ant-api03-"+strings.Repeat("k", 40))); got != "" {
		t.Fatalf("an API key file gave %q", got)
	}
}

// limitSession is a Claude session on the work subscription, its box
// signed in to a fake control plane that answers with `answer`.
func limitSession(t *testing.T, answer claudeAccountAnswer) (s *Service, id string, asked *[]claudeAccountRequest, switched *[]string) {
	t.Helper()
	id = "ws-limit"
	s, _ = cloudSession(t, CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main"})
	if err := s.SetAuth(context.Background(), id, AuthClaudeOAuthToken, workToken); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	asked, switched = &[]claudeAccountRequest{}, &[]string{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != claudeAccountRoute || r.Header.Get("X-Outrunner-Signature") == "" {
			t.Errorf("unexpected request %s, signed %q", r.URL.Path, r.Header.Get("X-Outrunner-Signature"))
		}
		var in claudeAccountRequest
		_ = json.NewDecoder(r.Body).Decode(&in)
		mu.Lock()
		*asked = append(*asked, in)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(answer)
	}))
	t.Cleanup(cp.Close)
	s.RelayExecutable = "/opt/runtime-agent"
	if err := s.UseGitCredential(&gitcred.Client{Config: gitcred.Config{AppURL: cp.URL, SandboxID: "box", Secret: "secret"}, HTTP: cp.Client()}); err != nil {
		t.Fatal(err)
	}
	s.claudeAccountSwitch = func(_ context.Context, sid, token, resume string) error {
		mu.Lock()
		defer mu.Unlock()
		*switched = append(*switched, sid+"|"+token+"|"+resume)
		return nil
	}
	return s, id, asked, switched
}

func TestALimitAsksForTheNextAccountByTokenHashAndSwitchesOnce(t *testing.T) {
	s, id, asked, switched := limitSession(t, claudeAccountAnswer{Token: personalToken, Label: "personal", From: "work"})
	s.claudeLimitReached(id, "limit-1", "2026-11-21T15:00:00Z", time.Now())

	hash := sha256.Sum256([]byte(workToken))
	if len(*asked) != 1 || (*asked)[0].Workspace != id || (*asked)[0].TokenSHA256 != hex.EncodeToString(hash[:]) || (*asked)[0].ResetsAt != "2026-11-21T15:00:00Z" {
		t.Fatalf("asked %+v", *asked)
	}
	if strings.Contains((*asked)[0].TokenSHA256, "work-aaaa") {
		t.Fatal("the token itself was sent")
	}
	if len(*switched) != 1 || !strings.HasPrefix((*switched)[0], id+"|"+personalToken+"|") || !strings.Contains((*switched)[0], `"work" hit its usage limit, so this session now runs on "personal"`) {
		t.Fatalf("switched %v", *switched)
	}
	// The same notice, replayed after the relaunch, is never handled again.
	s.claudeLimitReached(id, "limit-1", "", time.Now())
	if len(*asked) != 1 || len(*switched) != 1 {
		t.Fatalf("a replayed notice asked again: %d asks, %d switches", len(*asked), len(*switched))
	}
	if f, _ := s.getFacts(id); f.ClaudeLimitSeen != "limit-1" {
		t.Fatalf("seen %q", f.ClaudeLimitSeen)
	}
}

func TestAnOldNoticeIsHistoryAndNoNextAccountMeansNoSwitch(t *testing.T) {
	s, id, asked, switched := limitSession(t, claudeAccountAnswer{FirstReset: "2026-11-21T14:00:00Z"})
	s.claudeLimitReached(id, "old", "", time.Now().Add(-time.Hour))
	if len(*asked) != 0 {
		t.Fatalf("an hour-old notice asked: %+v", *asked)
	}
	s.claudeLimitReached(id, "new", "", time.Now())
	if len(*asked) != 1 || len(*switched) != 0 {
		t.Fatalf("with no next account: %d asks, %d switches", len(*asked), len(*switched))
	}
}

func TestOnlyASessionOnItsOwnSubscriptionSwitches(t *testing.T) {
	s, id, asked, _ := limitSession(t, claudeAccountAnswer{Token: personalToken, Label: "personal"})
	if err := s.SetAuth(context.Background(), id, AuthAnthropicAPIKey, "sk-ant-api03-"+strings.Repeat("k", 40)); err != nil {
		t.Fatal(err)
	}
	s.claudeLimitReached(id, "on-a-key", "", time.Now())
	if len(*asked) != 0 {
		t.Fatalf("a session on an API key asked: %+v", *asked)
	}
}

func TestSwitchingAccountsPutsTheNewTokenInTheSessionsAuthFile(t *testing.T) {
	id := "ws-switch"
	s, _ := cloudSession(t, CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main"})
	if err := s.SetAuth(context.Background(), id, AuthClaudeOAuthToken, workToken); err != nil {
		t.Fatal(err)
	}
	if err := s.SwitchClaudeAccount(context.Background(), id, personalToken, "carry on"); err != nil {
		t.Fatalf("switch: %v", err)
	}
	if got := oauthTokenOf(s.authFiles().read(id)); got != personalToken {
		t.Fatalf("auth file token %q", got)
	}
	if f, _ := s.getFacts(id); f.Auth != AuthClaudeOAuthToken {
		t.Fatalf("auth kind %q", f.Auth)
	}
	if err := s.SwitchClaudeAccount(context.Background(), id, "bad token with spaces", ""); err == nil {
		t.Fatal("a malformed token was taken")
	}
}
