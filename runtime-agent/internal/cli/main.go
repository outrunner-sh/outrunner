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

const usage = `Usage: outrunner [--url <app>] [--account <id>] [--version] [command]

Commands:
  (none)   Sign in if needed, then continue setting up in your browser
  login    Sign this terminal in to Outrunner
  claude   Connect your Claude subscription (runs claude setup-token),
           signing in first if needed
  logout   Sign this terminal out
  whoami   Show who this terminal is signed in as
  triage   Add a work item to your triage: outrunner triage "fix the flaky test"
`

// Main runs the command and returns its exit status. stdin is where the
// user answers; it's asked anything only when it's a terminal.
func Main(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("outrunner", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, usage) }
	base := flags.String("url", "", "the Outrunner app to sign in to")
	// The account the browser that gave the command is signed in to: a
	// terminal signed in to another one signs in again, rather than connect
	// Claude to an account the page isn't watching.
	account := flags.String("account", "", "the Outrunner account id to sign in as")
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
		return start(ctx, url, path, config, *account, in, stdout, stderr)
	case "login":
		_, _, code := signIn(ctx, url, path, "/cli-login/done", *account, stdout, stderr)
		return code
	case "logout":
		return logout(ctx, url, path, config, stdout, stderr)
	case "whoami":
		return whoami(ctx, url, config, stdout, stderr)
	case "claude":
		// The command onboarding's subscription page shows: that page is
		// open already and moves on by itself, so no browser opens after.
		config, code := ensureSignedIn(ctx, url, path, config, *account, stdout, stderr)
		if code != 0 {
			return code
		}
		if code := connectClaude(ctx, url, config, in, stdout, stderr); code != 0 {
			return code
		}
		fmt.Fprintln(stdout, "\nGo back to your browser to carry on.")
		return 0
	case "triage":
		return triage(ctx, url, config, flags.Args()[1:], in, stdout, stderr)
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
func start(ctx context.Context, url, path string, config Config, account string, in terminal, stdout, stderr io.Writer) int {
	config, code := ensureSignedIn(ctx, url, path, config, account, stdout, stderr)
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
// in through the browser when there's none, the app has dropped it, or it's
// for another account than `account` (when one is asked for).
func ensureSignedIn(ctx context.Context, url, path string, config Config, account string, stdout, stderr io.Writer) (Config, int) {
	// The other account's token, signed out once this one is in.
	replaced := ""
	if config.Token != "" {
		user, err := WhoAmI(ctx, nil, url, config.Token)
		switch {
		// An app that doesn't send the id can't be told apart: carry on, as
		// after signing in.
		case err == nil && (account == "" || user.ID == "" || user.ID == account):
			printSignedIn(stdout, user, url)
			return config, 0
		case err == nil:
			fmt.Fprintf(stdout, "This terminal is signed in as %s, not the account in your browser. Signing in again.\n", accountName(user))
			replaced = config.Token
		case !errors.Is(err, ErrSignedOut):
			fmt.Fprintln(stderr, "outrunner:", err)
			return config, 1
		}
	}
	token, _, code := signIn(ctx, url, path, "/cli-login/done", account, stdout, stderr)
	if code != 0 {
		return config, code
	}
	if replaced != "" {
		// Best effort: nothing here points to it anymore, so `outrunner
		// logout` never could.
		if err := Logout(ctx, nil, url, replaced); err != nil && !errors.Is(err, ErrSignedOut) {
			fmt.Fprintln(stderr, "outrunner: couldn't sign out the other account's terminal sign-in:", err)
		}
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

// signIn signs in through the browser and saves the token, unless it's for
// another account than `account` (when one is asked for): that one is
// signed out again and nothing is saved.
func signIn(ctx context.Context, url, path, after, account string, stdout, stderr io.Writer) (string, User, int) {
	token, user, err := Login(ctx, LoginOptions{
		BaseURL:     url,
		DeviceName:  DeviceName(),
		After:       after,
		OpenBrowser: openBrowser,
		Out:         stdout,
	})
	if err != nil {
		fmt.Fprintln(stderr, "outrunner: sign-in failed:", err)
		return "", User{}, 1
	}
	if account != "" && user.ID != "" && user.ID != account {
		_ = Logout(ctx, nil, url, token)
		fmt.Fprintf(stderr, "outrunner: signed in as %s, but this command is for another account. Sign in to Outrunner in your browser as that account, then run it again.\n", accountName(user))
		return "", User{}, 1
	}
	if err := SaveConfig(path, Config{URL: url, Token: token, Login: user.Login}); err != nil {
		fmt.Fprintf(stderr, "outrunner: signed in, but couldn't save to %s: %v\n", path, err)
		return "", User{}, 1
	}
	printSignedIn(stdout, user, url)
	return token, user, 0
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

// accountName is how an account is told apart in what the CLI prints.
func accountName(user User) string {
	email := ""
	if user.Email != nil {
		email = *user.Email
	}
	if user.Login != "" && email != "" && email != user.Login {
		return user.Login + " (" + email + ")"
	}
	return firstNonEmpty(user.Login, email, user.Name, "another account")
}
