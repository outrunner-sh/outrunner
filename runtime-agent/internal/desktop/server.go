// Package desktop is the agent's desktop tools: an MCP server, launched over
// stdio by a session's Claude Code or Codex (`runtime-agent desktop-mcp`),
// that looks at and drives the box's desktop, the same one the session's
// owner watches in the Desktop tab. It takes screenshots, moves the pointer
// and types; opens Chromium and drives it through DevTools by the page's
// accessibility tree; and records the screen.
//
// Screenshots and recordings are kept in the session's folder, under
// .context/desktop/ (FilesFolder), where the session's other screenshots go:
// a screenshot is embedded in the chat from there, and a recording is there
// to attach to a pull request.
package desktop

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ServerName is the MCP server's name, which its tools are known by:
// mcp__outrunner_desktop__screenshot to Claude, outrunner_desktop.screenshot
// to Codex.
const ServerName = "outrunner_desktop"

// The tools' names. They are a contract: the agent's instructions and the
// pull-request evidence built on recordings name them.
const (
	ToolScreenshot      = "screenshot"
	ToolClick           = "click"
	ToolDoubleClick     = "double_click"
	ToolDrag            = "drag"
	ToolScroll          = "scroll"
	ToolType            = "type"
	ToolKey             = "key"
	ToolOpenBrowser     = "open_browser"
	ToolBrowserSnapshot = "browser_snapshot"
	ToolBrowserClick    = "browser_click"
	ToolBrowserFill     = "browser_fill"
	ToolBrowserNavigate = "browser_navigate"
	ToolRecordStart     = "record_start"
	ToolRecordStop      = "record_stop"
)

// ReadOnlyTools only look: a session may use them without asking.
var ReadOnlyTools = []string{ToolScreenshot, ToolBrowserSnapshot}

// FilesFolder is where a session's screenshots and recordings are kept.
func FilesFolder(sessionFolder string) string {
	return filepath.Join(sessionFolder, ".context", "desktop")
}

// Display is the desktop's X display, the one Daytona's computer use starts.
const Display = ":0"

// MaxRecording is how long a recording runs before it stops on its own: one
// forgotten would otherwise fill the box's disk.
const MaxRecording = 10 * time.Minute

// Instructions tell the agent when the tools are worth it, and when not: in
// the session's orientation (internal/workspace), which Claude Code and Codex
// both read. The server's own, which only some clients show the model, is
// serverInstructions, a summary.
const Instructions = `This session's computer has a desktop (a 1280×800 Linux screen) that you can see and use with the outrunner_desktop tools. The user can watch it live in the session's Desktop tab.

Use it when seeing or using a graphical interface is the point: to check a UI you changed looks and behaves right in a real browser, to reproduce a bug that only shows on screen, or to work with a website or app that has no API or CLI. Prefer an API, a CLI, or a test run whenever one can do the job: they are faster and more reliable than a screen.

For web pages, use the browser tools: open_browser with a URL, then browser_snapshot to read the page as an accessibility tree whose elements carry refs (e123), and browser_click, browser_fill and browser_navigate by ref. Take a new snapshot after the page changes; refs from an old one may be gone. Use screenshot to see how the page looks, and the pointer tools (click, double_click, drag, scroll, type, key, at pixel coordinates read off the latest screenshot) for anything outside a web page or that the tree doesn't reach.

Screenshots are saved under .context/desktop/ in the session's folder; embed one in your reply to show the user. To capture a flow as evidence (a before and after, a bug and its fix), call record_start before you go through it and record_stop after: record_stop gives the path of the MP4 it saved.`

const serverInstructions = "Tools for this computer's desktop and its Chromium browser, which the user can watch in the Desktop tab. Prefer an API, a CLI or a test run; use these to see or use a graphical interface: a UI you changed, a site with no API. For web pages, read them with browser_snapshot and act by ref (browser_click, browser_fill) rather than clicking pixels. record_start and record_stop capture a flow as an MP4."

