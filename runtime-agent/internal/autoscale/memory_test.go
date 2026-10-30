package autoscale

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/media"
)

func TestReadMemory(t *testing.T) {
	root := t.TempDir()
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("memory.max", "1000\n")
	write("memory.current", "950\n")
	write("memory.stat", "anon 450\ninactive_file 500\n")
	r, err := ReadMemory(root)
	if err != nil || r.Limit != 1000 || r.WorkingSet != 450 {
		t.Fatalf("reading = %+v, %v", r, err)
	}
	write("memory.max", "max\n")
	if _, err := ReadMemory(root); err == nil {
		t.Fatal("unlimited cgroup should not request memory")
	}
	write("memory.max", "1000\n")
	write("memory.stat", "inactive_file 1001\n")
	if _, err := ReadMemory(root); err == nil {
		t.Fatal("invalid cache should not request memory")
	}
	if _, err := ReadMemory(t.TempDir()); err == nil {
		t.Fatal("missing cgroup should not request memory")
	}
}

func TestPressureNotifications(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		timestamp := r.Header.Get("X-Outrunner-Timestamp")
		want := media.Sign("secret", "memory-scale", "box", timestamp, body)
		if string(body) != "{}" || r.Method != "POST" || r.URL.Path != "/api/runtime/memory-scale" ||
			r.Header.Get("X-Outrunner-Sandbox") != "box" || r.Header.Get("X-Outrunner-Signature") != want {
			t.Error("notification was not correctly signed for this box/route")
		}
		fmt.Fprint(w, `{"outcome":"scaled","memoryGb":8,"retryAfterSeconds":90}`)
	}))
	defer server.Close()
	used := uint64(850)
	m := &Monitor{Config: gitcred.Config{AppURL: server.URL, SandboxID: "box", Secret: "secret"},
		Now: func() time.Time { return now }, Read: func() (Reading, error) { return Reading{1000, used}, nil }}
	check := func() {
		t.Helper()
		if err := m.Check(context.Background()); err != nil {
			t.Fatal(err)
		}
		now = now.Add(2 * time.Second)
	}
	check()
	if calls != 0 {
		t.Fatal("one 85% sample should wait")
	}
	used = 500
	check()
	used = 850
	check()
	if calls != 0 {
		t.Fatal("a quiet sample should reset consecutive pressure")
	}
	check()
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	used = 980
	check()
	if calls != 1 {
		t.Fatal("critical pressure bypassed cooldown")
	}
	now = now.Add(90 * time.Second)
	check()
	if calls != 2 {
		t.Fatal("critical pressure should notify immediately after cooldown")
	}
}

func TestRefusalsBackOffAndDoNotStopMonitoring(t *testing.T) {
	now := time.Now()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	m := &Monitor{Config: gitcred.Config{AppURL: server.URL, SandboxID: "box", Secret: "secret"},
		Now: func() time.Time { return now }, Read: func() (Reading, error) { return Reading{1000, 980}, nil }}
	if err := m.Check(context.Background()); err == nil {
		t.Fatal("refusal should be reported")
	}
	now = now.Add(2 * time.Minute)
	if err := m.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("failure should back off for five minutes")
	}
	now = now.Add(4 * time.Minute)
	if err := m.Check(context.Background()); err == nil {
		t.Fatal("monitor should retry after backoff")
	}
	if calls != 2 {
		t.Fatal("missing retry")
	}
}

func TestRunStopsWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { (&Monitor{}).Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop")
	}
}
