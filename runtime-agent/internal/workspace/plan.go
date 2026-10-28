package workspace

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"runtime-agent/internal/claude"
)

// A session plans or builds. In plan mode its agent reads and proposes a
// plan without changing anything: Claude launched with --permission-mode plan,
// which ends its plan with ExitPlanMode and a menu asking to approve it; Codex
// launched read-only, told with each prompt that a plan is wanted (it has no
// plan step of its own). Building is the session's own mode, whatever its
// create asked for (bypassPermissions on a Runtime Computer).
//
// The mode goes with each prompt rather than being switched on its own, so a
// prompt queued in one mode runs in it whenever it is sent. Claude reads its
// mode at launch, so a switch relaunches the session with its conversation
// continued, as a model switch does.
const (
	ModePlan  = "plan"
	ModeBuild = "build"
)

// Prompt is a prompt for a session: in Mode ("plan", "build"; empty leaves
// the session in its mode), and Dismiss closes the menu the agent shows (its
// plan, waiting on approval) first, so the prompt answers it.
type Prompt struct {
	Content string
	Mode    string
	Dismiss bool
	// RequirePlan sends it only while the session plans (ErrNoPlanWaiting
	// otherwise), as decided under the session's locks: a plan's approval,
	// which a second Approve mustn't paste into the build the first began.
	RequirePlan bool
}

// ErrModeUnsupported is plan mode asked of an engine that runs its sessions
// itself (jcode).
var ErrModeUnsupported = errors.New("this engine can't run a session in plan mode")

// switchesMode reports whether a prompt in mode would put the session in
// another mode than it is in.
func (s *Service) switchesMode(workspaceID, mode string) bool {
	if mode == "" {
		return false
	}
	f, _ := s.getFacts(workspaceID)
	return f.Plan != (mode == ModePlan)
}

// switchModeHeld puts the session in plan mode, or takes it out, for a caller
// holding its lifecycle and send locks: recorded, then a running session is
// relaunched in it, its conversation continued. Refused mid-turn, which the
// relaunch would cut off; a relaunch that fails puts the session back as it
// was, as a failed model switch does.
func (s *Service) switchModeHeld(workspaceID string, plan bool, lock *sendState) error {
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return ErrUnknownWorkspace
	}
	ctx, cancel := context.WithTimeout(context.Background(), switchCheckTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	running, err := s.tmux.SessionExists(ctx, name)
	if err != nil {
		return fmt.Errorf("%w (%v)", ErrSessionUnchecked, err)
	}
	if running {
		pane, err := s.tmux.CapturePane(ctx, name)
		if err != nil {
			return fmt.Errorf("%w (its screen could not be read: %v)", ErrSessionUnchecked, err)
		}
		if s.agentFor(workspaceID).isBusy(pane) {
			return ErrModeBusy
		}
	}
	s.updateFacts(workspaceID, func(f *workspaceFacts) { f.Plan = plan })
	if !running {
		return nil // the next Start launches in it
	}
	resume := s.SessionLog(workspaceID) != ""
	relaunchCtx, cancelRelaunch := context.WithTimeout(context.Background(), switchRelaunchTimeout)
	defer cancelRelaunch()
	if _, err := s.relaunchHeld(relaunchCtx, workspaceID, "", resume, lock); err != nil {
		s.updateFacts(workspaceID, func(now *workspaceFacts) { now.Plan = f.Plan })
		restoreCtx, cancelRestore := context.WithTimeout(context.Background(), switchRelaunchTimeout)
		defer cancelRestore()
		if _, restoreErr := s.relaunchHeld(restoreCtx, workspaceID, "", resume, lock); restoreErr != nil {
			return fmt.Errorf("%w; restarting it as it was failed too: %v", err, restoreErr)
		}
		return err
	}
	return nil
}

// ErrModeBusy is a prompt in another mode sent while the agent is mid-turn:
// the relaunch into that mode would cut the turn off.
var ErrModeBusy = errors.New("the agent is mid-turn; send it in this mode once it has finished")

