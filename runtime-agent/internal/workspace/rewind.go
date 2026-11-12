package workspace

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"runtime-agent/internal/conversation"
)

// Editing a sent message rewinds the chat's conversation to just before it:
// the message and everything after it are cut from the log, and the agent
// continues from there, in the same chat, when the edited prompt is sent.
// Files and git state are not rolled back.
//
// Claude continues its own session: its log is cut where the message began
// and Claude is launched on it again, by id. Codex can't be handed a rollout
// cut short, so a Codex chat continues as a new Codex conversation in the
// same chat: its log (Runtime's translation) is cut, its rollout put aside,
// and the edited prompt goes with a handoff of the conversation before it,
// as a fork's first prompt does.
//
// What was cut is kept beside the log (.rewound-<n>), never thrown away.

var (
	// ErrRewindBusy is an edit asked for while the agent works or waits on
	// an answer: cutting its log under it would lose what it is writing.
	ErrRewindBusy = errors.New("the agent is working: stop it before editing a message")
	// ErrRewindUnsupported is an edit of a message from before a chat
	// switched harnesses: that history is kept, not edited.
	ErrRewindUnsupported = errors.New("this computer's engine can't edit a sent message")
	// ErrNotAPrompt is an edit of a message that isn't one of the chat's
	// prompts (a reply, a tool's result, or one not in its log).
	ErrNotAPrompt = errors.New("that message isn't one of this chat's prompts")
)

// Rewound is where an edit cut a chat's log: at byte At, where the prompt
// UUID began, its Rewinds-th edit.
type Rewound struct {
	At      int64
	UUID    string
	Rewinds int
}

