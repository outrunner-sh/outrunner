package workspace

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"runtime-agent/internal/claude"
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
	// keys are the keys pressed; onKey, when set, answers one with the pane
	// it leads to ("" leaves the pane as it is).
	keys  []string
	onKey func(key string) string
	// exitAtOnce makes a session's Claude exit as soon as it is launched.
	exitAtOnce bool
	// pastes and enters count what a send typed.
	pastes, enters int
}

func newFakeSessions() *fakeSessions {
	// Claude's prompt box lets waitClaudeReady see a ready Claude.
	return &fakeSessions{running: map[string]bool{}, pane: composerPane}
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
	f.running[name] = !f.exitAtOnce
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

func (f *fakeSessions) Paste(context.Context, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pastes++
	return nil
}

func (f *fakeSessions) SubmitEnter(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.enters++
	return nil
}

func (f *fakeSessions) SendKey(_ context.Context, _ string, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keys = append(f.keys, key)
	if f.onKey != nil {
		if pane := f.onKey(key); pane != "" {
			f.pane = pane
		}
	}
	return nil
}

func (f *fakeSessions) SendKeys(ctx context.Context, name string, keys ...string) error {
	for _, key := range keys {
		_ = f.SendKey(ctx, name, key)
	}
	return nil
}

func (f *fakeSessions) CapturePaneStyled(ctx context.Context, name string) (string, error) {
	return f.CapturePane(ctx, name)
}

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

func launchedAt(argv []string, effort string) bool {
	i := slices.Index(argv, "--effort")
	if effort == "" {
		return i < 0
	}
	return i >= 0 && i+1 < len(argv) && argv[i+1] == effort
}

// The effort is part of the choice: a switch of it alone relaunches, and a
// switch that names none drops the one the session had.
func TestASwitchOfEffortRelaunchesAndANewModelReplacesIt(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "opus")
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus", Effort: "max"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if got := fake.lastLaunch(); !launchedOn(got, "opus") || !launchedAt(got, "max") {
		t.Fatalf("relaunch = %q, want opus at max", got)
	}
	if f, _ := s.getFacts(id); f.Effort != "max" {
		t.Errorf("recorded effort = %q, want max", f.Effort)
	}
	launches := len(fake.launches)
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus", Effort: "max"}, ""); err != nil || len(fake.launches) != launches {
		t.Errorf("the same choice again = %v with %d launches, want no relaunch", err, len(fake.launches)-launches)
	}
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "sonnet"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if got := fake.lastLaunch(); !launchedOn(got, "sonnet") || !launchedAt(got, "") {
		t.Errorf("relaunch = %q, want sonnet at its own effort", got)
	}
	// A repeated Create (an agent restart) keeps it, as it keeps the model.
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "sonnet", Effort: "low"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	f, _ := s.getFacts(id)
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: f.RepoPath}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if f, _ := s.getFacts(id); f.Effort != "low" || f.Model != "sonnet" {
		t.Errorf("after a repeated Create: %q at %q, want sonnet at low", f.Model, f.Effort)
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
	err := s.SetModel(context.Background(), id, ModelChoice{Model: "opus", Effort: "high"}, "")
	if !errors.Is(err, startErr) {
		t.Fatalf("SetModel = %v, want the start error", err)
	}
	if len(fake.launches) != 2 || !launchedOn(fake.launches[0], "opus") || !launchedOn(fake.launches[1], "sonnet") ||
		!launchedAt(fake.launches[1], "") {
		t.Fatalf("launches = %q, want opus then sonnet", fake.launches)
	}
	if !fake.HasSession(context.Background(), sessionName(id)) {
		t.Error("a failed switch left no session running")
	}
	if f, _ := s.getFacts(id); f.Model != "sonnet" || f.Effort != "" {
		t.Errorf("recorded %q at %q, want the old model kept, at its own effort", f.Model, f.Effort)
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

func TestAFailedSwitchKeepsTheGatewayKeyItWasRunningOn(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	ctx := context.Background()
	const oldKey = "sk-or-v1-old-0123456789abcdef"
	const newKey = "sk-or-v1-new-0123456789abcdef"
	if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: oldKey}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	fake.newErrs = []error{errors.New("tmux new-session failed")}
	if err := s.SetModel(ctx, id, ModelChoice{Model: "anthropic/claude-sonnet-5", Gateway: claude.OpenRouter, Token: newKey}, ""); err == nil {
		t.Fatal("SetModel succeeded, want the start error")
	}
	env, err := os.ReadFile(s.gatewayEnvPath(id))
	if err != nil || !strings.Contains(string(env), oldKey) || strings.Contains(string(env), newKey) {
		t.Fatalf("key file = %q, %v; want the old key back", env, err)
	}
	if f, _ := s.getFacts(id); f.Model != "z-ai/glm-5.3" || f.Gateway != claude.OpenRouter {
		t.Errorf("facts = %+v, want the old gateway model", f)
	}
	if got := fake.lastLaunch(); len(got) == 0 || got[0] != "sh" || !slices.Contains(got, s.gatewayEnvPath(id)) {
		t.Errorf("recovery launched %q, want it through the gateway file", got)
	}
	if !fake.HasSession(ctx, sessionName(id)) {
		t.Error("a failed switch left no session running")
	}
}

func TestAStopPressesEscapeOnceAndWaitsForTheTurnToEnd(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	fake.pane = "✶ Combobulating…\n  ⏵⏵ accept edits on · esc to interrupt"
	fake.onKey = func(key string) string {
		if key == "Escape" {
			return composerPane
		}
		return ""
	}
	if err := s.Interrupt(context.Background(), id); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	if !slices.Equal(fake.keys, []string{"Escape"}) {
		t.Errorf("keys = %q, want one Escape", fake.keys)
	}
}

func TestAStopOfAnIdleSessionPressesNothing(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	// Escape on an idle prompt box, pressed twice, opens Claude's rewind menu.
	if err := s.Interrupt(context.Background(), id); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	if len(fake.keys) != 0 {
		t.Errorf("keys = %q on an idle session, want none", fake.keys)
	}
}

func TestAStopThatLeavesTheTurnRunningSaysSo(t *testing.T) {
	t.Parallel()
	s, fake, id := runningSession(t, "sonnet")
	fake.pane = "✶ Combobulating…\n  ⏵⏵ accept edits on · esc to interrupt"
	if err := s.Interrupt(context.Background(), id); !errors.Is(err, ErrNotInterrupted) {
		t.Fatalf("Interrupt = %v, want ErrNotInterrupted", err)
	}
	if len(fake.keys) != 1 {
		t.Errorf("keys = %q, want Escape pressed once only", fake.keys)
	}
}

func TestAStopOfAnUnknownWorkspaceIsRefused(t *testing.T) {
	t.Parallel()
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	if err := s.Interrupt(context.Background(), "nope"); !errors.Is(err, ErrUnknownWorkspace) {
		t.Fatalf("Interrupt = %v, want ErrUnknownWorkspace", err)
	}
}
