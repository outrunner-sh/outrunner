package editor

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// health is code-server's /healthz, up once `up` is set.
func health(up *atomic.Bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"status":"alive","lastHeartbeat":1761400000000}`))
	}))
}

// noCodeServerOnPath leaves only the test's folder on PATH.
func noCodeServerOnPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
}

func TestARunningEditorIsLeftAsItIs(t *testing.T) {
	var up atomic.Bool
	up.Store(true)
	srv := health(&up)
	defer srv.Close()
	e := &Editor{Home: t.TempDir(), Health: srv.URL, Start: func(context.Context, string, int) error {
		t.Error("started an editor that was already up")
		return nil
	}}
	if port, err := e.Ensure(context.Background()); err != nil || port != Port {
		t.Fatalf("got %d, %v", port, err)
	}
}

func TestAStoppedEditorIsStartedOnItsPort(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	binary := (&Editor{Home: home}).releaseBinary()
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var up atomic.Bool
	srv := health(&up)
	defer srv.Close()
	var started []string
	e := &Editor{Home: home, Health: srv.URL, Port: 9000, Start: func(_ context.Context, b string, port int) error {
		started = append(started, b)
		if port != 9000 {
			t.Errorf("started on %d", port)
		}
		up.Store(true)
		return nil
	}}
	port, err := e.Ensure(context.Background())
	if err != nil || port != 9000 {
		t.Fatalf("got %d, %v", port, err)
	}
	if len(started) != 1 || started[0] != binary {
		t.Fatalf("started %v", started)
	}
}

func TestABoxWithoutCodeServerInstallsItFirst(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	var up atomic.Bool
	srv := health(&up)
	defer srv.Close()
	installs := 0
	e := &Editor{
		Home:   home,
		Health: srv.URL,
		Install: func(context.Context) error {
			installs++
			binary := (&Editor{Home: home}).releaseBinary()
			_ = os.MkdirAll(filepath.Dir(binary), 0o755)
			return os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
		},
		Start: func(context.Context, string, int) error { up.Store(true); return nil },
	}
	if _, err := e.Ensure(context.Background()); err != nil || installs != 1 {
		t.Fatalf("installs %d, %v", installs, err)
	}
}

func TestAFailedInstallSaysSo(t *testing.T) {
	noCodeServerOnPath(t)
	e := &Editor{
		Home:    t.TempDir(),
		Health:  "http://127.0.0.1:1/healthz",
		Install: func(context.Context) error { return errors.New("no network") },
		Start:   func(context.Context, string, int) error { t.Error("started without a binary"); return nil },
	}
	if _, err := e.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "no network") {
		t.Fatalf("got %v", err)
	}
}

func TestTwoOpensAtOnceStartOneEditor(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	binary := (&Editor{Home: home}).releaseBinary()
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
	var up atomic.Bool
	srv := health(&up)
	defer srv.Close()
	var starts atomic.Int32
	e := &Editor{Home: home, Health: srv.URL, Start: func(context.Context, string, int) error {
		starts.Add(1)
		up.Store(true)
		return nil
	}}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := e.Ensure(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if starts.Load() != 1 {
		t.Fatalf("started %d editors", starts.Load())
	}
}

func TestAnOpenThatFoundItDownAsAStartFinishedDoesNotStartAnother(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	binary := (&Editor{Home: home}).releaseBinary()
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
	var up, hold atomic.Bool
	held, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The one probe asked while held answers "down", but only once
		// released: after another open's start has finished.
		if hold.CompareAndSwap(true, false) {
			close(held)
			<-release
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if !up.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"status":"alive","lastHeartbeat":1761400000000}`))
	}))
	defer srv.Close()
	var starts atomic.Int32
	e := &Editor{Home: home, Health: srv.URL, Start: func(context.Context, string, int) error {
		starts.Add(1)
		up.Store(true)
		return nil
	}}

	hold.Store(true)
	late := make(chan error, 1)
	go func() {
		_, err := e.Ensure(context.Background())
		late <- err
	}()
	<-held
	// Another open starts it and sees it through, while the first's probe is out.
	if _, err := e.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-late; err != nil {
		t.Fatal(err)
	}
	if starts.Load() != 1 {
		t.Fatalf("started %d editors, want 1", starts.Load())
	}
}