// dismissHeld closes the menu the agent shows in place of its prompt box,
// as Escape does: Claude's plan waiting on approval (or a question), which
// Escape declines, so the prompt after it says what to do instead. A session
// showing its prompt box, or mid-turn, is left alone: Escape there would stop
// the turn. For a caller holding the send lock.
func (s *Service) dismissHeld(workspaceID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), interruptTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	a := s.agentFor(workspaceID)
	showing := func() (bool, error) {
		pane, err := s.tmux.CapturePane(ctx, name)
		if err != nil {
			return false, err
		}
		return a.awaitsAnswer(pane), nil
	}
	if menu, err := showing(); err != nil || !menu {
		return nil // nothing to close, or nothing known: the send says why
	}
	if err := s.tmux.SendKey(ctx, name, "Escape"); err != nil {
		return fmt.Errorf("%w (%v)", ErrNotInterrupted, err)
	}
	deadline := time.Now().Add(interruptSettle)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ErrNotInterrupted
		case <-time.After(interruptPollEvery):
		}
		if menu, err := showing(); err == nil && !menu {
			return nil
		}
	}
	return ErrNotInterrupted
}

// ErrCompactUnsupported is a compaction asked of an engine that runs its
// sessions itself (jcode).
var ErrCompactUnsupported = errors.New("this engine can't compact a session")

// compactAttempts bounds how long a compaction is waited on to start: it
// starts at once, and runs for as long as the summary takes.
const compactAttempts = 10

// Compact compacts a session's conversation, as /compact does in its
// terminal (Claude Code's and Codex's both): the agent summarizes it and goes
// on from the summary, in the same session. It returns once the compaction
// is under way (the agent shows its turn running, or has recorded it); the
// stream shows it once it is written. Refused mid-turn, and in a menu, where
// the command would be read as a choice.
func (s *Service) Compact(workspaceID, instructions string) error {
	if s.jcode != nil {
		return ErrCompactUnsupported
	}
	if _, ok := s.getFacts(workspaceID); !ok {
		return ErrUnknownWorkspace
	}
	lock := s.sendLock(workspaceID)
	lock.Lock()
	defer lock.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	a := s.agentFor(workspaceID)
	pane, err := s.tmux.CapturePane(ctx, name)
	switch {
	case err != nil:
		return fmt.Errorf("%w (its screen could not be read: %v)", ErrSessionUnchecked, err)
	case a.awaitsAnswer(pane):
		return errAwaitsAnswer
	case a.isBusy(pane):
		return ErrCompactBusy
	}
	// A prompt whose send gave up may still be in the prompt box: /compact
	// typed after it would go as that prompt's tail, an ordinary turn, and
	// nothing would compact. The screen decides, not the bookkeeping alone: a
	// prompt that landed since, or was cleared in the terminal, is forgotten.
	if st := lock.staged; st != nil {
		if s.userTurns(workspaceID) <= st.baseline && boxHolds(pane, st.content) {
			return ErrPromptStaged
		}
		lock.staged = nil
	}
	command := "/compact"
	// Codex's /compact takes no instructions: typed after it, they would go
	// as a prompt of their own, and the compaction never happen. It compacts
	// as it would without them.
	if f, _ := s.getFacts(workspaceID); f.Agent == AgentCodex {
		instructions = ""
	}
	if instructions = strings.TrimSpace(instructions); instructions != "" {
		command += " " + instructions
	}
	before := s.userTurns(workspaceID)
	if err := s.tmux.Paste(ctx, name, command); err != nil {
		return err
	}
	for attempt := 0; attempt < compactAttempts && ctx.Err() == nil; attempt++ {
		if err := s.tmux.SubmitEnter(ctx, name); err != nil {
			return err
		}
		time.Sleep(submitPollInterval)
		if pane, err := s.tmux.CapturePane(ctx, name); err == nil && a.isBusy(pane) {
			return nil
		}
		if s.userTurns(workspaceID) > before {
			return nil // over already: a short conversation compacts quickly
		}
	}
	return errors.New("the compaction didn't start; try again")
}

// ErrPromptStaged is a compaction asked for while the prompt box still holds
// a prompt whose send gave up. Sent or cleared in the session's terminal, it
// goes: a resend from the page long after would be typed a second time.
var ErrPromptStaged = errors.New("a message that didn't go is still in the prompt box: send it or clear it in the session's terminal, then compact")

// boxHolds reports whether the agent's prompt box shows content: the start of
// its first line, spaces collapsed, or, for a paste too long to show,
// Claude's placeholder for it ("[Pasted text #1 +12 lines]"). The box alone,
// not the screen's last lines, where a short prompt ("yes") could match a
// reply or the footer.
func boxHolds(pane, content string) bool {
	box := strings.Join(promptBoxLines(pane), " ")
	if strings.Contains(box, "[Pasted text #") {
		return true
	}
	first := strings.Join(strings.Fields(strings.SplitN(strings.TrimSpace(content), "\n", 2)[0]), " ")
	if r := []rune(first); len(r) > 40 {
		first = string(r[:40])
	}
	return first != "" && strings.Contains(strings.Join(strings.Fields(box), " "), first)
}

