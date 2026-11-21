package workspace

import (
	"context"
	"os"
	"strconv"
	"strings"
)

// AgentAlive reports whether the agent of a session (or one of its chats,
// by key) runs: its tmux session exists. Claude is launched with exec in
// that session, so the session ends with it. known is false where that can't
// be told: the jcode engine, which has no tmux session, or tmux not
// answering, which is not taken for the agent gone.
func (s *Service) AgentAlive(ctx context.Context, key string) (alive, known bool) {
	if s.jcode != nil {
		return false, false
	}
	exists, err := s.tmux.SessionExists(ctx, sessionName(key))
	if err != nil {
		return false, false
	}
	return exists, true
}

// MemoryEventsPath is the box's cgroup memory events, whose oom_kill counts
// the processes the kernel killed for memory. A var for tests.
var MemoryEventsPath = "/sys/fs/cgroup/memory.events"

// OOMKills is how many processes the kernel has killed on this box because
// its memory ran out, from the cgroup's memory.events; ok is false where
// that isn't there to read (no cgroup v2, a Mac).
func OOMKills() (n int64, ok bool) {
	data, err := os.ReadFile(MemoryEventsPath)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "oom_kill" {
			n, err := strconv.ParseInt(fields[1], 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}
