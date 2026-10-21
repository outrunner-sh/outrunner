package localimport

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"runtime-agent/internal/transcript"
)

// sessionIDPattern is what a Claude or Codex session id looks like. One that
// doesn't match is never made into a path.
var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// claudeSessions are the transcripts in Claude Code's own folder: every
// session run in a terminal, and those Conductor and Outrunner ran for it.
func claudeSessions(opts Options) ([]Session, Source) {
	source := Source{ID: SourceClaudeCLI}
	projects := filepath.Join(opts.Home, ".claude", "projects")
	dirs, err := os.ReadDir(projects)
	if os.IsNotExist(err) {
		return nil, source
	}
	source.Found = true
	if err != nil {
		source.Skip = &Skip{Reason: SkipSourceUnreadable, Detail: err.Error()}
		return nil, source
	}
	var sessions []Session
	for _, dir := range dirs {
		if !dir.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(projects, dir.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			id, ok := strings.CutSuffix(f.Name(), ".jsonl")
			if f.IsDir() || !ok || !sessionIDPattern.MatchString(id) {
				continue
			}
			sessions = append(sessions, Session{
				Key:        AgentClaude + ":" + id,
				Source:     SourceClaudeCLI,
				Agent:      AgentClaude,
				SessionID:  id,
				Transcript: filepath.Join(projects, dir.Name(), f.Name()),
			})
		}
	}
	return sessions, source
}

// codexSessions are Codex's rollouts, one a session.
func codexSessions(opts Options, rollouts map[string]string) ([]Session, Source) {
	source := Source{ID: SourceCodexCLI}
	if _, err := os.Stat(filepath.Join(opts.Home, ".codex", "sessions")); err != nil {
		return nil, source
	}
	source.Found = true
	sessions := make([]Session, 0, len(rollouts))
	for id, path := range rollouts {
		sessions = append(sessions, Session{
			Key:        AgentCodex + ":" + id,
			Source:     SourceCodexCLI,
			Agent:      AgentCodex,
			SessionID:  id,
			Transcript: path,
		})
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Key < sessions[j].Key })
	return sessions, source
}

// rolloutName is how Codex names a rollout: its start time, then its id.
var rolloutName = regexp.MustCompile(`^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$`)

// indexRollouts maps each Codex session id to its rollout, by file name.
func indexRollouts(sessions string) map[string]string {
	index := map[string]string{}
	_ = filepath.WalkDir(sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if m := rolloutName.FindStringSubmatch(d.Name()); m != nil {
			index[m[1]] = path
		}
		return nil
	})
	return index
}

// conductorQueryTimeout bounds each read of Conductor's database, which
// Conductor may be writing: sqlite3 waits for its lock up to the busy timeout.
const conductorQueryTimeout = 15 * time.Second

// conductorRequired are the columns a session can't be read without; any
// other one missing (an older or newer Conductor) reads as empty.
var conductorRequired = map[string]bool{
	"repos.id": true, "repos.name": true,
	"workspaces.local_id": true, "workspaces.repository_id": true, "workspaces.branch": true,
	"sessions.workspace_id": true, "sessions.claude_session_id": true,
}

// conductorRow is one Conductor session with its workspace and repository.
type conductorRow struct {
	SessionID     *string `json:"session_id"`
	AgentType     *string `json:"agent_type"`
	Model         *string `json:"model"`
	Title         *string `json:"title"`
	Branch        *string `json:"branch"`
	State         *string `json:"state"`
	WorkspacePath *string `json:"workspace_path"`
	DirectoryName *string `json:"directory_name"`
	TargetBranch  *string `json:"intended_target_branch"`
	RepoName      *string `json:"repo_name"`
}

// conductorSessions are the sessions Conductor's database records, read-only
// through the sqlite3 every Mac has. Their transcripts are Claude Code's and
// Codex's own files; Conductor's copy of the messages is never read.
func conductorSessions(ctx context.Context, opts Options, rollouts map[string]string) ([]Session, Source) {
	source := Source{ID: SourceConductor}
	if opts.ConductorDB == "" {
		return nil, source
	}
	if _, err := os.Stat(opts.ConductorDB); err != nil {
		return nil, source
	}
	source.Found = true
	rows, skip := readConductor(ctx, opts.ConductorDB)
	if skip != nil {
		source.Skip = skip
		return nil, source
	}
	var sessions []Session
	for _, row := range rows {
		id := str(row.SessionID)
		if !sessionIDPattern.MatchString(id) {
			continue
		}
		agent := AgentClaude
		if str(row.AgentType) == AgentCodex {
			agent = AgentCodex
		}
		worktree := str(row.WorkspacePath)
		if worktree == "" && str(row.DirectoryName) != "" && str(row.RepoName) != "" {
			// Before Conductor recorded the path: its default workspaces folder.
			worktree = filepath.Join(opts.Home, "conductor", "workspaces", str(row.RepoName), str(row.DirectoryName))
		}
		s := Session{
			Key:            agent + ":" + id,
			Source:         SourceConductor,
			Agent:          agent,
			SessionID:      id,
			Model:          str(row.Model),
			Branch:         str(row.Branch),
			BaseBranch:     str(row.TargetBranch),
			ConductorState: str(row.State),
		}
		if title := str(row.Title); title != "Untitled" {
			s.Title = oneLine(title, titleRunes)
		}
		switch {
		case worktree == "":
			s.Skip = &Skip{Reason: SkipWorktreeMissing, Detail: "Conductor has no folder for this workspace"}
		case agent == AgentCodex:
			s.Transcript = rollouts[id]
		default:
			s.Transcript = filepath.Join(transcript.ClaudeProjectDir(opts.Home, worktree), id+".jsonl")
		}
		if s.Skip == nil && s.Transcript == "" {
			s.Skip = &Skip{Reason: SkipTranscriptMissing, Detail: "no Codex rollout for session " + id}
		}
		sessions = append(sessions, s)
	}
	return sessions, source
}

