package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"runtime-agent/internal/localimport"
)

func TestPickReadsNumbersRangesAllAndNone(t *testing.T) {
	cases := []struct {
		answer     string
		emptyIsAll bool
		want       []int
	}{
		{"", true, []int{0, 1, 2, 3}},
		{"", false, nil},
		{"all", false, []int{0, 1, 2, 3}},
		{"none", true, nil},
		{"1,3", true, []int{0, 2}},
		{" 3 1 ", true, []int{0, 2}},
		{"2-4", true, []int{1, 2, 3}},
		{"1,1-2", true, []int{0, 1}},
	}
	for _, c := range cases {
		got, err := parsePick(c.answer, 4, c.emptyIsAll)
		if err != nil || !reflect.DeepEqual(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("parsePick(%q, %v) = %v, %v; want %v", c.answer, c.emptyIsAll, got, err, c.want)
		}
	}
	for _, bad := range []string{"5", "0-2", "3-1", "x", "1,,x"} {
		if _, err := parsePick(bad, 4, true); err == nil {
			t.Errorf("parsePick(%q) was taken", bad)
		}
	}
}

func TestTextIsCutToWhatTheServerCounts(t *testing.T) {
	if got := cutUTF16("héllo", 3); got != "hél" {
		t.Errorf("got %q", got)
	}
	// An emoji is two UTF-16 units: it doesn't fit in one, and isn't split.
	if got := cutUTF16("a😀b", 2); got != "a" {
		t.Errorf("got %q", got)
	}
	if got := cutUTF16("short", 200); got != "short" {
		t.Errorf("got %q", got)
	}
}

func session(key, title string) localimport.Session {
	return localimport.Session{
		Key: key, Source: "claude-cli", Agent: "claude", SessionID: strings.TrimPrefix(key, "claude:"),
		Title: title, Worktree: "/Users/me/app", Repo: "me/app", Branch: "feature", CheckedOut: true,
		Unpushed: 2, StartedAt: "2026-10-01T10:00:00Z", LastMessage: "done",
	}
}

func capture(s localimport.Session) localimport.Capture {
	artifact := func(name string) localimport.Artifact {
		return localimport.Artifact{Name: name, SHA256: "sha256:" + strings.Repeat("a", 64), Size: 10}
	}
	return localimport.Capture{
		Session: s, LastCommit: strings.Repeat("b", 40), ChangedFiles: 3,
		Artifacts: map[string]localimport.Artifact{
			"bundle": artifact("bundle"), "patch": artifact("patch"),
			"conversation": {Name: "conversation", SHA256: "sha256:" + strings.Repeat("c", 64), Size: 5, Encoding: "gzip"},
		},
	}
}

func TestTheCommitRequestIsTheOneTheServerReads(t *testing.T) {
	s := session("claude:abc", "Fix the build")
	item := planItem{Key: s.Key, Status: "ready", WorkspaceID: "w1", ProjectID: "p1", Branch: "feature-2", ImportedAt: "2026-10-23T00:00:00Z"}
	req, err := commitRequestFor(item, capture(s))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(req)
	var fields map[string]any
	_ = json.Unmarshal(data, &fields)
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	// ImportCommitRequest in lib/runtime/import-scan.ts, which is strict.
	want := []string{"agent", "artifacts", "branch", "bundleRef", "changedFiles", "importedAt", "key", "lastCommit", "lastMessage", "projectId", "sessionId", "source", "startedAt", "title", "unpushed", "workspaceId", "worktree"}
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("fields %v\nwant   %v", keys, want)
	}
	if req.Branch != "feature-2" || req.BundleRef != "feature" {
		t.Errorf("imported as %q from %q: the plan's branch, from the bundle's", req.Branch, req.BundleRef)
	}
	if req.Artifacts["conversation"].Encoding != "gzip" {
		t.Error("the conversation's encoding was lost")
	}

	incomplete := capture(s)
	delete(incomplete.Artifacts, "patch")
	if _, err := commitRequestFor(item, incomplete); err == nil {
		t.Error("an incomplete capture was committed")
	}
}