// Config is what a server works with.
type Config struct {
	Toolbox *Toolbox
	Browser *Browser
	// Folder is where screenshots and recordings are saved (FilesFolder).
	Folder string
	// Now is time.Now but in tests.
	Now func() time.Time
	// MaxRecording is MaxRecording but in tests.
	MaxRecording time.Duration
	// StartSettle is how long a desktop just started is given before it's
	// used: two seconds but in tests.
	StartSettle time.Duration
	// Watchdog holds a recording to MaxRecording (see Watchdog); nil keeps
	// the cap in this process, which only tests do.
	Watchdog Watchdog
}

// Watchdog sees that recording id stops at `until` if it is still running
// then, from a process of its own: the agent's CLI may restart this server,
// or the session end, mid-recording, and a cap kept in this process would go
// with it while the recording ran on, filling the disk. runtime-agent's is
// `desktop-mcp --stop-recording` (CapRecording), detached.
type Watchdog func(id string, until time.Time) error

// CapRecording waits until `until`, then stops recording id if it is still
// running. Its file stays in the toolbox's folder, where the next
// record_stop finds it and keeps it.
func CapRecording(ctx context.Context, tb *Toolbox, id string, until time.Time) error {
	if err := pause(ctx, time.Until(until)); err != nil {
		return err
	}
	recordings, err := tb.Recordings(ctx)
	if err != nil {
		return err
	}
	for _, rec := range recordings {
		if rec.ID == id && rec.Status == "recording" {
			_, err := tb.StopRecording(ctx, id)
			return err
		}
	}
	return nil
}

// protocolVersions are the MCP versions the server speaks; a client asking
// for another gets the newest.
var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Serve speaks MCP on in and out until in ends (the CLI closed it) or ctx
// does. Calls run one at a time, in order: two clicks at once on one screen
// would land in no order anyone meant. Pings are answered meanwhile.
func Serve(ctx context.Context, in io.Reader, out io.Writer, cfg Config) error {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MaxRecording == 0 {
		cfg.MaxRecording = MaxRecording
	}
	if cfg.StartSettle == 0 {
		cfg.StartSettle = 2 * time.Second
	}
	if cfg.Watchdog == nil {
		cfg.Watchdog = func(id string, until time.Time) error {
			go func() { _ = CapRecording(context.Background(), cfg.Toolbox, id, until) }()
			return nil
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &server{cfg: cfg, out: out}
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			s.send(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "parse error"}})
			continue
		}
		s.handle(ctx, msg)
	}
	cancel()
	s.wg.Wait()
	return scanner.Err()
}

type server struct {
	cfg   Config
	outMu sync.Mutex
	out   io.Writer
	wg    sync.WaitGroup
	// callMu runs the tools one at a time.
	callMu sync.Mutex

	sizeMu        sync.Mutex
	width, height int
}

func (s *server) send(resp rpcResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, _ = s.out.Write(append(data, '\n'))
}

func (s *server) handle(ctx context.Context, msg rpcMessage) {
	switch msg.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(msg.Params, &params)
		version := protocolVersions[0]
		for _, v := range protocolVersions {
			if v == params.ProtocolVersion {
				version = v
			}
		}
		s.send(rpcResponse{JSONRPC: "2.0", ID: msg.ID, Result: map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": ServerName, "version": "1"},
			"instructions":    serverInstructions,
		}})
	case "ping":
		s.send(rpcResponse{JSONRPC: "2.0", ID: msg.ID, Result: map[string]any{}})
	case "tools/list":
		s.send(rpcResponse{JSONRPC: "2.0", ID: msg.ID, Result: map[string]any{"tools": tools}})
	case "tools/call":
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.callMu.Lock()
			defer s.callMu.Unlock()
			callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			defer cancel()
			s.send(rpcResponse{JSONRPC: "2.0", ID: msg.ID, Result: s.call(callCtx, msg.Params)})
		}()
	default:
		if len(msg.ID) > 0 {
			s.send(rpcResponse{JSONRPC: "2.0", ID: msg.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + msg.Method}})
		}
	}
}

