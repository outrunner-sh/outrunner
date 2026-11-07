package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

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

// standInFile, in a worktree's own git dir, holds the stand-in name it's
// on while that's still to be renamed; `<it>.refused` once a push of it was
// refused. Per worktree, not per name: one box holds many sessions, and two
// can have the same stand-in (`session`, or `fix-login` in two repositories).
const standInFile = "outrunner-stand-in"

// markStandIns writes each folder's marker for branch, or removes it.
func (s *Service) markStandIns(dirs []string, branch string, standIn bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, dir := range dirs {
		gitDir, err := s.git(ctx, dir, "rev-parse", "--absolute-git-dir")
		if err != nil || gitDir == "" {
			continue
		}
		marker := filepath.Join(gitDir, standInFile)
		if !standIn {
			_ = os.Remove(marker)
			_ = os.Remove(marker + ".refused")
			_ = os.Remove(marker + ".unconfirmed")
			continue
		}
		if current, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(current)) == branch {
			continue // as it was: its refusal, if any, stands
		}
		_ = os.Remove(marker + ".refused")
		_ = os.Remove(marker + ".unconfirmed")
		_ = os.WriteFile(marker, []byte(branch+"\n"), 0o644)
	}
}

// markUnconfirmed guards each folder's branch, the name of a rename
// Outrunner hasn't confirmed, saying how to finish it.
func (s *Service) markUnconfirmed(dirs []string, branch string) {
	s.markStandIns(dirs, branch, true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, dir := range dirs {
		if gitDir, err := s.git(ctx, dir, "rev-parse", "--absolute-git-dir"); err == nil && gitDir != "" {
			_ = os.WriteFile(filepath.Join(gitDir, standInFile+".unconfirmed"), nil, 0o644)
		}
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
	if err := os.WriteFile(tmp, []byte(gitWrapper(realGit)), 0o755); err != nil {
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
// worktree whose marker names the branch it's on, the first time, is refused.
func gitWrapper(realGit string) string {
	return `#!/bin/sh
# Outrunner: refuses the first push of a branch still on its stand-in name.
real=` + gitcred.ShellQuote(realGit) + `
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
    gitdir=$("$real" -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)
    branch=$("$real" -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null)
  else
    gitdir=$("$real" rev-parse --absolute-git-dir 2>/dev/null)
    branch=$("$real" symbolic-ref --quiet --short HEAD 2>/dev/null)
  fi
  marker="$gitdir/` + standInFile + `"
  if [ -n "$gitdir" ] && [ -n "$branch" ] && [ -f "$marker" ] && [ ! -f "$marker.refused" ] && [ "$(cat "$marker")" = "$branch" ]; then
    : > "$marker.refused"
    if [ -f "$marker.unconfirmed" ]; then
      echo "Outrunner: the rename to $branch isn't confirmed yet. Finish it first, with this same name:" >&2
      echo "    ` + sessiontools.CommandName + ` rename-branch $branch" >&2
    else
      echo "Outrunner: $branch is still the stand-in name made from the first message. Name the branch first:" >&2
      echo "    ` + sessiontools.CommandName + ` rename-branch <type>/<what-it-does>" >&2
    fi
    echo "then push again. (A second push goes through as it is.)" >&2
    exit 1
  fi
fi
exec "$real" "$@"
`
}
