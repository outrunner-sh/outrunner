package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"runtime-agent/internal/protocol"
)

// Claude Code stops to ask before anything its permission mode doesn't allow
// on its own: in acceptEdits (a session on a Mac), a shell command it can't
// check, a page to fetch. It asks in its terminal, and nothing reaches the
// conversation log until it is answered, so the chat would only show Claude
// "working". These read the question off the pane, for the chat to show, and
// answer it with the key its option names.
//
// The prompt, as Claude Code 2.1 draws it (a box under a rule, wording and
// separators vary by version and tool):
//
//	─────────────────────────────
//	 Bash command
//	 Tip: auto mode handles these prompts for you …
//	 Print contents of a.txt and b.txt
//	╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//	 for f in a.txt b.txt; do cat "$f"; done
//	╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//	 A variable in this command can't be checked before it runs
//	 Do you want to proceed?
//	 ❯ 1. Yes
//	   2. Yes, and switch to auto mode · auto mode handles these prompts for you
//	   3. No
//	 Esc to cancel · Tab to amend

// ErrNoPrompt answers a choice made when no prompt waits, or a different one
// does than the one chosen on: an answer is only ever for what was shown.
var ErrNoPrompt = errors.New("Claude isn't waiting on that question any more")

var (
	promptQuestion = regexp.MustCompile(`^(?:Do you want|Would you like) .+\?$`)
	promptOption   = regexp.MustCompile(`^(?:❯\s*)?([1-9])\.\s+(.+?)\s*$`)
)

// parsePermissionPrompt reads the prompt Claude Code is waiting on from its
// pane; nil when there is none: the prompt box, or anything else, showing.
func parsePermissionPrompt(pane string) *protocol.PermissionPrompt {
	// The prompt box is hidden while a prompt waits: with it showing, a
	// question and a numbered list above it are Claude's own reply.
	if isComposer(pane) {
		return nil
	}
	lines := strings.Split(pane, "\n")
	question := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if promptQuestion.MatchString(strings.TrimSpace(lines[i])) {
			question = i
			break
		}
	}
	if question < 0 {
		return nil
	}
	p := &protocol.PermissionPrompt{Question: strings.TrimSpace(lines[question]), Detail: []string{}}
	for _, line := range lines[question+1:] {
		text := strings.TrimSpace(line)
		if text == "" {
			continue
		}
		m := promptOption.FindStringSubmatch(text)
		if m == nil {
			break
		}
		label, hint, _ := strings.Cut(m[2], " · ")
		p.Options = append(p.Options, protocol.PromptOption{Key: m[1], Label: strings.TrimSpace(label), Hint: strings.TrimSpace(hint)})
	}
	if len(p.Options) < 2 {
		return nil
	}

	// The box starts under the last rule above the question, which spans the
	// pane; its first line names what it asks about.
	start, width := 0, 0
	for i := question - 1; i >= 0; i-- {
		if isRule(lines[i]) {
			start, width = i+1, len([]rune(strings.TrimRight(lines[i], " ")))
			break
		}
	}
	var code []string
	inCode, inTip := false, false
	previous := "" // the last line of text, as drawn
	for _, line := range lines[start:question] {
		text := strings.TrimSpace(line)
		// Claude Code wraps its text at the pane's width itself: a line whose
		// first word would have fitted on the one before goes on its own.
		continues := previous != "" && wrapsOnto(previous, text, width)
		switch {
		case text == "":
			previous = ""
			continue
		case isDashedRule(text):
			inCode = !inCode
		case strings.HasPrefix(text, "│"):
			code = append(code, strings.TrimSpace(strings.TrimPrefix(text, "│")))
		case inCode:
			code = append(code, text)
		case continues && inTip:
		case continues && len(p.Detail) > 0:
			p.Detail[len(p.Detail)-1] += " " + text
		case p.Title == "":
			p.Title = text
		case strings.HasPrefix(text, "Tip:"):
			// Claude Code's advice to the terminal's user, not about this.
			inTip = true
		default:
			inTip = false
			p.Detail = append(p.Detail, text)
		}
		previous = strings.TrimRight(line, " ")
		if inCode || strings.HasPrefix(text, "│") || isDashedRule(text) {
			previous = ""
		}
	}
	p.Code = strings.Join(code, "\n")
	p.ID = promptID(p)
	return p
}

// wrapsOnto reports whether text is the rest of the line before it, wrapped:
// its first word would not have fitted after it in a pane width wide.
func wrapsOnto(previous, text string, width int) bool {
	if width == 0 {
		return false
	}
	first, _, _ := strings.Cut(text, " ")
	return len([]rune(previous))+1+len([]rune(first)) > width
}

// isDashedRule is the dashed line Claude Code draws around a command.
func isDashedRule(text string) bool {
	return len([]rune(text)) >= 10 && strings.Trim(text, "╌┄-") == ""
}

// promptID names a prompt by everything shown of it, so an answer meant for
// one never lands on another that took its place.
func promptID(p *protocol.PermissionPrompt) string {
	h := sha256.New()
	for _, part := range append([]string{p.Title, p.Code, p.Question}, p.Detail...) {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	for _, o := range p.Options {
		h.Write([]byte(o.Key + o.Label))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// PermissionPrompt is the question a workspace's Claude is waiting on, or nil.
func (s *Service) PermissionPrompt(ctx context.Context, workspaceID string) (*protocol.PermissionPrompt, error) {
	name := sessionName(workspaceID)
	if s.jcode != nil || !s.tmux.HasSession(ctx, name) {
		return nil, nil
	}
	pane, err := s.tmux.CapturePaneJoined(ctx, name)
	if err != nil {
		return nil, err
	}
	return parsePermissionPrompt(pane), nil
}

// AnswerPrompt picks an option of the prompt Claude is waiting on, by its key,
// if that prompt (id) is still the one waiting: otherwise ErrNoPrompt, and
// nothing is typed. A digit typed into Claude's prompt box would be a message.
func (s *Service) AnswerPrompt(ctx context.Context, workspaceID string, req protocol.AnswerPromptRequest) error {
	// Never between the keys of a message being sent.
	lock := s.sendLock(workspaceID)
	lock.Lock()
	defer lock.Unlock()
	p, err := s.PermissionPrompt(ctx, workspaceID)
	if err != nil {
		return err
	}
	if p == nil || p.ID != req.ID {
		return ErrNoPrompt
	}
	for _, o := range p.Options {
		if o.Key == req.Key {
			return s.tmux.SendKey(ctx, sessionName(workspaceID), o.Key)
		}
	}
	return ErrNoPrompt
}
