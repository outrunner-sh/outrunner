package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// Workspace is a session as the API answers with it (the fields printed).
type Workspace struct {
	ID           string  `json:"id"`
	Title        *string `json:"title"`
	Status       string  `json:"status"`
	SetupPhase   *string `json:"setup_phase"`
	Source       string  `json:"source"`
	Agent        string  `json:"agent"`
	Branch       string  `json:"branch"`
	BaseBranch   string  `json:"base_branch"`
	ErrorMessage *string `json:"error_message"`
	URL          string  `json:"url"`
	CreatedAt    string  `json:"created_at"`
	LastActiveAt *string `json:"last_active_at"`
	Model        *struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	} `json:"model"`
	Turn     *Turn `json:"turn"`
	TimedOut bool  `json:"timed_out"`
}

// Turn is where a session's turn is: working, needs_input or idle.
type Turn struct {
	State        string          `json:"state"`
	PendingInput json.RawMessage `json:"pending_input"`
	LastMessage  *string         `json:"last_message"`
	LastEventID  *string         `json:"last_event_id"`
}

// commandFlags is what every API command takes: --json and --org.
type commandFlags struct {
	set  *flag.FlagSet
	json *bool
	org  *string
}

func newCommandFlags(name, usage string, stderr io.Writer) commandFlags {
	set := flag.NewFlagSet("outrunner "+name, flag.ContinueOnError)
	set.SetOutput(stderr)
	set.Usage = func() { fmt.Fprint(stderr, usage) }
	return commandFlags{
		set:  set,
		json: set.Bool("json", false, "print the API's answer as JSON"),
		org:  set.String("org", "", "the org to act in (its name or id)"),
	}
}

// parse reads the flags, wherever they are among the arguments: `outrunner
// send <id> "do it" --json` and `outrunner send --json <id> "do it"` alike.
// A literal `--` ends them: everything after it is taken as it is, for a
// message that reads like a flag (`send <id> -- use --json output`).
func (f commandFlags) parse(args []string) ([]string, int) {
	var verbatim []string
	for i, arg := range args {
		if arg == "--" {
			args, verbatim = args[:i], args[i+1:]
			break
		}
	}
	positional, code := f.parseFlags(args)
	if code >= 0 {
		return nil, code
	}
	return append(positional, verbatim...), -1
}

func (f commandFlags) parseFlags(args []string) ([]string, int) {
	var positional []string
	for {
		if err := f.set.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, 0
			}
			return nil, 2
		}
		rest := f.set.Args()
		if len(rest) == 0 {
			return positional, -1
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}
}

