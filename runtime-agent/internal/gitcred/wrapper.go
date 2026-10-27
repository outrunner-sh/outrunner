package gitcred

import (
	"os"
	"path/filepath"
	"strings"
)

// GhWrapper is the script that stands in for gh on the sessions' PATH: it
// runs the real gh with a fresh token for the repository the command works
// on as $GH_TOKEN (GitHubToken), or, when there is none to be had, as it was
// launched (with the box's $GH_TOKEN, if any).
func GhWrapper(executable, root, realGh string) string {
	return "#!/bin/sh\n" +
		"token=$(" + ShellQuote(executable) + " github-token --root " + ShellQuote(root) + ` -- "$@" 2>/dev/null) && [ -n "$token" ] && GH_TOKEN=$token && export GH_TOKEN` + "\n" +
		"exec " + ShellQuote(realGh) + ` "$@"` + "\n"
}

// HelperCommand is git's credential.helper value that runs this binary's
// Helper: a shell snippet (the leading "!"), git adding the operation.
func HelperCommand(executable, root string) string {
	return "!" + ShellQuote(executable) + " git-credential --root " + ShellQuote(root)
}

// ShellQuote single-quotes a value for sh.
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// FindExecutable is the first executable file name in the directories of
// path (a $PATH), skipping the directory skip and anything that resolves to
// the file avoid: the wrapper must never find itself as the real gh.
func FindExecutable(name, path, skip, avoid string) (string, bool) {
	avoidResolved, _ := filepath.EvalSymlinks(avoid)
	for _, dir := range filepath.SplitList(path) {
		if dir == "" || !filepath.IsAbs(dir) || filepath.Clean(dir) == filepath.Clean(skip) {
			continue
		}
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(candidate); err == nil && avoidResolved != "" && resolved == avoidResolved {
			continue
		}
		return candidate, true
	}
	return "", false
}
