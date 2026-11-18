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
	"os/exec"
	"slices"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestOriginsAreNormalizedOrRefused(t *testing.T) {
	for raw, want := range map[string]string{
		"http://localhost:3000":       "http://localhost:3000",
		"HTTPS://App.Example.com/":    "https://app.example.com",
		"https://app.example.com:443": "https://app.example.com",
		"http://127.0.0.1:80":         "http://127.0.0.1",
	} {
		if got, err := NormalizeOrigin(raw); err != nil || got != want {
			t.Errorf("NormalizeOrigin(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"localhost:3000", "file:///etc/passwd", "chrome://settings", "https://", "https://u:p@app.example.com", "https://app.example.com/login", "https://app.example.com/?next=1"} {
		var invalid *InvalidOriginError
		if _, err := NormalizeOrigin(raw); !errors.As(err, &invalid) {
			t.Errorf("NormalizeOrigin(%q) = %v, want an InvalidOriginError", raw, err)
		}
	}
}

func TestCookiesAreAsPlaywrightReadsThem(t *testing.T) {
	got := playwrightCookies([]devToolsCookie{
		{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, Session: true, HTTPOnly: true},
		{Name: "pref", Value: "p", Domain: ".example.com", Path: "/", Expires: 1893456000.5, Secure: true, SameSite: "None"},
		{Name: "strict", Value: "x", Domain: "example.com", Path: "/a", Expires: 1893456000, SameSite: "Strict"},
		{Name: "embed", Value: "e", Domain: "widget.example", Path: "/", Expires: 1893456000, Secure: true, SameSite: "None",
			PartitionKey: json.RawMessage(`{"topLevelSite":"https://example.com","hasCrossSiteAncestor":true}`)},
	})
	want := []Cookie{
		// No SameSite is Lax, as Chromium treats it; a session cookie's -1.
		{Name: "sid", Value: "s", Domain: "localhost", Path: "/", Expires: -1, HTTPOnly: true, SameSite: "Lax"},
		{Name: "pref", Value: "p", Domain: ".example.com", Path: "/", Expires: 1893456000.5, Secure: true, SameSite: "None"},
		{Name: "strict", Value: "x", Domain: "example.com", Path: "/a", Expires: 1893456000, SameSite: "Strict"},
		// The partitioned cookie is left out.
	}
	if !slices.Equal(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
}

func TestAnOriginThatIsntOneIsRefusedBeforeTheBrowserIsTouched(t *testing.T) {
	// No browser answers on this port, and none can be launched: the
	// refusal comes first.
	b := &Browser{Port: freePort(t), Profile: t.TempDir(), Display: Display}
	t.Setenv("PATH", t.TempDir())
	var invalid *InvalidOriginError
	if _, _, err := b.StorageState(context.Background(), []string{"localhost:3000"}); !errors.As(err, &invalid) {
		t.Fatalf("err = %v", err)
	}
}

// A real Chromium, headless, signed in to an app by the app's own page: its
// cookies and localStorage come out as Playwright's storageState, with the
// app's code never run again to read them (the app is asked for nothing),
// and no tab left behind. Skipped where there's no Chromium (CHROMIUM names
// one that isn't on the PATH).
func TestStorageStateReadsARealBrowsersSignIns(t *testing.T) {
	binary := os.Getenv("CHROMIUM")
	if binary == "" {
		for _, name := range append(browserBinaries, "chrome") {
			if path, err := exec.LookPath(name); err == nil {
				binary = path
				break
			}
		}
	}
	if binary == "" {
		t.Skip("no Chromium (set CHROMIUM to one)")
	}

	var requests atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: "signed-in", Path: "/", HttpOnly: true})
		w.Header().Set("Content-Type", "text/html")
		// Each run of the app's code writes a new value: one read by running
		// it would differ from the one it wrote when the user signed in. Its
		// icon is its own: the browser's fetch of /favicon.ico for this tab
		// lands whenever it lands, before or after the count is taken.
		fmt.Fprint(w, `<!doctype html><link rel="icon" href="data:,"><script>localStorage.setItem("token", "t-" + Math.random())</script>`)
	}))
	defer app.Close()

	b := &Browser{Port: freePort(t), Profile: t.TempDir(), Display: Display}
	args := append([]string{"--headless=new", "--no-sandbox"}, BrowserArgs(b.Port, b.Profile, app.URL+"/")...)
	cmd := exec.Command(binary, args...)
	// In a group of its own, so its helpers (renderers, the GPU process) are
	// stopped with it: left running, they write to the profile as the test's
	// folder is removed.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
		// The helpers go a moment after the group is told to.
		for i := 0; i < 50 && syscall.Kill(-cmd.Process.Pid, 0) == nil; i++ {
			time.Sleep(100 * time.Millisecond)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for !b.running(ctx) {
		if ctx.Err() != nil {
			t.Fatal("Chromium didn't start")
		}
		time.Sleep(100 * time.Millisecond)
	}
	// The app's page, open in a tab, signs in.
	var token string
	for token == "" {
		if ctx.Err() != nil {
			t.Fatal("the app's page didn't sign in")
		}
		token = evaluateInTab(t, ctx, b, `localStorage.getItem("token") || ""`)
		time.Sleep(100 * time.Millisecond)
	}
	before := requests.Load()
	tabsBefore := pageCount(t, ctx, b)

	// The app's origin is the open tab's; asked for too, it's read once.
	state, warnings, err := b.StorageState(ctx, []string{app.URL})
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v", warnings)
	}
	wantCookie := Cookie{Name: "sid", Value: "signed-in", Domain: "127.0.0.1", Path: "/", Expires: -1, HTTPOnly: true, SameSite: "Lax"}
	if !slices.Contains(state.Cookies, wantCookie) {
		t.Errorf("cookies = %+v, want %+v among them", state.Cookies, wantCookie)
	}
	want := []OriginState{{Origin: app.URL, LocalStorage: []NameValue{{Name: "token", Value: token}}}}
	if !slices.EqualFunc(state.Origins, want, func(a, b OriginState) bool {
		return a.Origin == b.Origin && slices.Equal(a.LocalStorage, b.LocalStorage)
	}) {
		t.Errorf("origins = %+v, want %+v", state.Origins, want)
	}
	if got := requests.Load(); got != before {
		t.Errorf("the app was asked for %d more pages: its code ran to read its sign-in", got-before)
	}
	// Chromium closes a tab after saying it will.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		got := pageCount(t, ctx, b)
		if got == tabsBefore {
			break
		}
		if time.Now().After(deadline) {
			t.Errorf("%d tabs open after, %d before: a background tab was left", got, tabsBefore)
			break
		}
	}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func evaluateInTab(t *testing.T, ctx context.Context, b *Browser, expression string) string {
	t.Helper()
	tab, err := b.page(ctx)
	if err != nil {
		return ""
	}
	c, err := dialPage(ctx, tab)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var res struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	_ = c.call(ctx, "Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true}, &res)
	return res.Result.Value
}

func pageCount(t *testing.T, ctx context.Context, b *Browser) int {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/json/list", nil)
	var targets []devToolsTarget
	if err := fetchJSON(req, &targets); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, target := range targets {
		if target.Type == "page" {
			n++
		}
	}
	return n
}
