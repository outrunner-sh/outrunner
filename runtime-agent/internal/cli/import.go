package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"runtime-agent/internal/localimport"
)

// `outrunner import` moves sessions from this computer to the cloud, as the
// Mac app's Import page does (components/local-import.tsx), from a terminal:
// on Linux too, where there's no Mac app. The same scan and capture find and
// package each session (internal/localimport); the app plans and finishes
// each one through the CLI's import routes (app/api/cli/imports), as
// lib/imports/client.ts importSessions does through the web app's.

const importUsage = `Usage: outrunner import [--list] [--all | --key <key>…] [--org <name>] [--yes]

Moves sessions from this computer to your Outrunner cloud: Claude Code's,
Codex's and Conductor's. Each brings its branch's unpushed commits, its
uncommitted changes and its conversation, and becomes an archived session
you resume from its page.

  outrunner import                 pick from a list
  outrunner import --list          list what can be imported, and each key
  outrunner import --all --yes     import every one, without asking
  outrunner import --key claude:<id> --yes

Sessions go in your personal org, or the one --org names. Sign in first
with outrunner login. Your environment and agent setup aren't imported
here: the Mac app imports those.
`

// importNote is what the user agrees to by importing (lib/imports/client.ts
// IMPORT_UPLOAD_NOTE).
const importNote = "Each session's unpushed commits, uncommitted changes and full conversation are uploaded to your Outrunner cloud. A conversation can include anything its agent read, secrets too."

// importConcurrency is how many sessions are captured and uploaded at once,
// as the Mac app does: each upload is long, and the uplink is shared.
const importConcurrency = 2

// maxPlanSessions is the most sessions one plan takes
// (lib/runtime/import-scan.ts MAX_IMPORT_SESSIONS). A plan's upload URLs
// expire, so each batch is planned just before it is uploaded.
const maxPlanSessions = 50

// importDeps are what an import reads and writes on this computer: the scan,
// and a session's capture and upload. Tests pass fakes.
type importDeps struct {
	scan    func(ctx context.Context) localimport.Scan
	capture func(ctx context.Context, key, out string) (localimport.Capture, error)
	upload  func(ctx context.Context, c localimport.Capture, urls map[string]string) error
	// client calls the app; nil is one that waits out a long plan.
	client *http.Client
}

// liveImportDeps are the real places on this computer.
func liveImportDeps() (importDeps, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return importDeps{}, err
	}
	opts := localimport.DefaultOptions(home)
	return importDeps{
		scan: func(ctx context.Context) localimport.Scan { return localimport.Run(ctx, opts) },
		capture: func(ctx context.Context, key, out string) (localimport.Capture, error) {
			return localimport.CaptureSession(ctx, opts, key, out)
		},
		upload: localimport.Upload,
	}, nil
}

// importCommand is `outrunner import`: the args after the command name.
func importCommand(ctx context.Context, base string, config Config, args []string, in terminal, stdout, stderr io.Writer) int {
	deps, err := liveImportDeps()
	if err != nil {
		fmt.Fprintln(stderr, "outrunner import:", err)
		return 1
	}
	return runImport(ctx, deps, base, config, args, in, stdout, stderr)
}

