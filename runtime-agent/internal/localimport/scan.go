// Package localimport finds the coding sessions on someone's own Mac that can
// move to Outrunner's cloud — Conductor workspaces, Claude Code and Codex run
// from a terminal, Outrunner's own local sessions — and captures one as the
// artifacts a Snapshot is made of.
//
// It runs as `runtime-agent import`, spawned by the desktop app, never as a
// route on a computer: what it reads is the user's home. A scan reports what
// it found and, for anything that can't be imported, why; it never fails as
// a whole over one source. Capture takes a session's key, not paths: it finds
// the session again and reads only what the scan would have.
package localimport

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ScanVersion is the version of the Scan document. Bump on a breaking change;
// lib/runtime/import-scan.fixtures.json is the shared example both sides test.
const ScanVersion = 1

// Where a session was found.
const (
	SourceConductor      = "conductor"
	SourceClaudeCLI      = "claude-cli"
	SourceCodexCLI       = "codex-cli"
	SourceOutrunnerLocal = "outrunner-local"
)

// The agents a session can run, as Outrunner names them.
const (
	AgentClaude = "claude"
	AgentCodex  = "codex"
)

// Why something can't be imported. One list for the scan, the server's plan
// and the picker; the server adds those only it can know (repo access, a
// branch already in the cloud, an earlier import).
const (
	SkipNoGitHubRemote         = "no-github-remote"
	SkipNoRepoAccess           = "no-repo-access"
	SkipWorktreeMissing        = "worktree-missing"
	SkipBranchMissing          = "branch-missing"
	SkipBranchTaken            = "branch-taken"
	SkipTooLarge               = "too-large"
	SkipAlreadyImported        = "already-imported"
	SkipUnportableMCP          = "unportable-mcp"
	SkipUnknownConductorSchema = "unknown-conductor-schema"
	SkipSourceUnreadable       = "source-unreadable"
	SkipTranscriptMissing      = "transcript-missing"
)

// MaxTranscriptBytes is the largest transcript imported. It is stored
// compressed (about a tenth), well under the snapshot bucket's limit.
const MaxTranscriptBytes = 400 << 20

// Skip says why something can't be imported.
type Skip struct {
	Reason string `json:"reason"`
	// Detail is for the user: what exactly was missing or wrong.
	Detail string `json:"detail,omitempty"`
}

// Scan is everything found on this Mac.
type Scan struct {
	Version   int       `json:"version"`
	ScannedAt string    `json:"scannedAt"`
	Sources   []Source  `json:"sources"`
	Sessions  []Session `json:"sessions"`
	// Projects are the repositories' environments: names only.
	Projects []ProjectEnv `json:"projects"`
}

// Source is one place sessions are looked for.
type Source struct {
	ID string `json:"id"`
	// Found is whether the tool keeps anything here (it is installed and used).
	Found bool `json:"found"`
	// Skip is set when it is there but could not be read.
	Skip *Skip `json:"skip,omitempty"`
}

// Session is one conversation and the checkout it worked in.
type Session struct {
	// Key names the session across scans and machines: "<agent>:<session id>".
	Key       string `json:"key"`
	Source    string `json:"source"`
	Agent     string `json:"agent"`
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Model     string `json:"model,omitempty"`
	// Cwd is where the agent ran, as its transcript records it; Restore puts
	// the box's worktree in its place.
	Cwd string `json:"cwd"`
	// Worktree is the top of the git checkout Cwd is in.
	Worktree string `json:"worktree,omitempty"`
	// Repo is the checkout's GitHub repository, "owner/name".
	Repo       string `json:"repo,omitempty"`
	Branch     string `json:"branch,omitempty"`
	BaseBranch string `json:"baseBranch,omitempty"`
	// CheckedOut is whether the checkout is on Branch now: only then do its
	// uncommitted changes belong to the session and come along.
	CheckedOut bool `json:"checkedOut"`
	Dirty      bool `json:"dirty"`
	// Unpushed counts Branch's commits on no remote: what the bundle carries.
	Unpushed        int    `json:"unpushed"`
	Transcript      string `json:"transcript"`
	TranscriptBytes int64  `json:"transcriptBytes"`
	StartedAt       string `json:"startedAt,omitempty"`
	UpdatedAt       string `json:"updatedAt,omitempty"`
	LastMessage     string `json:"lastMessage,omitempty"`
	// ConductorState is the Conductor workspace's state ("ready", "archived").
	ConductorState string `json:"conductorState,omitempty"`
	Skip           *Skip  `json:"skip,omitempty"`
}

// Options says where to look. Every path is the user's; tests point them at
// a scratch home.
type Options struct {
	Home string
	// ConductorDB is Conductor's database; "" or missing means no Conductor.
	ConductorDB string
	// OutrunnerRoot is the desktop app's own root (~/.outrunner): sessions
	// under its workspaces are Outrunner's local sessions.
	OutrunnerRoot string
	// CachePath keeps what was read of each transcript, by its size and
	// modification time, for the next scan; "" keeps nothing.
	CachePath string
	Now       func() time.Time
}

