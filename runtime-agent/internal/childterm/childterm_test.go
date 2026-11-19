package childterm

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The fake program (fakeProgram, per OS) takes what to do as its argument:
//   - print: print "hello <$CHILDTERM_TEST>" and exit
//   - echo: prompt, read a line, print "got <line>" and exit
//   - wait: start a program of its own that runs for a minute, and wait for it
//
// It lives in a directory with a space in its name, as a user's might.

// output collects what a terminal prints until its reads end.
type output struct {
	mu   sync.Mutex
	text strings.Builder
	done chan struct{}
}

func readAll(term Terminal) *output {
	o := &output{done: make(chan struct{})}
	go func() {
		defer close(o.done)
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			o.mu.Lock()
			o.text.Write(buf[:n])
			o.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return o
}

func (o *output) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.text.String()
}

// waitFor waits until the output has want in it.
func (o *output) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(o.String(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("no %q in %q", want, o.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitForEnd waits until the terminal's reads have ended.
func (o *output) waitForEnd(t *testing.T) {
	t.Helper()
	select {
	case <-o.done:
	case <-time.After(15 * time.Second):
		t.Fatalf("reads never ended; got %q", o.String())
	}
}

func start(t *testing.T, mode string) Terminal {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "a dir")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	term, err := Start(fakeProgram(t, dir), []string{mode}, t.TempDir(), append(os.Environ(), "CHILDTERM_TEST=from-env"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = term.Close() })
	return term
}

// What the program printed reaches the reader, and reads end once it has
// exited: how SetupToken knows `claude setup-token` stopped.
func TestReadsEndAfterTheProgramsLastOutput(t *testing.T) {
	out := readAll(start(t, "print"))
	out.waitForEnd(t)
	if !strings.Contains(out.String(), "hello from-env") {
		t.Fatalf("got %q", out.String())
	}
}

// A line written, ended with CR as Enter sends it, is what the program reads.
func TestTypingReachesTheProgram(t *testing.T) {
	term := start(t, "echo")
	out := readAll(term)
	out.waitFor(t, "type >")
	if _, err := term.Write([]byte("the-code#state\r")); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "got the-code#state")
	out.waitForEnd(t)
}

// Close stops a program still running, with what it started, and doesn't
// hang on it.
func TestCloseStopsAProgramStillRunning(t *testing.T) {
	term := start(t, "wait")
	out := readAll(term)
	closed := make(chan struct{})
	go func() {
		_ = term.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(15 * time.Second):
		t.Fatal("Close hung on the running program")
	}
	out.waitForEnd(t)
}