func runImport(ctx context.Context, deps importDeps, base string, config Config, args []string, in terminal, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("outrunner import", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, importUsage) }
	list := flags.Bool("list", false, "list the sessions that can be imported, then stop")
	all := flags.Bool("all", false, "import every session that can be")
	var keys keyList
	flags.Var(&keys, "key", "a session to import, by its key from --list; repeat it, or separate keys with commas")
	org := flags.String("org", "", "the org (its name or id) the sessions go in; none is your personal org")
	yes := flags.Bool("yes", false, "agree to the upload without being asked")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(stderr, "outrunner import: unexpected argument %q\n\n%s", flags.Arg(0), importUsage)
		return 2
	}
	if *all && len(keys) > 0 {
		fmt.Fprintln(stderr, "outrunner import: pass --all or --key, not both.")
		return 2
	}
	// Before the scan, which can take a while: an import needs a sign-in to
	// send the sessions to; a list doesn't.
	if !*list && config.Token == "" {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`.")
		return 1
	}

	fmt.Fprintln(stdout, "Looking for sessions on this computer…")
	scan := deps.scan(ctx)
	if ctx.Err() != nil {
		return 1
	}
	importable, blocked := offeredForImport(scan.Sessions)
	printImportSources(stdout, scan.Sources)

	var picked []localimport.Session
	switch {
	case *list:
		printImportable(stdout, importable, blocked)
		return 0
	case len(keys) > 0:
		var err error
		if picked, err = sessionsByKey(importable, blocked, keys); err != nil {
			fmt.Fprintln(stderr, "outrunner import:", err)
			return 2
		}
	case len(importable) == 0:
		printImportable(stdout, importable, blocked)
		return 0
	case *all:
		picked = importable
	case !in.interactive:
		printImportable(stdout, importable, blocked)
		fmt.Fprintln(stderr, "\noutrunner import: pick the sessions with --all or --key, and agree to the upload with --yes.")
		return 2
	default:
		printImportable(stdout, importable, blocked)
		fmt.Fprint(in.out, "\nImport which? Numbers like 1,3 or 2-4, all, or nothing to stop: ")
		line, ok := <-in.lines
		if !ok {
			fmt.Fprintln(in.out)
		}
		var err error
		if picked, err = parseImportPicks(line, importable); err != nil {
			fmt.Fprintln(stderr, "outrunner import:", err)
			return 2
		}
		if len(picked) == 0 {
			fmt.Fprintln(stdout, "Nothing imported.")
			return 0
		}
	}

	fmt.Fprintf(stdout, "\n%s\n", importNote)
	if !*yes {
		if !in.interactive {
			fmt.Fprintln(stderr, "outrunner import: agree to the upload with --yes.")
			return 2
		}
		if !in.confirmNo(fmt.Sprintf("Import %s?", plural(len(picked), "session", "sessions"))) {
			fmt.Fprintln(stdout, "Nothing imported.")
			return 0
		}
	}

	run := importRun{deps: deps, base: base, token: config.Token, org: strings.TrimSpace(*org), out: stdout}
	err := run.all(ctx, picked)
	if summary := run.summary(); summary != "" {
		fmt.Fprintf(stdout, "\n%s\n", summary)
	}
	if errors.Is(err, ErrSignedOut) {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`.")
		return 1
	}
	if err != nil {
		fmt.Fprintln(stderr, "outrunner import:", err)
		return 1
	}
	if run.counts["failed"] > 0 {
		return 1
	}
	return 0
}

// importRun is one import of the picked sessions: what it has said, and how
// each session went.
type importRun struct {
	deps  importDeps
	base  string
	token string
	org   string
	out   io.Writer

	mu     sync.Mutex
	counts map[string]int
}

// all plans the picked sessions a batch at a time, and imports each one its
// plan can take, a couple at once. A plan the app refuses ends the run.
func (r *importRun) all(ctx context.Context, picked []localimport.Session) error {
	r.counts = map[string]int{}
	fmt.Fprintf(r.out, "\nImporting %s…\n", plural(len(picked), "session", "sessions"))
	for start := 0; start < len(picked); start += maxPlanSessions {
		batch := picked[start:min(start+maxPlanSessions, len(picked))]
		items, err := r.plan(ctx, batch)
		if err != nil {
			return err
		}
		byKey := make(map[string]localimport.Session, len(batch))
		for _, s := range batch {
			byKey[s.Key] = s
		}
		slots := make(chan struct{}, importConcurrency)
		var wg sync.WaitGroup
		for _, item := range items {
			slots <- struct{}{}
			if ctx.Err() != nil {
				// Stopped (Ctrl-C): start no more, and let those under way end.
				<-slots
				break
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-slots }()
				r.one(ctx, byKey[item.Key], item)
			}()
		}
		wg.Wait()
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return nil
}

