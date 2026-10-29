package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/dotenv"
)

// A session's environment is its project's: the variables (a Conductor
// project's), the files a checkout keeps out of git (its .env files), and the
// setup script its sessions start with. The variables are kept like a
// session's credential (keyFiles): owner-only under $ROOT/env, sourced by its
// launch before its credential, and masked in the terminal. The files are
// kept owner-only under $ROOT/envroot/<id>, laid out as in the checkout they
// came from: the setup script finds them at $CONDUCTOR_ROOT_PATH, as it did
// on the Mac, and a session with no setup script gets a copy of each in its
// worktree. The setup script runs once in the worktree, beside the session,
// its output in $ROOT/logs/setup-<id>.log.

// ErrInvalidEnvironment is an environment a session can't take.
var ErrInvalidEnvironment = errors.New("invalid environment")

// envName is a variable a shell can export.
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// reservedEnv are the variables a project's environment may not set: the
// session's own identity, credentials and the agent's.
var reservedEnv = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "PWD": true, "TMPDIR": true,
	"LANG": true, "TERM": true, "TMUX": true, "TMUX_PANE": true,
	"CLAUDE_CODE_OAUTH_TOKEN": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true, "ANTHROPIC_BASE_URL": true,
	"ANTHROPIC_MODEL": true, "OPENAI_API_KEY": true, "CODEX_HOME": true, "DISABLE_AUTOUPDATER": true,
}

// maxEnvBytes bounds a session's environment file.
const maxEnvBytes = 256 << 10

// maxSetupBytes bounds a setup script.
const maxSetupBytes = 64 << 10

// maxEnvFiles and maxEnvFilesBytes bound a session's files.
const (
	maxEnvFiles      = 100
	maxEnvFilesBytes = 1 << 20
)

// maxInstructionsBytes bounds a project's instructions.
const maxInstructionsBytes = 16 << 10

// setupTimeout bounds a setup script's run.
const setupTimeout = 30 * time.Minute

// ValidEnvName accepts a variable a project's environment may set.
func ValidEnvName(name string) bool {
	return envName.MatchString(name) && !reservedEnv[name] && !strings.HasPrefix(name, "RUNTIME_")
}

// envFiles holds each session's environment: every export in one is a secret.
func (s *Service) envFiles() keyFiles {
	return keyFiles{dir: filepath.Join(s.Root, "env")}
}

// envRoot is where a session's files are kept, as its checkout had them.
func (s *Service) envRoot(workspaceID string) string {
	return filepath.Join(s.Root, "envroot", workspaceID)
}

func (s *Service) setupPath(workspaceID string) string {
	return filepath.Join(s.Root, "setup", workspaceID+".sh")
}

func (s *Service) instructionsPath(workspaceID string) string {
	return filepath.Join(s.Root, "instructions", workspaceID+".md")
}

// ValidInstructions accepts instructions a session can take, so a caller can
// check them before changing anything else.
func ValidInstructions(instructions string) error {
	instructions = strings.TrimSpace(instructions)
	if len(instructions) > maxInstructionsBytes || strings.ContainsRune(instructions, 0) {
		return fmt.Errorf("%w: instructions too large", ErrInvalidEnvironment)
	}
	return nil
}

// SetInstructions gives a session its project's instructions for the agent,
// replacing any it had; empty removes them. They apply at its next launch,
// after Outrunner's orientation (orientation).
func (s *Service) SetInstructions(workspaceID, instructions string) error {
	instructions = strings.TrimSpace(instructions)
	if err := ValidInstructions(instructions); err != nil {
		return err
	}
	path := s.instructionsPath(workspaceID)
	if instructions == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeKeysFile(path, instructions+"\n")
}

// instructions are the session's project instructions, or "".
func (s *Service) instructions(workspaceID string) string {
	data, _ := os.ReadFile(s.instructionsPath(workspaceID))
	return strings.TrimSpace(string(data))
}

func (s *Service) warmHookPath(workspaceID string) string {
	return filepath.Join(s.Root, "setup", workspaceID+".warm.sh")
}

func (s *Service) startHookPath(workspaceID string) string {
	return filepath.Join(s.Root, "setup", workspaceID+".start.sh")
}

