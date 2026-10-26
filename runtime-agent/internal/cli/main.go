package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// DefaultURL is the hosted app; --url or OUTRUNNER_URL points elsewhere.
const DefaultURL = "https://app.outrunner.sh"

// Version is the release, set by scripts/build-cli.sh.
var Version = "dev"

const usage = `Usage: outrunner [--url <app>] [--version] [command]

Commands:
  (none)   Sign in if needed, then continue setting up in your browser
  login    Sign this terminal in to Outrunner
  claude   Connect your Claude subscription (runs claude setup-token),
           signing in first if needed
  logout   Sign this terminal out
  whoami   Show who this terminal is signed in as
`

// Main runs the command and returns its exit status. stdin is where the
// user answers; it's asked anything only when it's a terminal.
func Main(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("outrunner", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, usage) }
	base := flags.String("url", "", "the Outrunner app to sign in to")
	version := flags.Bool("version", false, "print the version")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *version {
		fmt.Fprintln(stdout, "outrunner", Version)
		return 0
	}
	url := strings.TrimRight(firstNonEmpty(*base, os.Getenv("OUTRUNNER_URL"), DefaultURL), "/")

	path, err := ConfigPath()
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	config, err := LoadConfig(path)
	if err != nil {
		fmt.Fprintf(stderr, "outrunner: read %s: %v\n", path, err)
		return 1
	}
	// A token is for the app it came from.
	if config.URL != url {
		config = Config{}
	}

	in := terminal{lines: readLines(stdin), interactive: isTerminal(stdin), out: stdout}
	command := flags.Arg(0)
	switch command {
	case "":
		return start(ctx, url, path, config, in, stdout, stderr)
	case "login":
		_, code := signIn(ctx, url, path, "/cli-login/done", stdout, stderr)
		return code
	case "logout":
		return logout(ctx, url, path, config, stdout, stderr)
	case "whoami":
		return whoami(ctx, url, config, stdout, stderr)
	case "claude":
		// The command onboarding's subscription page shows: that page is
		// open already and moves on by itself, so no browser opens after.
		config, code := ensureSignedIn(ctx, url, path, config, stdout, stderr)
		if code != 0 {
			return code
		}
		if code := connectClaude(ctx, url, config, in, stdout, stderr); code != 0 {
			return code
		}
		fmt.Fprintln(stdout, "\nGo back to your browser to carry on.")
		return 0
	case "help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "outrunner: unknown command %q\n\n%s", command, usage)
		return 2
	}
}

// start is the command a new user pastes: sign in, offer to connect Claude
// when it's on this computer, then the web app takes over onboarding from
// its first step the user hasn't done.
func start(ctx context.Context, url, path string, config Config, in terminal, stdout, stderr io.Writer) int {
	config, code := ensureSignedIn(ctx, url, path, config, stdout, stderr)
	if code != 0 {
		return code
	}

	if code := offerClaude(ctx, url, config, in, stdout, stderr); code != 0 {
		return code
	}

	fmt.Fprintln(stdout, "\nContinue setting up in your browser:")
	fmt.Fprintf(stdout, "%s/onboarding\n", url)
	_ = openBrowser(url + "/onboarding")
	return 0
}

// ensureSignedIn returns config as is when its token still works, and signs
// in through the browser when there's none or the app has dropped it.
func ensureSignedIn(ctx context.Context, url, path string, config Config, stdout, stderr io.Writer) (Config, int) {
	if config.Token != "" {
		user, err := WhoAmI(ctx, nil, url, config.Token)
		switch {
		case err == nil:
			printSignedIn(stdout, user, url)
			return config, 0
		case !errors.Is(err, ErrSignedOut):
			fmt.Fprintln(stderr, "outrunner:", err)
			return config, 1
		}
	}
	token, code := signIn(ctx, url, path, "/cli-login/done", stdout, stderr)
	if code != 0 {
		return config, code
	}
	if saved, err := LoadConfig(path); err == nil && saved.Token == token {
		return saved, 0
	}
	return Config{URL: url, Token: token}, 0
}

