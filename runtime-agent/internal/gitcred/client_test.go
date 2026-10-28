package gitcred

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

var testNow = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

// controlPlane stands in for the control plane's credential endpoint,
// recording what it was sent.
type controlPlane struct {
	*httptest.Server
	requests []*http.Request
	bodies   []string
	status   int
	answer   string
}

func newControlPlane(t *testing.T, status int, answer string) *controlPlane {
	t.Helper()
	cp := &controlPlane{status: status, answer: answer}
	cp.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cp.requests = append(cp.requests, r)
		cp.bodies = append(cp.bodies, string(body))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(cp.status)
		_, _ = io.WriteString(w, cp.answer)
	}))
	t.Cleanup(cp.Close)
	return cp
}

func (cp *controlPlane) client() *Client {
	return &Client{
		Config: Config{AppURL: cp.URL, SandboxID: "sbx_123", Secret: "agent-secret"},
		HTTP:   cp.Client(),
		Now:    func() time.Time { return testNow },
	}
}

func TestFetchSignsTheRequest(t *testing.T) {
	cp := newControlPlane(t, http.StatusOK, `{"token":"ghs_app","expiresAt":"2026-10-27T13:00:00Z","identity":"app"}`)
	cred, err := cp.client().Fetch(context.Background(), "acme/widgets")
	if err != nil {
		t.Fatal(err)
	}
	if cred.Token != "ghs_app" || cred.Identity != "app" || !cred.ExpiresAt.Equal(testNow.Add(time.Hour)) {
		t.Fatalf("credential = %+v", cred)
	}
	req, body := cp.requests[0], cp.bodies[0]
	if req.Method != http.MethodPost || req.URL.Path != "/api/runtime/git-credential" {
		t.Fatalf("request = %s %s", req.Method, req.URL.Path)
	}
	if body != `{"repo":"acme/widgets"}` {
		t.Fatalf("body = %s", body)
	}
	timestamp := "1793102400" // testNow
	if req.Header.Get("Content-Type") != "application/json" || req.Header.Get("X-Outrunner-Sandbox") != "sbx_123" || req.Header.Get("X-Outrunner-Timestamp") != timestamp {
		t.Fatalf("headers = %v", req.Header)
	}
	mac := hmac.New(sha256.New, []byte("agent-secret"))
	mac.Write([]byte("git-credential\nsbx_123\n" + timestamp + "\n" + body))
	if want := "sha256=" + hex.EncodeToString(mac.Sum(nil)); req.Header.Get("X-Outrunner-Signature") != want {
		t.Fatalf("signature = %q, want %q", req.Header.Get("X-Outrunner-Signature"), want)
	}
}

func TestFetchForTheProjectSendsAnEmptyObject(t *testing.T) {
	cp := newControlPlane(t, http.StatusOK, `{"token":"gho_user","expiresAt":null,"identity":"personal"}`)
	cred, err := cp.client().Fetch(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if cp.bodies[0] != `{}` {
		t.Fatalf("body = %s", cp.bodies[0])
	}
	if cred.Token != "gho_user" || !cred.ExpiresAt.IsZero() || cred.Identity != "personal" {
		t.Fatalf("credential = %+v", cred)
	}
}

func TestFetchPassesTheControlPlanesRefusalOn(t *testing.T) {
	cp := newControlPlane(t, http.StatusForbidden, `{"error":"The Outrunner GitHub App isn't installed on acme"}`)
	_, err := cp.client().Fetch(context.Background(), "acme/widgets")
	var refusal *Error
	if !errors.As(err, &refusal) || refusal.Status != http.StatusForbidden || refusal.Message != "The Outrunner GitHub App isn't installed on acme" {
		t.Fatalf("err = %v", err)
	}

	cp = newControlPlane(t, http.StatusBadGateway, `<html>bad gateway</html>`)
	if _, err := cp.client().Fetch(context.Background(), ""); !errors.As(err, &refusal) || refusal.Status != http.StatusBadGateway {
		t.Fatalf("err = %v", err)
	}

	cp = newControlPlane(t, http.StatusOK, `{"token":""}`)
	if _, err := cp.client().Fetch(context.Background(), ""); err == nil {
		t.Fatal("an answer without a token was taken")
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{
		"OUTRUNNER_APP_URL":    "https://app.outrunner.sh/",
		"RUNTIME_SANDBOX_ID":   "sbx_123",
		"RUNTIME_AGENT_SECRET": "s",
	}
	cfg, ok := ConfigFromEnv(func(k string) string { return env[k] })
	if !ok || cfg.AppURL != "https://app.outrunner.sh" || cfg.SandboxID != "sbx_123" || cfg.Secret != "s" {
		t.Fatalf("config = %+v, %v", cfg, ok)
	}
	for _, missing := range []string{"OUTRUNNER_APP_URL", "RUNTIME_SANDBOX_ID", "RUNTIME_AGENT_SECRET"} {
		partial := map[string]string{}
		for k, v := range env {
			if k != missing {
				partial[k] = v
			}
		}
		if _, ok := ConfigFromEnv(func(k string) string { return partial[k] }); ok {
			t.Errorf("on without %s", missing)
		}
	}
}