// apiFor is the API the command calls, or the exit status when there's no
// credential to call it with.
func apiFor(base string, config Config, org string, stderr io.Writer) (API, int) {
	token := apiToken(config)
	if token == "" {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`, or set OUTRUNNER_API_KEY.")
		return API{}, 1
	}
	return API{Base: base, Token: token, Org: strings.TrimSpace(org)}, -1
}

// failed says why a call failed, and is the command's exit status.
func failed(stderr io.Writer, err error) int {
	var api *APIError
	if errors.As(err, &api) && api.Status == 401 {
		fmt.Fprintf(stderr, "outrunner: %s\n", api.Message)
		fmt.Fprintln(stderr, "Run `outrunner login`, or check OUTRUNNER_API_KEY.")
		return 1
	}
	fmt.Fprintln(stderr, "outrunner:", err)
	return 1
}

func label(w Workspace) string {
	if w.Title != nil && *w.Title != "" {
		return *w.Title
	}
	return w.Branch
}

const listUsage = `Usage: outrunner list [--status <status>] [--source app|slack|automation|github|api]
                      [--user me|<id>] [--project <owner/name | id>] [--page <n>] [--per-page <n>] [--org <name>] [--json]

Lists your sessions in the org, newest first (an org's admins see the org's).
`

func listCommand(ctx context.Context, base string, config Config, args []string, stdout, stderr io.Writer) int {
	f := newCommandFlags("list", listUsage, stderr)
	status := f.set.String("status", "", "only sessions in this status (ready, preparing, archived, …)")
	source := f.set.String("source", "", "only sessions started from here")
	user := f.set.String("user", "", "only this user's sessions (me, or a user id)")
	project := f.set.String("project", "", "only sessions on this repository (owner/name, or its id)")
	page := f.set.Int("page", 1, "the page")
	perPage := f.set.Int("per-page", 20, "sessions a page, up to 100")
	if _, code := f.parse(args); code >= 0 {
		return code
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	// The API takes a repository's id; `owner/name` is looked up, as
	// `create --repo` does.
	projectID := strings.TrimSpace(*project)
	if projectID != "" {
		var err error
		if projectID, err = resolveRepo(ctx, api, projectID); err != nil {
			return failed(stderr, err)
		}
	}
	query := url.Values{"page": {strconv.Itoa(*page)}, "per_page": {strconv.Itoa(*perPage)}}
	for key, value := range map[string]string{"status": *status, "source": *source, "user_id": *user, "project_id": projectID} {
		if value != "" {
			query.Set(key, value)
		}
	}
	var answer struct {
		Data       []Workspace `json:"data"`
		Page       int         `json:"page"`
		TotalPages int         `json:"total_pages"`
		Total      int         `json:"total"`
	}
	raw, err := api.Call(ctx, "GET", "/workspaces", query, nil, &answer)
	if err != nil {
		return failed(stderr, err)
	}
	if *f.json {
		printJSON(stdout, raw)
		return 0
	}
	if len(answer.Data) == 0 {
		fmt.Fprintln(stdout, "No sessions.")
		return 0
	}
	now := time.Now()
	table := tabwriter.NewWriter(stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(table, "ID\tSTATUS\tSOURCE\tACTIVE\tTITLE")
	for _, w := range answer.Data {
		active := w.CreatedAt
		if w.LastActiveAt != nil {
			active = *w.LastActiveAt
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\n", w.ID, w.Status, w.Source, ago(active, now), label(w))
	}
	_ = table.Flush()
	if answer.TotalPages > 1 {
		fmt.Fprintf(stdout, "\nPage %d of %d (%d sessions). --page for more.\n", answer.Page, answer.TotalPages, answer.Total)
	}
	return 0
}

const getUsage = `Usage: outrunner get <id> [--org <name>] [--json]

Shows a session: its status, branch, and where its turn is.
`

func getCommand(ctx context.Context, base string, config Config, args []string, stdout, stderr io.Writer) int {
	f := newCommandFlags("get", getUsage, stderr)
	rest, code := f.parse(args)
	if code >= 0 {
		return code
	}
	if len(rest) != 1 {
		fmt.Fprint(stderr, getUsage)
		return 2
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	var w Workspace
	raw, err := api.Call(ctx, "GET", "/workspaces/"+url.PathEscape(rest[0]), nil, nil, &w)
	if err != nil {
		return failed(stderr, err)
	}
	if *f.json {
		printJSON(stdout, raw)
		return 0
	}
	printWorkspace(stdout, w)
	return 0
}

func printWorkspace(out io.Writer, w Workspace) {
	fmt.Fprintf(out, "%s\n\n", label(w))
	table := tabwriter.NewWriter(out, 0, 2, 2, ' ', 0)
	fmt.Fprintf(table, "  ID\t%s\n", w.ID)
	status := w.Status
	if w.SetupPhase != nil && *w.SetupPhase != "" {
		status += " (" + *w.SetupPhase + ")"
	}
	fmt.Fprintf(table, "  Status\t%s\n", status)
	if w.Turn != nil {
		fmt.Fprintf(table, "  Turn\t%s\n", w.Turn.State)
	}
	fmt.Fprintf(table, "  Branch\t%s → %s\n", w.Branch, w.BaseBranch)
	if w.Model != nil {
		fmt.Fprintf(table, "  Model\t%s (%s)\n", w.Model.ID, w.Model.Provider)
	}
	fmt.Fprintf(table, "  Source\t%s\n", w.Source)
	fmt.Fprintf(table, "  Open\t%s\n", w.URL)
	_ = table.Flush()
	if w.ErrorMessage != nil && *w.ErrorMessage != "" {
		fmt.Fprintf(out, "\n%s\n", *w.ErrorMessage)
	}
	if w.Turn != nil && w.Turn.State != "working" && w.Turn.LastMessage != nil {
		fmt.Fprintf(out, "\n%s\n", strings.TrimSpace(*w.Turn.LastMessage))
	}
}

const createUsage = `Usage: outrunner create --repo <owner/name | id> [--model <id>] [--agent claude|codex] [--effort <e>]
                        [--size x-small|small|medium|large] [--plan] [--branch <b>] [--base <b>]
                        [--webhook-url <url>] [--wait] [--org <name>] [--json] <prompt…>

Starts a cloud session on a repository with a prompt; the prompt is sent once
its box is ready. With no prompt in the arguments, it's read from stdin. With
--wait, waits for its first turn to end and prints what it said.
`

func createCommand(ctx context.Context, base string, config Config, args []string, in terminal, stdout, stderr io.Writer) int {
	f := newCommandFlags("create", createUsage, stderr)
	repo := f.set.String("repo", "", "the repository (owner/name, or its id)")
	model := f.set.String("model", "", "the model it runs")
	agent := f.set.String("agent", "", "claude or codex")
	effort := f.set.String("effort", "", "the model's effort")
	size := f.set.String("size", "", "its box")
	plan := f.set.Bool("plan", false, "reply with a plan and wait before changing anything")
	branch := f.set.String("branch", "", "the branch it works on")
	baseBranch := f.set.String("base", "", "the branch it starts from")
	webhook := f.set.String("webhook-url", "", "an https URL told of its events")
	wait := f.set.Bool("wait", false, "wait for its first turn to end")
	rest, code := f.parse(args)
	if code >= 0 {
		return code
	}
	prompt := readText(rest, in)
	if strings.TrimSpace(*repo) == "" || prompt == "" {
		fmt.Fprint(stderr, createUsage)
		return 2
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	projectID, err := resolveRepo(ctx, api, strings.TrimSpace(*repo))
	if err != nil {
		return failed(stderr, err)
	}
	body := map[string]any{"project_id": projectID, "prompt": prompt}
	for key, value := range map[string]string{
		"model": *model, "agent": *agent, "effort": *effort, "size": *size,
		"branch": *branch, "base_branch": *baseBranch, "webhook_url": *webhook,
	} {
		if value != "" {
			body[key] = value
		}
	}
	if *plan {
		body["plan_mode"] = true
	}
	var made Workspace
	raw, err := api.Call(ctx, "POST", "/workspaces", nil, body, &made)
	if err != nil {
		return failed(stderr, err)
	}
	if !*wait {
		if *f.json {
			printJSON(stdout, raw)
			return 0
		}
		fmt.Fprintf(stdout, "✓ Started %s (preparing)\n  %s\n", made.ID, made.URL)
		return 0
	}
	if !*f.json {
		fmt.Fprintf(stdout, "✓ Started %s\n  %s\n\nWaiting for its first turn…\n", made.ID, made.URL)
	}
	return waitAndPrint(ctx, api, made.ID, "", 0, *f.json, stdout, stderr)
}

// readText is the command's text: its arguments, else what was piped in.
func readText(args []string, in terminal) string {
	text := strings.TrimSpace(strings.Join(args, " "))
	if text == "" && !in.interactive && in.lines != nil {
		var piped []string
		for line := range in.lines {
			piped = append(piped, line)
		}
		text = strings.TrimSpace(strings.Join(piped, "\n"))
	}
	return text
}

// resolveRepo is the id of the repository `repo` names: an id as it is, or
// `owner/name` looked up among the org's (any case).
func resolveRepo(ctx context.Context, api API, repo string) (string, error) {
	if !strings.Contains(repo, "/") {
		return repo, nil
	}
	for page := 1; ; page++ {
		var answer struct {
			Data []struct {
				ID       string `json:"id"`
				FullName string `json:"full_name"`
			} `json:"data"`
			HasMore bool `json:"has_more"`
		}
		query := url.Values{"page": {strconv.Itoa(page)}, "per_page": {"100"}}
		if _, err := api.Call(ctx, "GET", "/projects", query, nil, &answer); err != nil {
			return "", err
		}
		for _, p := range answer.Data {
			if strings.EqualFold(p.FullName, repo) {
				return p.ID, nil
			}
		}
		if !answer.HasMore {
			return "", fmt.Errorf("no repository named %s that you can start sessions on in this org", repo)
		}
	}
}

const sendUsage = `Usage: outrunner send <id> [--wait] [--org <name>] [--json] <message…>

Sends a session a message, waking it first if it was paused or archived. With
no message in the arguments, it's read from stdin. With --wait, waits for the
turn it starts to end and prints what it said.
`

func sendCommand(ctx context.Context, base string, config Config, args []string, in terminal, stdout, stderr io.Writer) int {
	f := newCommandFlags("send", sendUsage, stderr)
	wait := f.set.Bool("wait", false, "wait for its reply")
	rest, code := f.parse(args)
	if code >= 0 {
		return code
	}
	if len(rest) < 1 {
		fmt.Fprint(stderr, sendUsage)
		return 2
	}
	id, message := rest[0], readText(rest[1:], in)
	if message == "" {
		fmt.Fprint(stderr, sendUsage)
		return 2
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	// Where the log stands before the send: the fence to wait from, should
	// the API not give one (its box hadn't logged the message yet). Only
	// with --wait, since it costs a read of the conversation. Whatever the
	// turn was doing: the API's wait, fenced, waits for this message to be
	// logged past it, so neither a question this answers nor a turn it was
	// queued behind is handed back.
	before := ""
	if *wait {
		var w Workspace
		if _, err := api.Call(ctx, "GET", "/workspaces/"+url.PathEscape(id), nil, nil, &w); err == nil && w.Turn != nil {
			before = "0"
			if w.Turn.LastEventID != nil {
				before = *w.Turn.LastEventID
			}
		}
	}
	var sent struct {
		AfterEvent *string `json:"after_event"`
	}
	raw, err := api.Call(ctx, "POST", "/workspaces/"+url.PathEscape(id)+"/messages", nil, map[string]any{"content": message}, &sent)
	if err != nil {
		return failed(stderr, err)
	}
	after := ""
	if sent.AfterEvent != nil {
		after = *sent.AfterEvent
	}
	if !*wait {
		if *f.json {
			printJSON(stdout, raw)
			return 0
		}
		fmt.Fprintln(stdout, "✓ Sent")
		if after != "" {
			fmt.Fprintf(stdout, "  %s\n", waitHint(api, id, after))
		} else {
			fmt.Fprintf(stdout, "  Its turn hasn't shown yet: once `outrunner get %s%s` says working, run `%s`.\n", id, orgArg(api), waitHint(api, id, ""))
		}
		return 0
	}
	if after == "" {
		after = before
	}
	if after == "" && !awaitWorking(ctx, api, id, 30*time.Second) {
		// The box hadn't logged the message when the send answered, nor was
		// it up before it (a session just woken): as docs/api.md says, its
		// turn is seen to start before it's waited on. Not seen: said.
		fmt.Fprintln(stderr, "outrunner: couldn't see the turn start; the reply below may be the previous turn's.")
	}
	return waitAndPrint(ctx, api, id, after, 0, *f.json, stdout, stderr)
}

// awaitWorkingEvery is how often awaitWorking looks.
var awaitWorkingEvery = 2 * time.Second

// awaitWorking looks at the session until its turn is working, for at most
// `limit`: a wait without a fence then can't take the quiet before the turn
// (or a question it was still showing) for its end. False when it never
// saw it working.
func awaitWorking(ctx context.Context, api API, id string, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		var w Workspace
		if _, err := api.Call(ctx, "GET", "/workspaces/"+url.PathEscape(id), nil, nil, &w); err == nil && w.Turn != nil && w.Turn.State == "working" {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(awaitWorkingEvery):
		}
	}
	return false
}

const waitUsage = `Usage: outrunner wait <id> [--after <event>] [--timeout <duration>] [--org <name>] [--json]

Waits until the session's turn is over or it needs input, then prints what it
said. --after is the event id ` + "`outrunner send`" + ` printed: the turn that message
starts. With no --timeout, it waits for as long as the turn takes.
Exits 0 when the turn is over, 3 when the session needs input, 4 on timeout,
1 when the session failed or stopped, and 5 when Outrunner couldn't be
reached for a while (calls that fail are tried again first): run the command
it prints to carry on waiting.
`

func waitCommand(ctx context.Context, base string, config Config, args []string, stdout, stderr io.Writer) int {
	f := newCommandFlags("wait", waitUsage, stderr)
	after := f.set.String("after", "", "the event id a send answered with")
	timeout := f.set.Duration("timeout", 0, "how long to wait at most (e.g. 30m); none is until the turn ends")
	rest, code := f.parse(args)
	if code >= 0 {
		return code
	}
	if len(rest) != 1 {
		fmt.Fprint(stderr, waitUsage)
		return 2
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	return waitAndPrint(ctx, api, rest[0], strings.TrimSpace(*after), *timeout, *f.json, stdout, stderr)
}

// maxWait is the longest the API holds one wait call.
const maxWait = 600 * time.Second

// waitAndPrint waits for the session's turn, a call of up to ten minutes at
// a time, until it's over, needs input, the session stops, or `timeout`
// (none: no limit) passes.
func waitAndPrint(ctx context.Context, api API, id, after string, timeout time.Duration, asJSON bool, stdout, stderr io.Writer) int {
	var deadline time.Time
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	for {
		hold := maxWait
		if !deadline.IsZero() {
			hold = time.Until(deadline)
			if hold > maxWait {
				hold = maxWait
			}
			if hold < 0 {
				hold = 0
			}
		}
		query := url.Values{"timeout": {strconv.Itoa(int(hold.Seconds()))}}
		if after != "" {
			query.Set("after_event", after)
		}
		var w Workspace
		raw, err := waitCall(ctx, api, id, query, hold, deadline, &w)
		if errors.Is(err, errWaitDeadline) {
			// The deadline came while a failed call waited to be tried
			// again: a timeout, as one the API answered, but said, so it
			// isn't taken for a turn that only took too long.
			fmt.Fprintln(stderr, "outrunner:", err)
			w = Workspace{ID: id, TimedOut: true}
			if asJSON {
				printJSON(stdout, json.RawMessage(fmt.Sprintf(`{"id":%q,"timed_out":true}`, id)))
			} else {
				printWaited(stdout, w, waitHint(api, id, after))
			}
			return 4
		}
		if err != nil {
			if !retryable(err) {
				return failed(stderr, err)
			}
			fmt.Fprintln(stderr, "outrunner:", err)
			fmt.Fprintf(stderr, "Couldn't reach Outrunner for a while. To carry on waiting: %s\n", waitHint(api, id, after))
			return 5
		}
		// Again only after a full hold with time left to cover: the API
		// answers a few seconds before its hold is up, and a short call
		// would come straight back, again and again, as the deadline nears.
		if w.TimedOut && hold == maxWait && (deadline.IsZero() || time.Until(deadline) > 3*time.Second) {
			continue
		}
		if asJSON {
			printJSON(stdout, raw)
		} else {
			printWaited(stdout, w, waitHint(api, id, after))
		}
		return waitStatus(w)
	}
}

// waitRetries are the pauses before each try again of a wait call that
// failed on the way (a dropped long-poll, a deploy, a 502): a wait can run
// for hours, and one such failure mustn't end it. The fence keeps a retry
// on the same turn.
var waitRetries = []time.Duration{2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second, 60 * time.Second}

// errWaitDeadline is a wait whose --timeout came while a failed call was
// waiting to be tried again.
var errWaitDeadline = errors.New("the wait's time ran out")

// waitCall makes one wait call, tried again on a failure on the way, within
// `deadline` (zero: none): a try again never runs past it, and asks only for
// the time left.
func waitCall(ctx context.Context, api API, id string, query url.Values, hold time.Duration, deadline time.Time, out *Workspace) (json.RawMessage, error) {
	for attempt := 0; ; attempt++ {
		call, cancel := context.WithTimeout(ctx, hold+60*time.Second)
		raw, err := api.Call(call, "GET", "/workspaces/"+url.PathEscape(id)+"/wait", query, nil, out)
		cancel()
		if err == nil || !retryable(err) || attempt >= len(waitRetries) || ctx.Err() != nil {
			return raw, err
		}
		pause := waitRetries[attempt]
		if !deadline.IsZero() {
			if time.Until(deadline) <= pause {
				// With why it was being tried again, for the caller to say.
				return nil, fmt.Errorf("%w: %v", errWaitDeadline, err)
			}
			hold = time.Until(deadline) - pause
			if hold > maxWait {
				hold = maxWait
			}
			query.Set("timeout", strconv.Itoa(int(hold.Seconds())))
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pause):
		}
	}
}

// retryable is a failure on the way, not a refusal: no answer at all, a
// rate limit, or the server's own trouble. 401, 403 and 404 end a wait.
func retryable(err error) bool {
	var api *APIError
	if errors.As(err, &api) {
		return api.Status == 429 || api.Status >= 500
	}
	return !errors.Is(err, context.Canceled)
}

// orgArg is " --org <name>" when the command was given one, for the
// commands it prints: a session is found only in its own org.
func orgArg(api API) string {
	if api.Org == "" {
		return ""
	}
	// Quoted for the shell (single quotes, nothing inside expands), when
	// it holds anything a shell would read.
	if strings.ContainsAny(api.Org, " \t'\"$`\\&;|<>()*?[]{}!#~") {
		return " --org '" + strings.ReplaceAll(api.Org, "'", `'\''`) + "'"
	}
	return " --org " + api.Org
}

