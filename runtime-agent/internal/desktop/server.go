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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
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

	recMu sync.Mutex
	// autoStopped is the file of a recording that ran out its time and was
	// stopped by itself, for the record_stop that comes after.
	autoStopped *savedRecording
	timer       *time.Timer
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
	if strings.HasPrefix(raw, "localhost") || strings.HasPrefix(raw, "127.0.0.1") {
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
	if w, h, err := s.cfg.Toolbox.DisplaySize(ctx); err == nil && w > 0 {
		size = fmt.Sprintf("the %d×%d desktop (coordinates are its pixels)", w, h)
	}
	return map[string]any{"content": []any{
		map[string]any{"type": "text", "text": fmt.Sprintf("Screenshot of %s, saved to %s.", size, path)},
		map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(image), "mimeType": "image/jpeg"},
	}}, nil
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

// running is the toolbox's recording in progress, if there is one.
func (s *server) running(ctx context.Context) (*Recording, error) {
	recordings, err := s.cfg.Toolbox.Recordings(ctx)
	if err != nil {
		return nil, err
	}
	for i := range recordings {
		if recordings[i].Status == "recording" {
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
	toolboxLabel := label
	if toolboxLabel == "" {
		toolboxLabel = "session"
	}
	rec, err := s.cfg.Toolbox.StartRecording(ctx, toolboxLabel)
	if err != nil {
		return nil, err
	}
	s.recMu.Lock()
	s.autoStopped = nil
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(s.cfg.MaxRecording, func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		s.callMu.Lock()
		defer s.callMu.Unlock()
		if saved, err := s.stopAndKeep(stopCtx, rec.ID, label); err == nil {
			s.recMu.Lock()
			s.autoStopped = &saved
			s.recMu.Unlock()
		}
	})
	s.recMu.Unlock()
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf(
			"Recording the desktop. Call record_stop when you're done; it stops by itself after %s.", s.cfg.MaxRecording)}},
		"structuredContent": map[string]any{"recording": true},
	}, nil
}

func (s *server) recordStop(ctx context.Context) (map[string]any, error) {
	current, err := s.running(ctx)
	if err != nil {
		return nil, err
	}
	s.recMu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	auto := s.autoStopped
	s.autoStopped = nil
	s.recMu.Unlock()
	var saved savedRecording
	switch {
	case current != nil:
		saved, err = s.stopAndKeep(ctx, current.ID, labelOf(current))
		if err != nil {
			return nil, err
		}
	case auto != nil:
		saved = *auto
	default:
		return nil, errors.New("no recording is running: call record_start first")
	}
	text := saved.describe()
	if current == nil {
		text = fmt.Sprintf("The recording ran %s and stopped by itself. %s", s.cfg.MaxRecording, text)
	}
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": text}},
		"structuredContent": saved,
	}, nil
}

// labelOf reads back the label a recording was started with, from its file
// name (<id>_<label>_<date>_<time>.mp4), for a recording this server didn't
// start (an earlier run of it, before the agent's CLI restarted it).
func labelOf(rec *Recording) string {
	parts := strings.Split(strings.TrimSuffix(filepath.Base(rec.FilePath), ".mp4"), "_")
	if len(parts) >= 4 && parts[1] != "session" {
		return cleanLabel(strings.Join(parts[1:len(parts)-2], "-"))
	}
	return ""
}

// stopAndKeep stops a recording and moves its file into the files folder,
// named by when it stopped and its label.
func (s *server) stopAndKeep(ctx context.Context, id, label string) (savedRecording, error) {
	rec, err := s.cfg.Toolbox.StopRecording(ctx, id)
	if err != nil {
		return savedRecording{}, err
	}
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
	return savedRecording{Path: path, DurationSeconds: rec.DurationSeconds, SizeBytes: size}, nil
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

func decodeBase64(s string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("the desktop's screenshot isn't base64: %w", err)
	}
	return data, nil
}