// promptBoxLines is the agent's prompt box, its lines as the pane shows them: from
// Claude's ❯ under a rule (prompts echoed above with ❯ are under none) to the
// rule below, or from Codex's › to its footer; none where it shows no box.
func promptBoxLines(pane string) []string {
	lines := nonBlankLines(pane)
	start := -1
	for i, line := range lines {
		claudes := (strings.HasPrefix(line, "❯") || strings.HasPrefix(line, ">")) && i > 0 && isRule(lines[i-1])
		if claudes || strings.HasPrefix(line, "›") {
			start = i
		}
	}
	if start < 0 {
		return nil
	}
	box := []string{lines[start]}
	for _, line := range lines[start+1:] {
		if isRule(line) || !strings.HasPrefix(line, "  ") || strings.Contains(line, " · ") {
			break
		}
		box = append(box, line)
	}
	return box
}

// ErrCompactBusy is a compaction asked for mid-turn.
var ErrCompactBusy = errors.New("the agent is mid-turn; compact once it has finished")

// PlanApproved is what a plan approved without Claude's own menu is answered
// with (Codex's, or a Claude whose menu isn't the one this agent knows), in
// build mode.
const PlanApproved = "The plan is approved. Go ahead and implement it."

// PlanAnsweredMode is the mode a session is in whose plan was answered
// elsewhere (another tab's Approve, its terminal): Claude's footer says it
// ("⏸ plan mode on", "⏵⏵ bypass permissions on", testdata/claude-2.1.304),
// else the agent's record. The record is brought in line with it, so the next
// prompt in build mode doesn't relaunch a session that builds already.
func (s *Service) PlanAnsweredMode(workspaceID string) string {
	f, _ := s.getFacts(workspaceID)
	mode := ModeBuild
	if f.Plan {
		mode = ModePlan
	}
	if s.jcode == nil && f.Agent != AgentCodex {
		ctx, cancel := context.WithTimeout(context.Background(), switchCheckTimeout)
		defer cancel()
		if pane, err := s.tmux.CapturePane(ctx, sessionName(workspaceID)); err == nil {
			switch a := s.agentFor(workspaceID); {
			case strings.Contains(pane, "plan mode on"):
				mode = ModePlan
			case a.isBusy(pane) || isComposer(pane):
				mode = ModeBuild // at work or at its prompt box, and not planning
			}
		}
	}
	s.updateFacts(workspaceID, func(f *workspaceFacts) { f.Plan = mode == ModePlan })
	return mode
}

// Approved plans: how ApprovePlan answered.
const (
	// ApprovedInMenu is Claude's own plan menu, its option for the session's
	// build mode picked: Claude goes on in that mode, in the same turn.
	ApprovedInMenu = "menu"
	// ApprovedByPrompt is the menu closed (if any) and PlanApproved sent in
	// build mode, the session relaunched into it.
	ApprovedByPrompt = "prompt"
)

// planMenuQuestion is how Claude Code's plan approval asks (2.1.304: "Claude
// has written up a plan and is ready to execute. Would you like to proceed?").
const planMenuQuestion = "Would you like to proceed?"

// planChoice is a numbered option of Claude's menu under its selection.
var planChoice = regexp.MustCompile(`❯\s*\d+\.\s`)

// ErrNoPlanWaiting is an approval asked of a session that isn't waiting on
// one: its plan was answered already (in its terminal, or another tab).
var ErrNoPlanWaiting = errors.New("the agent isn't waiting on a plan any more")

// planOption picks the option of Claude's plan menu that goes on in mode, by
// its label in Claude Code 2.1.304: "Yes, and switch to Bypass Permissions
// for this session" (offered when the session was launched able to bypass),
// "Yes, auto-accept edits", "Yes, manually approve edits". Never one that
// also clears the context ("Yes, clear context and …"): the conversation the
// plan came from is the one to build in.
func planOption(mode claude.PermissionMode) func(line string) bool {
	return func(line string) bool {
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "yes") || strings.Contains(lower, "clear context") {
			return false
		}
		switch mode {
		case claude.Bypass:
			return strings.Contains(lower, "bypass permissions")
		case claude.AcceptEdits:
			return strings.Contains(lower, "yes, auto-accept edits")
		default:
			return strings.Contains(lower, "yes, manually approve edits")
		}
	}
}

