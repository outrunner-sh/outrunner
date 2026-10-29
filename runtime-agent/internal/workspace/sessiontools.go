package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"runtime-agent/internal/sessiontools"
)

// A session's own commands for reaching Outrunner (package sessiontools):
// `outrunner-session` on its PATH, beside the gh wrapper, where the control
// plane gave this agent the means to reach it (UseGitCredential). Each call
// comes to this agent on the loopback and goes on to the control plane,
// signed with the box's secret, naming its session; the control plane checks
// the session is this box's and acts as its user.

// writeSessionToolsWrapper puts the command in gitBinDir.
func (s *Service) writeSessionToolsWrapper() error {
	if err := os.MkdirAll(s.gitBinDir(), 0o755); err != nil {
		return err
	}
	path := filepath.Join(s.gitBinDir(), sessiontools.CommandName)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(sessiontools.Wrapper(s.RelayExecutable, s.Root)), 0o755); err != nil {
		return err
	}
	// As the gh wrapper: the umask, or an earlier file's mode, mustn't leave
	// it unrunnable.
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	s.sessionTools = true
	return nil
}

// SessionToolsEnabled reports whether the sessions have the command.
func (s *Service) SessionToolsEnabled() bool { return s.sessionTools && s.controlPlane != nil }

// ErrNoSessionTools is a call on a computer whose sessions have no commands.
var ErrNoSessionTools = errors.New("this computer can't reach Outrunner from a session")

// SessionTool passes a session's call on to the control plane, and returns
// its status and answer as it gave them.
func (s *Service) SessionTool(ctx context.Context, call sessiontools.Call) (int, sessiontools.Answer, error) {
	if !s.SessionToolsEnabled() {
		return 0, sessiontools.Answer{}, ErrNoSessionTools
	}
	if _, ok := s.getFacts(call.Workspace); !ok {
		return 0, sessiontools.Answer{}, ErrUnknownWorkspace
	}
	body, err := json.Marshal(call)
	if err != nil {
		return 0, sessiontools.Answer{}, err
	}
	status, data, err := s.controlPlane.Post(ctx, sessiontools.Route, sessiontools.Purpose, body)
	if err != nil {
		return 0, sessiontools.Answer{}, fmt.Errorf("couldn't reach Outrunner: %w", err)
	}
	var answer sessiontools.Answer
	if json.Unmarshal(data, &answer) != nil || (answer.Text == "" && answer.Error == "") {
		answer = sessiontools.Answer{Error: fmt.Sprintf("Outrunner answered %d", status)}
	}
	return status, answer, nil
}

// sessionEnv names the session to its own commands, in its launch's env.
func sessionEnv(env []string, workspaceID string) []string {
	return append(append([]string(nil), env...), sessiontools.SessionEnv+"="+workspaceID)
}

// sessionToolsNote tells the agent about the commands, in its orientation,
// where it has them.
func (s *Service) sessionToolsNote() string {
	if !s.SessionToolsEnabled() {
		return ""
	}
	return "# Learnings\n\n" +
		"When the user gives a lasting instruction about how to work (\"from now on…\", \"always…\", \"never…\", \"moving forward…\"), follow it, and also suggest saving it as a learning, which every future session loads once the user accepts it:\n\n" +
		"    " + sessiontools.CommandName + " suggest-learning --title \"<a short title in the user's terms>\" \"<the instruction>\"\n\n" +
		"Restate only what the user actually said, as a direct instruction, usually one to three lines; leave out anything an agent could work out on its own. " +
		"Add --org when the user means it for their whole team: the org's admins accept it. " +
		"Only suggest for explicit, lasting instructions, never for one-off requests. " +
		"Tell the user it's waiting for them in Settings → Learnings, and never say it's saved: they accept or dismiss it."
}
