package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI answers /api/v1 as the app would, and records what it was asked.
type fakeAPI struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []map[string]any
	// Answers to each wait call, in turn.
	waits []string
}

func (f *fakeAPI) server(t *testing.T) *httptest.Server {
	t.Helper()
	// The signed-in token is what's sent, whatever this shell has set.
	if _, set := os.LookupEnv("OUTRUNNER_API_KEY"); set {
		t.Setenv("OUTRUNNER_API_KEY", "")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.requests = append(f.requests, r)
		f.bodies = append(f.bodies, body)
		if r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"That API key was revoked.","status":401}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/workspaces":
			_, _ = w.Write([]byte(`{"data":[{"id":"w1","title":"Fix the flaky test","status":"ready","source":"api","branch":"runtime/x","created_at":"2026-11-01T00:00:00Z"}],"page":1,"per_page":20,"total":1,"total_pages":1,"has_more":false}`))
		case r.Method == "GET" && r.URL.Path == "/api/v1/projects":
			_, _ = w.Write([]byte(`{"data":[{"id":"p1","full_name":"acme/web"}],"has_more":false}`))
		case r.Method == "POST" && r.URL.Path == "/api/v1/workspaces":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"id":"w2","status":"preparing","url":"https://app/workspaces/w2"}`))
		case r.Method == "GET" && r.URL.Path == "/api/v1/workspaces/w1":
			_, _ = w.Write([]byte(`{"id":"w1","title":"Fix it","status":"ready","branch":"b","base_branch":"main","source":"api","url":"https://app/workspaces/w1","turn":{"state":"idle","last_message":"All done."}}`))
		case r.Method == "GET" && r.URL.Path == "/api/v1/workspaces/missing":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"No session by that id that you can see.","status":404}}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/messages"):
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"result":"sent","workspace_id":"w1","after_event":"480"}`))
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/wait"):
			answer := `{"id":"w1","status":"ready","turn":{"state":"idle","last_message":"Fixed."},"timed_out":false}`
			if len(f.waits) > 0 {
				answer, f.waits = f.waits[0], f.waits[1:]
			}
			_, _ = w.Write([]byte(answer))
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/conversation"):
			_, _ = w.Write([]byte(`{"data":[{"id":"100","type":"message","role":"user","content":[{"type":"text","text":"fix it"}]},{"id":"200","type":"message","role":"assistant","content":[{"type":"tool_use","id":"t","name":"Bash","input":{}},{"type":"text","text":"Fixed."}]}],"has_more":true,"next_before_event":"100","from":"live"}`))
		case r.Method == "DELETE" && r.URL.Path == "/api/v1/workspaces/w1":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no route","status":404}}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func (f *fakeAPI) last() (*http.Request, map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1], f.bodies[len(f.bodies)-1]
}

var signedIn = Config{Token: "good"}