// one captures, uploads and commits a session the plan took, and says how
// it went.
func (r *importRun) one(ctx context.Context, s localimport.Session, item importPlanItem) {
	title := importTitle(s, item.Key)
	if item.Status != "ready" {
		reason := "the app didn't say why"
		if item.Skip != nil {
			reason = importSkipText(*item.Skip)
		}
		r.ended("skipped", "  - %s: skipped. %s\n", title, reason)
		return
	}
	if s.Key == "" {
		r.ended("failed", "  ✗ %s: the app planned a session that wasn't picked\n", item.Key)
		return
	}
	urls := make(map[string]string, len(item.Uploads))
	for kind, upload := range item.Uploads {
		if !uploadURLAllowed(upload.URL) {
			r.ended("failed", "  ✗ %s: the app asked for an upload that isn't over https, so nothing was sent\n", title)
			return
		}
		urls[kind] = upload.URL
	}

	r.say("  ↑ %s: uploading…\n", title)
	dir, err := os.MkdirTemp("", "outrunner-import-")
	if err != nil {
		r.ended("failed", "  ✗ %s: %v\n", title, err)
		return
	}
	defer os.RemoveAll(dir)
	capture, err := r.deps.capture(ctx, item.Key, dir)
	var skip *localimport.SkipError
	if errors.As(err, &skip) {
		r.ended("skipped", "  - %s: skipped. %s\n", title, importSkipText(skip.Skip))
		return
	}
	if err == nil {
		err = r.deps.upload(ctx, capture, urls)
	}
	var request importCommitRequest
	if err == nil {
		request, err = importCommitFor(item, capture)
	}
	var workspaceID string
	if err == nil {
		workspaceID, err = commitImport(ctx, r.deps.client, r.base, r.token, request)
	}
	if err != nil {
		if errors.Is(err, ErrSignedOut) {
			err = errors.New("not signed in. Run `outrunner login`")
		}
		r.ended("failed", "  ✗ %s: %v\n", title, err)
		return
	}
	as := ""
	if item.Renamed {
		as = fmt.Sprintf(" (as %s: %s was taken)", item.Branch, s.Branch)
	}
	r.ended("done", "  ✓ %s%s\n    %s\n", title, as, appURL(r.base, "/workspaces/"+workspaceID))
}

func (r *importRun) say(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fmt.Fprintf(r.out, format, args...)
}

// ended says how a session went, and counts it.
func (r *importRun) ended(state, format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.counts[state]++
	fmt.Fprintf(r.out, format, args...)
}

// summary is how the run went: "2 imported, 1 skipped". Empty with nothing to say.
func (r *importRun) summary() string {
	var parts []string
	for _, state := range []struct{ key, word string }{{"done", "imported"}, {"skipped", "skipped"}, {"failed", "failed"}} {
		if n := r.counts[state.key]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, state.word))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	summary := strings.Join(parts, ", ") + "."
	if r.counts["done"] > 0 {
		summary += " They're in the sidebar, under their projects."
	}
	return summary
}

// plan asks the app to take a batch of sessions.
func (r *importRun) plan(ctx context.Context, batch []localimport.Session) ([]importPlanItem, error) {
	sessions := make([]importPlanSession, len(batch))
	for i, s := range batch {
		sessions[i] = importPlanSession{Key: s.Key, Source: s.Source, Agent: s.Agent, Repo: s.Repo, Branch: s.Branch}
	}
	return planImport(ctx, r.deps.client, r.base, r.token, r.org, sessions)
}

// importPlanSession is a picked session as POST /api/cli/imports takes it.
type importPlanSession struct {
	Key    string `json:"key"`
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
}

// importUpload is where one artifact is to be uploaded.
type importUpload struct {
	URL  string `json:"url"`
	Path string `json:"path"`
}

