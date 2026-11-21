package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// signInBrowser is a browser's DevTools as sign-ins are read and written
// through them: its cookie store, its tabs and their localStorage, and a
// background tab for each origin written. What's asked of it is recorded,
// in order, across every connection.
type signInBrowser struct {
	t  *testing.T
	mu sync.Mutex
	// cookies are the store's; storage each origin's localStorage.
	cookies []devToolsCookie
	storage map[string][]NameValue
	// tabs are the pages open, by id: their address.
	tabs map[string]string
	// log is each command, as "target method".
	log []string
	// set is each Storage.setCookies call's cookies; scripts each script
	// a background tab ran, by its origin.
	set     [][]cookieParam
	scripts map[string][]string
	// refuseTogether has Storage.setCookies refuse more than one cookie at
	// once when one of them is named "bad", and refuse that one alone.
	refuseTogether bool
	created        int
}

func newSignInBrowser(t *testing.T) (*signInBrowser, *Browser) {
	f := &signInBrowser{t: t, storage: map[string][]NameValue{}, tabs: map[string]string{}, scripts: map[string][]string{}}
	mux := http.NewServeMux()
	var server *httptest.Server
	socket := func(kind, id string) string {
		return "ws://" + server.Listener.Addr().String() + "/devtools/" + kind + "/" + id
	}
	mux.HandleFunc("/json/version", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"webSocketDebuggerUrl": socket("browser", "B")})
	})
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		list := []any{map[string]any{"id": "SW", "type": "service_worker", "url": "http://localhost:3000/sw.js"}}
		ids := make([]string, 0, len(f.tabs))
		for id := range f.tabs {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		for _, id := range ids {
			list = append(list, map[string]any{"id": id, "type": "page", "url": f.tabs[id], "webSocketDebuggerUrl": socket("page", id)})
		}
		_ = json.NewEncoder(w).Encode(list)
	})
	upgrader := websocket.Upgrader{}
	serve := func(target string, handle func(conn *websocket.Conn, id int, method string, params json.RawMessage) any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			for {
				var msg struct {
					ID     int             `json:"id"`
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				if conn.ReadJSON(&msg) != nil {
					return
				}
				f.mu.Lock()
				f.log = append(f.log, target+" "+msg.Method)
				f.mu.Unlock()
				answer := handle(conn, msg.ID, msg.Method, msg.Params)
				if failure, ok := answer.(error); ok {
					_ = conn.WriteJSON(map[string]any{"id": msg.ID, "error": map[string]any{"message": failure.Error()}})
					continue
				}
				_ = conn.WriteJSON(map[string]any{"id": msg.ID, "result": answer})
			}
		}
	}
	mux.HandleFunc("/devtools/browser/B", serve("browser", func(_ *websocket.Conn, _ int, method string, raw json.RawMessage) any {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch method {
		case "Storage.getCookies":
			return map[string]any{"cookies": f.cookies}
		case "Storage.setCookies":
			var params struct {
				Cookies []cookieParam `json:"cookies"`
			}
			_ = json.Unmarshal(raw, &params)
			if f.refuseTogether && slices.ContainsFunc(params.Cookies, func(c cookieParam) bool { return c.Name == "bad" }) {
				return errors.New("Invalid cookie fields")
			}
			f.set = append(f.set, params.Cookies)
		case "Target.createTarget":
			f.created++
			id := "N" + strconv.Itoa(f.created)
			f.tabs[id] = "about:blank"
			return map[string]any{"targetId": id}
		case "Target.closeTarget":
			var params struct {
				TargetID string `json:"targetId"`
			}
			_ = json.Unmarshal(raw, &params)
			delete(f.tabs, params.TargetID)
		}
		return map[string]any{}
	}))
	mux.HandleFunc("/devtools/page/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		serve(id, func(conn *websocket.Conn, _ int, method string, raw json.RawMessage) any {
			var params map[string]any
			_ = json.Unmarshal(raw, &params)
			f.mu.Lock()
			defer f.mu.Unlock()
			address := f.tabs[id]
			switch method {
			case "Page.getFrameTree":
				return map[string]any{"frameTree": map[string]any{"frame": map[string]any{"id": id, "url": address}}}
			case "DOMStorage.getDOMStorageItems":
				storageID, _ := params["storageId"].(map[string]any)
				if storageID["securityOrigin"] != tabOrigin(address) || storageID["isLocalStorage"] != true {
					return errors.New("Frame not found for the given storage id")
				}
				entries := [][]string{}
				for _, item := range f.storage[tabOrigin(address)] {
					entries = append(entries, []string{item.Name, item.Value})
				}
				return map[string]any{"entries": entries}
			case "Page.navigate":
				// The document is asked for, paused for DevTools to answer.
				url, _ := params["url"].(string)
				_ = conn.WriteJSON(map[string]any{"method": "Fetch.requestPaused", "params": map[string]any{"requestId": "r1", "request": map[string]any{"url": url}}})
				f.tabs[id] = url
			case "Runtime.evaluate":
				expression, _ := params["expression"].(string)
				origin := tabOrigin(address)
				if expression == readLocalStorage {
					if strings.HasPrefix(id, "N") {
						return map[string]any{"result": map[string]any{"value": f.storage[origin]}}
					}
					return errors.New("a script was run in the person's own tab")
				}
				if strings.Contains(expression, "localStorage.setItem") {
					f.scripts[origin] = append(f.scripts[origin], expression)
					return map[string]any{"result": map[string]any{"value": true}}
				}
			}
			return map[string]any{}
		})(w, r)
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	return f, &Browser{Port: p, Profile: filepath.Join(t.TempDir(), "chromium"), Display: Display}
}

