package desktop

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeToolbox is Daytona's toolbox as the tools use it: a desktop that starts
// inactive, and recordings written as files in a folder of its own.
type fakeToolbox struct {
	t      *testing.T
	mu     sync.Mutex
	status string
	calls  []string
	bodies map[string]map[string]any
	dir    string
	recs   map[string]*Recording
	// broken answers every call as a crashed computer-use service does.
	broken bool
}

func newFakeToolbox(t *testing.T) (*fakeToolbox, *httptest.Server) {
	f := &fakeToolbox{t: t, status: "inactive", bodies: map[string]map[string]any{}, dir: t.TempDir(), recs: map[string]*Recording{}}
	server := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(server.Close)
	return f, server
}

func (f *fakeToolbox) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.bodies[r.URL.Path] = body
	if f.broken {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"statusCode":500,"message":"internal server error: connection is shut down"}`))
		return
	}
	reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch r.URL.Path {
	case "/computeruse/status":
		reply(map[string]string{"status": f.status})
	case "/computeruse/start":
		f.status = "active"
		reply(map[string]string{"message": "started"})
	case "/computeruse/screenshot/compressed":
		if r.URL.Query().Get("format") != "jpeg" {
			f.t.Errorf("screenshot query = %s", r.URL.RawQuery)
		}
		reply(map[string]any{"screenshot": base64.StdEncoding.EncodeToString([]byte("JPEGDATA"))})
	case "/computeruse/display/info":
		reply(map[string]any{"displays": []map[string]any{{"width": 1280, "height": 800, "isActive": true}}})
	case "/computeruse/recordings/start":
		label, _ := body["label"].(string)
		rec := &Recording{ID: "rec-1", Status: "recording", StartTime: "2026-10-29T09:00:00Z",
			FilePath: filepath.Join(f.dir, "rec-1_"+label+"_20261029_090000.mp4")}
		if err := os.WriteFile(rec.FilePath, []byte("MP4DATA"), 0o644); err != nil {
			f.t.Fatal(err)
		}
		f.recs[rec.ID] = rec
		reply(rec)
	case "/computeruse/recordings/stop":
		rec := f.recs[body["id"].(string)]
		rec.Status, rec.DurationSeconds, rec.SizeBytes = "completed", 4.5, 7
		reply(rec)
	case "/computeruse/recordings":
		var list []Recording
		for _, rec := range f.recs {
			if _, err := os.Stat(rec.FilePath); err == nil {
				list = append(list, *rec)
			}
		}
		reply(map[string]any{"recordings": list})
	default:
		reply(map[string]any{})
	}
}

func (f *fakeToolbox) called(call string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == call {
			n++
		}
	}
	return n
}

func (f *fakeToolbox) body(path string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bodies[path]
}

// mcpClient drives a server over pipes, as an agent's CLI does.
type mcpClient struct {
	t    *testing.T
	in   io.WriteCloser
	out  *bufio.Scanner
	next int
}

func startServer(t *testing.T, cfg Config) *mcpClient {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	if cfg.StartSettle == 0 {
		cfg.StartSettle = time.Millisecond
	}
	go func() {
		_ = Serve(context.Background(), inR, outW, cfg)
		outW.Close()
	}()
	t.Cleanup(func() { inW.Close() })
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	return &mcpClient{t: t, in: inW, out: scanner}
}

func (c *mcpClient) request(method string, params any) map[string]any {
	c.t.Helper()
	c.next++
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": c.next, "method": method, "params": params})
	if _, err := c.in.Write(append(data, '\n')); err != nil {
		c.t.Fatal(err)
	}
	if !c.out.Scan() {
		c.t.Fatalf("%s: no answer", method)
	}
	var resp struct {
		Result map[string]any `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.Unmarshal(c.out.Bytes(), &resp); err != nil {
		c.t.Fatal(err)
	}
	if resp.Error != nil {
		c.t.Fatalf("%s: %v", method, resp.Error)
	}
	return resp.Result
}

// tool calls one tool, returning its text and whether it is an error.
func (c *mcpClient) tool(name string, args map[string]any) (string, map[string]any) {
	c.t.Helper()
	result := c.request("tools/call", map[string]any{"name": name, "arguments": args})
	var texts []string
	for _, item := range result["content"].([]any) {
		if m := item.(map[string]any); m["type"] == "text" {
			texts = append(texts, m["text"].(string))
		}
	}
	return strings.Join(texts, "\n"), result
}

func isError(result map[string]any) bool { return result["isError"] == true }

