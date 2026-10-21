package localimport

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// conductorDB builds a Conductor database from a schema in testdata, in WAL
// mode as Conductor runs it, with one repository, workspace and session.
func conductorDB(t *testing.T, opts Options, schema, extra string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(opts.ConductorDB), 0o755); err != nil {
		t.Fatal(err)
	}
	sqliteExec(t, opts.ConductorDB, "PRAGMA journal_mode=WAL;\n"+readTestdata(t, schema)+`
		INSERT INTO repos (id, name, root_path, remote_url) VALUES ('r1', 'app', '/elsewhere', 'https://github.com/ada/app.git');
		INSERT INTO workspaces (local_id, repository_id, directory_name, branch, state, intended_target_branch)
			VALUES ('w1', 'r1', 'app-ws', 'feature', 'ready', 'develop');
		INSERT INTO sessions (id, workspace_id, claude_session_id, agent_type) VALUES ('cs1', 'w1', 's-1', 'claude');
	`+extra)
}

// holdWriteLock opens the database in another sqlite3 and leaves a write
// transaction open, as Conductor mid-write would, until the test ends.
func holdWriteLock(t *testing.T, db string) {
	t.Helper()
	bin, err := sqliteBinary()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, db)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); _ = cmd.Wait() })
	fmt.Fprintln(stdin, "BEGIN IMMEDIATE; INSERT INTO repos (id, name) VALUES ('r2', 'uncommitted');\n.print locked")
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || strings.TrimSpace(line) != "locked" {
		t.Fatalf("writer did not take the lock: %q %v", line, err)
	}
}

// Conductor's database is read whichever of its versions wrote it — a column
// this Conductor lacks reads as empty — and while Conductor is writing it.
// Its sessions come once, as Conductor's, though Claude's folder has them too.
func TestScanReadsConductorAcrossVersions(t *testing.T) {
	for _, tc := range []struct {
		schema    string
		extra     string
		wantTitle string
	}{
		{
			schema:    "conductor-current.sql",
			extra:     `UPDATE workspaces SET workspace_path = '%s'; UPDATE sessions SET title = 'Fix login', model = 'opus';`,
			wantTitle: "Fix login",
		},
		// No title column: the transcript's own title, from its end.
		{schema: "conductor-old.sql", wantTitle: "Login flow fix"},
	} {
		t.Run(tc.schema, func(t *testing.T) {
			home, opts := testHome(t)
			// Where Conductor puts a workspace: found from its folder name when
			// the database has no path for it.
			clone := filepath.Join(home, "conductor", "workspaces", "app", "app-ws")
			if err := os.MkdirAll(filepath.Dir(clone), 0o755); err != nil {
				t.Fatal(err)
			}
			repoWithOrigin(t, clone)
			gitIn(t, clone, "checkout", "-q", "-b", "feature")
			extra := tc.extra
			if strings.Contains(extra, "%s") {
				extra = fmt.Sprintf(extra, clone)
			}
			conductorDB(t, opts, tc.schema, extra)
			holdWriteLock(t, opts.ConductorDB)

			// Over 64 KB, so its end is read apart from its start.
			lines := []string{claudeLineJSON(t, "user", clone, "feature", "2026-10-20T10:00:00Z",
				"<system_instruction>\nYou are working inside Conductor.\n</system_instruction>\n\nfix the login flow")}
			for i := range 300 {
				lines = append(lines, claudeLineJSON(t, "assistant", clone, "feature", "2026-10-20T10:01:00Z", strings.Repeat("working ", 40)+fmt.Sprint(i)))
			}
			lines = append(lines,
				`{"type":"ai-title","aiTitle":"Login flow fix","sessionId":"s-1"}`,
				claudeLineJSON(t, "assistant", clone, "feature", "2026-10-20T11:00:00Z", "All done."))
			writeClaudeSession(t, home, clone, "s-1", lines...)

			scan := Run(context.Background(), opts)

			if src := sourceByID(t, scan, SourceConductor); !src.Found || src.Skip != nil {
				t.Fatalf("conductor source = %+v", src)
			}
			s := sessionByKey(t, scan, "claude:s-1")
			if len(scan.Sessions) != 1 {
				t.Errorf("found %d sessions, want the one", len(scan.Sessions))
			}
			if s.Skip != nil {
				t.Fatalf("session skipped: %+v", s.Skip)
			}
			want := Session{
				Key: "claude:s-1", Source: SourceConductor, Agent: AgentClaude, SessionID: "s-1",
				Title: tc.wantTitle, Cwd: clone, Worktree: clone, Repo: "ada/app",
				Branch: "feature", BaseBranch: "develop", CheckedOut: true,
				StartedAt: "2026-10-20T10:00:00Z", UpdatedAt: "2026-10-20T11:00:00Z",
				LastMessage: "All done.", ConductorState: "ready",
			}
			want.Model, want.Transcript, want.TranscriptBytes = s.Model, s.Transcript, s.TranscriptBytes
			if s != want {
				t.Errorf("session =\n%+v\nwant\n%+v", s, want)
			}
		})
	}
}

