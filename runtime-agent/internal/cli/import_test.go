package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"unicode/utf16"

	"runtime-agent/internal/localimport"
)

// importApp stands in for the app's CLI import routes: it takes the token
// "good", records each plan and commit, and plans as answer says.
type importApp struct {
	t      *testing.T
	server *httptest.Server
	// answer plans a batch; nil plans every session ready.
	answer func(importPlanSession) importPlanItem

	mu      sync.Mutex
	plans   [][]importPlanSession
	orgs    []string
	commits []importCommitRequest
}

func newImportApp(t *testing.T, answer func(importPlanSession) importPlanItem) *importApp {
	t.Helper()
	app := &importApp{t: t, answer: answer}
	app.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("%s %s: want POST", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Not signed in. Run ` + "`outrunner login`" + `."}`))
			return
		}
		app.mu.Lock()
		defer app.mu.Unlock()
		switch r.URL.Path {
		case "/api/cli/imports":
			var body struct {
				Sessions []importPlanSession `json:"sessions"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("plan body: %v", err)
			}
			app.plans = append(app.plans, body.Sessions)
			app.orgs = append(app.orgs, r.URL.Query().Get("org"))
			items := make([]importPlanItem, len(body.Sessions))
			for i, s := range body.Sessions {
				if app.answer != nil {
					items[i] = app.answer(s)
				} else {
					items[i] = readyItem(s)
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
		case "/api/cli/imports/commit":
			var body importCommitRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("commit body: %v", err)
			}
			app.commits = append(app.commits, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"workspace": map[string]string{"id": body.WorkspaceID, "status": "archived"}})
		default:
			t.Errorf("unexpected call to %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(app.server.Close)
	return app
}

// readyItem is the plan taking a session as it is, with an upload for each
// artifact kind.
func readyItem(s importPlanSession) importPlanItem {
	id := strings.TrimPrefix(strings.TrimPrefix(s.Key, "claude:"), "codex:")
	uploads := map[string]importUpload{}
	for _, kind := range []string{"bundle", "patch", "conversation", "rollout"} {
		uploads[kind] = importUpload{URL: "https://storage.example/" + id + "/" + kind + "?token=t", Path: id + "/" + kind}
	}
	return importPlanItem{
		Key:         s.Key,
		Status:      "ready",
		WorkspaceID: "ws-" + id,
		ProjectID:   "proj-web",
		Branch:      s.Branch,
		ImportedAt:  "2026-11-18T12:00:00.000Z",
		Uploads:     uploads,
	}
}

// localStub stands in for this computer: its scan, and each capture and
// upload, recorded.
type localStub struct {
	t    *testing.T
	scan localimport.Scan
	// fail is what capturing a session returns instead, by key.
	fail map[string]error

	mu       sync.Mutex
	scanned  bool
	captured []string
	dirs     []string
	uploads  map[string]map[string]string
}

func (l *localStub) deps() importDeps {
	return importDeps{
		scan: func(context.Context) localimport.Scan {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.scanned = true
			return l.scan
		},
		capture: func(_ context.Context, key, out string) (localimport.Capture, error) {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.captured = append(l.captured, key)
			l.dirs = append(l.dirs, out)
			if entries, err := os.ReadDir(out); err != nil || len(entries) > 0 {
				l.t.Errorf("capture of %s: out %s isn't an empty folder (%v)", key, out, err)
			}
			if err := l.fail[key]; err != nil {
				return localimport.Capture{}, err
			}
			for _, s := range l.scan.Sessions {
				if s.Key == key {
					return captureOf(s, out), nil
				}
			}
			return localimport.Capture{}, localimport.ErrNotFound
		},
		upload: func(_ context.Context, c localimport.Capture, urls map[string]string) error {
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.uploads == nil {
				l.uploads = map[string]map[string]string{}
			}
			l.uploads[c.Session.Key] = urls
			return nil
		},
	}
}

func captureOf(s localimport.Session, out string) localimport.Capture {
	digest := func(b byte) string { return "sha256:" + strings.Repeat(string("0123456789abcdef"[b%16]), 64) }
	artifacts := map[string]localimport.Artifact{
		"bundle":       {Name: "repo.bundle", Path: out + "/repo.bundle", SHA256: digest(1), Size: 1200},
		"patch":        {Name: "changes.patch", Path: out + "/changes.patch", SHA256: digest(2), Size: 40},
		"conversation": {Name: "conversation.jsonl.gz", Path: out + "/conversation.jsonl.gz", SHA256: digest(3), Size: 9000, Encoding: "gzip"},
	}
	if s.Agent == "codex" {
		artifacts["rollout"] = localimport.Artifact{Name: "rollout.jsonl.gz", Path: out + "/rollout.jsonl.gz", SHA256: digest(4), Size: 7000, Encoding: "gzip"}
	}
	return localimport.Capture{Session: s, LastCommit: strings.Repeat("c", 40), ChangedFiles: 3, Artifacts: artifacts}
}

// session is one importable session of acme/web on its own branch.
func session(key, title string) localimport.Session {
	agent, id, _ := strings.Cut(key, ":")
	source := map[string]string{"claude": "claude-cli", "codex": "codex-cli"}[agent]
	return localimport.Session{
		Key: key, Source: source, Agent: agent, SessionID: id, Title: title,
		Cwd: "/home/me/web", Worktree: "/home/me/web", Repo: "acme/web", Branch: "fix-" + id, BaseBranch: "main",
		CheckedOut: true, Dirty: true, Unpushed: 2,
		Transcript: "/home/me/.claude/projects/web/" + id + ".jsonl", TranscriptBytes: 300_000,
		StartedAt: "2026-11-01T10:00:00Z", LastMessage: "Done: the test passes.",
	}
}

func scanOf(sessions ...localimport.Session) localimport.Scan {
	return localimport.Scan{
		Version:  1,
		Sources:  []localimport.Source{{ID: "conductor"}, {ID: "claude-cli", Found: true}, {ID: "codex-cli", Found: true}},
		Sessions: sessions,
	}
}

// fourSessions is two importable sessions, one that can't be imported, and
// one archived in Conductor, which is never offered.
func fourSessions() []localimport.Session {
	blocked := session("claude:ccc", "Notes in a folder without a remote")
	blocked.Repo, blocked.Branch = "", ""
	blocked.Skip = &localimport.Skip{Reason: "no-github-remote"}
	archived := session("claude:ddd", "Put away in Conductor")
	archived.Source, archived.ConductorState = "conductor", "archived"
	return []localimport.Session{
		session("claude:aaa", "Fix the flaky checkout test"),
		session("codex:bbb", "Add a README"),
		blocked,
		archived,
	}
}

func interactive(out *bytes.Buffer, answers ...string) terminal {
	in := lines(answers...)
	in.interactive, in.out = true, out
	return in
}

type importOutcome struct {
	code      int
	out, errs string
}

func runImportWith(app *importApp, local *localStub, config Config, in terminal, args ...string) importOutcome {
	var out, errs bytes.Buffer
	if in.out == nil {
		in.out = &out
	}
	code := runImport(context.Background(), local.deps(), app.server.URL, config, args, in, &out, &errs)
	return importOutcome{code: code, out: out.String(), errs: errs.String()}
}

func TestImportAllPlansUploadsAndFinishesEachSession(t *testing.T) {
	app := newImportApp(t, func(s importPlanSession) importPlanItem {
		item := readyItem(s)
		switch s.Key {
		case "claude:aaa":
			item.Branch, item.Renamed = "fix-aaa-2", true
		case "codex:bbb":
			item = importPlanItem{Key: s.Key, Status: "skipped", Skip: &localimport.Skip{Reason: "already-imported"}}
		}
		return item
	})
	local := &localStub{t: t, scan: scanOf(fourSessions()...)}

	got := runImportWith(app, local, Config{Token: "good"}, lines(), "--all", "--yes")
	if got.code != 0 {
		t.Fatalf("exit %d\n%s%s", got.code, got.out, got.errs)
	}

	// Only what can be imported is planned: not the one without a remote,
	// nor the one archived in Conductor.
	wantPlan := []importPlanSession{
		{Key: "claude:aaa", Source: "claude-cli", Agent: "claude", Repo: "acme/web", Branch: "fix-aaa"},
		{Key: "codex:bbb", Source: "codex-cli", Agent: "codex", Repo: "acme/web", Branch: "fix-bbb"},
	}
	if len(app.plans) != 1 || !reflect.DeepEqual(app.plans[0], wantPlan) {
		t.Fatalf("planned %+v, want %+v", app.plans, wantPlan)
	}
	if app.orgs[0] != "" {
		t.Fatalf("org %q, want none (the personal org)", app.orgs[0])
	}

	// The skipped one is never captured; the other goes where its plan said.
	if !reflect.DeepEqual(local.captured, []string{"claude:aaa"}) {
		t.Fatalf("captured %v", local.captured)
	}
	if local.uploads["claude:aaa"]["bundle"] != "https://storage.example/aaa/bundle?token=t" {
		t.Fatalf("uploaded to %v", local.uploads)
	}

	if len(app.commits) != 1 {
		t.Fatalf("committed %d sessions, want 1", len(app.commits))
	}
	commit := app.commits[0]
	want := importCommitRequest{
		WorkspaceID: "ws-aaa", ProjectID: "proj-web", ImportedAt: "2026-11-18T12:00:00.000Z",
		Key: "claude:aaa", Source: "claude-cli", Agent: "claude", SessionID: "aaa",
		// Imported as the branch the plan chose; the bundle still names its own.
		Branch: "fix-aaa-2", BundleRef: "fix-aaa",
		Title: "Fix the flaky checkout test", Worktree: "/home/me/web", StartedAt: "2026-11-01T10:00:00Z",
		LastCommit: strings.Repeat("c", 40), Unpushed: 2, ChangedFiles: 3, LastMessage: "Done: the test passes.",
		Artifacts: map[string]artifactReceipt{
			"bundle":       {SHA256: "sha256:" + strings.Repeat("1", 64), Size: 1200},
			"patch":        {SHA256: "sha256:" + strings.Repeat("2", 64), Size: 40},
			"conversation": {SHA256: "sha256:" + strings.Repeat("3", 64), Size: 9000, Encoding: "gzip"},
		},
	}
	if !reflect.DeepEqual(commit, want) {
		t.Fatalf("committed\n %+v\nwant\n %+v", commit, want)
	}

	for _, said := range []string{
		app.server.URL + "/workspaces/ws-aaa",
		"(as fix-aaa-2: fix-aaa was taken)",
		"Add a README: skipped. It was imported already.",
		"1 imported, 1 skipped.",
		importNote,
	} {
		if !strings.Contains(got.out, said) {
			t.Errorf("didn't say %q:\n%s", said, got.out)
		}
	}
	for _, dir := range local.dirs {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("left %s behind (%v)", dir, err)
		}
	}
}

func TestImportKeyPicksSessionsIntoTheNamedOrg(t *testing.T) {
	app := newImportApp(t, nil)
	local := &localStub{t: t, scan: scanOf(fourSessions()...)}

	got := runImportWith(app, local, Config{Token: "good"}, lines(), "--key", "codex:bbb", "--org", "acme", "--yes")
	if got.code != 0 {
		t.Fatalf("exit %d\n%s%s", got.code, got.out, got.errs)
	}
	if len(app.plans) != 1 || len(app.plans[0]) != 1 || app.plans[0][0].Key != "codex:bbb" || app.orgs[0] != "acme" {
		t.Fatalf("planned %+v in org %v", app.plans, app.orgs)
	}
	// A Codex session's raw rollout comes along.
	if _, ok := app.commits[0].Artifacts["rollout"]; !ok || len(app.commits[0].Artifacts) != 4 {
		t.Fatalf("committed artifacts %v", app.commits[0].Artifacts)
	}
}

func TestImportRefusesKeysItCantImport(t *testing.T) {
	app := newImportApp(t, nil)
	local := &localStub{t: t, scan: scanOf(fourSessions()...)}

	for key, why := range map[string]string{
		"claude:ccc":  "Its folder isn't a GitHub repository.",
		"claude:ddd":  "outrunner import --list", // archived in Conductor: not offered
		"claude:nope": "outrunner import --list",
	} {
		got := runImportWith(app, local, Config{Token: "good"}, lines(), "--key", key, "--yes")
		if got.code != 2 || !strings.Contains(got.errs, why) {
			t.Errorf("--key %s: exit %d, said %q; want 2 and %q", key, got.code, got.errs, why)
		}
	}
	if len(app.plans) != 0 {
		t.Fatalf("planned %v", app.plans)
	}
}

func TestImportListShowsKeysWithoutASignIn(t *testing.T) {
	app := newImportApp(t, nil)
	local := &localStub{t: t, scan: scanOf(fourSessions()...)}

	got := runImportWith(app, local, Config{}, lines(), "--list")
	if got.code != 0 {
		t.Fatalf("exit %d\n%s%s", got.code, got.out, got.errs)
	}
	for _, said := range []string{
		"Found sessions from Claude Code, Codex.",
		"1. Fix the flaky checkout test",
		"Claude Code · acme/web · fix-aaa · 2 unpushed commits · uncommitted changes · 0.3 MB conversation",
		"claude:aaa",
		"2. Add a README",
		"1 session can't be imported:",
		"Its folder isn't a GitHub repository.",
	} {
		if !strings.Contains(got.out, said) {
			t.Errorf("didn't say %q:\n%s", said, got.out)
		}
	}
	if strings.Contains(got.out, "Put away in Conductor") {
		t.Errorf("listed a session archived in Conductor:\n%s", got.out)
	}
	if len(app.plans) != 0 {
		t.Fatalf("planned %v", app.plans)
	}
}

func TestImportAsksWhichAndForAgreement(t *testing.T) {
	t.Run("picked and agreed", func(t *testing.T) {
		app := newImportApp(t, nil)
		local := &localStub{t: t, scan: scanOf(fourSessions()...)}
		var out bytes.Buffer
		got := runImportWith(app, local, Config{Token: "good"}, interactive(&out, "2", "y"))
		if got.code != 0 {
			t.Fatalf("exit %d\n%s%s", got.code, got.out, got.errs)
		}
		if len(app.plans) != 1 || len(app.plans[0]) != 1 || app.plans[0][0].Key != "codex:bbb" {
			t.Fatalf("planned %+v, want the second session alone", app.plans)
		}
		if !strings.Contains(out.String(), "Import which?") || !strings.Contains(out.String(), "Import 1 session? (y/N)") {
			t.Fatalf("asked %q", out.String())
		}
	})
	for name, answers := range map[string][]string{
		"declined":     {"1", "n"},
		"picked none":  {""},
		"stdin closed": nil,
	} {
		t.Run(name, func(t *testing.T) {
			app := newImportApp(t, nil)
			local := &localStub{t: t, scan: scanOf(fourSessions()...)}
			var out bytes.Buffer
			got := runImportWith(app, local, Config{Token: "good"}, interactive(&out, answers...))
			if got.code != 0 || !strings.Contains(got.out, "Nothing imported.") || len(app.plans) != 0 {
				t.Fatalf("exit %d, planned %v:\n%s%s", got.code, app.plans, got.out, got.errs)
			}
		})
	}
	t.Run("not a number in the list", func(t *testing.T) {
		app := newImportApp(t, nil)
		local := &localStub{t: t, scan: scanOf(fourSessions()...)}
		var out bytes.Buffer
		got := runImportWith(app, local, Config{Token: "good"}, interactive(&out, "3"))
		if got.code != 2 || !strings.Contains(got.errs, `1 to 2: "3" isn't one`) || len(app.plans) != 0 {
			t.Fatalf("exit %d, planned %v: %s", got.code, app.plans, got.errs)
		}
	})
}