func TestAnEditorThatDiesAfterStartingIsStartedAgain(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	binary := (&Editor{Home: home}).releaseBinary()
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
	var up atomic.Bool
	srv := health(&up)
	defer srv.Close()
	var starts atomic.Int32
	e := &Editor{Home: home, Health: srv.URL, Start: func(context.Context, string, int) error {
		starts.Add(1)
		up.Store(true)
		return nil
	}}
	if _, err := e.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	// It died after its start: the next open finds it down and starts it.
	up.Store(false)
	if _, err := e.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	if starts.Load() != 2 {
		t.Fatalf("started %d editors, want 2", starts.Load())
	}
}

func TestASlowStartSaysItIsStartingThenOpens(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	binary := (&Editor{Home: home}).releaseBinary()
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
	var up atomic.Bool
	srv := health(&up)
	defer srv.Close()
	release := make(chan struct{})
	var starts atomic.Int32
	e := &Editor{Home: home, Health: srv.URL, Wait: 50 * time.Millisecond, Start: func(context.Context, string, int) error {
		starts.Add(1)
		<-release
		up.Store(true)
		return nil
	}}
	if _, err := e.Ensure(context.Background()); !errors.Is(err, ErrStarting) {
		t.Fatalf("first open: %v", err)
	}
	// Asked again while it's still starting: still starting, not a second start.
	if _, err := e.Ensure(context.Background()); !errors.Is(err, ErrStarting) {
		t.Fatalf("second open: %v", err)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		port, err := e.Ensure(context.Background())
		if err == nil && port == Port {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never opened: %v", err)
		}
	}
	if starts.Load() != 1 {
		t.Fatalf("started %d times", starts.Load())
	}
}

func TestAFailedStartIsToldThenTriedAgain(t *testing.T) {
	noCodeServerOnPath(t)
	installs := 0
	e := &Editor{
		Home:    t.TempDir(),
		Health:  "http://127.0.0.1:1/healthz",
		Install: func(context.Context) error { installs++; return errors.New("no network") },
	}
	if _, err := e.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "no network") {
		t.Fatalf("got %v", err)
	}
	if _, err := e.Ensure(context.Background()); err == nil || installs != 2 {
		t.Fatalf("tried again %d times, %v", installs, err)
	}
}

// gone says no code-server process is there.
func gone(context.Context) bool { return false }