// waitHint is the command that carries on waiting for the same turn.
func waitHint(api API, id, after string) string {
	hint := "outrunner wait " + id
	if after != "" {
		hint += " --after " + after
	}
	return hint + orgArg(api)
}

// waitStatus is how a wait ended, as an exit status scripts can tell apart.
func waitStatus(w Workspace) int {
	switch {
	case w.TimedOut:
		return 4
	case w.Turn != nil && w.Turn.State == "needs_input":
		return 3
	case w.Turn != nil:
		return 0
	default:
		// No turn: the session failed, or is paused, archived or gone.
		return 1
	}
}

// printWaited says how a wait ended; `hint` is the command to keep waiting,
// with its fence and org: without the fence, the next wait could take an
// earlier turn's end for this one's.
func printWaited(out io.Writer, w Workspace, hint string) {
	switch {
	case w.TimedOut:
		fmt.Fprintf(out, "Still working (%s). Run `%s` to keep waiting.\n", w.Status, hint)
	case w.Turn == nil:
		fmt.Fprintf(out, "The session is %s.\n", w.Status)
		if w.ErrorMessage != nil && *w.ErrorMessage != "" {
			fmt.Fprintln(out, *w.ErrorMessage)
		}
	case w.Turn.State == "needs_input":
		fmt.Fprintf(out, "It needs your input: %s\n", w.URL)
		if len(w.Turn.PendingInput) > 0 {
			printPending(out, w.Turn.PendingInput)
		}
	default:
		if w.Turn.LastMessage != nil {
			fmt.Fprintln(out, strings.TrimSpace(*w.Turn.LastMessage))
		} else {
			fmt.Fprintln(out, "Done.")
		}
	}
}