func TestImportWithoutATerminalNeedsItsPicksAndAgreementAsFlags(t *testing.T) {
	app := newImportApp(t, nil)
	local := &localStub{t: t, scan: scanOf(fourSessions()...)}

	if got := runImportWith(app, local, Config{Token: "good"}, lines()); got.code != 2 || !strings.Contains(got.errs, "--all or --key") {
		t.Errorf("no picks: exit %d, said %q", got.code, got.errs)
	}
	if got := runImportWith(app, local, Config{Token: "good"}, lines(), "--all"); got.code != 2 || !strings.Contains(got.errs, "--yes") {
		t.Errorf("no agreement: exit %d, said %q", got.code, got.errs)
	}
	if got := runImportWith(app, local, Config{Token: "good"}, lines(), "--all", "--key", "claude:aaa"); got.code != 2 {
		t.Errorf("--all and --key: exit %d", got.code)
	}
	if len(app.plans) != 0 {
		t.Fatalf("planned %v", app.plans)
	}
}

func TestImportSaysWhatWasSkippedAndWhatFailed(t *testing.T) {
	app := newImportApp(t, nil)
	local := &localStub{t: t, scan: scanOf(fourSessions()...), fail: map[string]error{
		"claude:aaa": &localimport.SkipError{Skip: localimport.Skip{Reason: "transcript-missing", Detail: "moved"}},
		"codex:bbb":  errors.New("no space left on device"),
	}}

	got := runImportWith(app, local, Config{Token: "good"}, lines(), "--all", "--yes")
	if got.code != 1 {
		t.Fatalf("exit %d, want 1 for a failure\n%s%s", got.code, got.out, got.errs)
	}
	for _, said := range []string{
		"Fix the flaky checkout test: skipped. Its conversation is gone. (moved)",
		"Add a README: no space left on device",
		"1 skipped, 1 failed.",
	} {
		if !strings.Contains(got.out, said) {
			t.Errorf("didn't say %q:\n%s", said, got.out)
		}
	}
	if len(app.commits) != 0 || len(local.uploads) != 0 {
		t.Fatalf("committed %v, uploaded %v", app.commits, local.uploads)
	}
}

