package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"runtime-agent/internal/desktop"
	"runtime-agent/internal/gitcred"
)

// signInsPlane is the control plane as it keeps a box's browser sign-ins:
// it answers a load with kept, and every call with status (200 unset).
type signInsPlane struct {
	t      *testing.T
	mu     sync.Mutex
	calls  []signInsRequest
	kept   *desktop.StorageState
	status int
}

func (p *signInsPlane) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	want := gitcred.SignFor(signInsPurpose, "secret", "box", r.Header.Get("X-Outrunner-Timestamp"), body)
	if r.URL.Path != signInsRoute || r.Header.Get("X-Outrunner-Signature") != want {
		p.t.Errorf("request to %s signed %q, want %s signed for %q", r.URL.Path, r.Header.Get("X-Outrunner-Signature"), signInsRoute, signInsPurpose)
	}
	var call signInsRequest
	_ = json.Unmarshal(body, &call)
	p.mu.Lock()
	p.calls = append(p.calls, call)
	status, kept := p.status, p.kept
	p.mu.Unlock()
	if status != 0 && status != http.StatusOK {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "not this box's"})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"state": kept})
}

func (p *signInsPlane) received() []signInsRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.calls)
}

// signInsBox is a Runtime Computer with a desktop and its browser, whose
// agent reaches plane, and the home its browser's profile is under.
func signInsBox(t *testing.T, plane *signInsPlane) (*Service, string) {
	t.Helper()
	plane.t = t
	home := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	s.RelayExecutable = "/opt/runtime-agent"
	s.DesktopToolbox = desktopToolbox(t).URL
	s.Browser = desktop.NewBrowser(home)
	cp := httptest.NewServer(http.HandlerFunc(plane.serve))
	t.Cleanup(cp.Close)
	if err := s.UseGitCredential(&gitcred.Client{Config: gitcred.Config{AppURL: cp.URL, SandboxID: "box", Secret: "secret"}, HTTP: cp.Client()}); err != nil {
		t.Fatal(err)
	}
	return s, home
}

func createOn(t *testing.T, s *Service, id string) {
	t.Helper()
	if err := os.MkdirAll(s.worktreePath(id), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main"}); err != nil {
		t.Fatalf("Create: %v", err)
	}
}

var lastSessions = desktop.StorageState{
	Cookies: []desktop.Cookie{{Name: "sid", Value: "s", Domain: "staging.example.com", Path: "/", Expires: -1, HTTPOnly: true, Secure: true, SameSite: "Lax"}},
	Origins: []desktop.OriginState{{Origin: "https://staging.example.com", LocalStorage: []desktop.NameValue{{Name: "token", Value: "t"}}}},
}

func TestANewSessionsBoxStartsItsBrowserWithTheLastSessionsSignIns(t *testing.T) {
	plane := &signInsPlane{kept: &lastSessions}
	s, home := signInsBox(t, plane)
	createOn(t, s, "ws-a")

	waiting := filepath.Join(home, ".outrunner", "desktop", "sign-ins.restore.json")
	var data []byte
	for deadline := time.Now().Add(5 * time.Second); len(data) == 0 && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		data, _ = os.ReadFile(waiting)
	}
	var got desktop.StorageState
	if err := json.Unmarshal(data, &got); err != nil || !slices.Equal(got.Cookies, lastSessions.Cookies) || len(got.Origins) != 1 {
		t.Fatalf("waiting for the browser: %s (%v)", data, err)
	}
	if calls := plane.received(); len(calls) != 1 || calls[0].Op != "load" || calls[0].State != nil {
		t.Fatalf("calls = %+v, want one load", calls)
	}

	// Asked once per agent: another session's Create doesn't ask again.
	createOn(t, s, "ws-b")
	time.Sleep(100 * time.Millisecond)
	if calls := plane.received(); len(calls) != 1 {
		t.Errorf("asked %d times", len(calls))
	}
}

func TestABoxWhoseBrowserHasRunKeepsItsOwnSignIns(t *testing.T) {
	plane := &signInsPlane{kept: &lastSessions}
	s, home := signInsBox(t, plane)
	if err := os.MkdirAll(filepath.Join(home, ".outrunner", "desktop", "chromium"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := s.restoreSignIns(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls := plane.received(); len(calls) != 0 {
		t.Fatalf("asked for the last session's: %+v", calls)
	}
}

func TestABoxWithoutADesktopNeverAsksForSignIns(t *testing.T) {
	plane := &signInsPlane{kept: &lastSessions}
	s, _ := signInsBox(t, plane)
	s.DesktopToolbox = ""
	if err := s.restoreSignIns(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls := plane.received(); len(calls) != 0 {
		t.Fatalf("asked for sign-ins: %+v", calls)
	}
}

func TestSignInsAreSentToBeKept(t *testing.T) {
	plane := &signInsPlane{}
	s, _ := signInsBox(t, plane)
	if err := s.saveSignIns(context.Background(), lastSessions); err != nil {
		t.Fatal(err)
	}
	calls := plane.received()
	if len(calls) != 1 || calls[0].Op != "save" || calls[0].State == nil || !slices.Equal(calls[0].State.Cookies, lastSessions.Cookies) {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestASharedBoxsSignInsArentKept(t *testing.T) {
	plane := &signInsPlane{status: http.StatusConflict}
	s, _ := signInsBox(t, plane)
	if state, err := s.loadSignIns(context.Background()); state != nil || err != nil {
		t.Errorf("load = %+v, %v; want none", state, err)
	}
	if err := s.saveSignIns(context.Background(), lastSessions); !errors.Is(err, desktop.ErrNotKept) {
		t.Errorf("save = %v, want ErrNotKept", err)
	}
	plane.status = http.StatusServiceUnavailable
	if err := s.saveSignIns(context.Background(), lastSessions); err == nil || errors.Is(err, desktop.ErrNotKept) {
		t.Errorf("save on a 503 = %v, want an error to try again on", err)
	}
}
