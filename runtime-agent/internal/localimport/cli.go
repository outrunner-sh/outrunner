package localimport

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Exit codes of `runtime-agent import`. A skipped session is not a failure of
// the command: it prints why, as JSON, and exits ExitSkipped.
const (
	ExitOK      = 0
	ExitFailed  = 1
	ExitUsage   = 2
	ExitSkipped = 3
)

// keyPattern is a session key as a scan gives one.
var keyPattern = regexp.MustCompile(`^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// Main runs `runtime-agent import scan` or `runtime-agent import capture
// --key <key> --out <empty folder> [--upload]`, printing its result as JSON
// on stdout.
func Main(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: runtime-agent import scan | capture --key <key> --out <dir> [--upload] | env --repo <owner/name> [--vars a,b] [--files p,q] [--scripts]")
		return ExitUsage
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return ExitFailed
	}
	opts := DefaultOptions(home)
	switch args[0] {
	case "scan":
		flags := flag.NewFlagSet("scan", flag.ContinueOnError)
		flags.SetOutput(stderr)
		if flags.Parse(args[1:]) != nil {
			return ExitUsage
		}
		return printJSON(stdout, stderr, Run(ctx, opts))
	case "capture":
		flags := flag.NewFlagSet("capture", flag.ContinueOnError)
		flags.SetOutput(stderr)
		key := flags.String("key", "", "the session's key, from a scan")
		out := flags.String("out", "", "an empty folder to write the artifacts in")
		upload := flags.Bool("upload", false, "upload each artifact to the URL stdin names for its kind, as a JSON object")
		if flags.Parse(args[1:]) != nil {
			return ExitUsage
		}
		if !keyPattern.MatchString(*key) {
			fmt.Fprintln(stderr, "capture: --key must be a session key from a scan")
			return ExitUsage
		}
		if err := emptyDir(*out); err != nil {
			fmt.Fprintln(stderr, "capture: --out", err)
			return ExitUsage
		}
		// The URLs carry their tokens, so they come on stdin, not argv.
		var urls map[string]string
		if *upload {
			if err := json.NewDecoder(stdin).Decode(&urls); err != nil {
				fmt.Fprintln(stderr, "capture: --upload needs a JSON object of upload URLs on stdin:", err)
				return ExitUsage
			}
		}
		capture, err := CaptureSession(ctx, opts, *key, *out)
		var skip *SkipError
		if errors.As(err, &skip) {
			printJSON(stdout, stderr, map[string]Skip{"skip": skip.Skip})
			return ExitSkipped
		}
		if err == nil && *upload {
			err = Upload(ctx, capture, urls)
		}
		if err != nil {
			fmt.Fprintln(stderr, "capture:", err)
			return ExitFailed
		}
		return printJSON(stdout, stderr, capture)
	case "env":
		flags := flag.NewFlagSet("env", flag.ContinueOnError)
		flags.SetOutput(stderr)
		repo := flags.String("repo", "", "the repository, owner/name, as a scan gave it")
		vars := flags.String("vars", "", "the variables to read, comma-separated")
		files := flags.String("files", "", "the files to read, comma-separated paths from a scan")
		scripts := flags.Bool("scripts", false, "include the repository's scripts")
		if flags.Parse(args[1:]) != nil {
			return ExitUsage
		}
		if parseGitHubRemote("https://github.com/"+*repo) == "" {
			fmt.Fprintln(stderr, "env: --repo must be owner/name")
			return ExitUsage
		}
		capture, err := CaptureEnv(ctx, opts, *repo, EnvPick{Vars: list(*vars), Files: list(*files), Scripts: *scripts})
		if err != nil {
			fmt.Fprintln(stderr, "env:", err)
			return ExitFailed
		}
		return printJSON(stdout, stderr, capture)
	}
	fmt.Fprintf(stderr, "unknown import command %q\n", args[0])
	return ExitUsage
}

// list splits a comma-separated flag, dropping empties.
func list(value string) []string {
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

// emptyDir accepts an absolute path to an existing, empty folder.
func emptyDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return errors.New("must be an absolute path")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return errors.New("must be empty")
	}
	return nil
}

func printJSON(stdout, stderr io.Writer, v any) int {
	if err := json.NewEncoder(stdout).Encode(v); err != nil {
		fmt.Fprintln(stderr, err)
		return ExitFailed
	}
	return ExitOK
}