// args are every tool's arguments, each reading the ones it takes.
type args struct {
	X         *int    `json:"x"`
	Y         *int    `json:"y"`
	Button    string  `json:"button"`
	FromX     *int    `json:"from_x"`
	FromY     *int    `json:"from_y"`
	ToX       *int    `json:"to_x"`
	ToY       *int    `json:"to_y"`
	Direction string  `json:"direction"`
	Amount    int     `json:"amount"`
	Text      *string `json:"text"`
	Keys      string  `json:"keys"`
	URL       string  `json:"url"`
	Ref       string  `json:"ref"`
	Submit    bool    `json:"submit"`
	Label     string  `json:"label"`
}

func textResult(text string) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}
}

func errorResult(err error) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": err.Error()}}, "isError": true}
}

func (s *server) call(ctx context.Context, raw json.RawMessage) map[string]any {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return errorResult(errors.New("malformed tool call"))
	}
	var a args
	if len(params.Arguments) > 0 {
		if err := json.Unmarshal(params.Arguments, &a); err != nil {
			return errorResult(fmt.Errorf("%s: malformed arguments: %v", params.Name, err))
		}
	}
	result, err := s.run(ctx, params.Name, a)
	if err != nil {
		return errorResult(err)
	}
	return result
}

func (s *server) run(ctx context.Context, name string, a args) (map[string]any, error) {
	tb := s.cfg.Toolbox
	if !knownTool(name) {
		return nil, fmt.Errorf("unknown tool %s", name)
	}
	if err := s.ensureDesktop(ctx); err != nil {
		return nil, err
	}
	switch name {
	case ToolScreenshot:
		return s.screenshot(ctx)
	case ToolClick, ToolDoubleClick:
		x, y, err := point(a.X, a.Y)
		if err != nil {
			return nil, err
		}
		button := a.Button
		if button == "" {
			button = "left"
		}
		if button != "left" && button != "right" && button != "middle" {
			return nil, fmt.Errorf("button is left, right or middle, not %q", button)
		}
		if err := tb.Click(ctx, x, y, button, name == ToolDoubleClick); err != nil {
			return nil, err
		}
		verb := "Clicked"
		if name == ToolDoubleClick {
			verb = "Double-clicked"
		}
		return textResult(fmt.Sprintf("%s at (%d, %d). Take a screenshot to see what it did.", verb, x, y)), nil
	case ToolDrag:
		fromX, fromY, err := point(a.FromX, a.FromY)
		if err != nil {
			return nil, err
		}
		toX, toY, err := point(a.ToX, a.ToY)
		if err != nil {
			return nil, err
		}
		if err := tb.Drag(ctx, fromX, fromY, toX, toY); err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("Dragged from (%d, %d) to (%d, %d).", fromX, fromY, toX, toY)), nil
	case ToolScroll:
		x, y, err := point(a.X, a.Y)
		if err != nil {
			return nil, err
		}
		if a.Direction != "up" && a.Direction != "down" {
			return nil, fmt.Errorf("direction is up or down, not %q", a.Direction)
		}
		amount := a.Amount
		if amount <= 0 {
			amount = 3
		}
		if err := tb.Scroll(ctx, x, y, a.Direction, amount); err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("Scrolled %s %d at (%d, %d).", a.Direction, amount, x, y)), nil
	case ToolType:
		if a.Text == nil || *a.Text == "" {
			return nil, errors.New("type needs text")
		}
		if err := tb.Type(ctx, *a.Text); err != nil {
			return nil, err
		}
		return textResult("Typed it."), nil
	case ToolKey:
		if strings.TrimSpace(a.Keys) == "" {
			return nil, errors.New("key needs keys, e.g. \"enter\" or \"ctrl+l\"")
		}
		if err := tb.Key(ctx, a.Keys); err != nil {
			return nil, err
		}
		return textResult("Pressed " + a.Keys + "."), nil
	case ToolOpenBrowser, ToolBrowserNavigate:
		target, err := webURL(a.URL)
		if err != nil {
			return nil, err
		}
		if name == ToolOpenBrowser {
			if err := s.cfg.Browser.Open(ctx, target); err != nil {
				return nil, err
			}
			snapshot, err := s.cfg.Browser.Snapshot(ctx)
			if err != nil {
				return nil, err
			}
			return textResult(snapshot), nil
		}
		snapshot, err := s.cfg.Browser.Navigate(ctx, target)
		if err != nil {
			return nil, err
		}
		return textResult(snapshot), nil
	case ToolBrowserSnapshot:
		snapshot, err := s.cfg.Browser.Snapshot(ctx)
		if err != nil {
			return nil, err
		}
		return textResult(snapshot), nil
	case ToolBrowserClick:
		text, err := s.cfg.Browser.Click(ctx, a.Ref)
		if err != nil {
			return nil, err
		}
		return textResult(text), nil
	case ToolBrowserFill:
		if a.Text == nil {
			return nil, errors.New("browser_fill needs text (empty to clear the field)")
		}
		text, err := s.cfg.Browser.Fill(ctx, a.Ref, *a.Text, a.Submit)
		if err != nil {
			return nil, err
		}
		return textResult(text), nil
	case ToolRecordStart:
		return s.recordStart(ctx, a.Label)
	case ToolRecordStop:
		return s.recordStop(ctx)
	}
	return nil, fmt.Errorf("unknown tool %s", name)
}