// SetHooks gives a session its project's warm hook (run once, at its first
// launch, unless its worktree was warmed on a ready box) and start hook (run
// at every launch), replacing any it had; empty removes one.
func (s *Service) SetHooks(workspaceID, warmHook, startHook string) error {
	for _, h := range []struct{ path, script string }{{s.warmHookPath(workspaceID), warmHook}, {s.startHookPath(workspaceID), startHook}} {
		if strings.TrimSpace(h.script) == "" {
			if err := os.Remove(h.path); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := writeKeysFile(h.path, h.script); err != nil {
			return err
		}
	}
	return nil
}

// ValidHooks accepts hooks a session can take.
func ValidHooks(warmHook, startHook string) error {
	for _, h := range []string{warmHook, startHook} {
		if len(h) > maxSetupBytes || strings.ContainsRune(h, 0) {
			return fmt.Errorf("%w: hook too large", ErrInvalidEnvironment)
		}
	}
	return nil
}

func (s *Service) setupLogPath(workspaceID string) string {
	return filepath.Join(s.Root, "logs", "setup-"+workspaceID+".log")
}

// SetEnvironment gives a session its project's variables, files (by path in
// the checkout) and setup script, replacing any it had; empty removes them. The variables apply at its next
// launch; the setup script runs at its next launch, once. It may come before
// the session is made (ahead of a Restore, which launches it at once).
func (s *Service) SetEnvironment(ctx context.Context, workspaceID string, env, files map[string]string, setup string) error {
	names := make([]string, 0, len(env))
	for name, value := range env {
		if !ValidEnvName(name) {
			return fmt.Errorf("%w: %s can't be set", ErrInvalidEnvironment, name)
		}
		if strings.ContainsRune(value, 0) {
			return fmt.Errorf("%w: %s has a NUL", ErrInvalidEnvironment, name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var content strings.Builder
	for _, name := range names {
		content.WriteString("export " + name + "=" + claude.ShellQuote(env[name]) + "\n")
	}
	if content.Len() > maxEnvBytes || len(setup) > maxSetupBytes || strings.ContainsRune(setup, 0) {
		return fmt.Errorf("%w: too large", ErrInvalidEnvironment)
	}
	if err := validEnvFiles(files); err != nil {
		return err
	}
	defer s.lockLifecycle(workspaceID)()
	if err := s.envFiles().put(workspaceID, content.String()); err != nil {
		return err
	}
	if err := s.putEnvRoot(workspaceID, files); err != nil {
		return err
	}
	if setup == "" {
		if err := os.Remove(s.setupPath(workspaceID)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeKeysFile(s.setupPath(workspaceID), setup)
}

// validEnvFiles accepts files whose paths stay inside the folder they are
// laid out in, within the bounds.
func validEnvFiles(files map[string]string) error {
	if len(files) > maxEnvFiles {
		return fmt.Errorf("%w: more than %d files", ErrInvalidEnvironment, maxEnvFiles)
	}
	total := 0
	for path, content := range files {
		total += len(content)
		if !filepath.IsLocal(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
			return fmt.Errorf("%w: file %q", ErrInvalidEnvironment, path)
		}
	}
	if total > maxEnvFilesBytes {
		return fmt.Errorf("%w: files too large", ErrInvalidEnvironment)
	}
	return nil
}

// putEnvRoot replaces a session's files in one step: written in a fresh
// folder beside the old, then swapped in.
func (s *Service) putEnvRoot(workspaceID string, files map[string]string) error {
	root := s.envRoot(workspaceID)
	if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(root), "."+workspaceID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	for path, content := range files {
		dst := filepath.Join(staging, path)
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(dst, []byte(content), 0o600); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if len(files) == 0 {
		return nil
	}
	return os.Rename(staging, root)
}

// withEnvironment wraps a launch so it sources the session's environment
// first: its credential and gateway, sourced after, win over a variable of
// the same name.
func (s *Service) withEnvironment(workspaceID string, argv []string) []string {
	path := s.envFiles().path(workspaceID)
	if _, err := os.Stat(path); err != nil {
		return argv
	}
	return claude.WithEnvFile(argv, path)
}

// startSetup runs the session's scripts beside it, in its worktree, one
// after another, with its environment and variables, their output in the
// setup log:
//
//   - the project's warm hook, once, unless the session's worktree was
//     already warmed on a ready box (warm.go);
//   - the setup script (Conductor's), once;
//   - the project's start hook, at every launch.
//
// A once-only script is moved aside as it starts, so a relaunch doesn't run
// it again. With no setup script, the session's files are copied into its
// worktree, once.
func (s *Service) startSetup(workspaceID, worktree string, env []string) {
	setup := s.setupPath(workspaceID)
	if !fileExists(setup) && !fileExists(setup+".run") {
		s.copyEnvFilesOnce(workspaceID, worktree)
	}
	type step struct{ name, path string }
	var steps []step
	timeout := setupTimeout
	if f, _ := s.getFacts(workspaceID); !f.Warmed {
		if path := s.claimOnce(s.warmHookPath(workspaceID)); path != "" {
			steps = append(steps, step{"warm hook", path})
			timeout += WarmTimeout
		}
	}
	if path := s.claimOnce(setup); path != "" {
		steps = append(steps, step{"setup", path})
	}
	if path := s.startHookPath(workspaceID); fileExists(path) {
		steps = append(steps, step{"start hook", path})
	}
	if len(steps) == 0 {
		return
	}
	logPath := s.setupLogPath(workspaceID)
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	cmdEnv := append(append([]string(nil), env...),
		"CONDUCTOR_ROOT_PATH="+s.envRoot(workspaceID),
		"CONDUCTOR_WORKSPACE_PATH="+worktree,
		"CONDUCTOR_WORKSPACE_NAME="+filepath.Base(worktree),
	)
	go func() {
		defer log.Close()
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		for _, st := range steps {
			if len(steps) > 1 {
				fmt.Fprintf(log, "== %s ==\n", st.name)
			}
			argv := []string{"sh", st.path}
			if path := s.envFiles().path(workspaceID); fileExists(path) {
				argv = claude.WithEnvFile(argv, path)
			}
			cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
			cmd.Dir = worktree
			cmd.Env = cmdEnv
			cmd.Stdout, cmd.Stderr = log, log
			err := cmd.Run()
			if strings.HasSuffix(st.path, ".run") {
				_ = os.Remove(st.path)
			}
			if err != nil {
				fmt.Fprintf(log, "\n%s failed: %v\n", st.name, err)
				return // a later step may need what this one didn't do
			}
			fmt.Fprintf(log, "\n%s finished\n", st.name)
		}
	}()
}

// claimOnce moves a run-once script aside to run it, returning where it now
// is; "" when there is none, or it ran already.
func (s *Service) claimOnce(script string) string {
	running := script + ".run"
	if err := os.Rename(script, running); err != nil {
		return ""
	}
	return running
}

// copyEnvFilesOnce puts a copy of each of the session's files in its
// worktree where none is, the first time it launches; a file the user
// removes after isn't put back.
func (s *Service) copyEnvFilesOnce(workspaceID, worktree string) {
	marker := s.setupPath(workspaceID) + ".copied"
	root := s.envRoot(workspaceID)
	if fileExists(marker) || !fileExists(root) {
		return
	}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		dst := filepath.Join(worktree, rel)
		if fileExists(dst) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if os.MkdirAll(filepath.Dir(dst), 0o755) == nil {
			_ = os.WriteFile(dst, data, 0o600)
		}
		return nil
	})
	_ = os.MkdirAll(filepath.Dir(marker), 0o700)
	_ = os.WriteFile(marker, nil, 0o600)
}

// minMaskedEnv is the shortest variable masked in the terminal: a short one
// ("1", "production") is a setting, and masking it would blank ordinary output.
const minMaskedEnv = 12

// envTokens are the session environments' values worth masking: their
// variables', and those their files set.
func (s *Service) envTokens() []string {
	values := s.envFiles().tokens()
	_ = filepath.WalkDir(filepath.Join(s.Root, "envroot"), func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if data, err := os.ReadFile(path); err == nil {
			for _, entry := range dotenv.Parse(string(data)) {
				values = append(values, entry.Value)
			}
		}
		return nil
	})
	var tokens []string
	for _, value := range values {
		if len(value) >= minMaskedEnv {
			tokens = append(tokens, value)
		}
	}
	return tokens
}

// removeEnvironment removes a destroyed session's environment and setup.
func (s *Service) removeEnvironment(workspaceID string) {
	s.envFiles().remove(workspaceID)
	_ = os.Remove(s.instructionsPath(workspaceID))
	s.removeGuide(workspaceID)
	_ = os.RemoveAll(s.envRoot(workspaceID))
	setup := s.setupPath(workspaceID)
	warm, startHook := s.warmHookPath(workspaceID), s.startHookPath(workspaceID)
	for _, path := range []string{setup, setup + ".run", setup + ".copied", s.setupLogPath(workspaceID), warm, warm + ".run", startHook} {
		_ = os.Remove(path)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