// Rewind cuts a chat's conversation back to just before its prompt uuid,
// for the edited prompt to be sent in its place. A running agent is
// relaunched on what is left; one that isn't is left for the next Start.
func (s *Service) Rewind(ctx context.Context, key, uuid string) (Rewound, error) {
	defer s.lockLifecycle(key)()
	f, ok := s.getFacts(key)
	if !ok {
		return Rewound{}, ErrUnknownWorkspace
	}
	if f.Harness != nil {
		return Rewound{}, fmt.Errorf("%w: messages in a chat that has switched harnesses are retained as history; send a follow-up instead", ErrRewindUnsupported)
	}
	// Held throughout, so no prompt lands between the check and the cut.
	lock := s.lockSend(key)
	defer lock.Unlock()
	base := context.WithoutCancel(ctx)
	checkCtx, cancel := context.WithTimeout(base, switchCheckTimeout)
	defer cancel()
	name := sessionName(key)
	running, err := s.tmux.SessionExists(checkCtx, name)
	if err != nil {
		return Rewound{}, fmt.Errorf("%w (%v)", ErrSessionUnchecked, err)
	}
	a := s.agentFor(key)
	if running {
		pane, err := s.tmux.CapturePane(checkCtx, name)
		if err != nil {
			return Rewound{}, fmt.Errorf("%w (its screen could not be read: %v)", ErrSessionUnchecked, err)
		}
		if a.isBusy(pane) || a.awaitsAnswer(pane) {
			return Rewound{}, ErrRewindBusy
		}
	}
	log := s.SessionLog(key)
	if log == "" {
		return Rewound{}, ErrNotAPrompt
	}
	cut, err := promptStart(log, uuid)
	if err != nil {
		return Rewound{}, err
	}
	codexChat := f.Agent == AgentCodex
	handoff := ""
	if codexChat && cut > 0 {
		handoff, err = s.editHandoffBefore(key, log, cut)
		if err != nil {
			return Rewound{}, err
		}
	}
	if !codexChat {
		// Launched again by id, on this log: never "the newest" in a folder
		// another chat's may be newer in.
		s.pinClaudeSession(key)
	}
	// The agent holds its log open: it goes before the cut, and the
	// conversation's collector with it, to be begun again on what is left.
	if running {
		stopCtx, cancelStop := context.WithTimeout(base, switchCheckTimeout)
		defer cancelStop()
		if err := s.tmux.KillSession(stopCtx, name); err != nil {
			return Rewound{}, fmt.Errorf("%w (its session could not be stopped: %v)", ErrSessionUnchecked, err)
		}
		for {
			alive, err := s.tmux.SessionExists(stopCtx, name)
			if err != nil {
				return Rewound{}, fmt.Errorf("%w (check stopped session: %v)", ErrSessionUnchecked, err)
			}
			if !alive {
				break
			}
			select {
			case <-stopCtx.Done():
				return Rewound{}, fmt.Errorf("%w (session did not stop)", ErrSessionUnchecked)
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	s.stopCodexTail(key)
	s.endSummary(key)
	s.summariesMu.Lock()
	delete(s.summaries, key)
	s.summariesMu.Unlock()

	rewinds := f.Rewinds + 1
	rolloutBackup := ""
	if codexChat && f.CodexRollout != "" {
		rolloutBackup = fmt.Sprintf("%s.rewound-%d", f.CodexRollout, rewinds)
		if err := os.Rename(f.CodexRollout, rolloutBackup); err != nil {
			return Rewound{}, fmt.Errorf("put the old rollout aside: %w", err)
		}
	}
	if err := cutLog(log, cut, rewinds); err != nil {
		if rolloutBackup != "" {
			if rollback := os.Rename(rolloutBackup, f.CodexRollout); rollback != nil {
				return Rewound{}, fmt.Errorf("%v; restore the rollout: %w", err, rollback)
			}
		}
		return Rewound{}, err
	}
	s.updateFacts(key, func(f *workspaceFacts) {
		f.Rewinds, f.RewoundAt, f.RewoundUUID = rewinds, cut, uuid
		if codexChat {
			f.CodexSessionID, f.CodexRollout, f.CodexPromptedAt = "", "", ""
			f.Handoff = handoff
		}
	})
	lock.staged = nil
	if running {
		relaunchCtx, cancelRelaunch := context.WithTimeout(base, switchRelaunchTimeout)
		defer cancelRelaunch()
		if _, err := s.relaunchHeld(relaunchCtx, key, "", s.SessionLog(key) != "", lock); err != nil {
			return Rewound{}, err
		}
	}
	return Rewound{At: cut, UUID: uuid, Rewinds: rewinds}, nil
}

// LogRewind is where a chat's log was last cut by an edit, and how many
// edits it has had: 0 for none, which a stream reads its log as before.
func (s *Service) LogRewind(key string) (rewinds int, at int64, uuid string) {
	f, _ := s.getFacts(key)
	return f.Rewinds, f.RewoundAt, f.RewoundUUID
}

// promptStart is where the prompt uuid begins in a conversation log: one of
// the user's, not a tool's result, Claude's own record, or a stop.
func promptStart(log, uuid string) (int64, error) {
	events, err := conversation.Read(log, 0)
	if err != nil {
		return 0, err
	}
	for _, ev := range events {
		msg := ev.Message
		if msg == nil || msg.UUID != uuid {
			continue
		}
		if msg.Role != "user" || msg.Meta || conversation.IsInterruption(msg) {
			return 0, ErrNotAPrompt
		}
		for _, block := range msg.Content {
			if block.Type == "text" {
				return ev.Start, nil
			}
		}
		return 0, ErrNotAPrompt
	}
	return 0, ErrNotAPrompt
}

// cutLog cuts a log at byte at, keeping what it cut beside it. A log cut to
// nothing is removed: an agent launched on an empty one has nothing to
// continue, and starts afresh as it would without.
func cutLog(log string, at int64, rewinds int) error {
	data, err := os.ReadFile(log)
	if err != nil {
		return err
	}
	if at > int64(len(data)) {
		return ErrNotAPrompt
	}
	if err := os.WriteFile(fmt.Sprintf("%s.rewound-%d", log, rewinds), data[at:], 0o600); err != nil {
		return fmt.Errorf("keep what the edit cut: %w", err)
	}
	if at == 0 {
		return os.Remove(log)
	}
	return os.Truncate(log, at)
}

// editHandoff is what a Codex chat's edited prompt goes with: the
// conversation before it, which its new Codex conversation hasn't had, as a
// transcript and its latest turns.
func (s *Service) editHandoff(key, log, sourceLog string, partial bool) (string, error) {
	parent, chatID := s.owner(key), MainChat
	if parent != key {
		chatID = strings.TrimPrefix(key, parent+"_")
	}
	path := s.handoffPath(parent, chatID+"-before-edit")
	turns, err := s.writeTranscriptPart(parent, log, "This chat before its edit", path, sourceLog, partial)
	if err != nil {
		return "", err
	}
	var note strings.Builder
	note.WriteString(handoffOpen + "\n")
	note.WriteString("The user edited one of their messages in this chat: the conversation before it carries on below, and what came after it is gone. Files and git state were not rolled back, so they may show work from after it.\n")
	fmt.Fprintf(&note, "The conversation before the edit is in %s (tool calls named, not quoted; secrets masked).\n", path)
	if recent := recentTurns(turns, handoffRecentTurns, handoffRecentBytes); recent != "" {
		note.WriteString("Its latest turns:\n\n" + s.masker()(recent))
	}
	note.WriteString(handoffClose + "\n\n")
	return note.String(), nil
}

// Prepare the Codex handoff before making any destructive change. Only the
// bounded tail before the cut is copied; the original log stays untouched.
func (s *Service) editHandoffBefore(key, log string, cut int64) (string, error) {
	source, err := os.Open(log)
	if err != nil {
		return "", err
	}
	defer source.Close()
	prefix, err := os.CreateTemp("", "outrunner-edit-prefix-*.jsonl")
	if err != nil {
		return "", err
	}
	defer os.Remove(prefix.Name())
	start := int64(0)
	if cut > handoffReadLimit {
		start = cut - handoffReadLimit
	}
	partial := start > 0
	if partial {
		var previous [1]byte
		if _, err := source.ReadAt(previous[:], start-1); err != nil {
			prefix.Close()
			return "", err
		}
		if previous[0] != '\n' {
			fragment, err := bufio.NewReader(io.NewSectionReader(source, start, cut-start)).ReadBytes('\n')
			if err != nil && err != io.EOF {
				prefix.Close()
				return "", err
			}
			start += int64(len(fragment))
		}
	}
	_, copyErr := io.Copy(prefix, io.NewSectionReader(source, start, cut-start))
	closeErr := prefix.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	return s.editHandoff(key, prefix.Name(), log, partial)
}
