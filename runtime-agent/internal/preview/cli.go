package preview

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// LocalRequest is POST /workspaces/{id}/preview's body, on the agent.
type LocalRequest struct {
	Port  int    `json:"port"`
	Label string `json:"label,omitempty"`
}

// LocalResponse is its answer.
type LocalResponse struct {
	Preview Preview `json:"preview"`
}

// Paths say where the CLI finds this box's agent: its announced address,
// and the session's ask token (workspace.AskPaths).
type Paths func(root, workspaceID string) (addrFile, tokenFile string)

// Main runs `runtime-agent preview --root R --workspace W [--label L]
// [--json] <port>`: it prints the preview's link, or its JSON, and exits
// non-zero with the reason on stderr when there's none.
func Main(ctx context.Context, args []string, stdout, stderr io.Writer, paths Paths, client *http.Client) int {
	flags := flag.NewFlagSet("preview", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", "", "the runtime-agent's root")
	workspaceID := flags.String("workspace", "", "the session's workspace id")
	label := flags.String("label", "", "a short name for the preview, e.g. \"Web app\"")
	asJSON := flags.Bool("json", false, "print the preview as JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *root == "" || *workspaceID == "" || flags.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: runtime-agent preview --root R --workspace W [--label L] [--json] <port>")
		return 2
	}
	port, err := strconv.Atoi(flags.Arg(0))
	if err != nil || port < 1 || port > 65535 {
		fmt.Fprintf(stderr, "preview: %q isn't a port\n", flags.Arg(0))
		return 2
	}
	addrFile, tokenFile := paths(*root, *workspaceID)
	got, err := ask(ctx, client, addrFile, tokenFile, *workspaceID, LocalRequest{Port: port, Label: strings.TrimSpace(*label)})
	if err != nil {
		fmt.Fprintln(stderr, "preview:", err)
		return 1
	}
	if *asJSON {
		data, _ := json.Marshal(got)
		fmt.Fprintln(stdout, string(data))
		return 0
	}
	fmt.Fprintln(stdout, got.URL)
	return 0
}

func ask(ctx context.Context, client *http.Client, addrFile, tokenFile, workspaceID string, body LocalRequest) (Preview, error) {
	addr, err := readTrimmed(addrFile)
	if err != nil {
		return Preview{}, fmt.Errorf("the runtime agent isn't running: %w", err)
	}
	token, err := readTrimmed(tokenFile)
	if err != nil {
		return Preview{}, fmt.Errorf("this session can't make previews: %w", err)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return Preview{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+addr+"/workspaces/"+url.PathEscape(workspaceID)+"/preview", bytes.NewReader(payload))
	if err != nil {
		return Preview{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if client == nil {
		client = &http.Client{Timeout: requestTimeout + 5*time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Preview{}, fmt.Errorf("couldn't reach the runtime agent: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Preview{}, fmt.Errorf("couldn't read the runtime agent's answer: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &refusal) == nil && refusal.Error.Message != "" {
			return Preview{}, errors.New(refusal.Error.Message)
		}
		return Preview{}, fmt.Errorf("the runtime agent refused: %s", resp.Status)
	}
	var answer LocalResponse
	if err := json.Unmarshal(data, &answer); err != nil || answer.Preview.URL == "" {
		return Preview{}, fmt.Errorf("the runtime agent sent a malformed preview")
	}
	return answer.Preview, nil
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