// readConductor reads Conductor's sessions, after checking it has the columns
// they are read from.
func readConductor(ctx context.Context, db string) ([]conductorRow, *Skip) {
	present, err := conductorColumns(ctx, db)
	if err != nil {
		return nil, &Skip{Reason: SkipSourceUnreadable, Detail: err.Error()}
	}
	var missing []string
	col := func(table, alias, name string) string {
		if present[table+"."+name] {
			return alias + "." + name
		}
		if conductorRequired[table+"."+name] {
			missing = append(missing, table+"."+name)
		}
		return "NULL"
	}
	selects := []string{
		col("sessions", "s", "claude_session_id") + " AS session_id",
		col("sessions", "s", "agent_type") + " AS agent_type",
		col("sessions", "s", "model") + " AS model",
		col("sessions", "s", "title") + " AS title",
		col("workspaces", "w", "branch") + " AS branch",
		col("workspaces", "w", "state") + " AS state",
		col("workspaces", "w", "workspace_path") + " AS workspace_path",
		col("workspaces", "w", "directory_name") + " AS directory_name",
		col("workspaces", "w", "intended_target_branch") + " AS intended_target_branch",
		col("repos", "r", "name") + " AS repo_name",
	}
	join := []string{
		col("sessions", "s", "workspace_id") + " = " + col("workspaces", "w", "local_id"),
		col("workspaces", "w", "repository_id") + " = " + col("repos", "r", "id"),
	}
	if len(missing) > 0 {
		return nil, &Skip{Reason: SkipUnknownConductorSchema, Detail: "this Conductor has no " + strings.Join(missing, ", ")}
	}
	query := fmt.Sprintf(`SELECT %s FROM sessions s JOIN workspaces w ON %s JOIN repos r ON %s
		WHERE s.claude_session_id IS NOT NULL AND s.claude_session_id <> ''`,
		strings.Join(selects, ", "), join[0], join[1])
	var rows []conductorRow
	if err := sqliteJSON(ctx, db, query, &rows); err != nil {
		return nil, &Skip{Reason: SkipSourceUnreadable, Detail: err.Error()}
	}
	return rows, nil
}

// conductorColumns are the "table.column"s Conductor's database has, of the
// tables an import reads.
func conductorColumns(ctx context.Context, db string) (map[string]bool, error) {
	var columns []struct {
		Table  string `json:"tbl"`
		Column string `json:"col"`
	}
	err := sqliteJSON(ctx, db, `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m
		JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN ('repos', 'workspaces', 'sessions', 'env_vars')`, &columns)
	if err != nil {
		return nil, err
	}
	present := map[string]bool{}
	for _, c := range columns {
		present[c.Table+"."+c.Column] = true
	}
	return present, nil
}

// sqliteJSON runs a read-only query on a database through the sqlite3 CLI
// and decodes its rows. Never a write: -readonly, and only SELECTs are passed.
func sqliteJSON(ctx context.Context, db, query string, into any) error {
	bin, err := sqliteBinary()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, conductorQueryTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-readonly", "-json", "-cmd", ".timeout 5000", db, query)
	out, err := cmd.Output()
	if err != nil {
		detail := err.Error()
		if exit, ok := err.(*exec.ExitError); ok && len(exit.Stderr) > 0 {
			detail = strings.TrimSpace(string(exit.Stderr))
		}
		return fmt.Errorf("could not read Conductor's database: %s", detail)
	}
	if len(strings.TrimSpace(string(out))) == 0 {
		out = []byte("[]") // sqlite3 prints nothing for no rows
	}
	if err := json.Unmarshal(out, into); err != nil {
		return fmt.Errorf("could not read Conductor's database: %v", err)
	}
	return nil
}

// sqliteBinary is the system's sqlite3: macOS ships it at /usr/bin.
func sqliteBinary() (string, error) {
	if _, err := os.Stat("/usr/bin/sqlite3"); err == nil {
		return "/usr/bin/sqlite3", nil
	}
	if path, err := exec.LookPath("sqlite3"); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("sqlite3 was not found, so Conductor's database can't be read")
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