func (f *signInBrowser) setCookie(name, value string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cookies = slices.DeleteFunc(f.cookies, func(c devToolsCookie) bool { return c.Name == name })
	f.cookies = append(f.cookies, devToolsCookie{Name: name, Value: value, Domain: "localhost", Path: "/", Expires: -1, Session: true, HTTPOnly: true})
}

func (f *signInBrowser) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.log)
}

// saves is a keeper's Save that keeps what it was given.
type saves struct {
	mu     sync.Mutex
	states []StorageState
	err    error
}

func (s *saves) save(_ context.Context, state StorageState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = append(s.states, state)
	return s.err
}

func (s *saves) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.states)
}

func (s *saves) lastState() StorageState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.states[len(s.states)-1]
}

func TestTheKeeperNotesTheSignInsFirstAndSendsWhatChanges(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.tabs["T1"] = "http://localhost:3000/dashboard"
	f.storage["http://localhost:3000"] = []NameValue{{Name: "token", Value: "a"}}
	f.setCookie("sid", "1")
	sent := &saves{}
	k := &SignInKeeper{Browser: b, Save: sent.save, MinGap: 30 * time.Second}
	ctx := context.Background()
	start := time.Unix(1_900_000_000, 0)

	// The first look only notes them: a box resumed sends nothing unchanged.
	k.Tick(ctx, start)
	k.Tick(ctx, start.Add(10*time.Second))
	if sent.count() != 0 {
		t.Fatalf("sent %d times with nothing changed", sent.count())
	}

	f.setCookie("sid", "2")
	k.Tick(ctx, start.Add(20*time.Second))
	if sent.count() != 1 {
		t.Fatalf("sent %d times after a change, want 1", sent.count())
	}
	got := sent.lastState()
	wantCookies := []Cookie{{Name: "sid", Value: "2", Domain: "localhost", Path: "/", Expires: -1, HTTPOnly: true, SameSite: "Lax"}}
	if !slices.Equal(got.Cookies, wantCookies) {
		t.Errorf("cookies = %+v, want %+v", got.Cookies, wantCookies)
	}
	if len(got.Origins) != 1 || got.Origins[0].Origin != "http://localhost:3000" || !slices.Equal(got.Origins[0].LocalStorage, f.storage["http://localhost:3000"]) {
		t.Errorf("origins = %+v", got.Origins)
	}
	// Read through DevTools: no tab was opened for it, nor anything run in one.
	for _, command := range f.commands() {
		if command == "browser Target.createTarget" || strings.HasSuffix(command, " Runtime.evaluate") {
			t.Errorf("%s, to read localStorage", command)
		}
	}

	// Another change waits out the gap.
	f.setCookie("sid", "3")
	k.Tick(ctx, start.Add(30*time.Second))
	if sent.count() != 1 {
		t.Fatalf("sent again %v after the last, inside the gap", 10*time.Second)
	}
	k.Tick(ctx, start.Add(50*time.Second))
	if sent.count() != 2 || sent.lastState().Cookies[0].Value != "3" {
		t.Fatalf("the change wasn't sent once the gap passed: %d sends", sent.count())
	}
}

