package workspace

import (
	"os"
	"path/filepath"
	"strings"
)

// keyFiles is a folder of per-session files of keys, each a shell file of
// exports a launch sources: a session's key reaches its agent's environment
// without ever being on a command line (visible in ps) or in the agent's own
// environment (shared by every session).
//
// The keys a session ran on before its current ones are kept in a retired
// file beside it, for redaction: the conversation it continues can redraw an
// old key (an earlier `env`), so a key stays masked for the life of the
// session, not just while it's in use.
type keyFiles struct {
	dir string
	// envs are the variables a key is exported in; any other export (a URL,
	// a model) is not a secret.
	envs []string
}

func (k keyFiles) path(workspaceID string) string {
	return filepath.Join(k.dir, workspaceID+".env")
}

func (k keyFiles) retiredPath(workspaceID string) string {
	return filepath.Join(k.dir, workspaceID+".retired")
}

func (k keyFiles) read(workspaceID string) string {
	data, _ := os.ReadFile(k.path(workspaceID))
	return string(data)
}

// value is the key the session's file exports in the variable name, or "".
func (k keyFiles) value(workspaceID, name string) string {
	for _, line := range k.keyLines(k.read(workspaceID)) {
		if value, ok := strings.CutPrefix(line, "export "+name+"="); ok {
			return strings.Trim(value, "'")
		}
	}
	return ""
}

// put stores the session's file, or removes it for none. The keys of the file
// it replaces are kept in the retired file first.
func (k keyFiles) put(workspaceID, content string) error {
	if prior := k.read(workspaceID); prior != "" && prior != content {
		if err := k.retire(workspaceID, prior); err != nil {
			return err
		}
	}
	if content == "" {
		if err := os.Remove(k.path(workspaceID)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	// Owner-only, atomically, so a launch never sources a half-written file.
	return writeKeysFile(k.path(workspaceID), content)
}

// retire adds the key lines of a replaced file to the session's retired file,
// skipping keys already there. The file is rewritten whole (writeKeysFile),
// not appended to: an append cut short would leave a line the next one runs
// into, and the key on it would no longer be found.
func (k keyFiles) retire(workspaceID, prior string) error {
	path := k.retiredPath(workspaceID)
	data, _ := os.ReadFile(path)
	existing := string(data)
	// A last line without its newline (a file from before this was atomic)
	// is ended, so nothing added runs into it.
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		existing += "\n"
	}
	content := existing
	for _, line := range k.keyLines(prior) {
		if !strings.Contains(content, line+"\n") {
			content += line + "\n"
		}
	}
	if content == existing && content == string(data) {
		return nil
	}
	return writeKeysFile(path, content)
}

// remove removes every file holding the session's keys: its current file, one
// left half-written by a crash, and its retired keys.
func (k keyFiles) remove(workspaceID string) {
	path, retired := k.path(workspaceID), k.retiredPath(workspaceID)
	for _, file := range []string{path, path + ".tmp", retired, retired + ".tmp"} {
		_ = os.Remove(file)
	}
}

// tokens are every key in the folder, for redaction: each session's current
// key, its retired ones, and any a crash left in a half-written file. Read
// from the files so a restarted agent still masks the sessions tmux kept.
func (k keyFiles) tokens() []string {
	files, _ := filepath.Glob(filepath.Join(k.dir, "*"))
	var tokens []string
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, line := range k.keyLines(string(data)) {
			_, value, _ := strings.Cut(line, "=")
			tokens = append(tokens, strings.Trim(value, "'"))
		}
	}
	return tokens
}

// keyLines are a file's exports of a non-empty key, in whichever of the
// folder's variables it is in.
func (k keyFiles) keyLines(content string) []string {
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		for _, name := range k.envs {
			if value, ok := strings.CutPrefix(line, "export "+name+"="); ok && strings.Trim(value, "'") != "" {
				lines = append(lines, line)
			}
		}
	}
	return lines
}

// writeKeysFile replaces a file of keys owner-only and atomically: a crash or
// a full disk leaves the old file whole (and at worst a .tmp beside it, which
// tokens reads too), never a half-written line run into the next.
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
