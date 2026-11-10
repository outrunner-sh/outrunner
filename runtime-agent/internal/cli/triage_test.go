package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func triageApp(t *testing.T, got *map[string]any) *httptest.Server {
	return triageAppOrg(t, got, new(string))
}

func triageAppOrg(t *testing.T, got *map[string]any, org *string) *httptest.Server {
	t.Helper()
	// The terminal's sign-in is what's sent, whatever this shell has set.
	t.Setenv("OUTRUNNER_API_KEY", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/triage/items" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		*org = r.URL.Query().Get("org")
		_ = json.NewDecoder(r.Body).Decode(got)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"key":"OR-7","url":"https://app/triage?item=x","created":true,"item":{"title":"Fix the flaky test"}}`))
	}))
	t.Cleanup(server.Close)
	return server
}

func lines(text ...string) terminal {
	ch := make(chan string, len(text))
	for _, line := range text {
		ch <- line
	}
	close(ch)
	return terminal{lines: ch}
}

func TestTriageSendsTheTextAndRepo(t *testing.T) {
	var got map[string]any
	server := triageApp(t, &got)
	var out, errs bytes.Buffer
	code := triage(context.Background(), server.URL, Config{Token: "good"},
		[]string{"--repo", "acme/web", "Fix", "the", "flaky", "test"}, terminal{interactive: true}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if got["body"] != "Fix the flaky test" || got["project"] != "acme/web" || got["source"] != "cli" {
		t.Fatalf("sent %v", got)
	}
	if !strings.Contains(out.String(), "OR-7") {
		t.Fatalf("printed %q", out.String())
	}
}

func TestTriageReadsPipedText(t *testing.T) {
	var got map[string]any
	server := triageApp(t, &got)
	var out, errs bytes.Buffer
	code := triage(context.Background(), server.URL, Config{Token: "good"}, nil,
		lines("Fix the flaky test", "", "It fails on Safari."), &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if got["body"] != "Fix the flaky test\n\nIt fails on Safari." {
		t.Fatalf("sent %v", got)
	}
}

func TestTriageNeedsTextAndASignIn(t *testing.T) {
	var out, errs bytes.Buffer
	if code := triage(context.Background(), "http://unused", Config{Token: "good"}, nil, terminal{interactive: true}, &out, &errs); code != 2 {
		t.Fatalf("no text: exit %d", code)
	}
	var got map[string]any
	server := triageApp(t, &got)
	if code := triage(context.Background(), server.URL, Config{Token: "stale"}, []string{"x"}, terminal{interactive: true}, &out, &errs); code != 1 {
		t.Fatalf("signed out: exit %d", code)
	}
	if !strings.Contains(errs.String(), "outrunner login") {
		t.Fatalf("said %q", errs.String())
	}
}

func TestTriageNamesTheOrg(t *testing.T) {
	var got map[string]any
	var org string
	server := triageAppOrg(t, &got, &org)
	var out, errs bytes.Buffer
	code := triage(context.Background(), server.URL, Config{Token: "good"},
		[]string{"--org", "Acme Inc", "Fix it"}, terminal{interactive: true}, &out, &errs)
	if code != 0 || org != "Acme Inc" {
		t.Fatalf("exit %d, org %q: %s", code, org, errs.String())
	}
}

func TestTriageWithAnAPIKeyFilesThroughTheAPI(t *testing.T) {
	var got map[string]any
	var asked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.Method + " " + r.URL.Path + "?" + r.URL.RawQuery
		if r.Header.Get("Authorization") != "Bearer or_key_ci" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"That API key was revoked.","status":401}}`))
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"i1","key":"OR-8","title":"Fix the flaky test","url":"https://app/triage?item=i1","created":true}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("OUTRUNNER_API_KEY", "or_key_ci")
	var out, errs bytes.Buffer
	// No sign-in on this computer: a CI job's.
	code := triage(context.Background(), server.URL, Config{},
		[]string{"--repo", "acme/web", "--org", "acme", "Fix the flaky test"}, terminal{interactive: true}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if asked != "POST /api/v1/triage/items?org=acme" {
		t.Fatalf("asked %s", asked)
	}
	if got["body"] != "Fix the flaky test" || got["project_id"] != "acme/web" || got["source"] != nil {
		t.Fatalf("sent %v", got)
	}
	if !strings.Contains(out.String(), "OR-8 Fix the flaky test") || !strings.Contains(out.String(), "https://app/triage?item=i1") {
		t.Fatalf("printed %q", out.String())
	}

	t.Setenv("OUTRUNNER_API_KEY", "or_key_old")
	errs.Reset()
	if code := triage(context.Background(), server.URL, Config{}, []string{"x"}, terminal{interactive: true}, &out, &errs); code != 1 {
		t.Fatalf("revoked key: exit %d", code)
	}
	if !strings.Contains(errs.String(), "revoked") || !strings.Contains(errs.String(), "OUTRUNNER_API_KEY") {
		t.Fatalf("said %q", errs.String())
	}
}