func TestTheKeeperKeepsAClosedTabsLocalStorageAndDropsASignedOutOnes(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.tabs["T1"] = "http://localhost:3000/"
	f.storage["http://localhost:3000"] = []NameValue{{Name: "token", Value: "a"}}
	f.setCookie("sid", "1")
	sent := &saves{}
	k := &SignInKeeper{Browser: b, Save: sent.save, MinGap: time.Second}
	k.Seed(StorageState{Origins: []OriginState{{Origin: "https://app.example.com", LocalStorage: []NameValue{{Name: "sb-auth", Value: "x"}}}}})
	ctx := context.Background()
	start := time.Unix(1_900_000_000, 0)
	k.Tick(ctx, start)

	f.setCookie("sid", "2")
	k.Tick(ctx, start.Add(time.Minute))
	var origins []string
	for _, o := range sent.lastState().Origins {
		origins = append(origins, o.Origin)
	}
	if want := []string{"http://localhost:3000", "https://app.example.com"}; !slices.Equal(origins, want) {
		t.Fatalf("origins = %v, want %v", origins, want)
	}

	// Signed out in its tab: its localStorage is empty, and gone.
	f.mu.Lock()
	f.storage["http://localhost:3000"] = nil
	f.mu.Unlock()
	k.Tick(ctx, start.Add(2*time.Minute))
	if got := sent.lastState().Origins; len(got) != 1 || got[0].Origin != "https://app.example.com" {
		t.Fatalf("origins = %+v, want only the closed tab's", got)
	}
}

func TestTheKeeperStopsWhenTheBoxsSignInsArentKept(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.setCookie("sid", "1")
	sent := &saves{err: ErrNotKept}
	k := &SignInKeeper{Browser: b, Save: sent.save, MinGap: time.Second}
	ctx := context.Background()
	start := time.Unix(1_900_000_000, 0)
	k.Tick(ctx, start)
	f.setCookie("sid", "2")
	if k.Tick(ctx, start.Add(time.Minute)) {
		t.Fatal("the keeper carries on after ErrNotKept")
	}
}

func TestTheKeeperSendsNothingWhileTheBrowserIsntRunning(t *testing.T) {
	b := &Browser{Port: freePort(t), Profile: filepath.Join(t.TempDir(), "chromium"), Display: Display}
	sent := &saves{}
	k := &SignInKeeper{Browser: b, Save: sent.save, MinGap: time.Second}
	if !k.Tick(context.Background(), time.Now()) || sent.count() != 0 {
		t.Fatalf("sent %d with no browser", sent.count())
	}
	if !b.FreshProfile() {
		t.Error("looking started the browser, or made its profile")
	}
}

func TestSignInsWaitingAreWrittenInWhenTheKeeperFindsTheBrowser(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.tabs["T1"] = "chrome://newtab/"
	now := time.Now()
	waiting := StorageState{
		Cookies: []Cookie{
			{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, HTTPOnly: true, SameSite: "Lax"},
			{Name: "old", Value: "o", Domain: "localhost", Path: "/", Expires: float64(now.Add(-time.Hour).Unix()), SameSite: "Lax"},
			{Name: "pref", Value: "p", Domain: ".example.com", Path: "/", Expires: float64(now.Add(time.Hour).Unix()), Secure: true, SameSite: "None"},
		},
		Origins: []OriginState{{Origin: "http://localhost:3000", LocalStorage: []NameValue{{Name: "token", Value: "t </script>"}}}},
	}
	if err := b.QueueRestore(waiting); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(b.restorePath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("the waiting sign-ins are %v, want 0600", info.Mode().Perm())
	}

	sent := &saves{}
	k := &SignInKeeper{Browser: b, Save: sent.save, MinGap: time.Second}
	k.Tick(context.Background(), now)

	f.mu.Lock()
	set, scripts := slices.Clone(f.set), f.scripts["http://localhost:3000"]
	tabsLeft := len(f.tabs)
	f.mu.Unlock()
	if len(set) != 1 {
		t.Fatalf("Storage.setCookies calls = %d, want 1", len(set))
	}
	var names []string
	for _, c := range set[0] {
		names = append(names, c.Name)
		if c.Name == "sid" && c.Expires != nil {
			t.Errorf("the session cookie was given an expiry: %v", *c.Expires)
		}
	}
	if want := []string{"sid", "pref"}; !slices.Equal(names, want) {
		t.Errorf("cookies written = %v, want %v (the expired one left out)", names, want)
	}
	if len(scripts) != 1 || !strings.Contains(scripts[0], `"token"`) || strings.Contains(scripts[0], " ") || strings.Contains(scripts[0], "</script>") {
		t.Errorf("localStorage scripts = %q", scripts)
	}
	if tabsLeft != 1 {
		t.Errorf("%d tabs open after, want the one: the background tab was left", tabsLeft)
	}
	if _, err := os.Stat(b.restorePath()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the sign-ins still wait after going in: %v", err)
	}

	// The origin written in is kept though no tab is open on it.
	f.setCookie("sid", "changed")
	k.Tick(context.Background(), now.Add(time.Minute))
	if got := sent.lastState().Origins; len(got) != 1 || got[0].Origin != "http://localhost:3000" {
		t.Errorf("origins kept = %+v", got)
	}
}

