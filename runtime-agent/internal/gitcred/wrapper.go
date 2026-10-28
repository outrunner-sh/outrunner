package gitcred

import (
	"os"
	"path/filepath"
	"strings"
)

// GhWrapper is the script that stands in for gh on the sessions' PATH: it
// runs the real gh with the token GitHubToken prints for the repository the
// command works on as $GH_TOKEN. That is the box's own $GH_TOKEN only where
// GitHubToken falls back to it; when it prints none (Outrunner refused, or
// there's no token at all), gh runs signed out, its reason on stderr: no
// token from the environment, and its config in an empty folder under the
// root (NoLoginDir), so a login the box's own gh config keeps doesn't answer
// either.
func GhWrapper(executable, root, realGh string) string {
	return "#!/bin/sh\n" +
		"if token=$(" + ShellQuote(executable) + " github-token --root " + ShellQuote(root) + ` -- "$@") && [ -n "$token" ]; then` + "\n" +
		"\tGH_TOKEN=$token; export GH_TOKEN\n" +
		"else\n" +
		"\tunset GH_TOKEN GITHUB_TOKEN\n" +
		"\tGH_CONFIG_DIR=" + ShellQuote(NoLoginDir(root)) + "; export GH_CONFIG_DIR\n" +
		"fi\n" +
		"exec " + ShellQuote(realGh) + ` "$@"` + "\n"
}

// NoLoginDir is the gh config folder a refused gh runs with: never logged in.
func NoLoginDir(root string) string {
	return filepath.Join(root, ".outrunner", "gh-signed-out")
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
