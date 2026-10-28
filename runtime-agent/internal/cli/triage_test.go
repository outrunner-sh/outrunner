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
