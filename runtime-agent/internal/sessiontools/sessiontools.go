// Package sessiontools is a session's own commands for reaching Outrunner,
// for the agent working in it, Claude or Codex alike: `outrunner-session
// suggest-learning` suggests a standing instruction for every future
// session, which the user accepts or dismisses in Settings → Learnings.
//
// A command is a shell command rather than an MCP tool so that both agents
// have it the same way (Codex sessions launch no MCP relay, ask.go). It runs
// as this binary (Main), found on the session's PATH through a wrapper
// (Wrapper) beside gh's, and goes as git's credential helper does: to the
// agent on the loopback, with the agent's credential token as its proof that
// it runs on this box (gitcred.Local), and from the agent to the control
// plane, signed with the box's secret (gitcred.Client.Post). The session it
// is for is named by $OUTRUNNER_SESSION_ID, which every launch sets.
//
// The commands exist only where the control plane gave the agent the means
// to reach it (gitcred.ConfigFromEnv): never on the desktop app's Mac.
package sessiontools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"runtime-agent/internal/gitcred"
)

// CommandName is the wrapper on the sessions' PATH.
const CommandName = "outrunner-session"

// SessionEnv names the session a command is run in.
const SessionEnv = "OUTRUNNER_SESSION_ID"

// Route is the control plane's endpoint for the tools, and Purpose what
// their requests are signed for (gitcred.SignFor).
const (
	Route   = "/api/runtime/session-tools"
	Purpose = "session-tools"
)

// localTimeout bounds a call to the agent: longer than the agent's own call
// to the control plane, so its refusal arrives rather than a timeout.
const localTimeout = 25 * time.Second

// maxStdinBytes bounds what a command reads from stdin.
const maxStdinBytes = 64 << 10

// toolName is a tool's name as the agent passes it on.
var toolName = regexp.MustCompile(`^[a-z][a-z_]{0,39}$`)

// ValidTool reports whether name could be a tool's.
func ValidTool(name string) bool { return toolName.MatchString(name) }

// Call is a tool's call: the CLI's to the agent (POST /session-tools), and
// the agent's to the control plane.
type Call struct {
	Workspace string          `json:"workspace"`
	Tool      string          `json:"tool"`
	Args      json.RawMessage `json:"args"`
}

// Answer is what a call answers: text for the agent to read, or why not.
type Answer struct {
	Text  string `json:"text,omitempty"`
	Error string `json:"error,omitempty"`
}

// Local is how the CLI reaches the agent on the box: the address it
// announces and its credential token (gitcred.GitCredentialPaths).
type Local struct {
	AddrFile  string
	TokenFile string
	// Client sends the calls; nil is a client with localTimeout.
	Client *http.Client
}

// Wrapper is the script that stands in for the command on the sessions'
// PATH: this binary's session-tool, with the agent's root.
func Wrapper(executable, root string) string {
	return "#!/bin/sh\nexec " + gitcred.ShellQuote(executable) + " session-tool --root " + gitcred.ShellQuote(root) + ` "$@"` + "\n"
}

const usage = `Usage: outrunner-session <command>

Commands:
  suggest-learning [--org] --title <title> <instruction>
      Suggest a standing instruction for every future session. The user
      accepts or dismisses it in Outrunner (Settings → Learnings); nothing
      is saved until they do. --org suggests it for the whole org, for its
      admins to accept. The instruction may come on stdin instead ("-").
`

// Main runs a command and returns its exit status: 0 done, 1 refused or
// failed (its reason on stderr), 2 used wrongly.
func Main(ctx context.Context, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer, local Local) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(stderr, usage)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	tool, toolArgs, err := parse(args[0], args[1:], stdin)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n\n%s", CommandName, err, usage)
		return 2
	}
	workspace := strings.TrimSpace(getenv(SessionEnv))
	if workspace == "" {
		fmt.Fprintf(stderr, "%s: run it in an Outrunner session ($%s isn't set)\n", CommandName, SessionEnv)
		return 1
	}
	answer, err := local.call(ctx, Call{Workspace: workspace, Tool: tool, Args: toolArgs})
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", CommandName, err)
		return 1
	}
	fmt.Fprintln(stdout, answer)
	return 0
}

// parse reads a command's arguments as its tool's.
func parse(command string, args []string, stdin io.Reader) (string, json.RawMessage, error) {
	switch command {
	case "suggest-learning":
		flags := flag.NewFlagSet(command, flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		org := flags.Bool("org", false, "")
		title := flags.String("title", "", "")
		if err := flags.Parse(args); err != nil {
			return "", nil, err
		}
		body, err := text(flags.Args(), stdin)
		if err != nil {
			return "", nil, err
		}
		if strings.TrimSpace(*title) == "" || body == "" {
			return "", nil, errors.New("suggest-learning needs a --title and the instruction")
		}
		scope := "personal"
		if *org {
			scope = "org"
		}
		raw, err := json.Marshal(map[string]string{"scope": scope, "title": strings.TrimSpace(*title), "body": body})
		return "suggest_learning", raw, err
	}
	return "", nil, fmt.Errorf("no command %q", command)
}

// text is a command's text: its arguments, or stdin when there are none or
// the one is "-".
func text(args []string, stdin io.Reader) (string, error) {
	if len(args) > 0 && !(len(args) == 1 && args[0] == "-") {
		return strings.TrimSpace(strings.Join(args, " ")), nil
	}
	data, err := io.ReadAll(io.LimitReader(stdin, maxStdinBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxStdinBytes {
		return "", errors.New("the text is too long")
	}
	return strings.TrimSpace(string(data)), nil
}

func (l Local) call(ctx context.Context, call Call) (string, error) {
	addr, err := readTrimmed(l.AddrFile)
	if err != nil {
		return "", fmt.Errorf("the runtime agent isn't running: %w", err)
	}
	token, err := readTrimmed(l.TokenFile)
	if err != nil {
		return "", errors.New("this computer can't reach Outrunner from a session")
	}
	payload, err := json.Marshal(call)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+addr+"/session-tools", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := l.Client
	if client == nil {
		client = &http.Client{Timeout: localTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("couldn't reach the runtime agent: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("couldn't read the runtime agent's answer: %w", err)
	}
	var answer Answer
	if json.Unmarshal(data, &answer) != nil {
		return "", fmt.Errorf("the runtime agent answered %s", resp.Status)
	}
	if resp.StatusCode/100 != 2 {
		if answer.Error != "" {
			return "", errors.New(answer.Error)
		}
		return "", fmt.Errorf("refused: %s", resp.Status)
	}
	return answer.Text, nil
}

func readTrimmed(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return value, nil
}
