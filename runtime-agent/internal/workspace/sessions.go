package workspace

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

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
		sessions = append(sessions, protocol.LocalSession{
			WorkspaceID: id,
			Name:        f.Name,
			Title:       f.Title,
			Folder:      f.RepoPath,
			Worktree:    s.worktreePath(id),
			Branch:      f.Branch,
			BaseBranch:  f.BaseBranch,
			InPlace:     f.InPlace,
			CreatedAt:   f.CreatedAt,
			Running:     s.SessionAlive(ctx, id),
		})
	}
	sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].CreatedAt > sessions[j].CreatedAt })
	return sessions
}
