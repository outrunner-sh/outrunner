package workspace

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
)

// fakeSessions stands in for tmux: a session that is running, busy, unreadable
// or failing to start, without a tmux server.
type fakeSessions struct {
	mu         sync.Mutex
	running    map[string]bool
	pane       string
	existsErr  error
	captureErr error
	// newErrs fail NewSession calls in order; nil entries (or none left) succeed.
	newErrs  []error
	launches [][]string
}

func newFakeSessions() *fakeSessions {
	// The composer glyph lets waitClaudeReady see a ready Claude.
	return &fakeSessions{running: map[string]bool{}, pane: "❯ \n  ⏵⏵ accept edits on"}
}

func (f *fakeSessions) NewSession(_ context.Context, name, _ string, command []string, _ []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.launches = append(f.launches, command)
	if len(f.newErrs) > 0 {
		err := f.newErrs[0]
		f.newErrs = f.newErrs[1:]
		if err != nil {
			return err
		}
	}
	f.running[name] = true
	return nil
}

func (f *fakeSessions) HideStatus(context.Context, string) {}

func (f *fakeSessions) HasSession(_ context.Context, name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running[name]
}

func (f *fakeSessions) SessionExists(_ context.Context, name string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.existsErr != nil {
		return false, f.existsErr
	}
	return f.running[name], nil
}

func (f *fakeSessions) KillSession(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.running, name)
	return nil
}

func (f *fakeSessions) Paste(context.Context, string, string) error { return nil }

func (f *fakeSessions) SubmitEnter(context.Context, string) error { return nil }

func (f *fakeSessions) CapturePane(context.Context, string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pane, f.captureErr
}

func (f *fakeSessions) lastLaunch() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.launches) == 0 {
		return nil
	}
	return f.launches[len(f.launches)-1]
}

// runningSession creates workspace id on model and marks its session running.
func runningSession(t *testing.T, model string) (*Service, *fakeSessions, string) {
	t.Helper()
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	s.tmux = fake
	const id = "ws-run"
	// A folder that isn't a repository: the session works in it in place.
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), Model: model}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	fake.running[sessionName(id)] = true
	t.Cleanup(func() { s.stopRecorder(context.Background(), id) })
	return s, fake, id
}

func launchedOn(argv []string, model string) bool {
	i := slices.Index(argv, "--model")
	return i >= 0 && i+1 < len(argv) && argv[i+1] == model
}

func TestASwitchRelaunchesARunningSessionOnTheNewModel(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if got := fake.lastLaunch(); !launchedOn(got, "opus") {
		t.Fatalf("relaunch = %q, want --model opus", got)
	}
	if f, _ := s.getFacts(id); f.Model != "opus" {
		t.Errorf("recorded model = %q, want opus", f.Model)
	}
	if !fake.HasSession(context.Background(), sessionName(id)) {
		t.Error("no session running after the switch")
	}
}

func TestASwitchMidTurnIsRefusedAndRecordsNothing(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	fake.pane = "✶ Combobulating…\n  ⏵⏵ accept edits on · esc to interrupt"
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, ""); !errors.Is(err, ErrSessionBusy) {
		t.Fatalf("SetModel = %v, want ErrSessionBusy", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("a busy session was relaunched: %q", fake.launches)
	}
	if f, _ := s.getFacts(id); f.Model != "sonnet" {
		t.Errorf("a refused switch recorded %q", f.Model)
	}
}

func TestASwitchThatCantReadTheScreenIsRefused(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	fake.captureErr = errors.New("capture-pane: server busy")
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, ""); !errors.Is(err, ErrSessionUnchecked) {
		t.Fatalf("SetModel = %v, want ErrSessionUnchecked", err)
	}
	if f, _ := s.getFacts(id); f.Model != "sonnet" || len(fake.launches) != 0 {
		t.Errorf("an unread session was switched: model %q, launches %q", f.Model, fake.launches)
	}
}

func TestASwitchWhenTmuxCantAnswerIsRefused(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	fake.existsErr = errors.New("tmux: lost server")
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, ""); !errors.Is(err, ErrSessionUnchecked) {
		t.Fatalf("SetModel = %v, want ErrSessionUnchecked", err)
	}
	if f, _ := s.getFacts(id); f.Model != "sonnet" {
		t.Errorf("recorded %q without knowing the session's state", f.Model)
	}
}

func TestAFailedSwitchBringsClaudeBackOnItsOldModel(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	startErr := errors.New("tmux new-session: no space left")
	fake.newErrs = []error{startErr}
	err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, "")
	if !errors.Is(err, startErr) {
		t.Fatalf("SetModel = %v, want the start error", err)
	}
	if len(fake.launches) != 2 || !launchedOn(fake.launches[0], "opus") || !launchedOn(fake.launches[1], "sonnet") {
		t.Fatalf("launches = %q, want opus then sonnet", fake.launches)
	}
	if !fake.HasSession(context.Background(), sessionName(id)) {
		t.Error("a failed switch left no session running")
	}
	if f, _ := s.getFacts(id); f.Model != "sonnet" {
		t.Errorf("recorded %q, want the old model kept", f.Model)
	}
	// Not recorded, so a retry of the same model really tries again.
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, ""); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if got := fake.lastLaunch(); !launchedOn(got, "opus") {
		t.Errorf("retry launched %q, want opus", got)
	}
}

func TestAFailedSwitchSaysSoWhenTheOldModelWontStartEither(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	fake.newErrs = []error{errors.New("first"), errors.New("second")}
	err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus"}, "")
	if err == nil || !strings.Contains(err.Error(), "previous model failed too") || !strings.Contains(err.Error(), "second") {
		t.Fatalf("SetModel = %v, want both failures reported", err)
	}
	if f, _ := s.getFacts(id); f.Model != "sonnet" {
		t.Errorf("recorded %q, want the old model kept", f.Model)
	}
}