func TestImportSendsNothingOverPlainHTTP(t *testing.T) {
	app := newImportApp(t, func(s importPlanSession) importPlanItem {
		item := readyItem(s)
		item.Uploads["patch"] = importUpload{URL: "http://storage.example/patch", Path: "p"}
		return item
	})
	local := &localStub{t: t, scan: scanOf(session("claude:aaa", "Fix it"))}

	got := runImportWith(app, local, Config{Token: "good"}, lines(), "--all", "--yes")
	if got.code != 1 || !strings.Contains(got.out, "isn't over https, so nothing was sent") {
		t.Fatalf("exit %d:\n%s%s", got.code, got.out, got.errs)
	}
	if len(local.captured) != 0 || len(local.uploads) != 0 || len(app.commits) != 0 {
		t.Fatalf("captured %v, uploaded %v, committed %v", local.captured, local.uploads, app.commits)
	}
}

func TestImportPlansAtMostFiftyAtATime(t *testing.T) {
	app := newImportApp(t, nil)
	var sessions []localimport.Session
	for i := range 51 {
		sessions = append(sessions, session(fmt.Sprintf("claude:s%02d", i), fmt.Sprintf("Session %d", i)))
	}
	local := &localStub{t: t, scan: scanOf(sessions...)}

	got := runImportWith(app, local, Config{Token: "good"}, lines(), "--all", "--yes")
	if got.code != 0 {
		t.Fatalf("exit %d\n%s%s", got.code, got.out, got.errs)
	}
	if len(app.plans) != 2 || len(app.plans[0]) != 50 || len(app.plans[1]) != 1 {
		t.Fatalf("planned batches of %d", len(app.plans))
	}
	if len(app.commits) != 51 || !strings.Contains(got.out, "51 imported.") {
		t.Fatalf("committed %d:\n%s", len(app.commits), got.out)
	}
}

