// Command outrunner is the CLI a user pastes into their terminal to start
// using Outrunner: it signs the terminal in through the browser, then hands
// onboarding to the web app. See package cli.
package main

import (
	"context"
	"os"
	"os/signal"

	"runtime-agent/internal/cli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	code := cli.Main(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