// A workspace archived in Conductor isn't offered: not as Conductor's, and not
// as the Claude Code session its transcript also is. Its live neighbour is.
func TestScanLeavesOutConductorsArchivedWorkspaces(t *testing.T) {
	home, opts := testHome(t)
	clone := filepath.Join(home, "app")
	repoWithOrigin(t, clone)
	gitIn(t, clone, "checkout", "-q", "-b", "feature")
	conductorDB(t, opts, "conductor-current.sql", fmt.Sprintf(`
		UPDATE workspaces SET workspace_path = '%[1]s';
		INSERT INTO workspaces (local_id, repository_id, directory_name, branch, state, workspace_path)
			VALUES ('w2', 'r1', 'app-old', 'feature', 'archived', '%[1]s');
		INSERT INTO sessions (id, workspace_id, claude_session_id, agent_type) VALUES ('cs2', 'w2', 's-2', 'claude');
	`, clone))
	for _, id := range []string{"s-1", "s-2"} {
		writeClaudeSession(t, home, clone, id, claudeLineJSON(t, "user", clone, "feature", "2026-10-20T10:00:00Z", "hi"))
	}

	scan := Run(context.Background(), opts)

	if s := sessionByKey(t, scan, "claude:s-1"); s.Source != SourceConductor {
		t.Errorf("live workspace's session = %+v, want it offered as Conductor's", s)
	}
	for _, s := range scan.Sessions {
		if s.Key == "claude:s-2" {
			t.Errorf("archived workspace's session offered: %+v", s)
		}
	}
}

// A Conductor whose database this importer can't read says so, and every
// other source is still scanned.
func TestScanSurvivesAnUnknownConductor(t *testing.T) {
	home, opts := testHome(t)
	clone := filepath.Join(home, "app")
	repoWithOrigin(t, clone)
	if err := os.MkdirAll(filepath.Dir(opts.ConductorDB), 0o755); err != nil {
		t.Fatal(err)
	}
	sqliteExec(t, opts.ConductorDB, readTestdata(t, "conductor-unknown.sql")+
		`INSERT INTO sessions (id, workspace_id, agent_session_id) VALUES ('cs1', 'w1', 's-1');`)
	writeClaudeSession(t, home, clone, "s-2",
		claudeLineJSON(t, "user", clone, "main", "2026-10-20T10:00:00Z", "hello"))

	scan := Run(context.Background(), opts)

	src := sourceByID(t, scan, SourceConductor)
	if src.Skip == nil || src.Skip.Reason != SkipUnknownConductorSchema || !strings.Contains(src.Skip.Detail, "sessions.claude_session_id") {
		t.Errorf("conductor source = %+v, want unknown-conductor-schema naming the column", src)
	}
	if s := sessionByKey(t, scan, "claude:s-2"); s.Source != SourceClaudeCLI || s.Skip != nil {
		t.Errorf("claude session = %+v, want it found and importable", s)
	}
}

// Every session that can't be imported says why.
func TestScanSaysWhyASessionCantBeImported(t *testing.T) {
	home, opts := testHome(t)
	good := filepath.Join(home, "good")
	repoWithOrigin(t, good)

	gone := filepath.Join(home, "gone")
	plain := filepath.Join(home, "plain")
	gitIn(t, home, "init", "-q", plain)
	gitIn(t, plain, "remote", "add", "origin", "https://gitlab.com/ada/app.git")
	notGit := filepath.Join(home, "not-git")
	writeFile(t, filepath.Join(notGit, "x.txt"), "x")

	session := func(id, cwd, branch string) {
		writeClaudeSession(t, home, cwd, id, claudeLineJSON(t, "user", cwd, branch, "2026-10-20T10:00:00Z", "hi"))
	}
	session("ok", good, "main")
	session("gone", gone, "main")
	session("plain", plain, "main")
	session("not-git", notGit, "main")
	session("deleted-branch", good, "was-here")
	// A Codex session: its branch from the rollout's own record of git.
	meta, _ := json.Marshal(map[string]any{"type": "session_meta", "timestamp": "2026-10-20T09:00:00Z",
		"payload": map[string]any{"id": "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", "cwd": good, "timestamp": "2026-10-20T09:00:00Z",
			"git": map[string]any{"branch": "main"}}})
	writeFile(t, filepath.Join(home, ".codex", "sessions", "2026", "10", "20",
		"rollout-2026-10-20T09-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl"), string(meta)+"\n")

	scan := Run(context.Background(), opts)

	for key, want := range map[string]string{
		"claude:ok": "",
		"codex:0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000": "",
		"claude:gone":           SkipWorktreeMissing,
		"claude:plain":          SkipNoGitHubRemote,
		"claude:not-git":        SkipNoGitHubRemote,
		"claude:deleted-branch": SkipBranchMissing,
	} {
		s := sessionByKey(t, scan, key)
		got := ""
		if s.Skip != nil {
			got = s.Skip.Reason
		}
		if got != want {
			t.Errorf("%s skipped for %q (%+v), want %q", key, got, s.Skip, want)
		}
	}
	if s := sessionByKey(t, scan, "codex:0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000"); s.Branch != "main" || s.Repo != "ada/app" {
		t.Errorf("codex session = %+v, want ada/app on main", s)
	}
}