// ApprovePlan approves the plan a session's agent is waiting on: through
// Claude's own menu where it shows the option for the session's build mode,
// so Claude goes on in the same turn, in that mode, with nothing typed; else
// (Codex, which has no such menu, or a menu this agent doesn't read) as a
// prompt in build mode, the menu closed first. Either way the session is out
// of plan mode after.
func (s *Service) ApprovePlan(workspaceID string) (string, error) {
	if s.jcode != nil {
		return "", ErrModeUnsupported
	}
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return "", ErrUnknownWorkspace
	}
	if f.Agent != AgentCodex {
		unlock := s.lockLifecycle(workspaceID)
		lock := s.sendLock(workspaceID)
		lock.Lock()
		picked, err := s.pickPlanOptionHeld(workspaceID)
		if picked {
			s.updateFacts(workspaceID, func(f *workspaceFacts) { f.Plan = false })
		}
		lock.Unlock()
		unlock()
		if err != nil || picked {
			return ApprovedInMenu, err
		}
	}
	// Only while the session still plans, decided under its locks: answered
	// already (another tab's Approve), the prompt's path would press Escape
	// into whatever the build shows (a permission question, declined) and
	// paste an approval into its turn.
	err := s.SendPrompt(workspaceID, Prompt{Content: PlanApproved, Mode: ModeBuild, Dismiss: f.Agent != AgentCodex, RequirePlan: true})
	return ApprovedByPrompt, err
}

// pickPlanOptionHeld picks the build mode's option in Claude's plan menu, as
// the arrows and Enter do, for a caller holding the send lock. False, and
// nothing pressed, where the screen shows another menu or doesn't offer the
// option; ErrNoPlanWaiting where it shows no plan (its prompt box, or a turn
// under way); another error where keys were pressed but the pick couldn't be
// seen to land.
func (s *Service) pickPlanOptionHeld(workspaceID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), interruptTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	pane, err := s.tmux.CapturePane(ctx, name)
	if err != nil {
		return false, fmt.Errorf("%w (its screen could not be read: %v)", ErrSessionUnchecked, err)
	}
	a := s.agentFor(workspaceID)
	// At work: a pick that landed (another tab's, or this one's not seen to
	// land in time) and Claude building. The plan menu never shows busy.
	if a.isBusy(pane) {
		return false, ErrNoPlanWaiting
	}
	if !strings.Contains(pane, planMenuQuestion) {
		if a.awaitsAnswer(pane) {
			return false, nil // some other menu: the prompt's path closes it
		}
		return false, ErrNoPlanWaiting
	}
	want := planOption(s.buildMode(workspaceID))
	// The menu's own selection, "❯ 1. …": a prompt echoed above the menu
	// starts with ❯ too.
	selected := planChoice.MatchString
	// A menu of a few options: never more presses than it has lines.
	for step := 0; step < 12 && ctx.Err() == nil; step++ {
		key := keyToward(pane, selected, want)
		if key == "" {
			if step == 0 {
				return false, nil // not offered: approve by prompt instead
			}
			return false, fmt.Errorf("%w (the plan menu changed while its option was picked)", ErrNotInterrupted)
		}
		if err := s.tmux.SendKey(ctx, name, key); err != nil {
			return false, err
		}
		if key == "Enter" {
			// Picked: the menu goes as Claude takes it up.
			deadline := time.Now().Add(interruptSettle)
			for time.Now().Before(deadline) {
				time.Sleep(interruptPollEvery)
				if pane, err := s.tmux.CapturePane(ctx, name); err == nil && !strings.Contains(pane, planMenuQuestion) {
					return true, nil
				}
			}
			return false, fmt.Errorf("%w (the plan menu stayed up after its option was picked)", ErrNotInterrupted)
		}
		time.Sleep(interruptPollEvery)
		if pane, err = s.tmux.CapturePane(ctx, name); err != nil {
			return false, err
		}
	}
	// Keys were pressed: never "not offered", which would approve by prompt
	// as well. The approval fails, for the user to see and try again.
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return false, fmt.Errorf("%w (the plan menu's option couldn't be reached)", ErrNotInterrupted)
}
