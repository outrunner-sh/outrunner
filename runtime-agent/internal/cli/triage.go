package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// TriageItem is what the app answers a capture with.
type TriageItem struct {
	Key     string `json:"key"`
	URL     string `json:"url"`
	Created bool   `json:"created"`
	Item    struct {
		Title string `json:"title"`
	} `json:"item"`
}

// NewTriageItem is a capture: a title (or none, when the body's first line
// is one), Markdown, and the workspace (`owner/repo`) when known.
type NewTriageItem struct {
	Title   string `json:"title,omitempty"`
	Body    string `json:"body,omitempty"`
	Project string `json:"project,omitempty"`
	Source  string `json:"source"`
}

// CaptureTriage adds a work item to the signed-in user's triage.
func CaptureTriage(ctx context.Context, client *http.Client, base, token string, item NewTriageItem) (TriageItem, error) {
	body, _ := json.Marshal(item)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, appURL(base, "/api/triage/items"), bytes.NewReader(body))
	if err != nil {
		return TriageItem{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	var answer TriageItem
	return answer, do(httpClient(client), req, &answer)
}

const triageUsage = `Usage: outrunner triage [--repo owner/name] [--title <title>] <text…>

Adds a work item to your Outrunner triage. The text is its Markdown; with no
--title, its first line is the title. With no text, it's read from stdin:

  git log -1 --format=%B | outrunner triage --repo acme/web
`

// triage is `outrunner triage`: the args after the command name.
// Piped text comes from in: the run's one reader of stdin.
func triage(ctx context.Context, url string, config Config, args []string, in terminal, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("outrunner triage", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, triageUsage) }
	repo := flags.String("repo", "", "the workspace (owner/name) it belongs to; none is Unsorted")
	title := flags.String("title", "", "its title; none is the text's first line")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	text := strings.TrimSpace(strings.Join(flags.Args(), " "))
	if text == "" && !in.interactive {
		var piped []string
		for line := range in.lines {
			piped = append(piped, line)
		}
		text = strings.TrimSpace(strings.Join(piped, "\n"))
	}
	if text == "" && strings.TrimSpace(*title) == "" {
		fmt.Fprint(stderr, triageUsage)
		return 2
	}
	if config.Token == "" {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`.")
		return 1
	}

	item, err := CaptureTriage(ctx, nil, url, config.Token, NewTriageItem{
		Title:   strings.TrimSpace(*title),
		Body:    text,
		Project: strings.TrimSpace(*repo),
		Source:  "cli",
	})
	if errors.Is(err, ErrSignedOut) {
		fmt.Fprintln(stderr, "Not signed in. Run `outrunner login`.")
		return 1
	}
	if err != nil {
		fmt.Fprintln(stderr, "outrunner:", err)
		return 1
	}
	fmt.Fprintf(stdout, "✓ Added %s %s to triage\n  %s\n", item.Key, item.Item.Title, item.URL)
	return 0
}
