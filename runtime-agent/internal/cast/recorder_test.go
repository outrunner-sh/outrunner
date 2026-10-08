package cast

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakePane emulates tmux: on arm it writes canned bytes into the FIFO (as
// pipe-pane's `cat` would) and records whether it was disarmed.
type fakePane struct {
	data       []byte
	cols, rows int

	mu       sync.Mutex
	armed    bool
	arms     int
	disarmed bool
}

func (p *fakePane) size(context.Context) (int, int, error) {
	if p.cols == 0 {
		return 100, 30, nil
	}
	return p.cols, p.rows, nil
}

func (p *fakePane) arm(_ context.Context, fifoPath string) error {
	p.mu.Lock()
	p.armed = true
	p.arms++
	data := p.data
	p.mu.Unlock()
	go func() {
		w, err := os.OpenFile(fifoPath, os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		defer w.Close()
		w.Write(data)
	}()
	return nil
}

func (p *fakePane) disarm(context.Context) error {
	p.mu.Lock()
	p.disarmed = true
	p.mu.Unlock()
	return nil
}

func newFakeRecorder(t *testing.T, p pane) *Recorder {
	t.Helper()
	castPath := filepath.Join(t.TempDir(), DefaultCastName)
	return &Recorder{pane: p, castPath: castPath}
}

func TestRecorderCapturesPaneOutput(t *testing.T) {
	p := &fakePane{data: []byte("hello CAST_OK world"), cols: 90, rows: 25}
	r := newFakeRecorder(t, p)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // let the drain goroutine consume
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(r.castPath)
	if err != nil {
		t.Fatal(err)
	}
	h, frames := parseCast(t, b)
	if h.Width != 90 || h.Height != 25 {
		t.Fatalf("header size = %dx%d, want 90x25 (from pane)", h.Width, h.Height)
	}
	var out bytes.Buffer
	for _, f := range frames {
		out.WriteString(f[2].(string))
	}
	if !bytes.Contains(out.Bytes(), []byte("CAST_OK")) {
		t.Fatalf("cast missing pane output; got %q", out.String())
	}
	if !p.disarmed {
		t.Fatal("expected pane to be disarmed on Stop")
	}
	if r.Err() != nil {
		t.Fatalf("unexpected record error: %v", r.Err())
	}
}

func TestRearmKeepsOneCastAcrossARelaunch(t *testing.T) {
	p := &fakePane{data: []byte("BEFORE_SWITCH ")}
	r := newFakeRecorder(t, p)
	ctx := context.Background()

	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	// The session is replaced under the same name; its new pane says something else.
	p.mu.Lock()
	p.data = []byte("AFTER_SWITCH")
	p.mu.Unlock()
	if running, err := r.Rearm(ctx); !running || err != nil {
		t.Fatalf("Rearm = %v, %v; want true, nil", running, err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := r.Stop(ctx); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(r.castPath)
	if err != nil {
		t.Fatal(err)
	}
	if n := bytes.Count(b, []byte(`"version"`)); n != 1 {
		t.Fatalf("cast has %d headers, want 1", n)
	}
	_, frames := parseCast(t, b)
	var out bytes.Buffer
	for _, f := range frames {
		out.WriteString(f[2].(string))
	}
	if !bytes.Contains(out.Bytes(), []byte("BEFORE_SWITCH")) || !bytes.Contains(out.Bytes(), []byte("AFTER_SWITCH")) {
		t.Fatalf("cast = %q, want the output from before and after the relaunch", out.String())
	}
	if p.arms != 2 {
		t.Fatalf("pane armed %d times, want 2", p.arms)
	}
}

func TestRearmDoesNothingWhenNotRecording(t *testing.T) {
	p := &fakePane{data: []byte("x")}
	r := newFakeRecorder(t, p)
	if running, err := r.Rearm(context.Background()); running || err != nil {
		t.Fatalf("Rearm before Start = %v, %v; want false, nil", running, err)
	}
	if p.arms != 0 {
		t.Fatal("Rearm armed a recorder that wasn't running")
	}
}

func TestRecorderStartStopIdempotent(t *testing.T) {
	p := &fakePane{data: []byte("x")}
	r := newFakeRecorder(t, p)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil { // second Start is a no-op
		t.Fatal(err)
	}
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Stop(context.Background()); err != nil { // second Stop is a no-op
		t.Fatal(err)
	}
}

func TestRecorderMasksSecretsBeforeRecording(t *testing.T) {
	// The key printed as a session might (`env | grep TOKEN`), ending the
	// output so the masking's held-back tail is flushed at Stop too.
	p := &fakePane{data: []byte("ANTHROPIC_AUTH_TOKEN=sk-or-v1-recorded-key\r\nmore output sk-or-v1-recorded-key")}
	r := newFakeRecorder(t, p)
	r.opts.Secrets = []string{"sk-or-v1-recorded-key"}

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(r.castPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("sk-or-v1-recorded-key")) {
		t.Fatalf("the cast holds the key:\n%s", b)
	}
	_, frames := parseCast(t, b)
	var out bytes.Buffer
	for _, f := range frames {
		out.WriteString(f[2].(string))
	}
	if got := out.String(); got != "ANTHROPIC_AUTH_TOKEN=***\r\nmore output ***" {
		t.Fatalf("recorded %q, want the output with the key masked and nothing else lost", got)
	}
}