func TestEveryOpenWaitingOnAFailedStartIsTold(t *testing.T) {
	noCodeServerOnPath(t)
	release := make(chan struct{})
	var installs atomic.Int32
	e := &Editor{
		Home:    t.TempDir(),
		Health:  "http://127.0.0.1:1/healthz",
		Running: gone,
		Wait:    5 * time.Second,
		Install: func(context.Context) error {
			installs.Add(1)
			<-release
			return errors.New("no network")
		},
	}
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() {
			_, err := e.Ensure(context.Background())
			errs <- err
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	for i := 0; i < 3; i++ {
		if err := <-errs; err == nil || !strings.Contains(err.Error(), "no network") {
			t.Fatalf("an open waiting on the start got %v", err)
		}
	}
	if installs.Load() != 1 {
		t.Fatalf("installed %d times for one start", installs.Load())
	}
}

func TestALiveButSlowEditorIsWaitedOnNotRestarted(t *testing.T) {
	var up atomic.Bool
	srv := health(&up)
	defer srv.Close()
	e := &Editor{
		Home:    t.TempDir(),
		Health:  srv.URL,
		Running: func(context.Context) bool { return true },
		Start: func(context.Context, string, int) error {
			t.Error("restarted an editor whose process was there")
			return nil
		},
		Install: func(context.Context) error {
			t.Error("installed over a running editor")
			return nil
		},
	}
	go func() {
		time.Sleep(500 * time.Millisecond)
		up.Store(true)
	}()
	if port, err := e.Ensure(context.Background()); err != nil || port != Port {
		t.Fatalf("got %d, %v", port, err)
	}
}

func TestAnEditorThatDiesAtOnceIsSaidAtOnceWithItsLog(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	binary := (&Editor{Home: home}).releaseBinary()
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
	e := &Editor{
		Home:    home,
		Health:  "http://127.0.0.1:1/healthz",
		Running: gone,
		Wait:    10 * time.Second,
		Start: func(context.Context, string, int) error {
			return os.WriteFile(filepath.Join(home, ".outrunner-editor.log"), []byte("error listen EADDRINUSE"), 0o600)
		},
	}
	began := time.Now()
	_, err := e.Ensure(context.Background())
	if err == nil || !strings.Contains(err.Error(), "EADDRINUSE") {
		t.Fatalf("got %v", err)
	}
	if time.Since(began) > 5*time.Second {
		t.Fatalf("took %s to say it died", time.Since(began))
	}
}

func TestAWedgedEditorIsStoppedSoTheNextOpenStartsFresh(t *testing.T) {
	running := true
	stops := 0
	starts := 0
	e := &Editor{
		Home:         t.TempDir(),
		Health:       "http://127.0.0.1:1/healthz",
		Running:      func(context.Context) bool { return running },
		Stop:         func(context.Context) { stops++; running = false },
		StartTimeout: 200 * time.Millisecond,
		Wait:         5 * time.Second,
		Install:      func(context.Context) error { return errors.New("no install expected") },
		Start:        func(context.Context, string, int) error { starts++; return nil },
	}
	if _, err := e.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "didn't answer") {
		t.Fatalf("got %v", err)
	}
	if stops != 1 || starts != 0 {
		t.Fatalf("stopped %d, started %d: a wedged editor is stopped, not started over", stops, starts)
	}
	// The next open finds it gone and starts it fresh.
	binary := e.releaseBinary()
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755)
	_, _ = e.Ensure(context.Background())
	if starts != 1 {
		t.Fatalf("started %d after the wedged editor was stopped, want 1", starts)
	}
}

func TestAnotherServerOnThePortIsNotTheEditor(t *testing.T) {
	spa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<!doctype html><title>my app</title>"))
	}))
	defer spa.Close()
	e := &Editor{Health: spa.URL}
	if e.up(context.Background()) {
		t.Fatal("a dev server's 200 passed for the editor")
	}
	if !e.LastUsed(context.Background()).IsZero() {
		t.Fatal("a dev server reported editor activity")
	}
}

func TestTheEditorsHeartbeatIsWhenItWasLastUsed(t *testing.T) {
	var up atomic.Bool
	up.Store(true)
	srv := health(&up)
	defer srv.Close()
	e := &Editor{Health: srv.URL}
	if got := e.LastUsed(context.Background()); !got.Equal(time.UnixMilli(1761400000000)) {
		t.Fatalf("got %v", got)
	}
	up.Store(false)
	if !e.LastUsed(context.Background()).IsZero() {
		t.Fatal("a stopped editor reported activity")
	}
}

func TestAnInstallOfAnotherVersionIsReplacedByThisOne(t *testing.T) {
	noCodeServerOnPath(t)
	home := t.TempDir()
	old := filepath.Join(home, ".local", "lib", "code-server-0.0.1-linux-amd64", "bin", "code-server")
	_ = os.MkdirAll(filepath.Dir(old), 0o755)
	_ = os.WriteFile(old, []byte("#!/bin/sh\n"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755)
	_ = os.Symlink(old, filepath.Join(home, ".local", "bin", "code-server"))
	installs := 0
	e := &Editor{Home: home, Install: func(context.Context) error {
		installs++
		path := (&Editor{Home: home}).releaseBinary()
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		return os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755)
	}}
	got, err := e.binary(context.Background())
	if err != nil || installs != 1 || got != e.releaseBinary() {
		t.Fatalf("got %q, %d installs, %v", got, installs, err)
	}
}