func TestImportPlansCapturesUploadsAndCommitsEachSession(t *testing.T) {
	var planned []planSession
	committed := map[string]commitRequest{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/imports", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer or_cli_token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct{ Sessions []planSession }
		_ = json.NewDecoder(r.Body).Decode(&body)
		planned = body.Sessions
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{
			map[string]any{"key": "claude:one", "status": "ready", "workspaceId": "w1", "projectId": "p1", "branch": "feature", "renamed": false, "importedAt": "2026-10-23T00:00:00Z",
				"uploads": map[string]any{"bundle": map[string]string{"url": "https://storage/bundle", "path": "x"}}},
			map[string]any{"key": "claude:two", "status": "skipped", "skip": map[string]string{"reason": "already-imported"}},
			map[string]any{"key": "claude:three", "status": "ready", "workspaceId": "w3", "projectId": "p1", "branch": "feature-2", "renamed": true, "importedAt": "2026-10-23T00:00:00Z", "uploads": map[string]any{}},
			map[string]any{"key": "claude:four", "status": "ready", "workspaceId": "w4", "projectId": "p1", "branch": "f", "renamed": false, "importedAt": "2026-10-23T00:00:00Z", "uploads": map[string]any{}},
		}})
	})
	mux.HandleFunc("POST /api/imports/commit", func(w http.ResponseWriter, r *http.Request) {
		var req commitRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		committed[req.Key] = req
		_ = json.NewEncoder(w).Encode(map[string]any{"workspace": map[string]string{"id": req.WorkspaceID, "status": "archived"}})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	sessions := []localimport.Session{session("claude:one", "One"), session("claude:two", "Two"), session("claude:three", "Three"), session("claude:four", "Four")}
	byKey := map[string]localimport.Session{}
	for _, s := range sessions {
		byKey[s.Key] = s
	}
	var uploaded map[string]string
	deps := liveImportDeps(server.URL, "or_cli_token", localimport.Options{})
	deps.capture = func(_ context.Context, key, _ string) (localimport.Capture, error) {
		if key == "claude:four" {
			return localimport.Capture{}, &localimport.SkipError{Skip: localimport.Skip{Reason: "branch-missing"}}
		}
		return capture(byKey[key]), nil
	}
	deps.upload = func(_ context.Context, c localimport.Capture, urls map[string]string) error {
		if c.Session.Key == "claude:three" {
			return errors.New("storage said no")
		}
		uploaded = urls
		return nil
	}

	var out bytes.Buffer
	imported, err := importSessions(context.Background(), sessions, server.URL, deps, &out)
	if err != nil {
		t.Fatal(err)
	}
	if imported != 1 || len(committed) != 1 || committed["claude:one"].WorkspaceID != "w1" {
		t.Fatalf("imported %d, committed %v", imported, committed)
	}
	if len(planned) != 4 || planned[0] != (planSession{Key: "claude:one", Source: "claude-cli", Agent: "claude", Repo: "me/app", Branch: "feature"}) {
		t.Errorf("planned %+v", planned)
	}
	if uploaded["bundle"] != "https://storage/bundle" {
		t.Errorf("uploaded to %v", uploaded)
	}
	text := out.String()
	for _, want := range []string{
		"✓ One: imported\n      " + server.URL + "/workspaces/w1",
		"– Two: skipped. It was imported already.",
		"✗ Three: upload: storage said no",
		"– Four: skipped. Its branch is gone.",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("output lacks %q:\n%s", want, text)
		}
	}
}

func TestAPlanTheServerRefusesIsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"Choose where your sessions run first.","settingsHref":"/settings/sandbox"}`))
	}))
	defer server.Close()
	_, err := importSessions(context.Background(), []localimport.Session{session("claude:one", "One")}, server.URL, liveImportDeps(server.URL, "or_cli_token", localimport.Options{}), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "Choose where your sessions run first.") {
		t.Fatalf("got %v", err)
	}
}

func TestOnlySessionsInAGitHubRepositoryAreOffered(t *testing.T) {
	ok := session("claude:one", "One")
	noRepo := ok
	noRepo.Repo = ""
	skipped := ok
	skipped.Skip = &localimport.Skip{Reason: "worktree-missing"}
	if !importable(ok) || importable(noRepo) || importable(skipped) {
		t.Error("importable is wrong")
	}
}

func TestNothingToImportSaysWhy(t *testing.T) {
	if got := nothingToImport(nil); !strings.Contains(got, "No sessions found") {
		t.Errorf("got %q", got)
	}
	a := session("claude:a", "A")
	a.Repo = ""
	a.Skip = &localimport.Skip{Reason: "no-github-remote"}
	b := a
	c := session("claude:c", "C")
	c.Skip = &localimport.Skip{Reason: "worktree-missing"}
	got := nothingToImport([]localimport.Session{a, b, c})
	want := "Found 3 sessions on this computer, but none can be imported:\n  2 × Its folder isn't a GitHub repository.\n  1 × Its folder is gone."
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}
