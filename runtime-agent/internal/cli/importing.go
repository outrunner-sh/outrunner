package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"

	"runtime-agent/internal/localimport"
)

// Importing: bring the sessions on this computer (Conductor, Claude Code,
// Codex) to Outrunner, as the Mac app's import does (lib/imports/client.ts):
// scan, let the user pick, have the server plan them (a workspace and upload
// URLs each), capture and upload each one, then commit it. The routes are the
// Mac app's, signed in by the CLI's token.

// sourceLabels are the sources as the user knows them (IMPORT_SOURCE_LABELS).
var sourceLabels = map[string]string{
	"conductor":  "Conductor",
	"claude-cli": "Claude Code",
	"codex-cli":  "Codex",
}

// skipText says why a session can't come, as the page does (SKIP_TEXT).
var skipText = map[string]string{
	"no-github-remote":         "Its folder isn't a GitHub repository.",
	"no-repo-access":           "Your GitHub account can't see its repository.",
	"worktree-missing":         "Its folder is gone.",
	"branch-missing":           "Its branch is gone.",
	"branch-taken":             "Its branch is already a session's in this project.",
	"too-large":                "It's too large to import.",
	"already-imported":         "It was imported already.",
	"unportable-mcp":           "It needs something that only runs on this computer.",
	"unknown-conductor-schema": "This version of Conductor can't be read yet.",
	"source-unreadable":        "Couldn't read it.",
	"transcript-missing":       "Its conversation is gone.",
}

// uploadNote is what the user agrees to by importing (IMPORT_UPLOAD_NOTE).
const uploadNote = "Each session's unpushed commits, uncommitted changes and full conversation are uploaded to your Outrunner cloud. A conversation can include anything its agent read, secrets too."

func skipMessage(skip localimport.Skip) string {
	if text, ok := skipText[skip.Reason]; ok {
		return text
	}
	return "It can't be imported."
}

// importable is a session the server can plan: a GitHub repository and a
// branch, and nothing the scan already ruled out.
func importable(s localimport.Session) bool {
	return s.Repo != "" && s.Branch != "" && s.Skip == nil
}

// sessionLine is how a session reads in the list.
func sessionLine(s localimport.Session) string {
	title := s.Title
	if title == "" {
		title = s.SessionID
	}
	if r := []rune(title); len(r) > 60 {
		title = string(r[:59]) + "…"
	}
	facts := []string{}
	if s.Unpushed > 0 {
		noun := "commits"
		if s.Unpushed == 1 {
			noun = "commit"
		}
		facts = append(facts, fmt.Sprintf("%d unpushed %s", s.Unpushed, noun))
	}
	if s.CheckedOut && s.Dirty {
		facts = append(facts, "uncommitted changes")
	}
	if !s.CheckedOut {
		facts = append(facts, "committed work only")
	}
	facts = append(facts, fmt.Sprintf("%.1f MB conversation", float64(s.TranscriptBytes)/1_000_000))
	return fmt.Sprintf("%s\n      %s · %s · %s · %s", title, s.Repo, s.Branch, sourceLabels[s.Source], strings.Join(facts, ", "))
}

// parsePick reads which of n sessions the user picked: "all" is all of them,
// "none" none, else numbers and ranges ("1,3", "2-4", "1 5"). Enter is all
// when emptyIsAll, else none.
func parsePick(answer string, n int, emptyIsAll bool) ([]int, error) {
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer == "" {
		answer = "none"
		if emptyIsAll {
			answer = "all"
		}
	}
	switch answer {
	case "a", "all", "y", "yes":
		picked := make([]int, n)
		for i := range picked {
			picked[i] = i
		}
		return picked, nil
	case "none", "n", "no", "0":
		return nil, nil
	}
	seen := map[int]bool{}
	for _, part := range strings.FieldsFunc(answer, func(r rune) bool { return r == ',' || r == ' ' }) {
		from, to, isRange := strings.Cut(part, "-")
		if !isRange {
			to = from
		}
		a, errA := strconv.Atoi(from)
		b, errB := strconv.Atoi(to)
		if errA != nil || errB != nil || a < 1 || b > n || a > b {
			return nil, fmt.Errorf("%q isn't one of 1 to %d", part, n)
		}
		for i := a; i <= b; i++ {
			seen[i-1] = true
		}
	}
	picked := make([]int, 0, len(seen))
	for i := range seen {
		picked = append(picked, i)
	}
	sort.Ints(picked)
	return picked, nil
}