func TestImportNeedsASignIn(t *testing.T) {
	app := newImportApp(t, nil)
	local := &localStub{t: t, scan: scanOf(fourSessions()...)}

	got := runImportWith(app, local, Config{}, lines(), "--all", "--yes")
	if got.code != 1 || !strings.Contains(got.errs, "outrunner login") || local.scanned {
		t.Fatalf("no sign-in: exit %d, scanned %v, said %q", got.code, local.scanned, got.errs)
	}
	got = runImportWith(app, local, Config{Token: "stale"}, lines(), "--all", "--yes")
	if got.code != 1 || !strings.Contains(got.errs, "Not signed in. Run `outrunner login`.") {
		t.Fatalf("signed out: exit %d, said %q", got.code, got.errs)
	}
	if len(local.captured) != 0 {
		t.Fatalf("captured %v", local.captured)
	}
}

func TestImportCommitForCutsToTheAppsLimits(t *testing.T) {
	s := session("claude:aaa", strings.Repeat("😀", 150)) // 300 UTF-16 units
	s.LastMessage = strings.Repeat("x", 2500)
	item := readyItem(importPlanSession{Key: s.Key, Branch: s.Branch})
	request, err := importCommitFor(item, captureOf(s, "/tmp/out"))
	if err != nil {
		t.Fatal(err)
	}
	if n := len(utf16.Encode([]rune(request.Title))); n != 200 {
		t.Errorf("title is %d UTF-16 units, want 200", n)
	}
	if len(request.LastMessage) != 2000 {
		t.Errorf("last message is %d long, want 2000", len(request.LastMessage))
	}

	incomplete := captureOf(s, "/tmp/out")
	delete(incomplete.Artifacts, "patch")
	if _, err := importCommitFor(item, incomplete); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Errorf("no patch: %v", err)
	}
}