func TestCookiesRefusedTogetherGoInOneAtATime(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.refuseTogether = true
	err := b.writeSignIns(context.Background(), StorageState{Cookies: []Cookie{
		{Name: "a", Value: "1", Domain: "localhost", Path: "/", Expires: -1},
		{Name: "bad", Value: "2", Domain: "localhost", Path: "/", Expires: -1},
		{Name: "c", Value: "3", Domain: "localhost", Path: "/", Expires: -1},
	}})
	if err == nil || !strings.Contains(err.Error(), "1 of 3 cookies") {
		t.Errorf("err = %v, want one of three refused", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var written []string
	for _, call := range f.set {
		for _, c := range call {
			written = append(written, c.Name)
		}
	}
	if want := []string{"a", "c"}; !slices.Equal(written, want) {
		t.Errorf("written = %v, want %v", written, want)
	}
}

func TestTheSignInsWaitingAreTakenOnce(t *testing.T) {
	b := &Browser{Port: freePort(t), Profile: filepath.Join(t.TempDir(), "chromium"), Display: Display}
	if err := b.QueueRestore(StorageState{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b.restorePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("empty sign-ins were queued")
	}
	state := StorageState{Cookies: []Cookie{{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, SameSite: "Lax"}}}
	if err := b.QueueRestore(state); err != nil {
		t.Fatal(err)
	}
	first, err := b.claimRestore()
	if err != nil || first == nil || !slices.Equal(first.Cookies, state.Cookies) {
		t.Fatalf("first claim = %+v, %v", first, err)
	}
	if second, err := b.claimRestore(); second != nil || err != nil {
		t.Fatalf("second claim = %+v, %v; want nothing", second, err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(b.Profile)); len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

// A launch of the browser with sign-ins waiting starts it on a blank tab,
// writes them in, and only then shows the page asked for.
func TestABrowserStartedWithSignInsWaitingOpensThePageSignedIn(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.tabs["T1"] = "about:blank"
	if err := b.QueueRestore(StorageState{Cookies: []Cookie{{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, SameSite: "Lax"}}}); err != nil {
		t.Fatal(err)
	}
	// A Chromium that says what it was launched on and hands over at once,
	// as one does to a browser on its profile that's starting up: the fake
	// DevTools is that browser.
	bin := t.TempDir()
	args := filepath.Join(t.TempDir(), "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + args + "\n"
	if err := os.WriteFile(filepath.Join(bin, "chromium"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := b.start(context.Background(), "http://localhost:3000/dashboard"); err != nil {
		t.Fatal(err)
	}
	var launched []byte
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if launched, _ = os.ReadFile(args); len(launched) > 0 {
			break
		}
	}
	lines := strings.Split(strings.TrimSpace(string(launched)), "\n")
	if len(lines) == 0 || lines[len(lines)-1] != "about:blank" {
		t.Errorf("launched on %q, want about:blank", lines[len(lines)-1])
	}
	commands := f.commands()
	set := slices.Index(commands, "browser Storage.setCookies")
	navigated := slices.Index(commands, "T1 Page.navigate")
	if set < 0 || navigated < 0 || navigated < set {
		t.Fatalf("commands = %v: the page was shown before the cookies went in", commands)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tabs["T1"] != "http://localhost:3000/dashboard" {
		t.Errorf("the tab shows %q", f.tabs["T1"])
	}
}

func TestSignInsThatDontFitLeaveTheLargestLocalStorageOutFirst(t *testing.T) {
	big := strings.Repeat("x", 4000)
	state := StorageState{
		Cookies: []Cookie{{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, SameSite: "Lax"}},
		Origins: []OriginState{
			{Origin: "https://a.example", LocalStorage: []NameValue{{Name: "k", Value: big}}},
			{Origin: "https://b.example", LocalStorage: []NameValue{{Name: "k", Value: "small"}}},
		},
	}
	data, ok := fit(&state, 1000)
	if !ok || len(data) > 1000 {
		t.Fatalf("fit = %d bytes, %v", len(data), ok)
	}
	if len(state.Origins) != 1 || state.Origins[0].Origin != "https://b.example" {
		t.Errorf("origins = %+v, want only the small one", state.Origins)
	}
	if _, ok := fit(&StorageState{Cookies: []Cookie{{Name: "sid", Value: big}}}, 1000); ok {
		t.Error("cookies more than the bound fit")
	}
}

// A real Chromium, headless, on an empty profile, given the sign-ins of an
// earlier session: their cookie is sent to the app with its first page,
// their localStorage is there for its code, the app is asked for nothing
// while they go in, and they read back as they're kept. Skipped where
// there's no Chromium (CHROMIUM names one that isn't on the PATH).
func TestARealBrowserTakesTheSignInsCarriedOver(t *testing.T) {
	binary := chromium(t)
	var (
		mu      sync.Mutex
		cookies []string
	)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cookies = append(cookies, r.URL.Path+" "+r.Header.Get("Cookie"))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><link rel="icon" href="data:,"><title>app</title>`)
	}))
	defer app.Close()
	asked := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(cookies)
	}

	b := &Browser{Port: freePort(t), Profile: filepath.Join(t.TempDir(), "chromium"), Display: Display}
	ctx := runHeadless(t, binary, b, "about:blank")
	carried := StorageState{
		Cookies: []Cookie{{Name: "sid", Value: "carried", Domain: "127.0.0.1", Path: "/", Expires: -1, HTTPOnly: true, SameSite: "Lax"}},
		Origins: []OriginState{{Origin: app.URL, LocalStorage: []NameValue{{Name: "token", Value: "t-1"}}}},
	}
	if err := b.QueueRestore(carried); err != nil {
		t.Fatal(err)
	}
	restored, err := b.RestorePending(ctx)
	if err != nil || restored == nil {
		t.Fatalf("RestorePending = %v, %v", restored, err)
	}
	if got := asked(); len(got) != 0 {
		t.Fatalf("the app was asked for %v while the sign-ins went in", got)
	}

	if err := b.Open(ctx, app.URL+"/dashboard"); err != nil {
		t.Fatal(err)
	}
	for !slices.Contains(asked(), "/dashboard sid=carried") {
		if ctx.Err() != nil {
			t.Fatalf("the app's first page was asked for with %q", asked())
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got := evaluateInTab(t, ctx, b, `localStorage.getItem("token") || ""`); got != "t-1" {
		t.Errorf("the page's localStorage token = %q, want t-1", got)
	}

	readCookies, origins, err := b.SignIns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(readCookies, carried.Cookies[0]) {
		t.Errorf("cookies read back = %+v", readCookies)
	}
	if got := origins[app.URL]; !slices.Equal(got, carried.Origins[0].LocalStorage) {
		t.Errorf("localStorage read back = %+v", origins)
	}
}

// A browser started from the dock, which no launch of this package's wrote
// the waiting sign-ins into, gets them within a second or so, however long
// the keeper's looks are apart.
func TestTheKeeperWritesWaitingSignInsInWithinASecond(t *testing.T) {
	f, b := newSignInBrowser(t)
	f.tabs["T1"] = "chrome://newtab/"
	if err := b.QueueRestore(StorageState{Cookies: []Cookie{{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, SameSite: "Lax"}}}); err != nil {
		t.Fatal(err)
	}
	k := &SignInKeeper{Browser: b, Save: (&saves{}).save, MinGap: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go k.Run(ctx, time.Hour, func() bool { return true })
	for deadline := time.Now().Add(3 * time.Second); b.restoreWaiting(); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the waiting sign-ins weren't written in")
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.set) != 1 {
		t.Errorf("Storage.setCookies calls = %d", len(f.set))
	}
}