// planSession is one session asked for (ImportPlanRequest).
type planSession struct {
	Key    string `json:"key"`
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
}

// planItem is what the server says of a session (ImportPlanItem).
type planItem struct {
	Key         string            `json:"key"`
	Status      string            `json:"status"`
	WorkspaceID string            `json:"workspaceId"`
	ProjectID   string            `json:"projectId"`
	Branch      string            `json:"branch"`
	Renamed     bool              `json:"renamed"`
	ImportedAt  string            `json:"importedAt"`
	Uploads     map[string]upload `json:"uploads"`
	Skip        *localimport.Skip `json:"skip"`
}

type upload struct {
	URL  string `json:"url"`
	Path string `json:"path"`
}

type receipt struct {
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	Encoding string `json:"encoding,omitempty"`
}

// commitRequest is one session, uploaded (ImportCommitRequest).
type commitRequest struct {
	WorkspaceID  string             `json:"workspaceId"`
	ProjectID    string             `json:"projectId"`
	ImportedAt   string             `json:"importedAt"`
	Key          string             `json:"key"`
	Source       string             `json:"source"`
	Agent        string             `json:"agent"`
	SessionID    string             `json:"sessionId"`
	Branch       string             `json:"branch"`
	BundleRef    string             `json:"bundleRef"`
	Title        string             `json:"title"`
	Worktree     string             `json:"worktree"`
	StartedAt    string             `json:"startedAt,omitempty"`
	LastCommit   string             `json:"lastCommit"`
	Unpushed     int                `json:"unpushed"`
	ChangedFiles int                `json:"changedFiles"`
	LastMessage  string             `json:"lastMessage,omitempty"`
	Artifacts    map[string]receipt `json:"artifacts"`
}

// commitRequestFor is what the server is told of a session captured and
// uploaded, as the page tells it (commitRequestFor in lib/imports/client.ts).
func commitRequestFor(item planItem, c localimport.Capture) (commitRequest, error) {
	s := c.Session
	artifacts := map[string]receipt{}
	for _, kind := range []string{"bundle", "patch", "conversation", "rollout"} {
		if a, ok := c.Artifacts[kind]; ok {
			artifacts[kind] = receipt{SHA256: a.SHA256, Size: a.Size, Encoding: a.Encoding}
		}
	}
	for _, kind := range []string{"bundle", "patch", "conversation"} {
		if _, ok := artifacts[kind]; !ok || s.Worktree == "" || s.Branch == "" {
			return commitRequest{}, errors.New("the capture of this session is incomplete")
		}
	}
	return commitRequest{
		WorkspaceID:  item.WorkspaceID,
		ProjectID:    item.ProjectID,
		ImportedAt:   item.ImportedAt,
		Key:          s.Key,
		Source:       s.Source,
		Agent:        s.Agent,
		SessionID:    s.SessionID,
		Branch:       item.Branch,
		BundleRef:    s.Branch,
		Title:        cutUTF16(s.Title, 200),
		Worktree:     s.Worktree,
		StartedAt:    s.StartedAt,
		LastCommit:   c.LastCommit,
		Unpushed:     s.Unpushed,
		ChangedFiles: c.ChangedFiles,
		LastMessage:  cutUTF16(s.LastMessage, 2000),
		Artifacts:    artifacts,
	}, nil
}

