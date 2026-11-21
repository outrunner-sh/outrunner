package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// The agent's browser is Chromium on the desktop, so the user watching the
// Desktop tab sees what it does, driven through the Chrome DevTools Protocol
// rather than by pixels: an element named in the page's accessibility tree is
// clicked where it is, whatever the layout, which a click at a point read off
// a screenshot can miss. DevTools listens on the box's loopback alone (as
// Chromium does unless told otherwise), never on a port the box's previews
// reach (lib/runtime/box-ports.ts DESKTOP_PORTS): whoever holds DevTools
// holds every site the browser is signed in to.

// DevToolsPort is the browser's DevTools port: not Chrome's usual 9222, so
// a project's own tests driving a Chrome of their own don't collide with it.
const DevToolsPort = 19222

// Browser launches and finds the agent's Chromium.
type Browser struct {
	// Port is DevTools', DevToolsPort but in tests.
	Port int
	// Profile is the browser's own profile folder: one per box, so a site the
	// agent or the person signed in to stays signed in across launches, and
	// is carried over to their next session's box (sign_ins.go).
	Profile string
	// Display is the X display it opens on, the desktop's.
	Display string

	// stateMu has StorageState read one at a time (storage_state.go).
	stateMu sync.Mutex

	mu sync.Mutex
	// target is the tab the agent last opened or navigated, which browser
	// actions act on while it is open.
	target string
}

// NewBrowser is the box's browser for a user whose home is home: the one
// the desktop tools drive and `outrunner browser state` reads sign-ins from,
// so both see the same profile.
func NewBrowser(home string) *Browser {
	return &Browser{
		Port:    DevToolsPort,
		Profile: filepath.Join(home, ".outrunner", "desktop", "chromium"),
		Display: Display,
	}
}

func (b *Browser) base() string { return "http://127.0.0.1:" + strconv.Itoa(b.Port) }

// DevToolsURL is where the browser's DevTools answer, on the box alone: what
// Playwright's connectOverCDP takes.
func (b *Browser) DevToolsURL() string { return b.base() }

// browserBinaries are the names Chromium goes by, in the order looked for.
// Daytona's images have /usr/bin/chromium.
var browserBinaries = []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"}

// running reports whether DevTools answers.
func (b *Browser) running(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/version", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// Open shows rawURL in the browser: in a new tab of the one running, or in a
// browser launched for it. The tab becomes the one browser actions act on.
func (b *Browser) Open(ctx context.Context, rawURL string) error {
	if b.running(ctx) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, b.base()+"/json/new?"+url.QueryEscape(rawURL), nil)
		if err != nil {
			return err
		}
		var tab devToolsTarget
		if err := fetchJSON(req, &tab); err != nil {
			return fmt.Errorf("open a tab: %w", err)
		}
		b.setTarget(tab.ID)
		_ = b.activate(ctx, tab.ID)
		return nil
	}
	if err := b.start(ctx, rawURL); err != nil {
		return err
	}
	b.setTarget("")
	return nil
}

// start launches the browser on rawURL and waits for its DevTools to answer.
// A box whose container can't give Chromium its sandbox (no user namespaces,
// no setuid helper: Daytona's) has it quit at once saying so; there it is
// launched again without one. Elsewhere it keeps its sandbox. Sign-ins
// carried over from the person's last session (QueueRestore) go in before
// any page loads: the browser starts on a blank tab, and goes to rawURL once
// they're in.
func (b *Browser) start(ctx context.Context, rawURL string) error {
	restore, err := b.claimRestore()
	if err != nil {
		fmt.Fprintf(os.Stderr, "desktop: starting the browser without the sign-ins carried over: %v\n", err)
	}
	if restore == nil {
		return b.startOn(ctx, rawURL)
	}
	if err := b.startOn(ctx, "about:blank"); err != nil {
		// Left for the next start, or the keeper.
		if queueErr := b.QueueRestore(*restore); queueErr != nil {
			fmt.Fprintf(os.Stderr, "desktop: the sign-ins carried over are lost: %v\n", queueErr)
		}
		return err
	}
	b.restoreAt(ctx, *restore, rawURL)
	return nil
}