// DefaultOptions are the real places on a Mac.
func DefaultOptions(home string) Options {
	return Options{
		Home:          home,
		ConductorDB:   filepath.Join(home, "Library", "Application Support", "com.conductor.app", "conductor.db"),
		OutrunnerRoot: filepath.Join(home, ".outrunner"),
		CachePath:     filepath.Join(home, ".outrunner", "import-scan.json"),
		Now:           time.Now,
	}
}

// scanWorkers is how many transcripts are read, and checkouts inspected, at once.
const scanWorkers = 8

// Run finds every session on this Mac.
func Run(ctx context.Context, opts Options) Scan {
	sessions, sources := discover(ctx, opts, "")
	return Scan{
		Version:   ScanVersion,
		ScannedAt: opts.now().UTC().Format(time.RFC3339),
		Sources:   sources,
		Sessions:  sessions,
		Projects:  projectEnvs(ctx, opts, sessions),
	}
}

// Locate finds one session again by its key; ok is false when it is gone.
func Locate(ctx context.Context, opts Options, key string) (Session, bool) {
	sessions, _ := discover(ctx, opts, key)
	for _, s := range sessions {
		if s.Key == key {
			return s, true
		}
	}
	return Session{}, false
}

// discover gathers sessions from every source, each found once (a Conductor
// session is also in Claude's or Codex's folders: Conductor's record of it
// wins), then completes them from their transcripts and checkouts. With a key,
// only that session is completed.
func discover(ctx context.Context, opts Options, key string) ([]Session, []Source) {
	cache := loadCache(opts.CachePath)
	rollouts := indexRollouts(filepath.Join(opts.Home, ".codex", "sessions"))

	conductor, conductorSource := conductorSessions(ctx, opts, rollouts)
	claude, claudeSource := claudeSessions(opts)
	codexes, codexSource := codexSessions(opts, rollouts)

	seen := map[string]bool{}
	var found []Session
	for _, group := range [][]Session{conductor, claude, codexes} {
		for _, s := range group {
			if seen[s.Key] || (key != "" && s.Key != key) {
				continue
			}
			seen[s.Key] = true
			found = append(found, s)
		}
	}

	checkouts := newCheckouts()
	var wg sync.WaitGroup
	work := make(chan int)
	for range scanWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				complete(ctx, &found[i], opts, cache, checkouts)
			}
		}()
	}
	for i := range found {
		work <- i
	}
	close(work)
	wg.Wait()

	// A transcript with no conversation in it (a one-shot run that never got
	// a prompt) has nothing to resume.
	sessions := found[:0]
	for _, s := range found {
		if s.Cwd != "" || s.Skip != nil {
			sessions = append(sessions, s)
		}
	}
	sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].UpdatedAt > sessions[j].UpdatedAt })
	if key == "" {
		cache.save(opts.CachePath)
	}
	return sessions, []Source{conductorSource, claudeSource, codexSource}
}

// complete fills in a session from its transcript and its checkout.
func complete(ctx context.Context, s *Session, opts Options, cache *scanCache, checkouts *checkouts) {
	if s.Skip != nil {
		return
	}
	facts, size, err := cache.facts(s.Agent, s.Transcript)
	if err != nil {
		s.Skip = &Skip{Reason: SkipTranscriptMissing, Detail: s.Transcript}
		return
	}
	s.TranscriptBytes = size
	s.merge(facts)
	if s.Cwd == "" {
		return // nothing in it to resume; dropped
	}
	if under(s.Cwd, filepath.Join(opts.OutrunnerRoot, "workspaces")) {
		s.Source = SourceOutrunnerLocal
	}
	if size > MaxTranscriptBytes {
		s.Skip = &Skip{Reason: SkipTooLarge, Detail: "the conversation is over 400 MB"}
		return
	}
	checkouts.inspect(ctx, s)
}

// merge takes what the transcript says where the source said nothing.
func (s *Session) merge(f transcriptFacts) {
	if s.Cwd == "" {
		s.Cwd = f.Cwd
	}
	if s.Branch == "" {
		s.Branch = f.Branch
	}
	if s.Title == "" {
		s.Title = f.Title
	}
	if s.Model == "" {
		s.Model = f.Model
	}
	if s.StartedAt == "" {
		s.StartedAt = f.StartedAt
	}
	s.UpdatedAt = f.UpdatedAt
	s.LastMessage = f.LastMessage
}

func (o Options) now() time.Time {
	if o.Now == nil {
		return time.Now()
	}
	return o.Now()
}

// under reports whether path is dir or inside it.
func under(path, dir string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