// importPlanItem is what the plan says of one session: "ready", with where to
// upload it and what it becomes, or "skipped", and why.
type importPlanItem struct {
	Key         string                  `json:"key"`
	Status      string                  `json:"status"`
	WorkspaceID string                  `json:"workspaceId"`
	ProjectID   string                  `json:"projectId"`
	Branch      string                  `json:"branch"`
	Renamed     bool                    `json:"renamed"`
	ImportedAt  string                  `json:"importedAt"`
	Uploads     map[string]importUpload `json:"uploads"`
	Skip        *localimport.Skip       `json:"skip"`
}

// artifactReceipt is an uploaded artifact as the commit names it.
type artifactReceipt struct {
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	Encoding string `json:"encoding,omitempty"`
}

// importCommitRequest is POST /api/cli/imports/commit's body
// (lib/runtime/import-scan.ts ImportCommitRequest).
type importCommitRequest struct {
	WorkspaceID  string                     `json:"workspaceId"`
	ProjectID    string                     `json:"projectId"`
	ImportedAt   string                     `json:"importedAt"`
	Key          string                     `json:"key"`
	Source       string                     `json:"source"`
	Agent        string                     `json:"agent"`
	SessionID    string                     `json:"sessionId"`
	Branch       string                     `json:"branch"`
	BundleRef    string                     `json:"bundleRef"`
	Title        string                     `json:"title"`
	Worktree     string                     `json:"worktree"`
	StartedAt    string                     `json:"startedAt,omitempty"`
	LastCommit   string                     `json:"lastCommit"`
	Unpushed     int                        `json:"unpushed"`
	ChangedFiles int                        `json:"changedFiles"`
	LastMessage  string                     `json:"lastMessage,omitempty"`
	Artifacts    map[string]artifactReceipt `json:"artifacts"`
}

// importCommitFor is what the app is told of a session captured and
// uploaded (lib/imports/client.ts commitRequestFor).
func importCommitFor(item importPlanItem, c localimport.Capture) (importCommitRequest, error) {
	s := c.Session
	incomplete := errors.New("the capture of this session is incomplete: update outrunner, then try again")
	artifacts := map[string]artifactReceipt{}
	for _, kind := range []string{"bundle", "patch", "conversation", "rollout"} {
		a, ok := c.Artifacts[kind]
		if !ok {
			if kind == "rollout" {
				continue // a Codex session's alone
			}
			return importCommitRequest{}, incomplete
		}
		artifacts[kind] = artifactReceipt{SHA256: a.SHA256, Size: a.Size, Encoding: a.Encoding}
	}
	if s.Worktree == "" || s.Branch == "" {
		return importCommitRequest{}, incomplete
	}
	return importCommitRequest{
		WorkspaceID:  item.WorkspaceID,
		ProjectID:    item.ProjectID,
		ImportedAt:   item.ImportedAt,
		Key:          s.Key,
		Source:       s.Source,
		Agent:        s.Agent,
		SessionID:    s.SessionID,
		Branch:       item.Branch,
		BundleRef:    s.Branch,
		Title:        truncateUTF16(s.Title, 200),
		Worktree:     s.Worktree,
		StartedAt:    s.StartedAt,
		LastCommit:   c.LastCommit,
		Unpushed:     s.Unpushed,
		ChangedFiles: c.ChangedFiles,
		LastMessage:  truncateUTF16(s.LastMessage, 2000),
		Artifacts:    artifacts,
	}, nil
}

// planImport asks the app to take sessions: into the org org names (its
// name or id), else the user's personal org.
func planImport(ctx context.Context, client *http.Client, base, token, org string, sessions []importPlanSession) ([]importPlanItem, error) {
	path := "/api/cli/imports"
	if org != "" {
		path += "?org=" + url.QueryEscape(org)
	}
	var answer struct {
		Items []importPlanItem `json:"items"`
	}
	err := postImport(ctx, client, base, path, token, map[string]any{"sessions": sessions}, &answer)
	return answer.Items, err
}

