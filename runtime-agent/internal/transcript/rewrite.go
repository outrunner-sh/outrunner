package transcript

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// RewriteCwd moves a transcript from one folder to another: every working
// directory it records at or under from is put under to instead. That is
// Claude Code's `cwd` on each record, and a Codex rollout's `payload.cwd`
// (session_meta, turn_context). Nothing else is touched — paths in the
// conversation itself stay what they were — and a line that names no such
// directory is kept byte for byte. The file is replaced in one step.
//
// A session imported from someone's Mac resumes in the box's worktree, and
// its agent would otherwise be told it works in a folder that isn't there.
func RewriteCwd(path, from, to string) error {
	from, to = filepath.Clean(from), filepath.Clean(to)
	if from == to {
		return nil
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.CreateTemp(filepath.Dir(path), ".rewrite-*")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name()) // a no-op once renamed
	w := bufio.NewWriter(out)
	r := bufio.NewReader(in)
	// Only a line naming from can need a rewrite; any other is copied as is.
	quoted := jsonString(from)
	needle := []byte(quoted[1 : len(quoted)-1])
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			if bytes.Contains(line, needle) {
				line = rewriteLine(line, from, to)
			}
			if _, werr := w.Write(line); werr != nil {
				out.Close()
				return werr
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			out.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		out.Close()
		return err
	}
	if err := out.Chmod(info.Mode().Perm()); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(out.Name(), path)
}

// rewriteLine rewrites one record's working directories, keeping the line as
// it was when it isn't a JSON object or names none of them.
func rewriteLine(line []byte, from, to string) []byte {
	body := bytes.TrimRight(line, "\r\n")
	ending := line[len(body):]
	var rec map[string]json.RawMessage
	if json.Unmarshal(body, &rec) != nil {
		return line
	}
	changed := moveCwd(rec, from, to)
	if raw, ok := rec["payload"]; ok {
		var payload map[string]json.RawMessage
		if json.Unmarshal(raw, &payload) == nil && moveCwd(payload, from, to) {
			if encoded, err := marshal(payload); err == nil {
				rec["payload"], changed = encoded, true
			}
		}
	}
	if !changed {
		return line
	}
	encoded, err := marshal(rec)
	if err != nil {
		return line
	}
	return append(encoded, ending...)
}

// moveCwd moves rec's "cwd" from under from to under to; false if it wasn't.
func moveCwd(rec map[string]json.RawMessage, from, to string) bool {
	raw, ok := rec["cwd"]
	if !ok {
		return false
	}
	var cwd string
	if json.Unmarshal(raw, &cwd) != nil {
		return false
	}
	rest, ok := strings.CutPrefix(cwd, from)
	if !ok || (rest != "" && rest[0] != '/') {
		return false
	}
	rec["cwd"] = json.RawMessage(jsonString(to + rest))
	return true
}

// marshal encodes v as compact JSON, leaving <, > and & as they are (a
// prompt keeps its tags), with keys sorted: a rewritten record differs from
// the original only in key order and where it was rewritten.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func jsonString(s string) string {
	data, _ := marshal(s)
	return string(data)
}