func (b *Browser) startOn(ctx context.Context, rawURL string) error {
	exited, err := b.launch(rawURL, false)
	if err != nil {
		return err
	}
	sandboxed := true
	deadline := time.Now().Add(30 * time.Second)
	for !b.running(ctx) {
		if time.Now().After(deadline) {
			return fmt.Errorf("the browser didn't start: see %s", b.logPath())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-exited:
			exited = nil
			switch {
			case sandboxed && b.noUsableSandbox():
				fmt.Fprintln(os.Stderr, "desktop: Chromium has no usable sandbox on this box; launching it with --no-sandbox")
				sandboxed = false
				if exited, err = b.launch(rawURL, true); err != nil {
					return err
				}
			case err != nil:
				return fmt.Errorf("the browser quit as it started (%v): see %s", err, b.logPath())
			}
			// Quit cleanly: it handed the URL to a browser on the same
			// profile that's starting up, whose DevTools are waited for.
		case <-time.After(250 * time.Millisecond):
		}
	}
	return nil
}

// noUsableSandbox is whether the browser's log says it quit for want of a
// sandbox it can use.
func (b *Browser) noUsableSandbox() bool {
	data, err := os.ReadFile(b.logPath())
	return err == nil && strings.Contains(string(data), "No usable sandbox")
}

func (b *Browser) logPath() string { return filepath.Join(filepath.Dir(b.Profile), "chromium.log") }

// launch starts Chromium on the desktop, in a session of its own, so it
// outlives this server: the agent's CLI restarts its MCP servers, and the
// browser, its tabs and sign-ins should carry on through that. Its exit is
// sent on the channel (nil for a clean one), and the log is a new one.
func (b *Browser) launch(rawURL string, noSandbox bool) (<-chan error, error) {
	var binary string
	for _, name := range browserBinaries {
		if path, err := exec.LookPath(name); err == nil {
			binary = path
			break
		}
	}
	if binary == "" {
		return nil, errors.New("no Chromium on this box (looked for " + strings.Join(browserBinaries, ", ") + ")")
	}
	if err := os.MkdirAll(b.Profile, 0o700); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(b.logPath(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	defer logFile.Close()
	args := BrowserArgs(b.Port, b.Profile, rawURL)
	if noSandbox {
		args = append([]string{"--no-sandbox"}, args...)
	}
	cmd := exec.Command(binary, args...)
	cmd.Env = append(withoutEnv(os.Environ(), "DISPLAY"), "DISPLAY="+b.Display)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start the browser: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	return exited, nil
}

// BrowserArgs are Chromium's flags: DevTools on the loopback, its own
// profile (which Chromium requires for remote debugging), no first-run
// screens to click through, and the window filling the screen.
func BrowserArgs(port int, profile, rawURL string) []string {
	return []string{
		"--remote-debugging-port=" + strconv.Itoa(port),
		"--remote-debugging-address=127.0.0.1",
		"--user-data-dir=" + profile,
		"--no-first-run",
		"--no-default-browser-check",
		"--password-store=basic",
		"--start-maximized",
		rawURL,
	}
}

func withoutEnv(env []string, name string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, name+"=") {
			out = append(out, kv)
		}
	}
	return out
}

func (b *Browser) setTarget(id string) {
	b.mu.Lock()
	b.target = id
	b.mu.Unlock()
}

