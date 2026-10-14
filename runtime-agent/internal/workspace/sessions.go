package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

// LocalSessions lists the local sessions this agent knows, newest first. The
// facts files are the record: they outlive agent restarts, and a session is
// forgotten (its file removed) only when destroyed.
func (s *Service) LocalSessions(ctx context.Context) []protocol.LocalSession {
	entries, err := os.ReadDir(filepath.Join(s.Root, "facts"))
	if err != nil {
		return []protocol.LocalSession{}
	}
	sessions := make([]protocol.LocalSession, 0, len(entries))
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || entry.IsDir() {
			continue
		}
		f, ok := s.getFacts(id)
		if !ok || f.RepoPath == "" {
			continue // not a local session (or unreadable)
		}
		// Facts written before sessions were named carry no name; the folder's
		// own name is what it would have been.
		name := f.Name
		if name == "" {
			name = filepath.Base(f.RepoPath)
		}
		sessions = append(sessions, protocol.LocalSession{
			WorkspaceID:  id,
			Name:         name,
			Title:        f.Title,
			Folder:       f.RepoPath,
			Worktree:     s.worktreePath(id),
			Branch:       f.Branch,
			BaseBranch:   f.BaseBranch,
			InPlace:      f.InPlace,
			CreatedAt:    f.CreatedAt,
			LastActiveAt: s.lastActiveAt(id, f),
			Running:      s.SessionAlive(ctx, id),
			Model:        f.Model,
			Gateway:      string(f.Gateway),
			Repo:         githubRepo(ctx, f.RepoPath),
		})
	}
	sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].CreatedAt > sessions[j].CreatedAt })
	return sessions
}

// lastActiveAt is when Claude last wrote this session's transcript (every turn
// appends to it), else its creation time: a session not yet talked to was last
// active when it was made. Also its creation time when the transcript found
// might be someone else's (ownsTranscript): an age that is old is better than
// one borrowed from another session.
func (s *Service) lastActiveAt(workspaceID string, f workspaceFacts) string {
	if s.ownsTranscript(f) {
		if log := s.SessionLog(workspaceID); log != "" {
			if info, err := os.Stat(log); err == nil {
				return info.ModTime().UTC().Format(time.RFC3339)
			}
		}
	}
	return f.CreatedAt
}

// ownsTranscript is whether SessionLog can only be this session's: the jcode
// engine keeps one log per workspace, a session with a ClaudeSessionID is
// found by that id, and any other session but an in-place one works in its
// own worktree, whose Claude project directory is its alone. An in-place
// session from before ClaudeSessionID shares the folder's directory with other
// sessions (and the user's own Claude Code), where "the newest log" may be
// anyone's.
func (s *Service) ownsTranscript(f workspaceFacts) bool {
	return s.jcode != nil || f.ClaudeSessionID != "" || !f.InPlace
}

// githubRepo is the GitHub repository (`owner/name`) a folder is a clone of,
// read from its origin remote; empty for a folder that isn't one. A session
// can be continued in the cloud only on a repository Outrunner can clone.
func githubRepo(ctx context.Context, folder string) string {
	out, err := exec.CommandContext(ctx, "git", "-C", folder, "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return ""
	}
	return githubRepoFromURL(strings.TrimSpace(string(out)))
}

// githubURL matches a GitHub remote over HTTPS or SSH, either spelling:
// https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r.
var githubURL = regexp.MustCompile(`^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$`)

func githubRepoFromURL(url string) string {
	m := githubURL.FindStringSubmatch(url)
	if m == nil {
		return ""
	}
	return m[1] + "/" + m[2]
}