func TestTruncateUTF16(t *testing.T) {
	for _, c := range []struct {
		in   string
		n    int
		want string
	}{
		{"abc", 10, "abc"},
		{"abc", 2, "ab"},
		{"ab😀c", 3, "ab"}, // the emoji is two units: never half of one
		{"ab😀c", 4, "ab😀"},
		{"", 5, ""},
	} {
		if got := truncateUTF16(c.in, c.n); got != c.want {
			t.Errorf("truncateUTF16(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

func TestParseImportPicks(t *testing.T) {
	sessions := []localimport.Session{{Key: "a"}, {Key: "b"}, {Key: "c"}, {Key: "d"}}
	keys := func(picked []localimport.Session) string {
		var out []string
		for _, s := range picked {
			out = append(out, s.Key)
		}
		return strings.Join(out, ",")
	}
	for answer, want := range map[string]string{
		"":          "",
		"1":         "a",
		"1,3":       "a,c",
		"3 1":       "c,a",
		"2-4":       "b,c,d",
		"1, 2-3, 2": "a,b,c",
		"all":       "a,b,c,d",
		" ALL ":     "a,b,c,d",
	} {
		picked, err := parseImportPicks(answer, sessions)
		if err != nil || keys(picked) != want {
			t.Errorf("%q: picked %q (%v), want %q", answer, keys(picked), err, want)
		}
	}
	for _, answer := range []string{"0", "5", "x", "1-9", "3-1", "-2"} {
		if _, err := parseImportPicks(answer, sessions); err == nil {
			t.Errorf("%q: no error", answer)
		}
	}
}

func TestUploadURLAllowed(t *testing.T) {
	for target, want := range map[string]bool{
		"https://auth.outrunner.sh/storage/v1/object/upload/sign/x?token=t": true,
		"http://127.0.0.1:54321/storage/v1/object/upload/sign/x":            true,
		"http://localhost:54321/x":                                          true,
		"http://[::1]:54321/x":                                              true,
		"http://storage.example/x":                                          false,
		"http://10.0.0.5/x":                                                 false,
		"ftp://storage.example/x":                                           false,
		"https:///no-host":                                                  false,
		"not a url":                                                         false,
	} {
		if got := uploadURLAllowed(target); got != want {
			t.Errorf("uploadURLAllowed(%q) = %v, want %v", target, got, want)
		}
	}
}