// commitImport finishes importing one session, its artifacts uploaded: the
// workspace it became.
func commitImport(ctx context.Context, client *http.Client, base, token string, request importCommitRequest) (string, error) {
	var answer struct {
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	if err := postImport(ctx, client, base, "/api/cli/imports/commit", token, request, &answer); err != nil {
		return "", err
	}
	if answer.Workspace.ID == "" {
		return "", errors.New("Outrunner answered without the session it made")
	}
	return answer.Workspace.ID, nil
}

func postImport(ctx context.Context, client *http.Client, base, path, token string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, appURL(base, path), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		// A plan connects repositories and signs up to 200 upload URLs.
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	return do(client, req, out)
}

// uploadURLAllowed is whether a plan may have a session's code sent to
// target: over https, or plain http only to this computer (a deployment's
// storage running here). The app signed in to is trusted with the code
// either way; this keeps it off the network in the clear.
func uploadURLAllowed(target string) bool {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		host := u.Hostname()
		if host == "localhost" {
			return true
		}
		ip := net.ParseIP(host)
		return ip != nil && ip.IsLoopback()
	}
	return false
}

// offeredForImport splits a scan's sessions into those that can be imported
// and those that can't (lib/imports/client.ts offeredSessions). A workspace
// archived in Conductor is neither: it is work the user put away.
func offeredForImport(sessions []localimport.Session) (importable, blocked []localimport.Session) {
	for _, s := range sessions {
		switch {
		case s.ConductorState == "archived":
		case s.Skip != nil:
			blocked = append(blocked, s)
		case s.Repo != "" && s.Branch != "":
			importable = append(importable, s)
		}
	}
	return importable, blocked
}

// sessionsByKey picks the sessions keys name, each once, in the order named.
func sessionsByKey(importable, blocked []localimport.Session, keys []string) ([]localimport.Session, error) {
	var picked []localimport.Session
	seen := map[string]bool{}
	for _, key := range keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		if s, ok := findSession(importable, key); ok {
			picked = append(picked, s)
			continue
		}
		if s, ok := findSession(blocked, key); ok {
			return nil, fmt.Errorf("%s can't be imported: %s", key, importSkipText(*s.Skip))
		}
		return nil, fmt.Errorf("no session %s on this computer can be imported. See outrunner import --list", key)
	}
	return picked, nil
}

func findSession(sessions []localimport.Session, key string) (localimport.Session, bool) {
	for _, s := range sessions {
		if s.Key == key {
			return s, true
		}
	}
	return localimport.Session{}, false
}

// parseImportPicks reads the sessions picked by their numbers in the list:
// "1,3", "2-4", "1 3", or "all". Nothing picks nothing.
func parseImportPicks(answer string, importable []localimport.Session) ([]localimport.Session, error) {
	answer = strings.TrimSpace(answer)
	if answer == "" {
		return nil, nil
	}
	if strings.EqualFold(answer, "all") {
		return importable, nil
	}
	number := func(text string) (int, error) {
		n, err := strconv.Atoi(strings.TrimSpace(text))
		if err != nil || n < 1 || n > len(importable) {
			return 0, fmt.Errorf("pick by the numbers in the list, 1 to %d: %q isn't one", len(importable), text)
		}
		return n, nil
	}
	var picked []localimport.Session
	seen := map[int]bool{}
	for _, part := range strings.FieldsFunc(answer, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
		from, to := part, part
		if before, after, ok := strings.Cut(part, "-"); ok {
			from, to = before, after
		}
		first, err := number(from)
		if err != nil {
			return nil, err
		}
		last, err := number(to)
		if err != nil {
			return nil, err
		}
		if last < first {
			return nil, fmt.Errorf("%q counts down: write it as %d-%d", part, last, first)
		}
		for n := first; n <= last; n++ {
			if !seen[n] {
				seen[n] = true
				picked = append(picked, importable[n-1])
			}
		}
	}
	return picked, nil
}

