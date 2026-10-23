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

const usage = `Usage: outrunner [--url <app>] [command]

Commands:
  (none)   Sign in if needed, then continue setting up in your browser
  login    Sign this terminal in to Outrunner
  logout   Sign this terminal out
  whoami   Show who this terminal is signed in as
`

// Main runs the command and returns its exit status.
func Main(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("outrunner", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, usage) }
	base := flags.String("url", "", "the Outrunner app to sign in to")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
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

	command := flags.Arg(0)
	switch command {
	case "":
		return start(ctx, url, path, config, stdout, stderr)
	case "login":
		_, code := signIn(ctx, url, path, "/cli-login/done", stdout, stderr)
		return code
	case "logout":
		return logout(ctx, url, path, config, stdout, stderr)
	case "whoami":
		return whoami(ctx, url, config, stdout, stderr)
	case "help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "outrunner: unknown command %q\n\n%s", command, usage)
		return 2
	}
}

// start is the command a new user pastes: sign in, then the web app takes
// over onboarding from its first step the user hasn't done.
func start(ctx context.Context, url, path string, config Config, stdout, stderr io.Writer) int {
	if config.Token != "" {
		if user, err := WhoAmI(ctx, nil, url, config.Token); err == nil {
			printSignedIn(stdout, user, url)
			fmt.Fprintln(stdout, "\nContinuing in your browser...")
			_ = OpenBrowser(url + "/onboarding")
			return 0
		} else if !errors.Is(err, ErrSignedOut) {
			fmt.Fprintln(stderr, "outrunner:", err)
			return 1
		}
	}
	if _, code := signIn(ctx, url, path, "/onboarding", stdout, stderr); code != 0 {
		return code
	}
	fmt.Fprintln(stdout, "\nContinue setting up in your browser.")
	return 0
}

func signIn(ctx context.Context, url, path, after string, stdout, stderr io.Writer) (User, int) {
	token, user, err := Login(ctx, LoginOptions{
		BaseURL:     url,
		DeviceName:  DeviceName(),
		After:       after,
		OpenBrowser: OpenBrowser,
		Out:         stdout,
	})
	if err != nil {
		fmt.Fprintln(stderr, "outrunner: sign-in failed:", err)
		return User{}, 1
	}
	if err := SaveConfig(path, Config{URL: url, Token: token, Login: user.Login}); err != nil {
		fmt.Fprintf(stderr, "outrunner: signed in, but couldn't save to %s: %v\n", path, err)
		return User{}, 1
	}
	printSignedIn(stdout, user, url)
	return user, 0
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