func testConfig(t *testing.T, toolbox string) (Config, string) {
	session := t.TempDir()
	return Config{
		Toolbox: &Toolbox{Base: toolbox},
		Browser: &Browser{Port: 1, Profile: filepath.Join(t.TempDir(), "chromium"), Display: Display},
		Folder:  FilesFolder(session),
		Now:     func() time.Time { return time.Date(2026, 10, 29, 9, 30, 15, 123e6, time.UTC) },
	}, session
}

func TestTheServerOffersItsToolsAndSaysWhenToUseThem(t *testing.T) {
	_, toolbox := newFakeToolbox(t)
	cfg, _ := testConfig(t, toolbox.URL)
	c := startServer(t, cfg)
	init := c.request("initialize", map[string]any{"protocolVersion": "2025-06-18"})
	if init["protocolVersion"] != "2025-06-18" || !strings.Contains(init["instructions"].(string), "Prefer an API") {
		t.Fatalf("initialize = %v", init)
	}
	var names []string
	for _, tool := range c.request("tools/list", nil)["tools"].([]any) {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	want := "screenshot click double_click drag scroll type key open_browser browser_snapshot browser_click browser_fill browser_navigate record_start record_stop"
	if strings.Join(names, " ") != want {
		t.Fatalf("tools = %v", names)
	}
}

func TestTheFirstToolStartsTheDesktopAndAScreenshotIsSeenAndKept(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, session := testConfig(t, toolbox.URL)
	c := startServer(t, cfg)
	text, result := c.tool(ToolScreenshot, nil)
	if isError(result) {
		t.Fatal(text)
	}
	if fake.called("POST /computeruse/start") != 1 {
		t.Fatalf("calls = %v", fake.calls)
	}
	path := filepath.Join(session, ".context", "desktop", "screenshot-20261029-093015-123.jpg")
	if !strings.Contains(text, "1280×800") || !strings.Contains(text, path) {
		t.Errorf("text = %q", text)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "JPEGDATA" {
		t.Errorf("saved = %q, %v", data, err)
	}
	image := result["content"].([]any)[1].(map[string]any)
	if image["type"] != "image" || image["mimeType"] != "image/jpeg" || image["data"] != base64.StdEncoding.EncodeToString([]byte("JPEGDATA")) {
		t.Errorf("image = %v", image)
	}
	// Kept out of git, whether or not the repository ignores .context.
	if ignore, _ := os.ReadFile(filepath.Join(session, ".context", "desktop", ".gitignore")); string(ignore) != "*\n" {
		t.Errorf(".gitignore = %q", ignore)
	}

	// Running now: not started again, and its size, which doesn't change,
	// not asked again.
	c.tool(ToolScreenshot, nil)
	if fake.called("POST /computeruse/start") != 1 {
		t.Fatalf("started twice: %v", fake.calls)
	}
	if n := fake.called("GET /computeruse/display/info"); n != 1 {
		t.Errorf("display size asked %d times", n)
	}
}

func TestThePointerAndKeyboardToolsSayWhatTheyDo(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, _ := testConfig(t, toolbox.URL)
	c := startServer(t, cfg)

	if text, r := c.tool(ToolDoubleClick, map[string]any{"x": 10, "y": 20}); isError(r) || !strings.HasPrefix(text, "Double-clicked at (10, 20)") {
		t.Fatalf("double_click = %q", text)
	}
	if b := fake.body("/computeruse/mouse/click"); b["double"] != true || b["button"] != "left" || b["x"] != 10.0 {
		t.Errorf("click body = %v", b)
	}
	c.tool(ToolClick, map[string]any{"x": 1, "y": 2, "button": "right"})
	if b := fake.body("/computeruse/mouse/click"); b["double"] != false || b["button"] != "right" {
		t.Errorf("click body = %v", b)
	}
	c.tool(ToolDrag, map[string]any{"from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4})
	if b := fake.body("/computeruse/mouse/drag"); b["startX"] != 1.0 || b["endY"] != 4.0 {
		t.Errorf("drag body = %v", b)
	}
	c.tool(ToolScroll, map[string]any{"x": 5, "y": 6, "direction": "down"})
	if b := fake.body("/computeruse/mouse/scroll"); b["direction"] != "down" || b["amount"] != 3.0 {
		t.Errorf("scroll body = %v", b)
	}
	c.tool(ToolType, map[string]any{"text": "hello"})
	if b := fake.body("/computeruse/keyboard/type"); b["text"] != "hello" {
		t.Errorf("type body = %v", b)
	}
	c.tool(ToolKey, map[string]any{"keys": "ctrl+l"})
	if b := fake.body("/computeruse/keyboard/hotkey"); b["keys"] != "ctrl+l" {
		t.Errorf("key body = %v", b)
	}

	for _, bad := range []struct {
		name string
		args map[string]any
	}{
		{ToolClick, map[string]any{"x": 1}},
		{ToolClick, map[string]any{"x": 1, "y": 1, "button": "side"}},
		{ToolScroll, map[string]any{"x": 1, "y": 1, "direction": "left"}},
		{ToolType, map[string]any{"text": ""}},
		{ToolKey, map[string]any{}},
		{ToolOpenBrowser, map[string]any{"url": "file:///etc/passwd"}},
		{ToolOpenBrowser, map[string]any{"url": "javascript:alert(1)"}},
		{ToolBrowserClick, map[string]any{"ref": "button"}},
		{"rm_rf", nil},
	} {
		if text, r := c.tool(bad.name, bad.args); !isError(r) {
			t.Errorf("%s %v was taken: %q", bad.name, bad.args, text)
		}
	}
}

func TestARecordingIsKeptInTheSessionFolderUnderItsLabel(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, session := testConfig(t, toolbox.URL)
	c := startServer(t, cfg)

	if text, r := c.tool(ToolRecordStop, nil); !isError(r) || !strings.Contains(text, "no recording is running") {
		t.Fatalf("record_stop with none = %q", text)
	}
	if text, r := c.tool(ToolRecordStart, map[string]any{"label": "Login fix: before!"}); isError(r) {
		t.Fatal(text)
	}
	tag := (&server{cfg: cfg}).sessionTag()
	if b := fake.body("/computeruse/recordings/start"); b["label"] != tag+"-login-fix-before" {
		t.Errorf("label sent = %v", b)
	}
	if text, r := c.tool(ToolRecordStart, nil); !isError(r) || !strings.Contains(text, "already running") {
		t.Fatalf("a second record_start = %q", text)
	}

	text, result := c.tool(ToolRecordStop, nil)
	if isError(result) {
		t.Fatal(text)
	}
	path := filepath.Join(session, ".context", "desktop", "recording-20261029-093015-123-login-fix-before.mp4")
	if data, err := os.ReadFile(path); err != nil || string(data) != "MP4DATA" {
		t.Fatalf("kept = %q, %v", data, err)
	}
	if text != "Saved the recording to "+path+" (4.5 s, 7 bytes, MP4 video)." {
		t.Errorf("text = %q", text)
	}
	structured := result["structuredContent"].(map[string]any)
	if structured["path"] != path || structured["durationSeconds"] != 4.5 || structured["sizeBytes"] != 7.0 {
		t.Errorf("structured = %v", structured)
	}
	// Moved, not copied: the toolbox lists it no more.
	if entries, _ := os.ReadDir(fake.dir); len(entries) != 0 {
		t.Errorf("left in the toolbox's folder: %v", entries)
	}
}

func TestRecordStopLeavesOtherSessionsAndFailedRecordingsAlone(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, _ := testConfig(t, toolbox.URL)
	other := &server{cfg: Config{Folder: t.TempDir()}}
	for id, item := range map[string]struct {
		tag    string
		status string
	}{
		"other-session": {tag: other.sessionTag(), status: "completed"},
		"failed":        {tag: (&server{cfg: cfg}).sessionTag(), status: "failed"},
	} {
		path := filepath.Join(fake.dir, id+"_"+item.tag+"_20261029_090000.mp4")
		if err := os.WriteFile(path, []byte("MP4DATA"), 0o644); err != nil {
			t.Fatal(err)
		}
		fake.recs[id] = &Recording{ID: id, FilePath: path, Status: item.status, StartTime: "2026-10-29T09:00:00Z"}
	}

	c := startServer(t, cfg)
	if text, result := c.tool(ToolRecordStop, nil); !isError(result) || !strings.Contains(text, "no recording is running") {
		t.Fatalf("record_stop adopted an unrelated recording: %q", text)
	}
	if n := fake.called("POST /computeruse/recordings/stop"); n != 0 {
		t.Errorf("stopped unrelated recordings %d times", n)
	}
	if entries, _ := os.ReadDir(fake.dir); len(entries) != 2 {
		t.Errorf("recordings in toolbox folder = %v", entries)
	}
}

// The time limit is kept by a watchdog of its own, not by the server: a
// server restarted mid-recording (a new one, without the first's state)
// still hands over the recording its watchdog stopped.
func TestARecordingLeftRunningStopsAtItsLimitWhateverHappensToTheServer(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, session := testConfig(t, toolbox.URL)
	cfg.MaxRecording = 50 * time.Millisecond
	var watched []string
	var mu sync.Mutex
	cfg.Watchdog = func(id string, until time.Time) error {
		mu.Lock()
		watched = append(watched, id)
		mu.Unlock()
		if d := time.Until(until); d <= 0 || d > time.Second {
			t.Errorf("watchdog until %s from now", d)
		}
		// Another process in the real thing: here, one the server can't stop.
		go func() { _ = CapRecording(context.Background(), &Toolbox{Base: toolbox.URL}, id, until) }()
		return nil
	}
	first := startServer(t, cfg)
	if text, r := first.tool(ToolRecordStart, map[string]any{"label": "Flow"}); isError(r) {
		t.Fatal(text)
	}
	first.in.Close() // the CLI restarts its servers
	time.Sleep(300 * time.Millisecond)
	if n := fake.called("POST /computeruse/recordings/stop"); n != 1 {
		t.Fatalf("stopped %d times at its limit", n)
	}

	cfg.Watchdog = nil
	second := startServer(t, cfg)
	text, result := second.tool(ToolRecordStop, nil)
	if isError(result) || !strings.Contains(text, "reached its 50ms limit and stopped by itself") {
		t.Fatalf("record_stop = %q", text)
	}
	path := filepath.Join(session, ".context", "desktop", "recording-20261029-093015-123-flow.mp4")
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if structured := result["structuredContent"].(map[string]any); structured["path"] != path {
		t.Errorf("structured = %v", structured)
	}
	if len(watched) != 1 || watched[0] != "rec-1" {
		t.Errorf("watched = %v", watched)
	}
}

func TestNoRecordingRunsWithoutItsWatchdog(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, _ := testConfig(t, toolbox.URL)
	cfg.Watchdog = func(string, time.Time) error { return errors.New("fork: no more processes") }
	c := startServer(t, cfg)
	if text, r := c.tool(ToolRecordStart, nil); !isError(r) || !strings.Contains(text, "time limit couldn't be set") {
		t.Fatalf("record_start = %q", text)
	}
	if fake.called("POST /computeruse/recordings/stop") != 1 {
		t.Errorf("the recording was left running: %v", fake.calls)
	}
}

func TestAWatchdogLeavesARecordingAlreadyStopped(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	cfg, _ := testConfig(t, toolbox.URL)
	c := startServer(t, cfg)
	cfg.MaxRecording = time.Hour
	c.tool(ToolRecordStart, nil)
	c.tool(ToolRecordStop, nil)
	if err := CapRecording(context.Background(), cfg.Toolbox, "rec-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := fake.called("POST /computeruse/recordings/stop"); n != 1 {
		t.Errorf("stopped %d times", n)
	}
}

func TestACrashedDesktopServiceIsSaidPlainly(t *testing.T) {
	fake, toolbox := newFakeToolbox(t)
	fake.broken = true
	cfg, _ := testConfig(t, toolbox.URL)
	c := startServer(t, cfg)
	if text, r := c.tool(ToolScreenshot, nil); !isError(r) || !strings.Contains(text, "only comes back when the computer restarts") {
		t.Fatalf("screenshot = %q", text)
	}
}

func TestAvailableIsTheToolboxAnswering(t *testing.T) {
	_, toolbox := newFakeToolbox(t)
	if !Available(context.Background(), toolbox.URL) {
		t.Error("a toolbox that answers isn't available")
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	if Available(context.Background(), closed.URL) {
		t.Error("nothing listening is available")
	}
	notFound := httptest.NewServer(http.NotFoundHandler())
	defer notFound.Close()
	if Available(context.Background(), notFound.URL) {
		t.Error("a server that isn't the toolbox is available")
	}
}

func TestWebAddresses(t *testing.T) {
	for in, want := range map[string]string{
		"https://example.com":    "https://example.com",
		"example.com/a":          "https://example.com/a",
		"localhost:3000":         "http://localhost:3000",
		"127.0.0.1:8000/x":       "http://127.0.0.1:8000/x",
		" http://localhost:5173": "http://localhost:5173",
		"HTTPS://Example.com":    "HTTPS://Example.com",
		"example.com:8443/a":     "https://example.com:8443/a",
		"0.0.0.0:8080":           "http://0.0.0.0:8080",
		"localhost":              "http://localhost",
		"localhost/a?b#c":        "http://localhost/a?b#c",
		// Hosts on the internet, whatever their names start with.
		"localhost.example.com": "https://localhost.example.com",
		"localhostfoo.com/x":    "https://localhostfoo.com/x",
		"127.0.0.1.nip.io":      "https://127.0.0.1.nip.io",
	} {
		if got, err := webURL(in); err != nil || got != want {
			t.Errorf("webURL(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,hi", "about:blank"} {
		if got, err := webURL(bad); err == nil {
			t.Errorf("webURL(%q) = %q", bad, got)
		}
	}
}
