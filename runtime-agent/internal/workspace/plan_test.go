package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/codex"
)

// Claude's plan, waiting on approval: a menu, which a prompt typed into would
// answer.
const planPane = ` Ready to code?

 Here is Claude's plan:
 Add a dark mode toggle to the settings page.

 Would you like to proceed?

 ❯ 1. Yes, and auto-accept edits
   2. Yes, and manually approve edits
   3. No, keep planning`

// landingSession is runningSession whose prompts land: each Enter records a
// user turn in the session's transcript, as Claude does once it takes one.
// Not parallel: the transcript is under $HOME.
func landingSession(t *testing.T) (*Service, *fakeSessions, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	s, fake, id := runningSession(t, "sonnet")
	f, _ := s.getFacts(id)
	log := filepath.Join(s.claudeConvDir(id), f.ClaudeSessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(log), 0o755); err != nil {
		t.Fatal(err)
	}
	fake.onEnter = func() string {
		file, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = file.WriteString(`{"type":"user"}` + "\n")
			_ = file.Close()
		}
		return ""
	}
	return s, fake, id
}

func launchedIn(argv []string, mode string) bool {
	i := slices.Index(argv, "--permission-mode")
	return i >= 0 && i+1 < len(argv) && argv[i+1] == mode
}

func TestAPromptInPlanModeRelaunchesTheSessionIntoItOnce(t *testing.T) {
	s, fake, id := landingSession(t)
	if err := s.SendPrompt(id, Prompt{Content: "Plan dark mode", Mode: ModePlan}); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if got := fake.lastLaunch(); !launchedIn(got, "plan") {
		t.Fatalf("relaunch = %q, want --permission-mode plan", got)
	}
	if f, _ := s.getFacts(id); !f.Plan {
		t.Error("plan mode wasn't recorded, so the next launch would build")
	}
	if !slices.Equal(fake.pasted, []string{"Plan dark mode"}) {
		t.Errorf("pasted %q, want the prompt as typed", fake.pasted)
	}
	// Already planning: the next prompt in plan mode just goes.
	launches := len(fake.launches)
	if err := s.SendPrompt(id, Prompt{Content: "And the docs", Mode: ModePlan}); err != nil || len(fake.launches) != launches {
		t.Fatalf("a second plan prompt = %v with %d relaunches, want none", err, len(fake.launches)-launches)
	}
	// A prompt with no mode leaves the session as it is.
	if err := s.SendPrompt(id, Prompt{Content: "Go on"}); err != nil || len(fake.launches) != launches {
		t.Fatalf("a prompt with no mode = %v with %d relaunches, want none", err, len(fake.launches)-launches)
	}
	// Build: back in the mode the session was made with.
	if err := s.SendPrompt(id, Prompt{Content: "Build it", Mode: ModeBuild}); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if got := fake.lastLaunch(); !launchedIn(got, "acceptEdits") {
		t.Errorf("relaunch = %q, want the session's own acceptEdits", got)
	}
	if f, _ := s.getFacts(id); f.Plan {
		t.Error("still recorded as planning after a build prompt")
	}
}

func TestAModeSwitchMidTurnIsRefusedAndSendsNothing(t *testing.T) {
	s, fake, id := landingSession(t)
	fake.pane = "✶ Combobulating…\n  ⏵⏵ accept edits on · esc to interrupt"
	if err := s.SendPrompt(id, Prompt{Content: "Plan it", Mode: ModePlan}); !errors.Is(err, ErrModeBusy) {
		t.Fatalf("SendPrompt = %v, want ErrModeBusy", err)
	}
	if f, _ := s.getFacts(id); f.Plan || len(fake.launches) != 0 || fake.pastes != 0 {
		t.Errorf("a refused switch: plan %v, launches %q, %d pastes", f.Plan, fake.launches, fake.pastes)
	}
}