// printImportSources says where sessions were found, and any place that
// couldn't be read.
func printImportSources(out io.Writer, sources []localimport.Source) {
	var found []string
	for _, source := range sources {
		if source.Found {
			found = append(found, importSourceLabel(source.ID))
		}
	}
	if len(found) == 0 {
		fmt.Fprintln(out, "No Conductor, Claude Code or Codex sessions on this computer.")
	} else {
		fmt.Fprintf(out, "Found sessions from %s.\n", strings.Join(found, ", "))
	}
	for _, source := range sources {
		if source.Skip != nil {
			fmt.Fprintf(out, "%s: %s\n", importSourceLabel(source.ID), importSkipText(*source.Skip))
		}
	}
}

// printImportable lists the sessions that can be imported, numbered for a
// pick and with each key for --key, then how many can't be, and why.
func printImportable(out io.Writer, importable, blocked []localimport.Session) {
	if len(importable) == 0 {
		fmt.Fprintln(out, "\nNo sessions here can be imported.")
	} else {
		fmt.Fprintln(out)
		for i, s := range importable {
			fmt.Fprintf(out, "%3d. %s\n", i+1, ellipsize(importTitle(s, s.Key), 72))
			facts := append([]string{importSourceLabel(s.Source), s.Repo, s.Branch}, importFacts(s)...)
			fmt.Fprintf(out, "     %s\n     %s\n", strings.Join(facts, " · "), s.Key)
		}
	}
	if len(blocked) > 0 {
		fmt.Fprintf(out, "\n%s can't be imported:\n", plural(len(blocked), "session", "sessions"))
		for _, s := range blocked {
			fmt.Fprintf(out, "  %s · %s · %s\n", ellipsize(importTitle(s, s.Key), 60), importSourceLabel(s.Source), importSkipText(*s.Skip))
		}
	}
}

// importTitle is a session as the user knows it: its title, else its id.
func importTitle(s localimport.Session, key string) string {
	return firstNonEmpty(strings.TrimSpace(s.Title), s.SessionID, key)
}

// importFacts is what a session brings with it (lib/imports/client.ts
// sessionFacts): "2 unpushed commits", "0.1 MB conversation".
func importFacts(s localimport.Session) []string {
	var facts []string
	if s.Unpushed > 0 {
		facts = append(facts, plural(s.Unpushed, "unpushed commit", "unpushed commits"))
	}
	if s.CheckedOut && s.Dirty {
		facts = append(facts, "uncommitted changes")
	}
	if !s.CheckedOut {
		facts = append(facts, "its folder is on another branch: committed work only")
	}
	return append(facts, fmt.Sprintf("%.1f MB conversation", float64(s.TranscriptBytes)/1_000_000))
}

var importSourceLabels = map[string]string{
	"conductor":       "Conductor",
	"claude-cli":      "Claude Code",
	"codex-cli":       "Codex",
	"outrunner-local": "Outrunner on this computer",
}

func importSourceLabel(id string) string {
	return firstNonEmpty(importSourceLabels[id], id)
}

// importSkipTexts say why something can't be imported (lib/imports/client.ts SKIP_TEXT).
var importSkipTexts = map[string]string{
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

func importSkipText(skip localimport.Skip) string {
	text := firstNonEmpty(importSkipTexts[skip.Reason], skip.Reason)
	if skip.Detail != "" {
		return fmt.Sprintf("%s (%s)", text, skip.Detail)
	}
	return text
}

// keyList is --key: given again, or with commas, it names more sessions.
type keyList []string

func (l *keyList) String() string { return strings.Join(*l, ",") }

func (l *keyList) Set(value string) error {
	for _, key := range strings.Split(value, ",") {
		if key = strings.TrimSpace(key); key != "" {
			*l = append(*l, key)
		}
	}
	return nil
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// ellipsize shortens text to at most n characters, for a list.
func ellipsize(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n-1]) + "…"
}

// truncateUTF16 cuts s to at most n UTF-16 code units, at a character: the
// length the app's checks count (a JavaScript string's), so an emoji counts
// two.
func truncateUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		width := utf16.RuneLen(r)
		if width < 0 {
			width = 1 // sent as U+FFFD
		}
		if units+width > n {
			return s[:i]
		}
		units += width
	}
	return s
}