func TestListPrintsSessionsAndFilters(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	code := listCommand(context.Background(), server.URL, signedIn, []string{"--status", "ready", "--user", "me", "--org", "acme"}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	req, _ := api.last()
	q := req.URL.Query()
	if q.Get("status") != "ready" || q.Get("user_id") != "me" || q.Get("org") != "acme" {
		t.Fatalf("asked %s", req.URL.RawQuery)
	}
	if !strings.Contains(out.String(), "w1") || !strings.Contains(out.String(), "Fix the flaky test") {
		t.Fatalf("printed %q", out.String())
	}
}

func TestJSONPrintsTheAPIsAnswer(t *testing.T) {
	server := (&fakeAPI{}).server(t)
	var out, errs bytes.Buffer
	if code := getCommand(context.Background(), server.URL, signedIn, []string{"w1", "--json"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || got["id"] != "w1" {
		t.Fatalf("printed %q (%v)", out.String(), err)
	}
}

func TestGetShowsTheTurnAndLastMessage(t *testing.T) {
	server := (&fakeAPI{}).server(t)
	var out, errs bytes.Buffer
	if code := getCommand(context.Background(), server.URL, signedIn, []string{"w1"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if !strings.Contains(out.String(), "idle") || !strings.Contains(out.String(), "All done.") {
		t.Fatalf("printed %q", out.String())
	}
}

func TestCreateFindsTheRepoByNameAndSendsWhatWasAsked(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	code := createCommand(context.Background(), server.URL, signedIn,
		[]string{"--repo", "ACME/web", "--model", "sonnet", "--plan", "--size", "large", "Fix", "the", "test"}, terminal{interactive: true}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	_, body := api.last()
	if body["project_id"] != "p1" || body["prompt"] != "Fix the test" || body["model"] != "sonnet" || body["plan_mode"] != true || body["size"] != "large" {
		t.Fatalf("sent %v", body)
	}
	if !strings.Contains(out.String(), "w2") {
		t.Fatalf("printed %q", out.String())
	}
}

func TestCreateReadsThePromptFromStdin(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	code := createCommand(context.Background(), server.URL, signedIn, []string{"--repo", "p1"}, lines("Fix it", "carefully"), &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if _, body := api.last(); body["prompt"] != "Fix it\ncarefully" || body["project_id"] != "p1" {
		t.Fatalf("sent %v", body)
	}
}

func TestSendThenWaitsForTheTurnItStarts(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	code := sendCommand(context.Background(), server.URL, signedIn, []string{"w1", "--wait", "Also", "add", "a", "test"}, terminal{interactive: true}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	req, _ := api.last()
	if !strings.HasSuffix(req.URL.Path, "/wait") || req.URL.Query().Get("after_event") != "480" {
		t.Fatalf("waited with %s", req.URL.String())
	}
	if !strings.Contains(out.String(), "Fixed.") {
		t.Fatalf("printed %q", out.String())
	}
}

func TestWaitCallsAgainUntilTheTurnEnds(t *testing.T) {
	api := &fakeAPI{waits: []string{
		`{"id":"w1","status":"ready","turn":{"state":"working"},"timed_out":true}`,
		`{"id":"w1","status":"ready","turn":{"state":"needs_input","pending_input":{"type":"question","questions":[{"question":"Which DB?","options":[{"label":"Postgres"}]}]}},"timed_out":false}`,
	}}
	server := api.server(t)
	var out, errs bytes.Buffer
	code := waitCommand(context.Background(), server.URL, signedIn, []string{"w1"}, &out, &errs)
	if code != 3 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if len(api.requests) != 2 || !strings.Contains(out.String(), "Which DB?") {
		t.Fatalf("%d calls, printed %q", len(api.requests), out.String())
	}
}

func TestWaitExitStatusesTellOutcomesApart(t *testing.T) {
	for _, c := range []struct {
		w    Workspace
		code int
	}{
		{Workspace{Turn: &Turn{State: "idle"}}, 0},
		{Workspace{Turn: &Turn{State: "needs_input"}}, 3},
		{Workspace{TimedOut: true}, 4},
		{Workspace{Status: "failed"}, 1},
	} {
		if got := waitStatus(c.w); got != c.code {
			t.Fatalf("%+v: exit %d, want %d", c.w, got, c.code)
		}
	}
}

func TestReadPrintsTheConversation(t *testing.T) {
	server := (&fakeAPI{}).server(t)
	var out, errs bytes.Buffer
	if code := readCommand(context.Background(), server.URL, signedIn, []string{"w1", "--limit", "10"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	text := out.String()
	for _, want := range []string{"You: fix it", "→ Bash", "Agent: Fixed.", "--before 100"} {
		if !strings.Contains(text, want) {
			t.Fatalf("printed %q, missing %q", text, want)
		}
	}
}

func TestDeleteAsksFirstUnlessYes(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	if code := deleteCommand(context.Background(), server.URL, signedIn, []string{"w1"}, terminal{}, &out, &errs); code != 2 {
		t.Fatalf("no one to ask: exit %d", code)
	}
	if len(api.requests) != 0 {
		t.Fatal("deleted without asking")
	}
	if code := deleteCommand(context.Background(), server.URL, signedIn, []string{"w1", "--yes"}, terminal{}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if req, _ := api.last(); req.Method != "DELETE" {
		t.Fatalf("asked %s", req.Method)
	}
}

func TestTheAPIsRefusalsAreSaid(t *testing.T) {
	server := (&fakeAPI{}).server(t)
	var out, errs bytes.Buffer
	if code := getCommand(context.Background(), server.URL, signedIn, []string{"missing"}, &out, &errs); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(errs.String(), "No session by that id") {
		t.Fatalf("said %q", errs.String())
	}
	errs.Reset()
	if code := getCommand(context.Background(), server.URL, Config{Token: "stale"}, []string{"w1"}, &out, &errs); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(errs.String(), "revoked") || !strings.Contains(errs.String(), "outrunner login") {
		t.Fatalf("said %q", errs.String())
	}
}

func TestAnAPIKeyInTheEnvironmentWins(t *testing.T) {
	server := (&fakeAPI{}).server(t)
	t.Setenv("OUTRUNNER_API_KEY", "good")
	var out, errs bytes.Buffer
	if code := getCommand(context.Background(), server.URL, Config{}, []string{"w1"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	t.Setenv("OUTRUNNER_API_KEY", "")
	if code := getCommand(context.Background(), server.URL, Config{}, []string{"w1"}, &out, &errs); code != 1 {
		t.Fatalf("no credential: exit %d", code)
	}
}

// noFenceAPI answers a send with no after_event; `before` is what a look at
// the session says before it (null: its box wasn't up), and later looks say
// working from the second on.
func noFenceAPI(t *testing.T, before string, waited *string) *httptest.Server {
	t.Helper()
	sent, gets := false, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/messages"):
			sent = true
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"result":"sent","workspace_id":"w1","after_event":null}`))
		case strings.HasSuffix(r.URL.Path, "/wait"):
			*waited = r.URL.RawQuery
			_, _ = w.Write([]byte(`{"id":"w1","status":"ready","turn":{"state":"idle","last_message":"Fixed."}}`))
		case !sent:
			_, _ = w.Write([]byte(`{"id":"w1","status":"suspended","turn":` + before + `}`))
		default:
			gets++
			state := "idle"
			if gets >= 2 {
				state = "working"
			}
			_, _ = w.Write([]byte(`{"id":"w1","status":"ready","turn":{"state":"` + state + `"}}`))
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OUTRUNNER_API_KEY", "")
	return server
}

func TestSendWithNoFenceWaitsFromWhereTheLogStoodBefore(t *testing.T) {
	var waited string
	server := noFenceAPI(t, `{"state":"idle","last_event_id":"480"}`, &waited)
	var out, errs bytes.Buffer
	if code := sendCommand(context.Background(), server.URL, signedIn, []string{"w1", "--wait", "go"}, terminal{interactive: true}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if !strings.Contains(waited, "after_event=480") || !strings.Contains(out.String(), "Fixed.") {
		t.Fatalf("waited with %q, printed %q", waited, out.String())
	}
}

func TestSendWithNoFenceAtAllWaitsForTheTurnToStart(t *testing.T) {
	awaitWorkingEvery = time.Millisecond
	defer func() { awaitWorkingEvery = 2 * time.Second }()
	var waited string
	server := noFenceAPI(t, "null", &waited)
	var out, errs bytes.Buffer
	if code := sendCommand(context.Background(), server.URL, signedIn, []string{"w1", "--wait", "go"}, terminal{interactive: true}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if strings.Contains(waited, "after_event") || errs.Len() != 0 || !strings.Contains(out.String(), "Fixed.") {
		t.Fatalf("waited with %q, said %q, printed %q", waited, errs.String(), out.String())
	}
}

func TestADoubleDashEndsTheFlags(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	code := sendCommand(context.Background(), server.URL, signedIn, []string{"w1", "--", "use", "--json", "output", "-rf"}, terminal{interactive: true}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if _, body := api.last(); body["content"] != "use --json output -rf" {
		t.Fatalf("sent %v", body)
	}
	if strings.HasPrefix(strings.TrimSpace(out.String()), "{") {
		t.Fatalf("--json after -- was taken as the flag: %q", out.String())
	}
}

func TestDeleteTakesOnlyAYes(t *testing.T) {
	api := &fakeAPI{}
	server := api.server(t)
	var out, errs bytes.Buffer
	// A bare Enter: no.
	asked := terminal{interactive: true, out: &out, lines: lines("").lines}
	if code := deleteCommand(context.Background(), server.URL, signedIn, []string{"w1"}, asked, &out, &errs); code != 1 || len(api.requests) != 0 {
		t.Fatalf("Enter deleted it: exit %d", code)
	}
	if !strings.Contains(out.String(), "(y/N)") {
		t.Fatalf("asked %q", out.String())
	}
	yes := terminal{interactive: true, out: &out, lines: lines("yes").lines}
	if code := deleteCommand(context.Background(), server.URL, signedIn, []string{"w1"}, yes, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
}

func TestAWaitThatTimesOutSaysToKeepItsFenceAndOrg(t *testing.T) {
	var out bytes.Buffer
	printWaited(&out, Workspace{ID: "w1", Status: "ready", TimedOut: true}, waitHint(API{Org: "Acme Inc"}, "w1", "480"))
	if !strings.Contains(out.String(), `outrunner wait w1 --after 480 --org 'Acme Inc'`) {
		t.Fatalf("printed %q", out.String())
	}
}

func TestSendsHintKeepsTheOrg(t *testing.T) {
	server := (&fakeAPI{}).server(t)
	var out, errs bytes.Buffer
	if code := sendCommand(context.Background(), server.URL, signedIn, []string{"w1", "--org", "acme", "go"}, terminal{interactive: true}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if !strings.Contains(out.String(), "outrunner wait w1 --after 480 --org acme") {
		t.Fatalf("printed %q", out.String())
	}
}

// flakyWait fails its first `failures` wait calls with `status` (0: the
// connection dropped), then answers that the turn is over.
func flakyWait(t *testing.T, failures, status int) (*httptest.Server, *int) {
	t.Helper()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls <= failures {
			if status == 0 {
				hijacker, _ := w.(http.Hijacker)
				conn, _, _ := hijacker.Hijack()
				_ = conn.Close()
				return
			}
			w.WriteHeader(status)
			return
		}
		_, _ = w.Write([]byte(`{"id":"w1","status":"ready","turn":{"state":"idle","last_message":"Fixed."}}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("OUTRUNNER_API_KEY", "")
	waitRetries = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() {
		waitRetries = []time.Duration{2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second, 60 * time.Second}
	})
	return server, &calls
}

func TestAWaitOutlastsADroppedCallOrA502(t *testing.T) {
	for _, status := range []int{0, 502, 429} {
		server, calls := flakyWait(t, 2, status)
		var out, errs bytes.Buffer
		if code := waitCommand(context.Background(), server.URL, signedIn, []string{"w1", "--after", "480"}, &out, &errs); code != 0 {
			t.Fatalf("status %d: exit %d: %s", status, code, errs.String())
		}
		if *calls != 3 || !strings.Contains(out.String(), "Fixed.") {
			t.Fatalf("status %d: %d calls, printed %q", status, *calls, out.String())
		}
	}
}

func TestAWaitThatCantReachOutrunnerSaysHowToCarryOn(t *testing.T) {
	server, _ := flakyWait(t, 10, 503)
	var out, errs bytes.Buffer
	if code := waitCommand(context.Background(), server.URL, signedIn, []string{"w1", "--after", "480"}, &out, &errs); code != 5 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if !strings.Contains(errs.String(), "outrunner wait w1 --after 480") {
		t.Fatalf("said %q", errs.String())
	}
}

func TestARefusedWaitEndsAtOnce(t *testing.T) {
	server, calls := flakyWait(t, 10, 404)
	var out, errs bytes.Buffer
	if code := waitCommand(context.Background(), server.URL, signedIn, []string{"w1"}, &out, &errs); code != 1 || *calls != 1 {
		t.Fatalf("exit %d after %d calls", code, *calls)
	}
}

func TestAnAnswerOrAQueuedMessageWaitsFromWhereTheLogStood(t *testing.T) {
	// Asking a question, or mid-turn: the API's fenced wait waits for this
	// message past the fence, so the snapshot is the fence either way.
	for _, before := range []string{`{"state":"needs_input","last_event_id":"480"}`, `{"state":"working","last_event_id":"480"}`} {
		var waited string
		server := noFenceAPI(t, before, &waited)
		var out, errs bytes.Buffer
		if code := sendCommand(context.Background(), server.URL, signedIn, []string{"w1", "--wait", "Postgres"}, terminal{interactive: true}, &out, &errs); code != 0 {
			t.Fatalf("exit %d: %s", code, errs.String())
		}
		if !strings.Contains(waited, "after_event=480") {
			t.Fatalf("from %s, waited with %q", before, waited)
		}
	}
}

func TestOrgNamesAreQuotedForTheShell(t *testing.T) {
	for org, want := range map[string]string{
		"acme":     " --org acme",
		"Acme Inc": " --org 'Acme Inc'",
		"a&b":      " --org 'a&b'",
		"$x":       " --org '$x'",
		"o'neil":   ` --org 'o'\''neil'`,
	} {
		if got := orgArg(API{Org: org}); got != want {
			t.Fatalf("%q: %q, want %q", org, got, want)
		}
	}
}

func TestRetriesKeepToTheTimeout(t *testing.T) {
	server, calls := flakyWait(t, 100, 502)
	waitRetries = []time.Duration{time.Second, time.Second}
	var out, errs bytes.Buffer
	started := time.Now()
	if code := waitCommand(context.Background(), server.URL, signedIn, []string{"w1", "--after", "480", "--timeout", "50ms"}, &out, &errs); code != 4 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if *calls != 1 || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("%d calls in %s", *calls, time.Since(started))
	}
	if !strings.Contains(out.String(), "--after 480") || !strings.Contains(errs.String(), "502") {
		t.Fatalf("printed %q, said %q", out.String(), errs.String())
	}
}

func TestAShortTimeoutDoesntCallAgainAndAgain(t *testing.T) {
	api := &fakeAPI{waits: []string{
		`{"id":"w1","status":"ready","turn":{"state":"working"},"timed_out":true}`,
		`{"id":"w1","status":"ready","turn":{"state":"working"},"timed_out":true}`,
		`{"id":"w1","status":"ready","turn":{"state":"working"},"timed_out":true}`,
	}}
	server := api.server(t)
	var out, errs bytes.Buffer
	if code := waitCommand(context.Background(), server.URL, signedIn, []string{"w1", "--timeout", "2s"}, &out, &errs); code != 4 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if len(api.requests) != 1 {
		t.Fatalf("%d calls for a 2s timeout", len(api.requests))
	}
}