func TestAFailedModeSwitchPutsTheSessionBack(t *testing.T) {
	s, fake, id := landingSession(t)
	fake.newErrs = []error{errors.New("tmux new-session: no space left")}
	if err := s.SendPrompt(id, Prompt{Content: "Plan it", Mode: ModePlan}); err == nil {
		t.Fatal("SendPrompt succeeded, want the start error")
	}
	if len(fake.launches) != 2 || !launchedIn(fake.launches[0], "plan") || !launchedIn(fake.launches[1], "acceptEdits") {
		t.Fatalf("launches = %q, want plan then the old mode", fake.launches)
	}
	if f, _ := s.getFacts(id); f.Plan || fake.pastes != 0 {
		t.Errorf("after a failed switch: plan %v, %d pastes; want neither", f.Plan, fake.pastes)
	}
}

// Approving a plan: Escape declines Claude's menu, the session relaunches to
// build, and the approval is the next prompt.
func TestADismissingPromptClosesThePlanMenuFirst(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan = true })
	fake.pane = planPane
	fake.onKey = func(key string) string {
		if key == "Escape" {
			return composerPane
		}
		return ""
	}
	if err := s.SendPrompt(id, Prompt{Content: "Approved. Go ahead.", Mode: ModeBuild, Dismiss: true}); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if !slices.Equal(fake.keys, []string{"Escape"}) {
		t.Errorf("keys = %q, want one Escape", fake.keys)
	}
	if got := fake.lastLaunch(); !launchedIn(got, "acceptEdits") {
		t.Errorf("relaunch = %q, want build", got)
	}
	if !slices.Equal(fake.pasted, []string{"Approved. Go ahead."}) {
		t.Errorf("pasted %q", fake.pasted)
	}
}

// Dismiss only closes a menu: Escape on the prompt box, or mid-turn, would do
// something else (stop the turn).
func TestADismissWithNoMenuPressesNothing(t *testing.T) {
	s, fake, id := landingSession(t)
	if err := s.SendPrompt(id, Prompt{Content: "Revise it", Dismiss: true}); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if len(fake.keys) != 0 {
		t.Errorf("keys = %q on the prompt box, want none", fake.keys)
	}
}

func TestACodexPromptInPlanModeSaysAPlanIsWanted(t *testing.T) {
	s, _, id := runningSession(t, "")
	if got := s.promptText(id, "Add dark mode"); got != "Add dark mode" {
		t.Errorf("Claude in build mode is given %q", got)
	}
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan = true })
	if got := s.promptText(id, "Add dark mode"); got != "Add dark mode" {
		t.Errorf("Claude in plan mode is given %q: its own plan mode says so", got)
	}
	s.updateFacts(id, func(f *workspaceFacts) { f.Agent = AgentCodex })
	if got := s.promptText(id, "Add dark mode"); got != codex.PlanPreamble+"Add dark mode" {
		t.Errorf("Codex in plan mode is given %q", got)
	}
}

func TestPlanModeOutlivesARepeatedCreate(t *testing.T) {
	s, _, id := runningSession(t, "")
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan = true })
	f, _ := s.getFacts(id)
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: f.RepoPath}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := s.launchCommand(id, s.worktreePath(id), true); !launchedIn(got, "plan") {
		t.Errorf("launch after a repeated Create = %q, want plan", got)
	}
}

func TestACompactionTypesTheCommandAndWaitsForItToStart(t *testing.T) {
	s, fake, id := landingSession(t)
	fake.onEnter = func() string { return "✻ Compacting conversation… (esc to interrupt)" }
	if err := s.Compact(id, " keep the failing tests "); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if !slices.Equal(fake.pasted, []string{"/compact keep the failing tests"}) || fake.enters != 1 {
		t.Errorf("typed %q with %d Enters, want /compact and its instructions, once", fake.pasted, fake.enters)
	}
}

