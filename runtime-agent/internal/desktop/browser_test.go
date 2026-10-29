package desktop

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// fakeDevTools is a browser's DevTools: one tab, whose commands are recorded
// and answered as Chromium answers them.
type fakeDevTools struct {
	mu       sync.Mutex
	commands []string
	params   map[string][]map[string]any
	opened   []string
}

func newFakeDevTools(t *testing.T) (*fakeDevTools, *Browser) {
	f := &fakeDevTools{params: map[string][]map[string]any{}}
	mux := http.NewServeMux()
	var server *httptest.Server
	tab := func() map[string]any {
		return map[string]any{"id": "T1", "type": "page", "title": "Signup", "url": "http://localhost:8000/",
			"webSocketDebuggerUrl": "ws://" + server.Listener.Addr().String() + "/devtools/page/T1"}
	}
	mux.HandleFunc("/json/version", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) })
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]any{
			map[string]any{"id": "SW", "type": "service_worker", "url": "http://localhost:8000/sw.js"},
			tab(),
		})
	})
	mux.HandleFunc("/json/new", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "Using unsafe HTTP verb GET to invoke /json/new.", http.StatusMethodNotAllowed)
			return
		}
		f.mu.Lock()
		f.opened = append(f.opened, r.URL.RawQuery)
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(tab())
	})
	mux.HandleFunc("/json/activate/", func(w http.ResponseWriter, r *http.Request) {})
	upgrader := websocket.Upgrader{}
	mux.HandleFunc("/devtools/page/T1", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			var msg struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if conn.ReadJSON(&msg) != nil {
				return
			}
			f.mu.Lock()
			f.commands = append(f.commands, msg.Method)
			f.params[msg.Method] = append(f.params[msg.Method], msg.Params)
			f.mu.Unlock()
			// An event first, as a tab sends them unasked.
			_ = conn.WriteJSON(map[string]any{"method": "Page.frameNavigated", "params": map[string]any{}})
			_ = conn.WriteJSON(map[string]any{"id": msg.ID, "result": answer(msg.Method, msg.Params)})
		}
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	return f, &Browser{Port: p, Profile: t.TempDir(), Display: Display}
}

func answer(method string, params map[string]any) any {
	switch method {
	case "Runtime.evaluate":
		if strings.Contains(params["expression"].(string), "document.title") {
			return map[string]any{"result": map[string]any{"value": []string{"Signup", "http://localhost:8000/"}}}
		}
		return map[string]any{"result": map[string]any{"value": true}}
	case "DOM.getContentQuads":
		return map[string]any{"quads": [][]float64{{100, 200, 140, 200, 140, 220, 100, 220}}}
	case "DOM.resolveNode":
		return map[string]any{"object": map[string]any{"objectId": "obj-1"}}
	case "Runtime.callFunctionOn":
		return map[string]any{"result": map[string]any{"value": "field"}}
	case "Accessibility.getFullAXTree":
		return map[string]any{"nodes": []any{
			map[string]any{"nodeId": "1", "role": map[string]any{"value": "RootWebArea"}, "name": map[string]any{"value": "Signup"}, "childIds": []string{"2"}, "backendDOMNodeId": 1},
			map[string]any{"nodeId": "2", "parentId": "1", "role": map[string]any{"value": "button"}, "name": map[string]any{"value": "Join"}, "backendDOMNodeId": 15},
		}}
	case "Page.navigate":
		if params["url"] == "https://nowhere.invalid/" {
			return map[string]any{"errorText": "net::ERR_NAME_NOT_RESOLVED"}
		}
	}
	return map[string]any{}
}

func (f *fakeDevTools) sent(method string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.params[method]
}

