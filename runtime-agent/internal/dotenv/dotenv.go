// Package dotenv reads .env files the way the common loaders (dotenv, Vite,
// Next) do, for their names (what an import offers) and values (what the box
// masks in the terminal).
package dotenv

import (
	"regexp"
	"strings"
)

// Entry is one variable a file sets.
type Entry struct {
	Name  string
	Value string
}

var assignment = regexp.MustCompile(`^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$`)

// Parse reads a .env file's variables, in order. It takes `export`, comments,
// single- and double-quoted values (a double-quoted one may run over lines
// and take \n escapes), and an unquoted value's trailing ` # comment`; a line
// that sets nothing is skipped.
func Parse(content string) []Entry {
	var entries []Entry
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for i := 0; i < len(lines); i++ {
		m := assignment.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		name, raw := m[1], m[2]
		var value string
		switch {
		case strings.HasPrefix(raw, `"`):
			body := raw[1:]
			for !closesDouble(body) && i+1 < len(lines) {
				i++
				body += "\n" + lines[i]
			}
			if end := closingDouble(body); end >= 0 {
				body = body[:end]
			}
			value = strings.NewReplacer(`\n`, "\n", `\r`, "\r", `\t`, "\t", `\"`, `"`, `\\`, `\`).Replace(body)
		case strings.HasPrefix(raw, "'"):
			body := raw[1:]
			if end := strings.Index(body, "'"); end >= 0 {
				body = body[:end]
			}
			value = body
		default:
			if j := strings.Index(raw, " #"); j >= 0 {
				raw = raw[:j]
			}
			value = strings.TrimSpace(raw)
		}
		entries = append(entries, Entry{Name: name, Value: value})
	}
	return entries
}

func closesDouble(s string) bool { return closingDouble(s) >= 0 }

// closingDouble is the index of the first unescaped double quote, or -1.
func closingDouble(s string) int {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '"':
			return i
		}
	}
	return -1
}