func TestACompactionIsRefusedMidTurnAndInAMenu(t *testing.T) {
	s, fake, id := landingSession(t)
	fake.pane = "✶ Combobulating…\n  esc to interrupt"
	if err := s.Compact(id, ""); !errors.Is(err, ErrCompactBusy) {
		t.Errorf("mid-turn = %v, want ErrCompactBusy", err)
	}
	fake.pane = planPane
	if err := s.Compact(id, ""); !errors.Is(err, errAwaitsAnswer) {
		t.Errorf("in a menu = %v, want errAwaitsAnswer", err)
	}
	if fake.pastes != 0 || fake.enters != 0 {
		t.Errorf("typed %q into a session that couldn't take it", fake.pasted)
	}
	if err := s.Compact("nope", ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("an unknown workspace = %v", err)
	}
}

func TestACompactionThatNeverStartsSaysSo(t *testing.T) {
	s, _, id := runningSession(t, "")
	err := s.Compact(id, "")
	if err == nil || !strings.Contains(err.Error(), "didn't start") {
		t.Errorf("Compact = %v, want it said the compaction didn't start", err)
	}
}

// Codex's /compact takes no instructions: typed after it, they'd go as a
// prompt and nothing would compact.
func TestACodexCompactionTypesTheCommandAlone(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Agent = AgentCodex })
	fake.onEnter = func() string { return "• Compacting (esc to interrupt)" }
	if err := s.Compact(id, "keep the failing tests"); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if !slices.Equal(fake.pasted, []string{"/compact"}) {
		t.Errorf("typed %q, want /compact alone", fake.pasted)
	}
}

// Two prompts naming opposite modes at once both switch under the lifecycle
// lock: the second can't decide it switches only after the first has.
func TestPromptsInOppositeModesAtOnceEachSwitchSafely(t *testing.T) {
	s, fake, id := landingSession(t)
	done := make(chan error, 2)
	go func() { done <- s.SendPrompt(id, Prompt{Content: "plan", Mode: ModePlan}) }()
	go func() { done <- s.SendPrompt(id, Prompt{Content: "build", Mode: ModeBuild}) }()
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatalf("SendPrompt: %v", err)
		}
	}
	if fake.pastes != 2 {
		t.Errorf("%d pastes, want both prompts", fake.pastes)
	}
}

// The lifecycle lock is the switch's alone: a prompt still being pasted
// doesn't hold up a Start (which every attach calls) behind it.
func TestAPromptBeingDeliveredLeavesTheLifecycleLockFree(t *testing.T) {
	s, fake, id := landingSession(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	fake.onEnter = func() string {
		select {
		case <-entered:
		default:
			close(entered)
			<-release
		}
		return ""
	}
	done := make(chan error, 1)
	go func() { done <- s.SendPrompt(id, Prompt{Content: "build", Mode: ModeBuild}) }()
	<-entered
	got := make(chan struct{})
	go func() {
		s.lockLifecycle(id)()
		close(got)
	}()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Error("the lifecycle lock was held through the paste")
	}
	close(release)
	if err := <-done; err != nil && !strings.Contains(err.Error(), "not confirmed") {
		t.Fatalf("SendPrompt: %v", err)
	}
}

// planMenu draws Claude Code 2.1.304's plan approval as its labels read in
// that build (cli bundle: yut/lCe), `selected` the option under ❯. Not a pane
// capture: drawn from the labels, the menu's layout as Ink renders a Select.
func planMenu(options []string, selected int) string {
	var b strings.Builder
	b.WriteString(" Here is Claude's plan:\n  Add a dark mode toggle.\n\n Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n")
	for i, option := range options {
		mark := "  "
		if i == selected {
			mark = "❯ "
		}
		fmt.Fprintf(&b, " %s%d. %s\n", mark, i+1, option)
	}
	return b.String()
}

// moveSelection answers the arrows over a planMenu as Claude's does, and
// Enter by leaving the menu (the pick taken up).
func moveSelection(fake *fakeSessions, options []string) {
	selected := 0
	fake.onKey = func(key string) string {
		switch key {
		case "Down":
			selected = min(selected+1, len(options)-1)
		case "Up":
			selected = max(selected-1, 0)
		case "Enter":
			fake.picked = options[selected]
			return "✶ Implementing… (esc to interrupt)"
		}
		return planMenu(options, selected)
	}
}