func TestAClickByRefLandsInTheMiddleOfTheElement(t *testing.T) {
	f, b := newFakeDevTools(t)
	text, err := b.Click(context.Background(), "e15")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Clicked e15. Page: Signup (http://localhost:8000/)") {
		t.Errorf("text = %q", text)
	}
	if quads := f.sent("DOM.getContentQuads"); len(quads) != 1 || quads[0]["backendNodeId"] != 15.0 {
		t.Errorf("quads asked for %v", quads)
	}
	events := f.sent("Input.dispatchMouseEvent")
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, e["type"].(string))
		if e["x"] != 120.0 || e["y"] != 210.0 {
			t.Errorf("event at (%v, %v), want the middle (120, 210)", e["x"], e["y"])
		}
	}
	if !slices.Equal(kinds, []string{"mouseMoved", "mousePressed", "mouseReleased"}) {
		t.Errorf("events = %v", kinds)
	}
}

func TestFillReplacesTheFieldsTextAndSubmits(t *testing.T) {
	f, b := newFakeDevTools(t)
	if _, err := b.Fill(context.Background(), "e2", "ada@example.com", true); err != nil {
		t.Fatal(err)
	}
	if calls := f.sent("Runtime.callFunctionOn"); len(calls) != 1 || calls[0]["objectId"] != "obj-1" ||
		!strings.Contains(calls[0]["functionDeclaration"].(string), "this.select()") {
		t.Errorf("select = %v", calls)
	}
	if inserts := f.sent("Input.insertText"); len(inserts) != 1 || inserts[0]["text"] != "ada@example.com" {
		t.Errorf("insertText = %v", inserts)
	}
	var keys []string
	for _, k := range f.sent("Input.dispatchKeyEvent") {
		keys = append(keys, k["type"].(string)+" "+k["key"].(string))
	}
	if !slices.Equal(keys, []string{"keyDown Enter", "keyUp Enter"}) {
		t.Errorf("keys = %v", keys)
	}
}

func TestASnapshotIsTheCurrentTabsTree(t *testing.T) {
	_, b := newFakeDevTools(t)
	got, err := b.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := "Page: Signup\nURL: http://localhost:8000/\n\n- document \"Signup\"\n  - button \"Join\" [ref=e15]"
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestOpeningWithTheBrowserRunningOpensATab(t *testing.T) {
	f, b := newFakeDevTools(t)
	if err := b.Open(context.Background(), "http://localhost:3000/?a=1&b=2"); err != nil {
		t.Fatal(err)
	}
	if len(f.opened) != 1 || f.opened[0] != "http%3A%2F%2Flocalhost%3A3000%2F%3Fa%3D1%26b%3D2" {
		t.Errorf("opened = %v", f.opened)
	}
}

func TestANavigationThatFailsSaysWhy(t *testing.T) {
	_, b := newFakeDevTools(t)
	if _, err := b.Navigate(context.Background(), "https://nowhere.invalid/"); err == nil || !strings.Contains(err.Error(), "ERR_NAME_NOT_RESOLVED") {
		t.Fatalf("err = %v", err)
	}
}

func TestBrowserActionsWithNoBrowserSaySoAndNeverLaunchOne(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	_, port, _ := net.SplitHostPort(closed.Listener.Addr().String())
	closed.Close()
	p, _ := strconv.Atoi(port)
	b := &Browser{Port: p, Profile: t.TempDir(), Display: Display}
	if _, err := b.Snapshot(context.Background()); err != errNoBrowser {
		t.Fatalf("err = %v", err)
	}
}

func TestDevToolsListensOnTheLoopbackAlone(t *testing.T) {
	args := BrowserArgs(DevToolsPort, "/home/u/.outrunner/desktop/chromium", "http://localhost:3000")
	for _, want := range []string{"--remote-debugging-port=19222", "--remote-debugging-address=127.0.0.1", "--user-data-dir=/home/u/.outrunner/desktop/chromium"} {
		if !slices.Contains(args, want) {
			t.Errorf("args %v lack %s", args, want)
		}
	}
	if args[len(args)-1] != "http://localhost:3000" {
		t.Errorf("the page isn't last: %v", args)
	}
}