// cutUTF16 cuts s to at most n UTF-16 code units, the length the server's
// checks count, never inside a character.
func cutUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		size := 1
		if r >= 0x10000 {
			size = 2 // a surrogate pair
		}
		if units+size > n {
			return s[:i]
		}
		units += size
	}
	return s
}

// importDeps are an import's collaborators, passed in so it tests without a
// real computer's sessions or the network.
type importDeps struct {
	capture func(ctx context.Context, key, out string) (localimport.Capture, error)
	upload  func(ctx context.Context, c localimport.Capture, urls map[string]string) error
	plan    func(ctx context.Context, sessions []planSession) ([]planItem, error)
	commit  func(ctx context.Context, req commitRequest) (string, error)
}

// importSessions plans the picked sessions and brings over each one it can,
// one at a time, printing how each went. It returns how many came.
func importSessions(ctx context.Context, picked []localimport.Session, url string, deps importDeps, out io.Writer) (int, error) {
	asked := make([]planSession, len(picked))
	byKey := map[string]localimport.Session{}
	for i, s := range picked {
		asked[i] = planSession{Key: s.Key, Source: s.Source, Agent: s.Agent, Repo: s.Repo, Branch: s.Branch}
		byKey[s.Key] = s
	}
	items, err := deps.plan(ctx, asked)
	if err != nil {
		return 0, err
	}

	imported := 0
	for _, item := range items {
		s := byKey[item.Key]
		name := s.Title
		if name == "" {
			name = s.SessionID
		}
		if r := []rune(name); len(r) > 60 {
			name = string(r[:59]) + "…"
		}
		if item.Status != "ready" {
			reason := "It can't be imported."
			if item.Skip != nil {
				reason = skipMessage(*item.Skip)
			}
			fmt.Fprintf(out, "  – %s: skipped. %s\n", name, reason)
			continue
		}
		fmt.Fprintf(out, "  ↑ %s: uploading…\n", name)
		id, err := importOne(ctx, item, deps)
		var skip *localimport.SkipError
		switch {
		case errors.As(err, &skip):
			fmt.Fprintf(out, "  – %s: skipped. %s\n", name, skipMessage(skip.Skip))
		case err != nil:
			fmt.Fprintf(out, "  ✗ %s: %v\n", name, err)
		default:
			imported++
			renamed := ""
			if item.Renamed {
				renamed = fmt.Sprintf(" as %s", item.Branch)
			}
			fmt.Fprintf(out, "  ✓ %s: imported%s\n      %s/workspaces/%s\n", name, renamed, url, id)
		}
	}
	return imported, nil
}

