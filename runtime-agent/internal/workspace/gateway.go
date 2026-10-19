package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"runtime-agent/internal/claude"
)

// A session that runs through a gateway (OpenRouter) gets its key and model in
// a private file the launch sources, rather than in the agent's environment
// (shared by every session) or on a command line (visible in ps).

func (s *Service) gatewayEnvPath(workspaceID string) string {
	return filepath.Join(s.Root, "gateways", workspaceID+".env")
}

// gatewayEnvFile renders the session's gateway environment as shell exports.
func gatewayEnvFile(g claude.Gateway, token, model string) string {
	set, unset := claude.GatewayEnv(g, token, model)
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range unset {
		b.WriteString("unset " + k + "\n")
	}
	for _, k := range keys {
		b.WriteString("export " + k + "=" + claude.ShellQuote(set[k]) + "\n")
	}
	return b.String()
}

// writeGatewayEnv stores it owner-only, atomically, so a launch never sources a
// half-written file.
func (s *Service) writeGatewayEnv(workspaceID, content string) error {
	return writeKeysFile(s.gatewayEnvPath(workspaceID), content)
}

// writeKeysFile replaces a file of keys owner-only and atomically: a crash or
// a full disk leaves the old file whole (and at worst a .tmp beside it, which
// gatewayTokens reads too), never a half-written line run into the next.
func writeKeysFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// retiredGatewayPath keeps the keys a session ran on before its current one.
// The conversation it continues can redraw an old key (an earlier `env`), so
// a key stays masked for the life of the session, not just while it's in use.
func (s *Service) retiredGatewayPath(workspaceID string) string {
	return filepath.Join(s.Root, "gateways", workspaceID+".retired")
}

// putGatewayEnv stores the session's gateway file, or removes it for none. The
// keys of the file it replaces are kept in the retired file first.
func (s *Service) putGatewayEnv(workspaceID, content string) error {
	if prior := s.readGatewayEnv(workspaceID); prior != "" && prior != content {
		if err := s.retireGatewayKeys(workspaceID, prior); err != nil {
			return err
		}
	}
	if content == "" {
		if err := os.Remove(s.gatewayEnvPath(workspaceID)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return s.writeGatewayEnv(workspaceID, content)
}

// retireGatewayKeys adds the key lines of a replaced gateway file to the
// session's retired file, skipping keys already there. The file is rewritten
// whole (writeKeysFile), not appended to: an append cut short would leave a
// line the next one runs into, and the key on it would no longer be found.
func (s *Service) retireGatewayKeys(workspaceID, prior string) error {
	path := s.retiredGatewayPath(workspaceID)
	data, _ := os.ReadFile(path)
	existing := string(data)
	// A last line without its newline (a file from before this was atomic)
	// is ended, so nothing added runs into it.
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		existing += "\n"
	}
	content := existing
	for _, line := range keyLines(prior) {
		if !strings.Contains(content, line+"\n") {
			content += line + "\n"
		}
	}
	if content == existing && content == string(data) {
		return nil
	}
	return writeKeysFile(path, content)
}

// removeGatewayFiles removes every file holding the session's keys: its
// gateway file, one left half-written by a crash, and its retired keys.
func (s *Service) removeGatewayFiles(workspaceID string) {
	path := s.gatewayEnvPath(workspaceID)
	retired := s.retiredGatewayPath(workspaceID)
	for _, file := range []string{path, path + ".tmp", retired, retired + ".tmp"} {
		_ = os.Remove(file)
	}
}

func (s *Service) readGatewayEnv(workspaceID string) string {
	data, _ := os.ReadFile(s.gatewayEnvPath(workspaceID))
	return string(data)
}

// ErrGatewayKeyMissing is a session recorded on a gateway whose key file is
// gone: launched anyway, sourcing the missing file fails and Claude exits with
// nothing on screen to say why.
var ErrGatewayKeyMissing = errors.New("this session's model key is missing; choose its model again to restart it")

// requireGatewayEnv refuses to launch a gateway session without its key file.
func (s *Service) requireGatewayEnv(workspaceID string) error {
	if f, _ := s.getFacts(workspaceID); f.Gateway == claude.NoGateway {
		return nil
	}
	if _, err := os.Stat(s.gatewayEnvPath(workspaceID)); err != nil {
		return ErrGatewayKeyMissing
	}
	return nil
}

// gatewayTokens are every key in the gateways folder, for redaction: each
// session's current key, its retired ones, and any a crash left in a
// half-written file. Read from the files so a restarted agent still masks the
// sessions tmux kept.
func (s *Service) gatewayTokens() []string {
	files, _ := filepath.Glob(filepath.Join(s.Root, "gateways", "*"))
	var tokens []string
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, line := range keyLines(string(data)) {
			_, value, _ := strings.Cut(line, "=")
			tokens = append(tokens, strings.Trim(value, "'"))
		}
	}
	return tokens
}

// keyLines are a gateway file's exports of a non-empty key, in whichever
// variable its gateway uses.
func keyLines(content string) []string {
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		for _, name := range claude.GatewayKeyEnvs() {
			if value, ok := strings.CutPrefix(line, "export "+name+"="); ok && strings.Trim(value, "'") != "" {
				lines = append(lines, line)
			}
		}
	}
	return lines
}
