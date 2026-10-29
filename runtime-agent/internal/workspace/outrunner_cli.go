package workspace

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"runtime-agent/internal/gitcred"
)

// On a Runtime Computer the sessions have `outrunner` on their PATH: this
// binary's copy of the CLI (package cli), for `outrunner media upload` and
// `outrunner media gif`, how a session shows its work in a pull request. An
// upload goes through this agent, as the upload_media tool's does, so the
// command finds it under Root (OUTRUNNER_BOX_ROOT), and says which session it
// is with the id each session is launched with (OUTRUNNER_SESSION_ID) and its
// ask token. Only a box the control plane launched gets it: on the desktop
// app's Mac it would stand in front of the user's own `outrunner`.

// outrunnerCLIPath is the `outrunner` the sessions run: a script in the gh
// wrapper's folder, first on their PATH.
func (s *Service) outrunnerCLIPath() string { return filepath.Join(s.gitBinDir(), "outrunner") }

// OutrunnerCLIScript is the script: this binary's `outrunner` command, told
// where the agent's files are.
func OutrunnerCLIScript(executable, root string) string {
	return "#!/bin/sh\n" +
		"OUTRUNNER_BOX_ROOT=" + gitcred.ShellQuote(root) + "; export OUTRUNNER_BOX_ROOT\n" +
		"exec " + gitcred.ShellQuote(executable) + ` outrunner "$@"` + "\n"
}

// UseOutrunnerCLI puts `outrunner` on the sessions' PATH and has each launch
// say which session it is. Called once at start, after RelayExecutable is
// known and before the environment is handed out.
func (s *Service) UseOutrunnerCLI() error {
	if s.RelayExecutable == "" {
		return errors.New("no executable for the outrunner command")
	}
	if err := os.MkdirAll(s.gitBinDir(), 0o755); err != nil {
		return err
	}
	path := s.outrunnerCLIPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(OutrunnerCLIScript(s.RelayExecutable, s.Root)), 0o755); err != nil {
		return err
	}
	// As the gh wrapper: executable whatever the umask, or an earlier file's
	// mode.
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	s.env = withPathFirst(s.env, s.gitBinDir())
	s.outrunnerCLI = true
	return nil
}

// withPathFirst is env with dir first on its PATH, once.
func withPathFirst(env []string, dir string) []string {
	out := make([]string, 0, len(env)+1)
	path := ""
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "PATH="); ok {
			path = value
			continue
		}
		out = append(out, entry)
	}
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	dirs := slices.DeleteFunc(filepath.SplitList(path), func(d string) bool { return filepath.Clean(d) == dir })
	return append(out, "PATH="+strings.Join(append([]string{dir}, dirs...), string(os.PathListSeparator)))
}

// withSessionID has a launch run with its session's id, for `outrunner media
// upload` to say which session it uploads for, and makes sure the session
// has the ask token it proves that with: a Codex session, which has no ask
// relay, still uploads. Unchanged where the command isn't on the PATH.
func (s *Service) withSessionID(workspaceID string, argv []string) []string {
	if !s.outrunnerCLI {
		return argv
	}
	if _, err := s.askToken(workspaceID); err != nil {
		log.Printf("workspace %s: `outrunner media upload` can't prove the session (token: %v)", workspaceID, err)
	}
	return append([]string{"env", "OUTRUNNER_SESSION_ID=" + workspaceID}, argv...)
}