// offerClaude connects Claude when the user has it here, hasn't connected it
// yet, and says yes. Nothing to offer is no failure: onboarding starts on
// Outrunner's models, and Claude can be connected later.
func offerClaude(ctx context.Context, url string, config Config, in terminal, stdout, stderr io.Writer) int {
	if _, err := FindClaude(); err != nil {
		return 0
	}
	status, err := GetClaude(ctx, nil, url, config.Token)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner: couldn't check your Claude connection:", err)
		return 0
	}
	if status.Connected {
		fmt.Fprintln(stdout, "\n✓ Claude Code connected")
		return 0
	}
	if !in.interactive {
		fmt.Fprintln(stdout, "\nRun `outrunner claude` to connect your Claude subscription.")
		return 0
	}
	fmt.Fprintln(stdout)
	if !in.confirm("Claude Code is on this computer. Connect your Claude subscription?") {
		fmt.Fprintln(stdout, "Skipped. Run `outrunner claude` to connect it later.")
		return 0
	}
	return connectClaude(ctx, url, config, in, stdout, stderr)
}

// connectClaude mints a token with this computer's `claude` and saves it.
func connectClaude(ctx context.Context, url string, config Config, in terminal, stdout, stderr io.Writer) int {
	binary, err := FindClaude()
	if err != nil {
		fmt.Fprintf(stderr, "outrunner: %v. Install it with `npm install -g @anthropic-ai/claude-code`, then run `outrunner claude`.\n", err)
		return 1
	}
	fmt.Fprintln(stdout, "\n Connect Claude Code · subscription")
	if config.Login != "" {
		fmt.Fprintf(stdout, "\n  User   %s\n", config.Login)
	}
	fmt.Fprintln(stdout)
	token, err := SetupToken(ctx, ClaudeOptions{Binary: binary, Lines: in.lines, Out: stdout})
	if err != nil {
		fmt.Fprintln(stderr, "\noutrunner:", err)
		return 1
	}
	fmt.Fprintln(stdout, "\n 3/3 Saving credentials")
	status, err := SaveClaude(ctx, nil, url, config.Token, token)
	if err != nil {
		fmt.Fprintln(stderr, "outrunner: couldn't save your Claude token:", err)
		return 1
	}
	fmt.Fprint(stdout, "\n ✓ Claude Code connected")
	if status.Last4 != nil {
		fmt.Fprintf(stdout, " (token …%s)", *status.Last4)
	}
	fmt.Fprintln(stdout)
	return 0
}

func signIn(ctx context.Context, url, path, after string, stdout, stderr io.Writer) (string, int) {
	token, user, err := Login(ctx, LoginOptions{
		BaseURL:     url,
		DeviceName:  DeviceName(),
		After:       after,
		OpenBrowser: openBrowser,
		Out:         stdout,
	})
	if err != nil {
		fmt.Fprintln(stderr, "outrunner: sign-in failed:", err)
		return "", 1
	}
	if err := SaveConfig(path, Config{URL: url, Token: token, Login: user.Login}); err != nil {
		fmt.Fprintf(stderr, "outrunner: signed in, but couldn't save to %s: %v\n", path, err)
		return "", 1
	}
	printSignedIn(stdout, user, url)
	return token, 0
}

func logout(ctx context.Context, url, path string, config Config, stdout, stderr io.Writer) int {
	if config.Token == "" {
		fmt.Fprintln(stdout, "Not signed in.")
		return 0
	}
	if err := Logout(ctx, nil, url, config.Token); err != nil && !errors.Is(err, ErrSignedOut) {
		fmt.Fprintln(stderr, "outrunner: sign-out failed:", err)
		return 1
	}
	if err := SaveConfig(path, Config{}); err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	fmt.Fprintln(stdout, "✓ Signed out")
	return 0
}

func whoami(ctx context.Context, url string, config Config, stdout, stderr io.Writer) int {
	if config.Token == "" {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`.")
		return 1
	}
	user, err := WhoAmI(ctx, nil, url, config.Token)
	if errors.Is(err, ErrSignedOut) {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`.")
		return 1
	}
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	printSignedIn(stdout, user, url)
	return 0
}

func printSignedIn(out io.Writer, user User, url string) {
	fmt.Fprintln(out, "✓ Signed in to Outrunner")
	fmt.Fprintf(out, "\n  User   %s\n", user.Login)
	if user.Email != nil && *user.Email != "" {
		fmt.Fprintf(out, "  Email  %s\n", *user.Email)
	}
	if url != DefaultURL {
		fmt.Fprintf(out, "  App    %s\n", url)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