func TestApprovingAPlanPicksTheBuildModesOptionInClaudesMenu(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan, f.PermissionMode = true, claude.Bypass })
	options := []string{
		"Yes, clear context (31% used) and bypass permissions",
		"Yes, and switch to Bypass Permissions for this session",
		"Yes, manually approve edits",
		"No, keep planning",
	}
	fake.pane = planMenu(options, 0)
	moveSelection(fake, options)
	via, err := s.ApprovePlan(id)
	if err != nil || via != ApprovedInMenu {
		t.Fatalf("ApprovePlan = %q, %v; want it picked in the menu", via, err)
	}
	if fake.picked != options[1] || !slices.Equal(fake.keys, []string{"Down", "Enter"}) {
		t.Errorf("picked %q with %q, want bypass without clearing the context", fake.picked, fake.keys)
	}
	if f, _ := s.getFacts(id); f.Plan {
		t.Error("still planning after the plan was approved")
	}
	if len(fake.launches) != 0 || fake.pastes != 0 {
		t.Errorf("approved in the menu but relaunched %d times and typed %q", len(fake.launches), fake.pasted)
	}
}

func TestALocalSessionsPlanIsApprovedToAcceptEdits(t *testing.T) {
	s, fake, id := landingSession(t) // a folder of the user's: acceptEdits
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan = true })
	options := []string{"Yes, clear context and auto-accept edits", "Yes, auto-accept edits", "Yes, manually approve edits", "No, keep planning"}
	fake.pane = planMenu(options, 0)
	moveSelection(fake, options)
	if via, err := s.ApprovePlan(id); err != nil || via != ApprovedInMenu || fake.picked != options[1] {
		t.Fatalf("ApprovePlan = %q, %v, picked %q", via, err, fake.picked)
	}
}

// A menu without the build mode's option (a session launched before it could
// bypass), or one this agent doesn't read: approved as before, by prompt.
func TestAPlanMenuWithoutTheOptionIsApprovedByPrompt(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan, f.PermissionMode = true, claude.Bypass })
	options := []string{"Yes, clear context and auto-accept edits", "Yes, auto-accept edits", "No, keep planning"}
	fake.pane = planMenu(options, 0)
	fake.onKey = func(key string) string {
		if key == "Escape" {
			return composerPane
		}
		return ""
	}
	via, err := s.ApprovePlan(id)
	if err != nil || via != ApprovedByPrompt {
		t.Fatalf("ApprovePlan = %q, %v; want it approved by prompt", via, err)
	}
	if !slices.Equal(fake.keys, []string{"Escape"}) || !slices.Equal(fake.pasted, []string{PlanApproved}) {
		t.Errorf("keys %q, typed %q; want the menu closed and the approval sent", fake.keys, fake.pasted)
	}
	if got := fake.lastLaunch(); !launchedIn(got, "bypassPermissions") {
		t.Errorf("relaunch = %q, want build", got)
	}
}

func TestApprovingWithNoPlanWaitingSaysSo(t *testing.T) {
	s, _, id := landingSession(t)
	if _, err := s.ApprovePlan(id); !errors.Is(err, ErrNoPlanWaiting) {
		t.Errorf("ApprovePlan on a prompt box = %v, want ErrNoPlanWaiting", err)
	}
}

// Planning where it builds without asking, Claude is launched able to bypass,
// so its plan menu offers to go on that way.
func TestPlanningInABypassSessionCanApproveIntoBypass(t *testing.T) {
	s, _, id := runningSession(t, "")
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan, f.PermissionMode = true, claude.Bypass })
	if got := s.launchCommand(id, s.worktreePath(id), true); !launchedIn(got, "plan") || !slices.Contains(got, "--allow-dangerously-skip-permissions") {
		t.Errorf("launch = %q, want plan, able to bypass", got)
	}
	s.updateFacts(id, func(f *workspaceFacts) { f.PermissionMode = claude.AcceptEdits })
	if got := s.launchCommand(id, s.worktreePath(id), true); slices.Contains(got, "--allow-dangerously-skip-permissions") {
		t.Errorf("launch = %q: a session that asks first was made able to bypass", got)
	}
}

