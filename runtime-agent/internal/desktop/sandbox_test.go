package desktop

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeChromium puts a "chromium" on the PATH that records each launch's
// flags and acts as script says, and a DevTools that answers once a launch
// has touched $FAKE_UP.
func fakeChromium(t *testing.T, script string) (b *Browser, launches func() []string) {
	t.Helper()
	dir := t.TempDir()
	record, up := filepath.Join(dir, "launches"), filepath.Join(dir, "up")
	body := "#!/bin/sh\necho \"$*\" >> \"$FAKE_LAUNCHES\"\n" + script
	if err := os.WriteFile(filepath.Join(dir, "chromium"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":/bin:/usr/bin")
	t.Setenv("FAKE_LAUNCHES", record)
	t.Setenv("FAKE_UP", up)
	devtools := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(up); err != nil {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(devtools.Close)
	_, port, _ := net.SplitHostPort(devtools.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	profile := filepath.Join(t.TempDir(), "chromium")
	return &Browser{Port: p, Profile: profile, Display: Display}, func() []string {
		data, _ := os.ReadFile(record)
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
}

// As on a Daytona box: the sandbox can't be had, Chromium says so and quits,
// and is launched again without it.
func TestABrowserWithNoUsableSandboxIsLaunchedWithoutOne(t *testing.T) {
	b, launches := fakeChromium(t, `
case " $* " in *" --no-sandbox "*) : > "$FAKE_UP"; exit 0;; esac
echo "ERROR:zygote_host_impl_linux.cc(130)] No usable sandbox! If you want to live dangerously ... --no-sandbox." >&2
exit 1
`)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := b.Open(ctx, "http://localhost:3000/"); err != nil {
		t.Fatal(err)
	}
	got := launches()
	if len(got) != 2 || strings.Contains(got[0], "--no-sandbox") || !strings.HasPrefix(got[1], "--no-sandbox ") {
		t.Fatalf("launches = %q, want one with the sandbox, then one without", got)
	}
}

// Where the sandbox works, Chromium keeps it.
func TestABrowserWithItsSandboxKeepsIt(t *testing.T) {
	b, launches := fakeChromium(t, `: > "$FAKE_UP"`)
	if err := b.Open(context.Background(), "http://localhost:3000/"); err != nil {
		t.Fatal(err)
	}
	if got := launches(); len(got) != 1 || strings.Contains(got[0], "--no-sandbox") {
		t.Fatalf("launches = %q", got)
	}
}

// A browser that quits as it starts for any other reason is said to have,
// at once, rather than waited on, and isn't launched without its sandbox.
func TestABrowserThatQuitsForAnotherReasonSaysSo(t *testing.T) {
	b, launches := fakeChromium(t, "echo 'Missing X server or $DISPLAY' >&2\nexit 1\n")
	start := time.Now()
	err := b.Open(context.Background(), "http://localhost:3000/")
	if err == nil || !strings.Contains(err.Error(), "quit as it started") || !strings.Contains(err.Error(), "chromium.log") {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("took %v: waited on a browser that had quit", time.Since(start))
	}
	if got := launches(); len(got) != 1 {
		t.Errorf("launches = %q", got)
	}
}
