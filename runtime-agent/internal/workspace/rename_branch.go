package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"runtime-agent/internal/sessiontools"
)

// The agent naming its session's branch, once, when it knows what the change
// is: `outrunner-session rename-branch <type>/<what-it-does>`. The branch
// Outrunner made up from the first prompt is a stand-in until then. The
// control plane says the name it may take (numbered when taken) and records
// it; this agent renames the branch in every checkout between the two, and
// back again when the control plane refuses, so git and Outrunner never
// disagree on its name (lib/session/rename-branch.ts).

// RenameBranchTool is the session tool the command calls.
const RenameBranchTool = "rename_branch"

// branchName is a name the control plane gave back: one ref, no options.
var branchName = regexp.MustCompile(`^[a-z][a-z0-9]{1,19}/[a-z0-9]+(?:-[a-z0-9]+)*$`)

// renameBranch renames the session `owner`'s branch to the name args ask for,
// as the control plane allows, in each of its checkouts.
func (s *Service) renameBranch(ctx context.Context, owner string, args json.RawMessage) (int, sessiontools.Answer, error) {
	var in struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(args, &in) != nil || strings.TrimSpace(in.Name) == "" {
		return http.StatusBadRequest, sessiontools.Answer{Error: "Name the branch: rename-branch <type>/<what-it-does>."}, nil
	}
	defer s.lockLifecycle(owner)()
	f, ok := s.getFacts(owner)
	if !ok {
		return 0, sessiontools.Answer{}, ErrUnknownWorkspace
	}
	if !f.BranchRenamable || f.RepoPath != "" {
		return http.StatusConflict, sessiontools.Answer{Error: fmt.Sprintf("This branch, %s, keeps its name: it was named already, or chosen.", f.Branch)}, nil
	}
	dirs := s.branchCheckouts(owner, f)
	for _, dir := range dirs {
		if head, err := s.git(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD"); err != nil || head != f.Branch {
			return http.StatusConflict, sessiontools.Answer{Error: fmt.Sprintf("Switch back to the session's branch, %s, to rename it.", f.Branch)}, nil
		}
	}

	status, answer, err := s.passOn(ctx, owner, RenameBranchTool, map[string]string{"phase": "check", "name": strings.TrimSpace(in.Name)})
	if err != nil || status/100 != 2 {
		return status, answer, err
	}
	to := strings.TrimSpace(answer.Text)
	if !branchName.MatchString(to) {
		return http.StatusBadGateway, sessiontools.Answer{Error: "Outrunner answered with no name: try again."}, nil
	}

	renamed, err := s.renameIn(ctx, dirs, f.Branch, to)
	if err != nil {
		return http.StatusConflict, sessiontools.Answer{Error: fmt.Sprintf("git couldn't rename the branch: %v", err)}, nil
	}
	status, answer, err = s.passOn(ctx, owner, RenameBranchTool, map[string]string{"phase": "commit", "from": f.Branch, "to": to})
	if err != nil || status/100 != 2 {
		// Outrunner keeps the old name, so git does too.
		if _, undoErr := s.renameIn(ctx, renamed, to, f.Branch); undoErr != nil {
			return http.StatusInternalServerError, sessiontools.Answer{Error: fmt.Sprintf("Outrunner refused the name and git couldn't put %s back: %v", f.Branch, undoErr)}, nil
		}
		return status, answer, err
	}

	from := f.Branch
	f.Branch, f.BranchRenamable = to, false
	s.setFacts(owner, f)
	s.markStandIns(dirs, to, false)
	// Its chats work in the same folder, on the same branch.
	for _, key := range s.chatKeys(owner) {
		if chat, ok := s.getFacts(key); ok {
			chat.Branch, chat.BranchRenamable = to, false
			s.setFacts(key, chat)
		}
	}
	text := fmt.Sprintf("Renamed the branch from %s to %s.", from, to)
	if to != strings.TrimSpace(in.Name) {
		text += fmt.Sprintf(" %s was taken, so it's numbered.", strings.TrimSpace(in.Name))
	}
	text += " It keeps this name now; push it with `git push -u origin HEAD`."
	return http.StatusOK, sessiontools.Answer{Text: text}, nil
}

// branchCheckouts are the folders on the session's branch: its worktree, or
// each repository's in a session of several.
func (s *Service) branchCheckouts(owner string, f workspaceFacts) []string {
	worktree := s.worktreePath(owner)
	if len(f.Checkouts) == 0 {
		return []string{worktree}
	}
	dirs := make([]string, 0, len(f.Checkouts))
	for _, c := range f.Checkouts {
		dirs = append(dirs, filepath.Join(worktree, c.Name))
	}
	return dirs
}

// renameIn renames branch from to to in each folder, in order. On a failure
// it puts back those it did and returns the error; else the folders done.
func (s *Service) renameIn(ctx context.Context, dirs []string, from, to string) ([]string, error) {
	var done []string
	for _, dir := range dirs {
		if _, err := s.git(ctx, dir, "branch", "-m", from, to); err != nil {
			for _, back := range done {
				_, _ = s.git(ctx, back, "branch", "-m", to, from)
			}
			return nil, fmt.Errorf("%s: %w", filepath.Base(dir), err)
		}
		done = append(done, dir)
	}
	return done, nil
}

// mayNameBranch reports whether the session's agent is to give its branch
// its real name: Outrunner made it up, the command can reach Outrunner, and
// the session is still on it. Read each launch, so once named (or switched
// away from) the agent isn't told again.
func (s *Service) mayNameBranch(workspaceID string, f workspaceFacts) bool {
	owner := s.owner(workspaceID)
	if owner != workspaceID {
		if parent, ok := s.getFacts(owner); ok {
			f = parent
		}
	}
	if !f.BranchRenamable || f.RepoPath != "" || f.Branch == "" || !s.SessionToolsEnabled() {
		return false
	}
	dirs := s.branchCheckouts(owner, f)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	head, err := s.git(ctx, dirs[0], "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || head != f.Branch {
		return false
	}
	// Each launch, so a worktree made since (a restore) has its push guard.
	s.markStandIns(dirs, f.Branch, true)
	return true
}

// branchNameNote tells the agent how to name its branch, in its orientation.
func branchNameNote(current string) string {
	return "# Branch name\n\n" +
		"The branch's name, `" + current + "`, is a stand-in made from the first message. " +
		"As soon as you know what the change is, before you edit your first file, give it its real name, once:\n\n" +
		"    " + sessiontools.CommandName + " rename-branch <type>/<what-it-does>\n\n" +
		"- <type> is the kind of change: fix, feat, refactor, docs, test, chore or perf. When the change is clearly about one area, that area instead (security, deps, ci). For mixed work, the type of the main change the user asked for.\n" +
		"- <what-it-does> is 2 to 5 lowercase words joined by hyphens, at most 40 characters, saying what the change does: fix/google-sign-in-redirect, feat/expandable-right-sidebar, perf/faster-ci-build.\n" +
		"- If the task names a Linear or GitHub issue, put its key first: fix/nee-268-mask-chat-secrets, fix/issue-266-box-oom.\n" +
		"- No ids, dates or tool names (outrunner/, claude/).\n" +
		"- If you only answer questions, investigate or ask what's meant, and edit nothing, leave it as it is. If you're asked to push to another branch or an existing pull request, leave it too.\n" +
		"- If the name is taken, the command numbers it (-2) and says so: use the name it prints. Once pushed, the branch keeps its name."
}