func importOne(ctx context.Context, item planItem, deps importDeps) (string, error) {
	dir, err := os.MkdirTemp("", "outrunner-import-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	captured, err := deps.capture(ctx, item.Key, dir)
	if err != nil {
		return "", err
	}
	urls := map[string]string{}
	for kind, u := range item.Uploads {
		urls[kind] = u.URL
	}
	if err := deps.upload(ctx, captured, urls); err != nil {
		return "", fmt.Errorf("upload: %w", err)
	}
	req, err := commitRequestFor(item, captured)
	if err != nil {
		return "", err
	}
	return deps.commit(ctx, req)
}

// liveImportDeps capture this computer's sessions and reach the app.
func liveImportDeps(url, token string, opts localimport.Options) importDeps {
	client := httpClient(nil)
	return importDeps{
		capture: func(ctx context.Context, key, out string) (localimport.Capture, error) {
			return localimport.CaptureSession(ctx, opts, key, out)
		},
		upload: localimport.Upload,
		plan: func(ctx context.Context, sessions []planSession) ([]planItem, error) {
			var answer struct {
				Items []planItem `json:"items"`
			}
			err := postJSON(ctx, client, url+"/api/imports", token, map[string]any{"sessions": sessions}, &answer)
			return answer.Items, err
		},
		commit: func(ctx context.Context, req commitRequest) (string, error) {
			var answer struct {
				Workspace struct {
					ID string `json:"id"`
				} `json:"workspace"`
			}
			err := postJSON(ctx, client, url+"/api/imports/commit", token, req, &answer)
			return answer.Workspace.ID, err
		},
	}
}

func postJSON(ctx context.Context, client *http.Client, endpoint, token string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	return do(client, req, out)
}

// nothingToImport says why no session can come: none found, or each one's
// reason, most common first.
func nothingToImport(sessions []localimport.Session) string {
	if len(sessions) == 0 {
		return "No sessions found on this computer in Conductor, Claude Code or Codex."
	}
	counts := map[string]int{}
	for _, s := range sessions {
		reason := "It isn't in a GitHub repository on a branch."
		if s.Skip != nil {
			reason = skipMessage(*s.Skip)
		}
		counts[reason]++
	}
	reasons := make([]string, 0, len(counts))
	for reason := range counts {
		reasons = append(reasons, reason)
	}
	sort.Slice(reasons, func(i, j int) bool {
		if counts[reasons[i]] != counts[reasons[j]] {
			return counts[reasons[i]] > counts[reasons[j]]
		}
		return reasons[i] < reasons[j]
	})
	noun := "sessions"
	if len(sessions) == 1 {
		noun = "session"
	}
	lines := []string{fmt.Sprintf("Found %d %s on this computer, but none can be imported:", len(sessions), noun)}
	for _, reason := range reasons {
		lines = append(lines, fmt.Sprintf("  %d × %s", counts[reason], reason))
	}
	return strings.Join(lines, "\n")
}

// runImport is `outrunner import`, and the offer the first run makes: scan,
// list what can come, let the user pick, and bring it over. offer is the
// first run's softer version: nothing found is said in a line, not an error.
func runImport(ctx context.Context, url string, config Config, in terminal, all, offer bool, stdout, stderr io.Writer) int {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	opts := localimport.DefaultOptions(home)
	scan := localimport.Run(ctx, opts)
	var found []localimport.Session
	for _, s := range scan.Sessions {
		if importable(s) {
			found = append(found, s)
		}
	}
	if len(found) == 0 {
		if !offer {
			fmt.Fprintln(stdout, nothingToImport(scan.Sessions))
		}
		return 0
	}

	fmt.Fprintf(stdout, "\n Import sessions from this computer\n\n")
	for i, s := range found {
		fmt.Fprintf(stdout, "  %d. %s\n", i+1, sessionLine(s))
	}
	fmt.Fprintf(stdout, "\n  %s\n\n", uploadNote)

	var picked []int
	switch {
	case all:
		picked, _ = parsePick("all", len(found), true)
	case !in.interactive:
		fmt.Fprintln(stdout, "Run `outrunner import` in a terminal to pick, or `outrunner import --all` to import them all.")
		return 0
	default:
		for attempt := 0; ; attempt++ {
			if offer {
				fmt.Fprintf(stdout, "Import which? (\"all\", numbers like 1,3, or Enter to skip) ")
			} else {
				fmt.Fprintf(stdout, "Import which? (Enter for all, \"none\", or numbers like 1,3) ")
			}
			line, ok := <-in.lines
			if !ok {
				fmt.Fprintln(stdout)
				return 0
			}
			picked, err = parsePick(line, len(found), !offer)
			if err == nil {
				break
			}
			fmt.Fprintln(stdout, " ", err)
			if attempt == 2 {
				return 2
			}
		}
	}
	if len(picked) == 0 {
		fmt.Fprintln(stdout, "Nothing imported. Run `outrunner import` to import later.")
		return 0
	}

	sessions := make([]localimport.Session, len(picked))
	for i, index := range picked {
		sessions[i] = found[index]
	}
	fmt.Fprintln(stdout)
	imported, err := importSessions(ctx, sessions, url, liveImportDeps(url, config.Token, opts), stdout)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner: import failed:", err)
		return 1
	}
	fmt.Fprintf(stdout, "\n ✓ %d of %d imported\n", imported, len(sessions))
	return 0
}