func knownTool(name string) bool {
	for _, t := range tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

func point(x, y *int) (int, int, error) {
	if x == nil || y == nil {
		return 0, 0, errors.New("needs x and y, in the screenshot's pixels")
	}
	if *x < 0 || *y < 0 {
		return 0, 0, fmt.Errorf("(%d, %d) is off the screen", *x, *y)
	}
	return *x, *y, nil
}

// schemeOf matches an address's scheme: letters and the like, then a colon
// that isn't a port's (localhost:3000 has none).
var schemeOf = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*):([^0-9]|$)`)

// webURL is the address to open: http(s) as given, a bare host given
// https (http on this computer), anything else (a file, javascript:)
// refused.
func webURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("needs a url")
	}
	if m := schemeOf.FindStringSubmatch(raw); m != nil {
		if scheme := strings.ToLower(m[1]); scheme != "http" && scheme != "https" {
			return "", fmt.Errorf("%q isn't a web address (http or https)", raw)
		}
		return raw, nil
	}
	// This computer by name, compared whole: localhost.example.com is a
	// host on the internet like any other, and gets https.
	host := raw
	if i := strings.IndexAny(host, ":/?#"); i >= 0 {
		host = host[:i]
	}
	if host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0" {
		return "http://" + raw, nil
	}
	return "https://" + raw, nil
}

// ensureDesktop starts the desktop if it isn't running and waits for it:
// the first desktop tool a session uses is what starts it. Nothing here ever
// stops it: on Daytona, the first screenshot after a stop and a start can
// crash its computer-use service for good (until the box restarts), which a
// desktop left running never meets.
func (s *server) ensureDesktop(ctx context.Context) error {
	tb := s.cfg.Toolbox
	status, err := tb.Status(ctx)
	if err != nil {
		return unavailable(err)
	}
	if status == "active" {
		return nil
	}
	if err := tb.Start(ctx); err != nil {
		return unavailable(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if status, err := tb.Status(ctx); err == nil && status == "active" {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("the desktop didn't start; try again")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	// Its processes run before the display takes a client: a moment for
	// the window manager to draw, and for a first screenshot to be of it.
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(s.cfg.StartSettle):
	}
	return nil
}

// unavailable says why the desktop can't be used, in the words the agent
// can act on.
func unavailable(err error) error {
	if strings.Contains(err.Error(), "connection is shut down") {
		// Daytona's computer-use service has crashed, and nothing brings it
		// back but the box restarting.
		return errors.New("this computer's desktop service stopped working and only comes back when the computer restarts. Tell the user; don't retry the desktop tools in this session")
	}
	return fmt.Errorf("this computer's desktop isn't available: %w", err)
}

// folder is the files folder, made if it isn't there with a .gitignore that
// keeps all of it out of git: .context is ignored where Outrunner made it,
// but a repository may track a .context of its own.
func (s *server) folder() (string, error) {
	if err := os.MkdirAll(s.cfg.Folder, 0o755); err != nil {
		return "", err
	}
	ignore := filepath.Join(s.cfg.Folder, ".gitignore")
	if _, err := os.Stat(ignore); os.IsNotExist(err) {
		_ = os.WriteFile(ignore, []byte("*\n"), 0o644)
	}
	return s.cfg.Folder, nil
}

func (s *server) stamp() string {
	now := s.cfg.Now().UTC()
	return now.Format("20060102-150405") + fmt.Sprintf("-%03d", now.Nanosecond()/int(time.Millisecond))
}

func (s *server) screenshot(ctx context.Context) (map[string]any, error) {
	image, err := s.cfg.Toolbox.Screenshot(ctx)
	if err != nil {
		return nil, err
	}
	dir, err := s.folder()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "screenshot-"+s.stamp()+".jpg")
	if err := os.WriteFile(path, image, 0o644); err != nil {
		return nil, err
	}
	size := "the desktop"
	if w, h := s.displaySize(ctx); w > 0 {
		size = fmt.Sprintf("the %d×%d desktop (coordinates are its pixels)", w, h)
	}
	return map[string]any{"content": []any{
		map[string]any{"type": "text", "text": fmt.Sprintf("Screenshot of %s, saved to %s.", size, path)},
		map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(image), "mimeType": "image/jpeg"},
	}}, nil
}

// displaySize is the desktop's size, asked once: a box's display keeps the
// size it started at. Zero when it couldn't be read, to be asked again.
func (s *server) displaySize(ctx context.Context) (int, int) {
	s.sizeMu.Lock()
	defer s.sizeMu.Unlock()
	if s.width == 0 {
		if w, h, err := s.cfg.Toolbox.DisplaySize(ctx); err == nil && w > 0 {
			s.width, s.height = w, h
		}
	}
	return s.width, s.height
}

// savedRecording is a recording moved into the files folder.
type savedRecording struct {
	Path            string  `json:"path"`
	DurationSeconds float64 `json:"durationSeconds"`
	SizeBytes       int64   `json:"sizeBytes"`
}

func (r savedRecording) describe() string {
	return fmt.Sprintf("Saved the recording to %s (%.1f s, %s, MP4 video).", r.Path, r.DurationSeconds, humanBytes(r.SizeBytes))
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d bytes", n)
}

var labelChars = regexp.MustCompile(`[^a-z0-9]+`)

// cleanLabel makes a label part of a file name: lower case, letters, digits
// and dashes, at most 40 of them.
func cleanLabel(label string) string {
	label = strings.Trim(labelChars.ReplaceAllString(strings.ToLower(label), "-"), "-")
	if len(label) > 40 {
		label = strings.Trim(label[:40], "-")
	}
	return label
}

// The toolbox's recordings are the box's, and its desktop is shared by the
// box's sessions, while this server is one session's. So each recording is
// tagged with the session it is for: the label the toolbox puts in its file
// name (<id>_<label>_<date>_<time>.mp4) starts with the session's tag, and
// a server only stops, or keeps, recordings carrying its own.

// sessionTag is the tag of this server's session: a short hash of its
// files folder, the same for every run of the server in that session.
func (s *server) sessionTag() string {
	sum := sha256.Sum256([]byte(s.cfg.Folder))
	return "s" + hex.EncodeToString(sum[:6])
}

// ownLabel reads the label back from a recording's file name: ok when it
// carries this session's tag, label what was given after it ("" for none).
func (s *server) ownLabel(rec *Recording) (label string, ok bool) {
	parts := strings.Split(strings.TrimSuffix(filepath.Base(rec.FilePath), ".mp4"), "_")
	if len(parts) < 4 {
		return "", false
	}
	tagged := strings.Join(parts[1:len(parts)-2], "_")
	tag := s.sessionTag()
	if tagged == tag {
		return "", true
	}
	if rest, found := strings.CutPrefix(tagged, tag+"-"); found {
		return rest, true
	}
	return "", false
}

// running is this session's recording in progress, if there is one.
func (s *server) running(ctx context.Context) (*Recording, error) {
	recordings, err := s.cfg.Toolbox.Recordings(ctx)
	if err != nil {
		return nil, err
	}
	for i := range recordings {
		if _, ours := s.ownLabel(&recordings[i]); ours && recordings[i].Status == "recording" {
			return &recordings[i], nil
		}
	}
	return nil, nil
}

func (s *server) recordStart(ctx context.Context, label string) (map[string]any, error) {
	if current, err := s.running(ctx); err != nil {
		return nil, err
	} else if current != nil {
		return nil, fmt.Errorf("a recording is already running (since %s): call record_stop first", current.StartTime)
	}
	label = cleanLabel(label)
	tagged := s.sessionTag()
	if label != "" {
		tagged += "-" + label
	}
	rec, err := s.cfg.Toolbox.StartRecording(ctx, tagged)
	if err != nil {
		return nil, err
	}
	if err := s.cfg.Watchdog(rec.ID, time.Now().Add(s.cfg.MaxRecording)); err != nil {
		// Never a recording without its cap.
		_, _ = s.cfg.Toolbox.StopRecording(ctx, rec.ID)
		return nil, fmt.Errorf("couldn't record: its time limit couldn't be set (%v)", err)
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf(
			"Recording the desktop. Call record_stop when you're done; it stops by itself after %s.", s.cfg.MaxRecording)}},
		"structuredContent": map[string]any{"recording": true},
	}, nil
}

// recordStop stops this session's recording and keeps it; with none
// running, it keeps the one its watchdog stopped at the time limit, still in
// the toolbox's folder (CapRecording), whichever run of this server started
// it. Another session's recordings, and one that failed, are left alone.
func (s *server) recordStop(ctx context.Context) (map[string]any, error) {
	recordings, err := s.cfg.Toolbox.Recordings(ctx)
	if err != nil {
		return nil, err
	}
	var current, stopped *Recording
	for i := range recordings {
		rec := &recordings[i]
		if _, ours := s.ownLabel(rec); !ours {
			continue
		}
		switch {
		case rec.Status == "recording":
			current = rec
		case rec.Status == "completed" && (stopped == nil || rec.StartTime > stopped.StartTime):
			stopped = rec
		}
	}
	var saved savedRecording
	text := ""
	switch {
	case current != nil:
		label, _ := s.ownLabel(current)
		rec, err := s.cfg.Toolbox.StopRecording(ctx, current.ID)
		if err != nil {
			return nil, err
		}
		if saved, err = s.keep(ctx, rec, label); err != nil {
			return nil, err
		}
	case stopped != nil:
		label, _ := s.ownLabel(stopped)
		if saved, err = s.keep(ctx, *stopped, label); err != nil {
			return nil, err
		}
		text = fmt.Sprintf("The recording reached its %s limit and stopped by itself. ", s.cfg.MaxRecording)
	default:
		return nil, errors.New("no recording is running: call record_start first")
	}
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": text + saved.describe()}},
		"structuredContent": saved,
	}, nil
}

// keep moves a stopped recording's file into the files folder, named by
// when it was kept and its label.
func (s *server) keep(ctx context.Context, rec Recording, label string) (savedRecording, error) {
	dir, err := s.folder()
	if err != nil {
		return savedRecording{}, err
	}
	name := "recording-" + s.stamp()
	if label != "" {
		name += "-" + label
	}
	path := filepath.Join(dir, name+".mp4")
	if err := moveFile(rec.FilePath, path); err != nil {
		return savedRecording{}, fmt.Errorf("keep the recording: %w", err)
	}
	size := rec.SizeBytes
	if info, err := os.Stat(path); err == nil {
		size = info.Size()
	}
	duration := rec.DurationSeconds
	if duration <= 0 {
		// The toolbox's list doesn't say how long one it stopped ran.
		duration = videoSeconds(ctx, path)
	}
	return savedRecording{Path: path, DurationSeconds: duration, SizeBytes: size}, nil
}

// videoSeconds is a video's length as ffprobe reads it, 0 when it can't.
func videoSeconds(ctx context.Context, path string) float64 {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path).Output()
	if err != nil {
		return 0
	}
	seconds, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return seconds
}

// moveFile renames from to `to`, or copies it across filesystems.
func moveFile(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(to)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Remove(from)
}

// pause waits d, or until ctx ends: a call cancelled or out of time doesn't
// hold the tools (callMu) while it waits.
func pause(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func decodeBase64(s string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("the desktop's screenshot isn't base64: %w", err)
	}
	return data, nil
}