func printPending(out io.Writer, raw json.RawMessage) {
	var pending struct {
		Type      string `json:"type"`
		Reason    string `json:"reason"`
		Questions []struct {
			Question string `json:"question"`
			Options  []struct {
				Label string `json:"label"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(raw, &pending) != nil {
		return
	}
	if pending.Type == "secrets" {
		fmt.Fprintf(out, "\nIt asks for secrets: %s\n", pending.Reason)
		return
	}
	for _, q := range pending.Questions {
		fmt.Fprintf(out, "\n%s\n", q.Question)
		for _, o := range q.Options {
			fmt.Fprintf(out, "  - %s\n", o.Label)
		}
	}
}

const readUsage = `Usage: outrunner read <id> [--before <event>] [--limit <n>] [--org <name>] [--json]

Prints a session's conversation, newest last: the last --limit events (50),
or those before --before for the page before.
`

// Event is one event of a conversation, as the API answers with it.
type Event struct {
	ID      string            `json:"id"`
	Type    string            `json:"type"`
	Role    string            `json:"role"`
	Content []json.RawMessage `json:"content"`
}

func readCommand(ctx context.Context, base string, config Config, args []string, stdout, stderr io.Writer) int {
	f := newCommandFlags("read", readUsage, stderr)
	before := f.set.String("before", "", "the page before this event id")
	limit := f.set.Int("limit", 50, "events to print, up to 100")
	rest, code := f.parse(args)
	if code >= 0 {
		return code
	}
	if len(rest) != 1 {
		fmt.Fprint(stderr, readUsage)
		return 2
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	query := url.Values{"per_page": {strconv.Itoa(*limit)}}
	if *before != "" {
		query.Set("before_event", *before)
	}
	var answer struct {
		Data            []Event `json:"data"`
		HasMore         bool    `json:"has_more"`
		NextBeforeEvent *string `json:"next_before_event"`
		From            string  `json:"from"`
	}
	raw, err := api.Call(ctx, "GET", "/workspaces/"+url.PathEscape(rest[0])+"/conversation", query, nil, &answer)
	if err != nil {
		return failed(stderr, err)
	}
	if *f.json {
		printJSON(stdout, raw)
		return 0
	}
	if answer.From == "none" {
		fmt.Fprintln(stdout, "No conversation yet.")
		return 0
	}
	if answer.HasMore && answer.NextBeforeEvent != nil {
		fmt.Fprintf(stdout, "(earlier: outrunner read %s --before %s%s)\n\n", rest[0], *answer.NextBeforeEvent, orgArg(api))
	}
	for _, event := range answer.Data {
		printEvent(stdout, event)
	}
	return 0
}

// printEvent prints a message: its text, and a line for each tool it used.
// Tool results and usage records aren't printed (--json has them).
func printEvent(out io.Writer, event Event) {
	if event.Type != "message" {
		return
	}
	for _, rawBlock := range event.Content {
		var block struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Name string `json:"name"`
		}
		if json.Unmarshal(rawBlock, &block) != nil {
			continue
		}
		switch block.Type {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			// The session's agent may be Claude Code or Codex: named for
			// neither, rather than fetch which.
			who := "Agent"
			if event.Role == "user" {
				who = "You"
			}
			fmt.Fprintf(out, "%s: %s\n\n", who, text)
		case "tool_use":
			fmt.Fprintf(out, "  → %s\n", block.Name)
		}
	}
}

const deleteUsage = `Usage: outrunner delete <id> [--yes] [--org <name>] [--json]

Deletes a session for good: its box, its worktree, its snapshots. Asks first
unless --yes.
`

func deleteCommand(ctx context.Context, base string, config Config, args []string, in terminal, stdout, stderr io.Writer) int {
	f := newCommandFlags("delete", deleteUsage, stderr)
	yes := f.set.Bool("yes", false, "don't ask first")
	rest, code := f.parse(args)
	if code >= 0 {
		return code
	}
	if len(rest) != 1 {
		fmt.Fprint(stderr, deleteUsage)
		return 2
	}
	if !*yes {
		if !in.interactive {
			fmt.Fprintln(stderr, "outrunner: deleting can't be undone; pass --yes to delete without asking.")
			return 2
		}
		if !in.confirmNo(fmt.Sprintf("Delete session %s for good?", rest[0])) {
			fmt.Fprintln(stdout, "Left as it is.")
			return 1
		}
	}
	api, code := apiFor(base, config, *f.org, stderr)
	if code >= 0 {
		return code
	}
	if _, err := api.Call(ctx, "DELETE", "/workspaces/"+url.PathEscape(rest[0]), nil, nil, nil); err != nil {
		return failed(stderr, err)
	}
	if *f.json {
		printJSON(stdout, json.RawMessage(fmt.Sprintf(`{"result":"deleted","workspace_id":%q}`, rest[0])))
		return 0
	}
	fmt.Fprintln(stdout, "✓ Deleted")
	return 0
}