// Arrows pressed that never bring the selection to the option: the approval
// fails, rather than being taken for "not offered" and approved by prompt too.
func TestAPickThatCantReachItsOptionFailsAndSendsNothing(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan, f.PermissionMode = true, claude.Bypass })
	options := []string{"Yes, manually approve edits", "Yes, and switch to Bypass Permissions for this session", "No, keep planning"}
	fake.pane = planMenu(options, 0) // and the selection never moves
	if _, err := s.ApprovePlan(id); !errors.Is(err, ErrNotInterrupted) {
		t.Fatalf("ApprovePlan = %v, want ErrNotInterrupted", err)
	}
	if fake.pastes != 0 || slices.Contains(fake.keys, "Escape") {
		t.Errorf("fell back to the prompt: keys %q, typed %q", fake.keys, fake.pasted)
	}
}

// Approved in another tab: the session builds, and may show a question of
// its build's. Nothing is pressed into it, and no approval is pasted.
func TestAPlanApprovedElsewhereIsntApprovedAgain(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan = false })
	fake.pane = permissionPane
	if _, err := s.ApprovePlan(id); !errors.Is(err, ErrNoPlanWaiting) {
		t.Fatalf("over a permission question = %v, want ErrNoPlanWaiting", err)
	}
	fake.pane = "✶ Building… (esc to interrupt)"
	if _, err := s.ApprovePlan(id); !errors.Is(err, ErrNoPlanWaiting) {
		t.Fatalf("mid-build = %v, want ErrNoPlanWaiting", err)
	}
	if len(fake.keys) != 0 || fake.pastes != 0 {
		t.Errorf("keys %q, typed %q into a session already building", fake.keys, fake.pasted)
	}
}

// A prompt whose send gave up may still be in the box: /compact typed after
// it would send them as one prompt. Refused until that prompt has landed.
func TestACompactionWaitsOnAPromptStillInTheBox(t *testing.T) {
	s, fake, id := landingSession(t)
	fake.onEnter = func() string { return "✻ Compacting conversation… (esc to interrupt)" }
	s.sendLock(id).staged = &stagedPrompt{content: "fix the flaky test", baseline: s.userTurns(id), at: time.Now()}
	fake.pane = strings.Replace(composerPane, "❯ ", "❯ fix the flaky test", 1)
	if err := s.Compact(id, ""); !errors.Is(err, ErrPromptStaged) || fake.pastes != 0 {
		t.Fatalf("Compact = %v with %d pastes, want ErrPromptStaged and nothing typed", err, fake.pastes)
	}
	// Cleared in the terminal: the box is empty, and /compact goes, the
	// staged prompt forgotten.
	fake.pane = composerPane
	if err := s.Compact(id, ""); err != nil || !slices.Equal(fake.pasted, []string{"/compact"}) || s.sendLock(id).staged != nil {
		t.Fatalf("Compact = %v, typed %q", err, fake.pasted)
	}
	// Landed since (its turn recorded, its box empty): forgotten, and it goes.
	s.sendLock(id).staged = &stagedPrompt{content: "fix the flaky test", baseline: -1, at: time.Now()}
	fake.pane = composerPane // the last compaction over
	if err := s.Compact(id, ""); err != nil || s.sendLock(id).staged != nil {
		t.Fatalf("Compact after the prompt landed = %v", err)
	}
}

