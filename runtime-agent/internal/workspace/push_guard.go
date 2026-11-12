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

// gitWrapper is the guard's script: realGit for everything, but a push of the
// branch a worktree's marker names (its stand-in, or an unconfirmed rename),
// the first time, is refused. The branches pushed are read off the command:
// its refspecs' sources and destinations (HEAD or @ as the branch checked
// out, refs/heads/ dropped), every branch for --all, --mirror or a pattern,
// and with no refspec the branch checked out. A deletion pushes none, and a
// dry run is left alone: neither may use up the one refusal.
func gitWrapper(realGit string) string {
	return `#!/bin/sh
# Outrunner: refuses the first push of a branch still on its stand-in name.
real=` + gitcred.ShellQuote(realGit) + `
set -f
sub= dir= skip= args= all= tagsonly= del= dry=
for a in "$@"; do
  if [ -n "$skip" ]; then
    [ "$skip" = C ] && dir=$a
    skip=; continue
  fi
  if [ "$sub" = push ]; then
    case "$a" in
      --all|--mirror|--branches) all=1 ;;
      --tags) tagsonly=1 ;;
      -d|--delete) del=1 ;;
      -n|--dry-run) dry=1 ;;
      --repo|-o|--push-option|--receive-pack|--exec) skip=1 ;;
      -o*) ;; # its value attached
      -[!-]*)
        # Short flags bundled (-fd, -nu): a d or n among them counts. An o
        # takes the rest of the bundle as its value, or the next argument.
        f=${a%%o*}
        case "$f" in *d*) del=1 ;; esac
        case "$f" in *n*) dry=1 ;; esac
        case "$a" in *o*) [ -z "${a#*o}" ] && skip=1 ;; esac ;;
      -*) ;;
      *) args="$args $a" ;;
    esac
    continue
  fi
  case "$a" in
    -C) skip=C ;;
    -c|--git-dir|--work-tree|--namespace|--config-env|--exec-path) skip=1 ;;
    -*) ;;
    *) sub=$a; [ "$sub" = push ] || break ;;
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
  guarded=
  [ -n "$gitdir" ] && [ -f "$marker" ] && [ ! -f "$marker.refused" ] && guarded=$(cat "$marker")
  hit=
  if [ -n "$guarded" ] && [ -z "$del" ] && [ -z "$dry" ]; then
    n=0
    for spec in $args; do
      n=$((n + 1))
      [ $n -eq 1 ] && continue # the repository
      spec=${spec#+}
      src=${spec%%:*}
      [ -z "$src" ] && continue # :name deletes it
      case "$src" in HEAD|@) src=$branch ;; esac
      src=${src#refs/heads/}
      case "$src" in
        *'*'*) hit=1 ;;
        "$guarded") hit=1 ;;
      esac
      # The name it lands under, too: the stand-in mustn't reach GitHub.
      case "$spec" in *:*)
        dst=${spec#*:}
        [ "${dst#refs/heads/}" = "$guarded" ] && hit=1 ;;
      esac
    done
    [ -n "$all" ] && hit=1
    # No refspec: the branch checked out (but --tags alone pushes tags).
    [ $n -le 1 ] && [ -z "$all" ] && [ -z "$tagsonly" ] && [ "$branch" = "$guarded" ] && hit=1
  fi
  if [ -n "$hit" ]; then
    : > "$marker.refused"
    if [ -f "$marker.unconfirmed" ]; then
      echo "Outrunner: the rename to $guarded isn't confirmed yet. Finish it first, with this same name:" >&2
      echo "    ` + sessiontools.CommandName + ` rename-branch $guarded" >&2
    else
      echo "Outrunner: $guarded is still the stand-in name made from the first message. Name the branch first:" >&2
      echo "    ` + sessiontools.CommandName + ` rename-branch <type>/<what-it-does>" >&2
    fi
    echo "then push again. (A second push goes through as it is.)" >&2
    exit 1
  fi
  set +f
fi
exec "$real" "$@"
`
}
