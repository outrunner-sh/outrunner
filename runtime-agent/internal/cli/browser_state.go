package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// `outrunner browser state` is how a session's own browser tests start signed
// in: it writes the box's desktop browser's sign-ins (wherever the user or
// the agent signed in, in the Desktop tab) as a Playwright storageState file
// and prints its path, for `browser.newContext({ storageState })`. The box's
// agent reads them (runtime-agent/internal/desktop StorageState): the session
// proves itself with its ask token, as `outrunner media upload` does.

const browserUsage = `Usage: outrunner browser <command>

Use the desktop browser's sign-ins (in an Outrunner session's terminal):
  state    Write them as a Playwright storageState file and print its path:
           outrunner browser state --origin http://localhost:3000

outrunner browser <command> --help for more.
`

const browserStateUsage = `Usage: outrunner browser state [--origin <url>]... [-o <file>]

Writes the sign-ins of this computer's desktop browser (the one in the
session's Desktop tab) as a Playwright storageState file, and prints its path.
Sign in to your app there once; then each test starts signed in, in a browser
context of its own. Run it once, in Playwright's globalSetup, not in every test:

  execFileSync("outrunner", ["browser", "state", "--origin", baseURL, "-o", "playwright/.auth/state.json"]);

with use: { storageState: "playwright/.auth/state.json" } in the config, and
playwright/.auth/ in .gitignore. A one-off script leaves out -o and starts
its context from the path printed: browser.newContext({ storageState: path }).

  --origin   An origin whose localStorage to include, as http://localhost:3000.
             Apps that keep their sign-in in localStorage need theirs named,
             unless a tab is open on it. Repeat for more. Cookies are always
             all included.
  -o         Where to write it. By default, outside the repository, under the
             box's Outrunner folder: the file is a live sign-in, so it
             mustn't be committed.
`

// stringList is a flag given once per value.
type stringList []string

func (l *stringList) String() string { return strings.Join(*l, ",") }
func (l *stringList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

func browserCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, browserUsage)
		return 2
	}
	switch args[0] {
	case "state":
		return browserStateCommand(ctx, args[1:], stdout, stderr)
	case "help", "--help", "-h":
		fmt.Fprint(stdout, browserUsage)
		return 0
	default:
		fmt.Fprintf(stderr, "outrunner: unknown browser command %q\n\n%s", args[0], browserUsage)
		return 2
	}
}

func browserStateCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	set := boxCommandFlags("outrunner browser state", browserStateUsage, stderr)
	var origins stringList
	set.Var(&origins, "origin", "an origin whose localStorage to include")
	output := set.String("o", "", "where to write it")
	positional, code := parseAnywhere(set, args)
	if code >= 0 {
		return code
	}
	if len(positional) != 0 {
		fmt.Fprint(stderr, browserStateUsage)
		return 2
	}
	cwd, _ := os.Getwd()
	agent, err := boxAgentFromEnv(os.Getenv, cwd)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	path := *output
	if path == "" {
		path = defaultBrowserStatePath(os.Getenv("OUTRUNNER_BOX_ROOT"), agent.sessionID)
	}
	if path, err = filepath.Abs(path); err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}

	if origins == nil {
		origins = stringList{}
	}
	data, err := agent.post(ctx, "browser-state", map[string]any{"origins": origins}, agentAsk{
		what:   "read the browser's sign-ins",
		before: "this box's Outrunner agent can't read the browser's sign-ins yet: it's from before them",
	})
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	var answer struct {
		State    json.RawMessage `json:"state"`
		Warnings []string        `json:"warnings"`
	}
	if err := json.Unmarshal(data, &answer); err != nil || len(answer.State) == 0 {
		fmt.Fprintln(stderr, "outrunner: the agent sent a malformed answer")
		return 1
	}
	for _, warning := range answer.Warnings {
		fmt.Fprintln(stderr, "outrunner:", warning)
	}
	if err := writePrivateFile(path, answer.State); err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	if committable(ctx, path) {
		fmt.Fprintf(stderr, "outrunner: %s is a live sign-in in a repository and not ignored there: add it to .gitignore, or write it elsewhere (leave out -o)\n", path)
	}
	fmt.Fprintln(stdout, path)
	return 0
}

// defaultBrowserStatePath is the session's own file under the box's root:
// outside every repository, and each session's, so two don't share one.
func defaultBrowserStatePath(root, session string) string {
	return filepath.Join(root, "browser", session+".json")
}

// writePrivateFile writes data to path whole or not at all, readable by its
// owner alone: a test that reads it while another run writes it reads the
// one or the other, never half.
func writePrivateFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// committable is whether path is in a git repository and not ignored there:
// `git check-ignore` exits 1 for that, 0 for an ignored path, and 128 outside
// a repository.
func committable(ctx context.Context, path string) bool {
	cmd := exec.CommandContext(ctx, "git", "-C", filepath.Dir(path), "check-ignore", "-q", path)
	var exit *exec.ExitError
	return errors.As(cmd.Run(), &exit) && exit.ExitCode() == 1
}