// Text typed into the box in the session's terminal, which no send staged, or
// a paste Claude shows by its placeholder: /compact would go as its tail.
func TestACompactionWaitsOnTextTypedIntoTheBox(t *testing.T) {
	s, fake, id := landingSession(t)
	for _, typed := range []string{"fix the bug", "[Pasted text #1 +12 lines]"} {
		fake.pane = strings.Replace(composerPane, "❯ ", "❯ "+typed, 1)
		if err := s.Compact(id, ""); !errors.Is(err, ErrPromptStaged) || fake.pastes != 0 {
			t.Fatalf("%q in the box: Compact = %v with %d pastes", typed, err, fake.pastes)
		}
	}
	// Claude's dim placeholder in an empty box is no text.
	fake.pane = strings.Replace(composerPane, "❯ ", "❯ \x1b[2mTry \"fix lint errors\"\x1b[22m", 1)
	fake.onEnter = func() string { return "✻ Compacting conversation… (esc to interrupt)" }
	if err := s.Compact(id, ""); err != nil {
		t.Fatalf("a placeholder in the box: Compact = %v", err)
	}
}

// Two Approves at once on a session without Claude's menu (Codex): the second
// finds the plan approved, under the session's locks, and sends nothing.
func TestTwoApprovesAtOnceApproveOnce(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan, f.Agent = true, AgentCodex })
	s.lookPath = func(string) (string, error) { return "/usr/bin/codex", nil }
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { _, err := s.ApprovePlan(id); errs <- err }()
	}
	answered := 0
	for i := 0; i < 2; i++ {
		if err := <-errs; errors.Is(err, ErrNoPlanWaiting) {
			answered++
		}
	}
	approvals := 0
	for _, text := range fake.pasted {
		if strings.HasSuffix(text, PlanApproved) {
			approvals++
		}
	}
	if answered != 1 || approvals != 1 {
		t.Errorf("%d approvals pasted, %d told it was answered; want one of each", approvals, answered)
	}
}

func TestThePromptBoxIsReadAloneAndAPasteByItsPlaceholder(t *testing.T) {
	inBox := func(text string) string { return strings.Replace(composerPane, "❯ ", "❯ "+text, 1) }
	// A long paste shows as Claude's placeholder, not as its text.
	if !boxHolds(inBox("[Pasted text #1 +12 lines]"), "A very long prompt\nover many lines") {
		t.Error("a pasted prompt's placeholder wasn't read as the prompt")
	}
	if !boxHolds(inBox("fix the flaky test"), "fix the flaky test") || boxHolds(composerPane, "fix the flaky test") {
		t.Error("the prompt in the box, or its absence, misread")
	}
	// A short prompt that a reply above, or the footer below, also says.
	pane := "⏺ Say yes and I'll go ahead.\n" + composerPane + "\n  yes · esc to interrupt"
	if boxHolds(pane, "yes") {
		t.Error("words outside the box were read as the prompt in it")
	}
	// A prompt echoed above (with ❯, under no rule) is not the box.
	if boxHolds("❯ yes\n⏺ Done.\n"+composerPane, "yes") {
		t.Error("an echoed prompt was read as the box")
	}
	// The real 2.1.304 prompt box, empty.
	if boxHolds(realPane(t, "plan-ready"), "Plan a small change") {
		t.Error("the real empty box was read as holding a prompt")
	}
}

// A plan answered elsewhere: the mode the session is in, as its footer says
// (the real panes), and the record brought in line with it.
func TestAnAnsweredPlansModeIsReadOffTheScreen(t *testing.T) {
	s, fake, id := landingSession(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Plan = true })
	fake.pane = realPane(t, "built") // "⏵⏵ bypass permissions on"
	if got := s.PlanAnsweredMode(id); got != ModeBuild {
		t.Errorf("building: mode = %q", got)
	}
	if f, _ := s.getFacts(id); f.Plan {
		t.Error("the record still says planning")
	}
	fake.pane = realPane(t, "plan-ready") // "⏸ plan mode on"
	if got := s.PlanAnsweredMode(id); got != ModePlan {
		t.Errorf("planning: mode = %q", got)
	}
	// A building session whose reply quotes the plan footer is building.
	fake.pane = "⏺ Press Shift+Tab until the footer says ⏸ plan mode on.\n" + realPane(t, "built")
	if got := s.PlanAnsweredMode(id); got != ModeBuild {
		t.Errorf("a reply quoting the footer: mode = %q, want build", got)
	}
}
