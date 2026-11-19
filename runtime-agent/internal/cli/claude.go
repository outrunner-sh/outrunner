package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/childterm"
)

// Connecting Claude: run `claude setup-token` on this computer, as the Mac
// app does (runtime-desktop/src-tauri/src/claude_login.rs), and save the
// token it prints to the user's account.
//
// setup-token is a TUI: with no terminal it prints nothing and never exits,
// so it runs on a terminal of its own (childterm: a PTY, or a ConPTY on
// Windows). Its flow: print a sign-in link and open the browser; the user
// approves there; usually it then prints the token on its own, and otherwise
// it asks for a code, which the user pastes here.

const (
	// urlTimeout is how long setup-token may take to print its sign-in link.
	urlTimeout = 45 * time.Second
	// claudeTimeout is how long to wait for the user to approve.
	claudeTimeout = 5 * time.Minute
)

var (
	ansiOSC   = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	ansiCSI   = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	ansiOther = regexp.MustCompile(`\x1b[()][A-Za-z0-9]|\x1b[=>]|[\x00-\x08\x0b\x0c\x0e-\x1f]`)
	// The link's host depends on the Claude Code version (claude.com,
	// claude.ai, an Anthropic host); its oauth/authorize path doesn't.
	authorizeURL = regexp.MustCompile(`https://(?:[a-z0-9-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)/(?:[A-Za-z0-9._~-]+/)*oauth/authorize\?[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+`)
	claudeToken  = regexp.MustCompile(`sk-ant-[A-Za-z0-9_-]{20,}`)
	anyToken     = regexp.MustCompile(`sk-ant-[A-Za-z0-9_-]{10,}`)
)

// stripANSI leaves the text a TUI printed, without its escapes.
func stripANSI(raw string) string {
	return ansiOther.ReplaceAllString(ansiCSI.ReplaceAllString(ansiOSC.ReplaceAllString(raw, ""), ""), "")
}

// lastLines is the end of what setup-token printed, tokens hidden, for an
// error: a failure on someone's computer should say what Claude Code said.
func lastLines(raw string) string {
	var lines []string
	for _, line := range strings.Split(stripANSI(raw), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > 6 {
		lines = lines[len(lines)-6:]
	}
	return anyToken.ReplaceAllString(strings.Join(lines, " | "), "<redacted token>")
}

// ErrNoClaude is no `claude` on this computer's PATH.
var ErrNoClaude = errors.New("Claude Code isn't installed on this computer")

// FindClaude is the `claude` a user would run here.
func FindClaude() (string, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return "", ErrNoClaude
	}
	return path, nil
}

// ClaudeOptions are what minting a token needs from the command.
type ClaudeOptions struct {
	// Binary is the `claude` to run.
	Binary string
	// Lines are what the user types, a line at a time: a code, if asked.
	Lines <-chan string
	Out   io.Writer
}

// SetupToken runs `claude setup-token` and returns the token it prints.
func SetupToken(ctx context.Context, opts ClaudeOptions) (string, error) {
	dir := ""
	if home, err := os.UserHomeDir(); err == nil {
		dir = home
	}
	term, err := childterm.Start(opts.Binary, []string{"setup-token"}, dir, append(os.Environ(), "TERM=xterm-256color"))
	if errors.Is(err, childterm.ErrUnsupported) {
		return "", errors.New("connecting Claude from the terminal isn't supported on this system. Run `claude setup-token`, then paste the token it prints in Outrunner under Settings → Claude")
	}
	if err != nil {
		return "", fmt.Errorf("run claude setup-token: %w", err)
	}
	defer func() { _ = term.Close() }()

	var (
		mu         sync.Mutex
		transcript strings.Builder
	)
	text := func() string {
		mu.Lock()
		defer mu.Unlock()
		return transcript.String()
	}
	changed := make(chan struct{}, 1)
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				mu.Lock()
				transcript.Write(buf[:n])
				mu.Unlock()
				select {
				case changed <- struct{}{}:
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// 1. The sign-in link. Claude Code opens the browser at it itself.
	urlDeadline := time.After(urlTimeout)
	var link string
	for link == "" {
		if link = authorizeURL.FindString(stripANSI(text())); link != "" {
			break
		}
		select {
		case <-changed:
		case <-exited:
			if link = authorizeURL.FindString(stripANSI(text())); link == "" {
				return "", setupTokenFailed("Claude Code stopped before giving a sign-in link", text())
			}
		case <-urlDeadline:
			return "", setupTokenFailed("Claude Code didn't give a sign-in link. Run `claude` once to finish its first-run setup, then try again", text())
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	fmt.Fprintln(opts.Out, " 1/3 Approve access in your browser")
	fmt.Fprintln(opts.Out, "     If it didn't open, visit:")
	fmt.Fprintf(opts.Out, "     %s\n\n", link)
	fmt.Fprintln(opts.Out, " 2/3 If Claude shows you a code, paste it here and press Enter")

	// 2. The token: printed on its own once the user approves, or after a
	// code they paste.
	deadline := time.After(claudeTimeout)
	lines := opts.Lines
	for {
		if token := claudeToken.FindString(stripANSI(text())); token != "" {
			return token, nil
		}
		select {
		case <-changed:
		case <-exited:
			if token := claudeToken.FindString(stripANSI(text())); token != "" {
				return token, nil
			}
			return "", setupTokenFailed("Claude Code stopped without a token. Connecting needs a Claude Pro or Max subscription on the account you approve with", text())
		case line, ok := <-lines:
			if !ok {
				lines = nil // stdin closed: keep waiting for the browser
				continue
			}
			if code := strings.TrimSpace(line); code != "" {
				// A PTY line ends with CR, which its driver turns into the
				// newline setup-token's prompt waits for.
				if _, err := io.WriteString(term, code+"\r"); err != nil {
					return "", fmt.Errorf("give Claude Code the code: %w", err)
				}
			}
		case <-deadline:
			return "", errors.New("timed out waiting for you to approve Claude in the browser")
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func setupTokenFailed(message, transcript string) error {
	if said := lastLines(transcript); said != "" {
		return fmt.Errorf("%s. It said: %s", message, said)
	}
	return errors.New(message)
}

// ClaudeStatus is whether the user has a Claude subscription connected.
type ClaudeStatus struct {
	Connected bool    `json:"connected"`
	Last4     *string `json:"last4"`
}

// GetClaude asks whether the signed-in user has Claude connected.
func GetClaude(ctx context.Context, client *http.Client, base, token string) (ClaudeStatus, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, appURL(base, "/api/cli/claude"), nil)
	if err != nil {
		return ClaudeStatus{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	var status ClaudeStatus
	return status, do(httpClient(client), req, &status)
}

// SaveClaude saves a Claude token to the signed-in user's account.
func SaveClaude(ctx context.Context, client *http.Client, base, token, claude string) (ClaudeStatus, error) {
	body, _ := json.Marshal(map[string]string{"token": claude})
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, appURL(base, "/api/cli/claude"), bytes.NewReader(body))
	if err != nil {
		return ClaudeStatus{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	var status ClaudeStatus
	return status, do(httpClient(client), req, &status)
}
