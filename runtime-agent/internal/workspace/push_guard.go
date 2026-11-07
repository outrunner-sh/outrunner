package workspace

import (
	"os"
	"path/filepath"
	"regexp"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/sessiontools"
)

// A push of a branch still on the stand-in name Outrunner made from the first
// prompt is refused once, telling the agent to name it first
// (rename_branch.go): the orientation asks it to, but an agent that forgets
// would otherwise put the stand-in on GitHub for good. The next push goes
// through, named or not, so nothing can block pushes for long: a control
// plane that can't be reached, an agent that won't.
//
// It is a `git` on the sessions' PATH, beside gh's wrapper, rather than a
// pre-push hook: a repository's own hooks folder (husky's core.hooksPath)
// would take the place of one Outrunner put in the mirror. The wrapper
// passes every call to the real git unchanged, and only looks at pushes.

// standInBranch is a name Outrunner made up: words only, no slash.
var standInBranch = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// standInsDir holds a marker for each branch still on its stand-in name,
// and `<branch>.refused` once a push of it was refused.
func (s *Service) standInsDir() string { return filepath.Join(s.Root, "stand-ins") }

// markStandIn notes branch as a stand-in, or no longer one, for the guard.
func (s *Service) markStandIn(branch string, standIn bool) {
	if !standInBranch.MatchString(branch) {
		return
	}
	marker := filepath.Join(s.standInsDir(), branch)
	if !standIn {
		_ = os.Remove(marker)
		_ = os.Remove(marker + ".refused")
		return
	}
	if err := os.MkdirAll(s.standInsDir(), 0o755); err == nil {
		_ = os.WriteFile(marker, nil, 0o644)
	}
}

// writeGitWrapper puts the guard in gitBinDir, or removes one an earlier start
// left when there's no git to pass calls to.
func (s *Service) writeGitWrapper() error {
	wrapper := filepath.Join(s.gitBinDir(), "git")
	realGit, ok := gitcred.FindExecutable("git", envValue(s.env, "PATH"), s.gitBinDir(), wrapper)
	if !ok {
		if err := os.Remove(wrapper); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(s.gitBinDir(), 0o755); err != nil {
		return err
	}
	tmp := wrapper + ".tmp"
	if err := os.WriteFile(tmp, []byte(gitWrapper(realGit, s.standInsDir())), 0o755); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, wrapper); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// gitWrapper is the guard's script: realGit for everything, but a push from a
// branch with a marker in standIns, the first time, is refused.
func gitWrapper(realGit, standIns string) string {
	return `#!/bin/sh
# Outrunner: refuses the first push of a branch still on its stand-in name.
real=` + gitcred.ShellQuote(realGit) + `
standins=` + gitcred.ShellQuote(standIns) + `
sub= dir= skip=
for a in "$@"; do
  if [ -n "$skip" ]; then
    [ "$skip" = C ] && dir=$a
    skip=; continue
  fi
  case "$a" in
    -C) skip=C ;;
    -c|--git-dir|--work-tree|--namespace|--config-env|--exec-path) skip=1 ;;
    -*) ;;
    *) sub=$a; break ;;
  esac
done
if [ "$sub" = push ]; then
  if [ -n "$dir" ]; then
    branch=$("$real" -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null)
  else
    branch=$("$real" symbolic-ref --quiet --short HEAD 2>/dev/null)
  fi
  case "$branch" in */*|'') ;; *)
    if [ -f "$standins/$branch" ] && [ ! -f "$standins/$branch.refused" ]; then
      : > "$standins/$branch.refused"
      echo "Outrunner: $branch is still the stand-in name made from the first message. Name the branch first:" >&2
      echo "    ` + sessiontools.CommandName + ` rename-branch <type>/<what-it-does>" >&2
      echo "then push again. (A second push goes through as it is.)" >&2
      exit 1
    fi ;;
  esac
fi
exec "$real" "$@"
`
}