type devToolsTarget struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	Title                string `json:"title"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

func fetchJSON(req *http.Request, out any) error {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	return json.Unmarshal(data, out)
}

// errNoBrowser is a browser action with no browser open.
var errNoBrowser = errors.New("no browser is open: call open_browser with a URL first")

// page is the tab browser actions act on: the one last opened or navigated
// while it's still open, else the one in front (DevTools lists the most
// recently active first).
func (b *Browser) page(ctx context.Context) (devToolsTarget, error) {
	if !b.running(ctx) {
		return devToolsTarget{}, errNoBrowser
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/list", nil)
	if err != nil {
		return devToolsTarget{}, err
	}
	var targets []devToolsTarget
	if err := fetchJSON(req, &targets); err != nil {
		return devToolsTarget{}, err
	}
	b.mu.Lock()
	want := b.target
	b.mu.Unlock()
	var first *devToolsTarget
	for i, t := range targets {
		if t.Type != "page" || strings.HasPrefix(t.URL, "devtools://") {
			continue
		}
		if t.ID == want {
			return t, nil
		}
		if first == nil {
			first = &targets[i]
		}
	}
	if first == nil {
		return devToolsTarget{}, errNoBrowser
	}
	return *first, nil
}

func (b *Browser) activate(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/activate/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// cdp is one DevTools connection to a tab.
type cdp struct {
	conn *websocket.Conn
	next int
}

func dialPage(ctx context.Context, t devToolsTarget) (*cdp, error) {
	if t.WebSocketDebuggerURL == "" {
		return nil, errors.New("the tab has no DevTools connection (is DevTools already open on it?)")
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, t.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connect to the tab: %w", err)
	}
	return &cdp{conn: conn}, nil
}

func (c *cdp) Close() { _ = c.conn.Close() }

// call sends one command and waits for its answer, passing over the events
// the tab sends meanwhile.
func (c *cdp) call(ctx context.Context, method string, params any, out any) error {
	return c.callHandling(ctx, method, params, out, nil)
}

// send sends a command without waiting for its answer, which the next call
// passes over: an answer to an event, from callHandling's onEvent.
func (c *cdp) send(method string, params any) error {
	c.next++
	return c.conn.WriteJSON(map[string]any{"id": c.next, "method": method, "params": params})
}

// callHandling is call, giving each event that arrives before the answer to
// onEvent (when not nil): a command whose answer waits on the caller's
// answer to an event, as a navigation whose request is paused does.
func (c *cdp) callHandling(ctx context.Context, method string, params any, out any, onEvent func(method string, params json.RawMessage) error) error {
	c.next++
	id := c.next
	if params == nil {
		params = map[string]any{}
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = c.conn.SetReadDeadline(deadline)
		_ = c.conn.SetWriteDeadline(deadline)
	}
	if err := c.conn.WriteJSON(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	for {
		var msg struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
				Data    string `json:"data"`
			} `json:"error"`
		}
		if err := c.conn.ReadJSON(&msg); err != nil {
			return fmt.Errorf("%s: %w", method, err)
		}
		if msg.ID == 0 && msg.Method != "" && onEvent != nil {
			if err := onEvent(msg.Method, msg.Params); err != nil {
				return fmt.Errorf("%s: %w", method, err)
			}
			continue
		}
		if msg.ID != id {
			continue
		}
		if msg.Error != nil {
			return fmt.Errorf("%s: %s", method, strings.TrimSpace(msg.Error.Message+" "+msg.Error.Data))
		}
		if out != nil {
			return json.Unmarshal(msg.Result, out)
		}
		return nil
	}
}

// pageInfo is the tab's title and address.
func (c *cdp) pageInfo(ctx context.Context) (title, address string) {
	var res struct {
		Result struct {
			Value []string `json:"value"`
		} `json:"result"`
	}
	_ = c.call(ctx, "Runtime.evaluate", map[string]any{
		"expression":    "[document.title, location.href]",
		"returnByValue": true,
	}, &res)
	if len(res.Result.Value) == 2 {
		return res.Result.Value[0], res.Result.Value[1]
	}
	return "", ""
}

// loaded is true once the page has a document of its own, fully loaded: a
// tab just opened shows about:blank, complete, before its page starts.
const loaded = `document.readyState === "complete" && location.href !== "about:blank"`

// settle waits for the page to finish loading, up to `wait`: a tab just
// opened, or a click that started a navigation, is half a page until then.
func (c *cdp) settle(ctx context.Context, wait time.Duration) {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		var res struct {
			Result struct {
				Value bool `json:"value"`
			} `json:"result"`
		}
		err := c.call(ctx, "Runtime.evaluate", map[string]any{"expression": loaded, "returnByValue": true}, &res)
		if err == nil && res.Result.Value {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// Navigate loads rawURL in the tab browser actions act on.
func (b *Browser) Navigate(ctx context.Context, rawURL string) (string, error) {
	t, err := b.page(ctx)
	if err != nil {
		return "", err
	}
	c, err := dialPage(ctx, t)
	if err != nil {
		return "", err
	}
	defer c.Close()
	var res struct {
		ErrorText string `json:"errorText"`
	}
	if err := c.call(ctx, "Page.navigate", map[string]any{"url": rawURL}, &res); err != nil {
		return "", err
	}
	if res.ErrorText != "" {
		return "", fmt.Errorf("%s didn't load: %s", rawURL, res.ErrorText)
	}
	b.setTarget(t.ID)
	c.settle(ctx, 15*time.Second)
	return b.snapshotWith(ctx, c)
}

// Snapshot is the tab's accessibility tree, in short (FormatTree).
func (b *Browser) Snapshot(ctx context.Context) (string, error) {
	t, err := b.page(ctx)
	if err != nil {
		return "", err
	}
	c, err := dialPage(ctx, t)
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.settle(ctx, 15*time.Second)
	return b.snapshotWith(ctx, c)
}

func (b *Browser) snapshotWith(ctx context.Context, c *cdp) (string, error) {
	var tree struct {
		Nodes []AXNode `json:"nodes"`
	}
	if err := c.call(ctx, "Accessibility.getFullAXTree", nil, &tree); err != nil {
		return "", err
	}
	title, address := c.pageInfo(ctx)
	return fmt.Sprintf("Page: %s\nURL: %s\n\n%s", title, address, FormatTree(tree.Nodes, maxSnapshotLines)), nil
}

// maxSnapshotLines bounds a snapshot: a long page's tree runs to thousands
// of lines, more of the model's context than any one look is worth.
const maxSnapshotLines = 500

// ParseRef reads a ref from a snapshot ("e123") as the DOM node it names.
func ParseRef(ref string) (int, error) {
	n, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(ref), "e"))
	if err != nil || n <= 0 || !strings.HasPrefix(strings.TrimSpace(ref), "e") {
		return 0, fmt.Errorf("%q isn't a ref from browser_snapshot (they look like e123)", ref)
	}
	return n, nil
}

// center finds where on the screen the element is, scrolled into view.
func (c *cdp) center(ctx context.Context, node int) (float64, float64, error) {
	_ = c.call(ctx, "DOM.getDocument", map[string]any{"depth": 0}, nil)
	_ = c.call(ctx, "DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": node}, nil)
	var res struct {
		Quads [][]float64 `json:"quads"`
	}
	if err := c.call(ctx, "DOM.getContentQuads", map[string]any{"backendNodeId": node}, &res); err != nil {
		return 0, 0, fmt.Errorf("that element isn't on the page any more, or can't be clicked (take a new browser_snapshot): %w", err)
	}
	for _, q := range res.Quads {
		if len(q) != 8 {
			continue
		}
		x := (q[0] + q[2] + q[4] + q[6]) / 4
		y := (q[1] + q[3] + q[5] + q[7]) / 4
		return x, y, nil
	}
	return 0, 0, errors.New("that element has no size on the page: it's hidden")
}

func (c *cdp) mouseClick(ctx context.Context, x, y float64) error {
	for _, kind := range []string{"mouseMoved", "mousePressed", "mouseReleased"} {
		params := map[string]any{"type": kind, "x": x, "y": y}
		if kind != "mouseMoved" {
			params["button"] = "left"
			params["clickCount"] = 1
		}
		if err := c.call(ctx, "Input.dispatchMouseEvent", params, nil); err != nil {
			return err
		}
	}
	return nil
}

func (c *cdp) pressKey(ctx context.Context, key, code string, keyCode int, text string) error {
	down := map[string]any{"type": "keyDown", "key": key, "code": code, "windowsVirtualKeyCode": keyCode}
	if text != "" {
		down["text"] = text
	}
	if err := c.call(ctx, "Input.dispatchKeyEvent", down, nil); err != nil {
		return err
	}
	return c.call(ctx, "Input.dispatchKeyEvent", map[string]any{"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": keyCode}, nil)
}

// Click clicks the element `ref` names, as a person's click would: pointer
// events at its middle, which a page's handlers can't tell from a real one.
func (b *Browser) Click(ctx context.Context, ref string) (string, error) {
	node, err := ParseRef(ref)
	if err != nil {
		return "", err
	}
	t, err := b.page(ctx)
	if err != nil {
		return "", err
	}
	c, err := dialPage(ctx, t)
	if err != nil {
		return "", err
	}
	defer c.Close()
	x, y, err := c.center(ctx, node)
	if err != nil {
		return "", err
	}
	if err := c.mouseClick(ctx, x, y); err != nil {
		return "", err
	}
	b.setTarget(t.ID)
	// A click that navigates starts loading a moment later.
	if err := pause(ctx, 300*time.Millisecond); err != nil {
		return "", err
	}
	c.settle(ctx, 10*time.Second)
	title, address := c.pageInfo(ctx)
	return fmt.Sprintf("Clicked %s. Page: %s (%s). Take a browser_snapshot to see what changed.", ref, title, address), nil
}

// selectContents focuses an editable element and selects what's in it, so
// the text typed next replaces it. It names the element's kind, or says it
// can't be typed in.
const selectContents = `function () {
  this.scrollIntoView({ block: "center" });
  this.focus();
  if (typeof this.select === "function") { this.select(); return "field"; }
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return "editable";
  }
  return "not-editable";
}`

// Fill replaces the text in the field `ref` names with text, typed in as
// keyboard input so the page's own handlers see it, and with submit presses
// Enter after.
func (b *Browser) Fill(ctx context.Context, ref, text string, submit bool) (string, error) {
	node, err := ParseRef(ref)
	if err != nil {
		return "", err
	}
	t, err := b.page(ctx)
	if err != nil {
		return "", err
	}
	c, err := dialPage(ctx, t)
	if err != nil {
		return "", err
	}
	defer c.Close()
	var resolved struct {
		Object struct {
			ObjectID string `json:"objectId"`
		} `json:"object"`
	}
	if err := c.call(ctx, "DOM.resolveNode", map[string]any{"backendNodeId": node}, &resolved); err != nil {
		return "", fmt.Errorf("that element isn't on the page any more (take a new browser_snapshot): %w", err)
	}
	var kind struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	if err := c.call(ctx, "Runtime.callFunctionOn", map[string]any{
		"objectId":            resolved.Object.ObjectID,
		"functionDeclaration": selectContents,
		"returnByValue":       true,
	}, &kind); err != nil {
		return "", err
	}
	if kind.Result.Value == "not-editable" {
		return "", fmt.Errorf("%s isn't a field that takes text", ref)
	}
	if text == "" {
		err = c.pressKey(ctx, "Backspace", "Backspace", 8, "")
	} else {
		err = c.call(ctx, "Input.insertText", map[string]any{"text": text}, nil)
	}
	if err != nil {
		return "", err
	}
	b.setTarget(t.ID)
	if !submit {
		return fmt.Sprintf("Filled %s.", ref), nil
	}
	if err := c.pressKey(ctx, "Enter", "Enter", 13, "\r"); err != nil {
		return "", err
	}
	if err := pause(ctx, 300*time.Millisecond); err != nil {
		return "", err
	}
	c.settle(ctx, 10*time.Second)
	title, address := c.pageInfo(ctx)
	return fmt.Sprintf("Filled %s and pressed Enter. Page: %s (%s). Take a browser_snapshot to see what changed.", ref, title, address), nil
}
